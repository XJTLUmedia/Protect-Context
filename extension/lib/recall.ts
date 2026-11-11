/**
 * Local recall over the retained journal and evidence window.
 *
 * Readers use readJsonl, so the live ledger plus up to three rotated segments
 * are concatenated oldest-first — the same window every other reader sees.
 * No embeddings and no extra index. Filters combine with AND.
 *
 * A query is a paraphrase, not a string, so matching is word-start **or equal
 * stem**: `retrieving` reaches a row about `retrieval`, while `arch` still never
 * reaches `search`. Common English stopwords are dropped. Each keyword matches
 * across text, cmd, and digest; a keyword that is itself an evidence id
 * (`ev-NNNN`) also matches that id. Tags are exact, case-insensitive, and AND.
 * Evidence rows have no tags, so a tag filter excludes them.
 *
 * Rows score by BM25 (k1=1.5, b=0.75, Lucene IDF) in integer thousandths: term
 * frequency saturates, and a row is normalised by its length against the corpus
 * average so a verbose row cannot win on volume alone. A query of three or more
 * keywords must still share two words, but when nothing matches at that floor the
 * search widens once to a single shared term and reports `widened`.
 *
 * A query also reaches past bash commands from the events ledger (`command` rows,
 * successful calls only, one row per fingerprint, half weight), so a repeated
 * task can reuse the exact command that solved it before.
 *
 * Ranking is match strength, then recency, then a bounded boost from a row's
 * recorded reuse count. The displayed page collapses near-duplicates (dedup), so
 * restatements of one entry cannot fill it. Journal hits tagged `agent` stay
 * unverified; every other journal hit and every evidence row is trusted.
 *
 * Keep the weights, constants, and filter rules aligned with
 * src/protect_context/recall.py.
 */

import { suppress } from "./dedup.ts";
import { normalizeCommand } from "./fingerprint.ts";
import { translationsOf } from "./glossary.ts";
import { hasAgentTag, isJournalType, sanitizeTags, type JournalEntry } from "./journal.ts";
import { stem as stemToken, countTokens, stems as stemSet } from "./stem.ts";
import { eventsPath, journalPath, readJsonl, verifyRunsPath } from "./store.ts";
import { normalizeOneLine } from "./text.ts";

export const RECALL_TYPES = ["decision", "correction", "risk", "note", "evidence"] as const;
export type RecallType = (typeof RECALL_TYPES)[number];
export const LIMIT_DEFAULT = 5;
export const LIMIT_MAX = 20;
const MAX_KEYWORDS = 12;
const QUERY_CAP = 500;

const TEXT_WEIGHT = 3;
const TAG_WEIGHT = 2;
const CMD_WEIGHT = 2;
const DIGEST_WEIGHT = 1;
const ID_WEIGHT = 4;
const CMD_EXACT_WEIGHT = 4;
const CMD_SUB_WEIGHT = 1;

// Observed-reuse reinforcement. A hint that already solved this three times is
// worth more than one that was tried once, but the boost is capped and small, so
// it can settle a near-tie and never outvote a genuinely better lexical match.
// This is not ACT-R base-level activation: the ledger stores a count, not the
// dates of each reuse, so there is no history to decay.
const USES_BONUS_STEP = 10;
const USES_BONUS_CAP = 8;

// A keyword that reaches a row only through the bilingual glossary
// (glossary.ts) is a weaker signal than a literal one: the dictionary is
// curated, but it is still an inference. The term is scaled by 0.6 so a literal
// row always outranks an equally rare translated one. Integer arithmetic keeps
// this identical to recall.py.
const TRANSLATION_WEIGHT_MILLI = 600;

// BM25 saturation (k1) and length normalisation (b), in thousandths so the
// arithmetic stays integer and Python's recall mirrors it to the unit.
const K1_MILLI = 1500;
const B_MILLI = 750;

const EV_ID = /^ev-(\d+)$/i;

export class RecallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecallError";
  }
}

export interface RecallQuery {
  query?: unknown;
  type?: unknown;
  tags?: unknown;
  limit?: unknown;
  evidenceId?: unknown;
  cmd?: unknown;
}

export interface RecallHit {
  kind: string;
  provenance: "trusted" | "agent";
  ts: string;
  text: string;
  tags: string[];
  evidenceId: string | null;
  cmd: string;
  exitCode: number | null;
  /** How many times the same command succeeded, for `command` hits. */
  uses: number;
  /** Last observed result of that command, when the ledgers pair up. */
  lastOk: boolean | null;
  lastExit: number | null;
  /** Tool name for `file` hints (read, edit, grep ...). */
  tool: string;
  strength: number;
  recency: number;
}

export interface RecallResult {
  hits: RecallHit[];
  scanned: number;
  matched: number;
  /**
   * True when the strict pass matched nothing and the search relaxed to a single
   * shared term. The hits are then weaker evidence, so the caller is told rather
   * than left to assume precision it did not get.
   */
  widened: boolean;
}

/** Tools whose rows are shell runs; every other tool leaves a reuse key. */
const SHELL_TOOLS = new Set(["bash", "guard_verify"]);
/** Search tools record the *query* they ran, so indexing their rows let a query
 *  answer itself: for any wording the store had not seen before, the echo of
 *  the search was rank 1 and carried no knowledge (mirrors recall.py;
 *  QUERY_TOOLS, measured 2026-11-11). */
const QUERY_TOOLS = new Set(["guard_recall"]);
/** The same rule for shell rows: `protect-context recall "production database"`
 *  is the question, and indexing it let the echo outrank the answer (measured
 *  2026-11-11 on the real store). It is not only the CLI verb —
 *  `from protect_context import recall` in a `python -c` one-liner is the same
 *  question in another shape, and a guard_verify row stores that command. */
const QUERY_COMMAND = /(?<![\w.-])(?:protect[-_]context|pc)\b[^\n]*\brecall\b(?!\.)/i;

function isQueryCommand(cmd: string): boolean {
  return QUERY_COMMAND.test(cmd);
}

interface CorpusRow {
  source: "journal" | "evidence" | "command" | "file";
  kind: string;
  text: string;
  cmd: string;
  digest: string;
  ts: string;
  tags: string[];
  evidenceId: string | null;
  exitCode: number | null;
  provenance: "trusted" | "agent";
  uses?: number;
  lastOk?: boolean | null;
  lastExit?: number | null;
  /** Tool name for `file` rows (read, edit, grep ...). */
  tool?: string;
}

export function canonicalEvidenceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = EV_ID.exec(value.trim());
  if (!match) return null;
  const digits = match[1] ?? "";
  if (digits.length > 8) return null;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return `ev-${String(number).padStart(4, "0")}`;
}

export function boundedRecallLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return LIMIT_DEFAULT;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new RecallError("recall limit must be an integer");
  }
  return Math.max(0, Math.min(Math.trunc(limit), LIMIT_MAX));
}

function isRecallType(value: string): value is RecallType {
  return (RECALL_TYPES as readonly string[]).includes(value);
}

function blankToNull(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new RecallError(`${label} must be a string`);
  const text = value.trim();
  return text === "" ? null : text;
}

function validateType(value: unknown): RecallType | null {
  const text = blankToNull(value, "recall type");
  if (text === null) return null;
  if (!isRecallType(text)) {
    throw new RecallError(`unknown recall type ${JSON.stringify(text)}; use one of ${RECALL_TYPES.join(", ")}`);
  }
  return text;
}

function validateEvidenceId(value: unknown): string | null {
  const text = blankToNull(value, "evidence id");
  if (text === null) return null;
  const canonical = canonicalEvidenceId(text);
  if (canonical === null) throw new RecallError("evidence id must look like ev-NNNN");
  return canonical;
}

// Query words that carry no signal on their own (same list as recall.py).
const STOPWORDS = new Set(
  (
    "a an and any are as at be been before being but by can could did do does" +
    " doing done for from get gets got had has have how i if in into is it" +
    " its just me more most my no not now of on once only or other our out" +
    " over own same she" +
    " should so some such than that the their them then there these they this" +
    " those through to too under until up very was we were what when where" +
    " which while who whom why will with would you your"
  ).split(" "),
);
const MULTI_MATCH_FROM = 3;
const MULTI_MATCH_FLOOR = 2;

function keywordsOf(query: unknown): string[] {
  if (query === undefined || query === null) return [];
  if (typeof query !== "string") throw new RecallError("recall query must be a string");
  const raw = normalizeOneLine(query, QUERY_CAP).toLowerCase();
  const found: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(" ")) {
    if (part === "" || seen.has(part) || STOPWORDS.has(part)) continue;
    seen.add(part);
    found.push(part);
    if (found.length >= MAX_KEYWORDS) break;
  }
  return found;
}

function rawTags(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function tagKey(tag: string): string {
  return normalizeOneLine(tag, 40).toLowerCase();
}

function requestedTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  const items = typeof tags === "string" ? [tags] : tags;
  if (!Array.isArray(items)) throw new RecallError("recall tags must be a list of strings");
  const found: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") throw new RecallError("recall tags must be a list of strings");
    for (const part of item.split(",")) {
      const key = tagKey(part);
      if (key !== "" && !seen.has(key)) {
        seen.add(key);
        found.push(key);
      }
    }
  }
  return found;
}

function displayTags(tags: string[]): string[] {
  return sanitizeTags(tags);
}

function asJournal(row: unknown): CorpusRow | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (!isJournalType(record.type)) return null;
  if (typeof record.text !== "string") return null;
  const tags = rawTags(record.tags);
  return {
    source: "journal",
    kind: record.type,
    text: record.text,
    cmd: "",
    digest: "",
    ts: typeof record.ts === "string" ? record.ts : "",
    tags,
    evidenceId: null,
    exitCode: null,
    provenance: hasAgentTag(tags) ? "agent" : "trusted",
    // Carried through rather than dropped: a journal row that records its own
    // reuse count used to rank as if it had never been reused at all.
    uses: asCount(record.uses),
  };
}

function asEvidence(row: unknown): CorpusRow | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const cmd = typeof record.cmd === "string" ? record.cmd : "";
  const digest = typeof record.digest === "string" ? record.digest : "";
  const rawId = typeof record.id === "string" ? record.id : "";
  if (cmd === "" && digest === "" && rawId === "") return null;
  const exitCode = typeof record.exit === "number" && Number.isFinite(record.exit) ? Math.trunc(record.exit) : null;
  return {
    source: "evidence",
    kind: "evidence",
    text: "",
    cmd,
    digest,
    ts: typeof record.ts === "string" ? record.ts : "",
    tags: [],
    evidenceId: canonicalEvidenceId(rawId),
    exitCode,
    provenance: "trusted",
  };
}

/**
 * Non-shell tool calls grouped by the path/pattern they touched.
 *
 * A read/edit/search call records its key, so "where did I read this before" is
 * answerable from the ledger instead of re-derived. Hint only: it carries no
 * trust and never drives a loop streak (loops.ts skips non-shell tools).
 */
function fileRows(events: unknown[]): CorpusRow[] {
  const grouped = new Map<string, CorpusRow>();
  for (const row of events) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (record.kind !== "tool_result") continue;
    const tool = typeof record.tool === "string" ? record.tool : "";
    if (tool === "" || SHELL_TOOLS.has(tool)) continue;
    // MCP clients qualify the name (mcp__server__guard_recall); the last
    // segment is the tool the store actually recorded.
    if (QUERY_TOOLS.has(tool.split("__").at(-1) ?? tool)) continue;
    if (typeof record.cmd !== "string" || record.cmd.trim() === "") continue;
    const key = normalizeCommand(record.cmd);
    if (key === "") continue;
    const ts = typeof record.ts === "string" ? record.ts : "";
    const seen = grouped.get(key);
    const lastOk = typeof record.ok === "boolean" ? record.ok : null;
    const lastExit =
      typeof record.exit === "number" && Number.isFinite(record.exit) ? Math.trunc(record.exit) : null;
    if (!seen) {
      grouped.set(key, {
        source: "file",
        kind: "file",
        text: "",
        cmd: record.cmd,
        digest: "",
        ts,
        tags: [],
        evidenceId: null,
        exitCode: null,
        provenance: "agent",
        tool,
        uses: 1,
        lastOk,
        lastExit,
      });
      continue;
    }
    seen.uses = (seen.uses ?? 1) + 1;
    seen.cmd = record.cmd;
    seen.tool = tool;
    seen.ts = ts === "" ? seen.ts : ts;
    seen.lastOk = lastOk;
    seen.lastExit = lastExit;
  }
  return [...grouped.values()];
}

/**
 * Successful bash calls from the events ledger, one row per command family.
 *
 * Only `tool_call` rows with a command that was not refused (`ok` not false)
 * are reused: a blocked or declined attempt is not a proven recipe. An outcome
 * is attached only when it can be correlated with one outstanding call — by the
 * result's own command fingerprint, or when exactly one pending call carries
 * the result's tool. With overlapping calls the pairing would be a guess, and a
 * mislabelled outcome is worse than none (mirrors recall._command_rows).
 */
function commandRows(events: unknown[]): CorpusRow[] {
  const grouped = new Map<string, CorpusRow>();
  // session -> still-unpaired calls, oldest first; bounded like recall.py.
  const pending = new Map<string, Array<{ tool: string; key: string }>>();
  for (const row of events) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const session = typeof record.session === "string" ? record.session : "";
    if (record.kind === "tool_result") {
      const stack = pending.get(session);
      if (!stack || stack.length === 0) continue;
      const tool = typeof record.tool === "string" ? record.tool : "";
      const resultCmd = record.cmd;
      const resultKey =
        typeof resultCmd === "string" && resultCmd.trim() !== "" ? normalizeCommand(resultCmd) : "";
      let match = -1;
      if (resultKey !== "") {
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          if (stack[index]?.key === resultKey) {
            match = index;
            break;
          }
        }
      }
      if (match === -1) {
        const candidates: number[] = [];
        stack.forEach((call, index) => {
          if (tool === "" || call.tool === tool) candidates.push(index);
        });
        if (candidates.length === 1) match = candidates[0] ?? -1;
      }
      if (match === -1) continue;
      const paired = stack.splice(match, 1)[0];
      const seen = paired === undefined ? undefined : grouped.get(paired.key);
      if (seen) {
        seen.lastOk = typeof record.ok === "boolean" ? record.ok : null;
        seen.lastExit =
          typeof record.exit === "number" && Number.isFinite(record.exit) ? Math.trunc(record.exit) : null;
      }
      continue;
    }
    if (record.kind !== "tool_call" || record.ok === false) continue;
    if (typeof record.cmd !== "string" || record.cmd.trim() === "") continue;
    if (isQueryCommand(record.cmd)) continue;
    const key = normalizeCommand(record.cmd);
    if (key === "") continue;
    const tool = typeof record.tool === "string" ? record.tool : "";
    const stack = pending.get(session) ?? [];
    stack.push({ tool, key });
    if (stack.length > 4) stack.splice(0, stack.length - 4);
    pending.set(session, stack);
    const ts = typeof record.ts === "string" ? record.ts : "";
    const seen = grouped.get(key);
    if (!seen) {
      grouped.set(key, {
        source: "command",
        kind: "command",
        text: "",
        cmd: record.cmd,
        digest: "",
        ts,
        tags: [],
        evidenceId: null,
        exitCode: null,
        provenance: "agent",
        uses: 1,
        lastOk: null,
        lastExit: null,
      });
      continue;
    }
    seen.uses = (seen.uses ?? 1) + 1;
    if (ts > seen.ts) {
      seen.ts = ts;
      seen.cmd = record.cmd;
    }
  }
  return [...grouped.values()];
}

/**
 * True when `keyword` starts a word in `haystack`.
 *
 * A plain substring test made "old" hit the tag "threshold" and "arch" hit
 * "search", so a query could answer itself with the wrong entry. Matching only
 * at a word start keeps the useful morphology ("patch" -> "patches") while
 * dropping mid-word noise. Mirrors Python's recall.word_hit.
 */
export function wordHit(haystack: string, keyword: string): boolean {
  if (keyword === "") return false;
  const folded = haystack.toLowerCase();
  // A non-ASCII keyword is a substring match: scripts written without spaces
  // have no word start to find, and the mid-word noise the boundary rule stops
  // ("arch" in "search") needs an ASCII word structure Chinese does not have.
  // Mirrors recall.word_hit (measured 2026-11-11).
  if (/[^\x00-\x7F]/.test(keyword)) return folded.includes(keyword.toLowerCase());
  let start = 0;
  for (;;) {
    const idx = folded.indexOf(keyword, start);
    if (idx < 0) return false;
    if (idx === 0) return true;
    // Mirror Python's str.isalnum(): Unicode letters and numbers also end a
    // word. Slicing by code point keeps astral symbols intact, and an ASCII
    // test here let "naïold"/"表格old" match "old" where Python does not.
    const prior = Array.from(folded.slice(0, idx)).at(-1);
    if (prior === undefined || !/^[\p{L}\p{N}]$/u.test(prior)) return true;
    start = idx + 1;
  }
}

/** Unweighted hit strength for one keyword against one row. */
function rawHit(keyword: string, keywordStem: string, canonical: string | null, row: CorpusRow): number {
  let hit = 0;
  if (termHit(row.text, keyword, keywordStem)) hit += TEXT_WEIGHT;
  if (row.tags.some((tag) => termHit(tag, keyword, keywordStem))) hit += TAG_WEIGHT;
  if (termHit(row.cmd, keyword, keywordStem)) hit += CMD_WEIGHT;
  if (termHit(row.digest, keyword, keywordStem)) hit += DIGEST_WEIGHT;
  if (canonical !== null && canonical === row.evidenceId) hit += ID_WEIGHT;
  return hit;
}

/**
 * BM25 inverse document frequency in thousandths.
 *
 * `ln(1 + (N - df + 0.5) / (df + 0.5))` is the Lucene form: always non-negative,
 * so a word present in every row ("owner") scores near zero instead of demanding
 * an arbitrary clamp, and a word in one row of a hundred dominates the query.
 * The old rule (`N/df` clamped to [1x, 8x]) could not tell a word in 2 rows from
 * a word in 12 — both hit the ceiling.
 *
 * Values are rounded to integer thousandths so this matches Python's
 * recall._idf: `floor(x * 1000 + 0.5)` is a rounding rule both runtimes share,
 * unlike banker's rounding.
 */
export function idfFor(df: number, total: number): number {
  if (df <= 0 || total <= 0) return 0;
  const value = Math.log(1 + (total - df + 0.5) / (df + 0.5));
  return Math.floor(value * 1000 + 0.5);
}

/**
 * One BM25 term score, integer-only.
 *
 * `idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length / average))` in
 * thousandths. Saturation is what fixes the measured length bias: without a
 * `k1` ceiling a 60-word filler row outranked a precise 5-word row because the
 * old score was a plain sum of weights that never stopped growing.
 */
export function bm25Term(idfMilli: number, tf: number, length: number, average: number): number {
  if (idfMilli <= 0 || tf <= 0 || average <= 0) return 0;
  // (1 - b + b * length / average) in thousandths.
  const norm = 1000 - B_MILLI + Math.floor((B_MILLI * length) / average);
  const denominator = tf * 1000 + Math.floor((K1_MILLI * norm) / 1000);
  if (denominator <= 0) return 0;
  return Math.floor((idfMilli * tf * (1000 + K1_MILLI)) / denominator);
}

/** Usage counter from a row: non-negative integer, anything else zero. */
function asCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 0;
  return value;
}

/** Bounded reinforcement from how often a row was reused. */
function usesBonus(value: unknown): number {
  return Math.min(asCount(value), USES_BONUS_CAP) * USES_BONUS_STEP;
}

/** Searchable length of a row, for BM25's length normalisation. */
function docLength(row: CorpusRow): number {
  let total = countTokens(row.text) + countTokens(row.cmd) + countTokens(row.digest);
  for (const tag of row.tags) total += countTokens(tag);
  return total;
}

/**
 * Stem sets are pure functions of a field string, so they are memoised across
 * rows and searches. The cap bounds a long-lived process; the retained window is
 * far smaller than this, and clearing only costs one re-tokenise.
 */
const STEM_CACHE_MAX = 4096;
const stemCache = new Map<string, Set<string>>();

function stemsOf(text: string): Set<string> {
  const cached = stemCache.get(text);
  if (cached !== undefined) return cached;
  const computed = stemSet(text);
  if (stemCache.size >= STEM_CACHE_MAX) stemCache.clear();
  stemCache.set(text, computed);
  return computed;
}

/**
 * True when `keyword` starts a word in `haystack`, or shares its stem.
 *
 * The word-start rule alone made morphology one-way: a query for `retrieving`
 * found nothing in a row about `retrieval`. Adding stem equality keeps the
 * mid-word guard (`arch` still misses `search`) while joining inflections.
 */
function termHit(haystack: string, keyword: string, keywordStem: string): boolean {
  if (wordHit(haystack, keyword)) return true;
  return keywordStem !== "" && stemsOf(haystack).has(keywordStem);
}

function documentFrequencies(keywords: string[], keywordStems: string[], corpus: CorpusRow[]): number[] {
  const counts = keywords.map(() => 0);
  for (const row of corpus) {
    keywords.forEach((keyword, index) => {
      if (rawHit(keyword, keywordStems[index] ?? "", canonicalEvidenceId(keyword), row) > 0) {
        counts[index] = (counts[index] ?? 0) + 1;
      }
    });
  }
  return counts;
}

/**
 * Best hit for one query term, and whether it came from the glossary.
 *
 * The literal keyword is tried first so a row that contains it is never
 * downgraded by a neighbour that also happens to be in the glossary. Alternates
 * are alternatives for the same term, not extra required terms, so the query
 * keeps its AND-over-terms shape.
 */
function groupHit(
  keyword: string,
  keywordStem: string,
  alternates: string[],
  alternateStems: string[],
  row: CorpusRow,
): { raw: number; translated: boolean } {
  const raw = rawHit(keyword, keywordStem, canonicalEvidenceId(keyword), row);
  if (raw > 0) return { raw, translated: false };
  let best = 0;
  alternates.forEach((alternate, index) => {
    const candidate = rawHit(alternate, alternateStems[index] ?? "", null, row);
    if (candidate > best) best = candidate;
  });
  return { raw: best, translated: best > 0 };
}

/** True when a tag (a deliberate synonym) matches the term or an alternate. */
function tagReached(
  tags: string[],
  keyword: string,
  stem: string,
  alternates: string[],
  alternateStems: string[],
): boolean {
  return tags.some(
    (tag) =>
      termHit(tag, keyword, stem) ||
      alternates.some((alternate, index) => termHit(tag, alternate, alternateStems[index] ?? "")),
  );
}

/** BM25 partial-match score, or null when the row is too weak. */
function keywordScore(
  keywords: string[],
  keywordStems: string[],
  alternates: string[][],
  alternateStems: string[][],
  row: CorpusRow,
  idf: number[],
  length: number,
  average: number,
  floorOverride?: number,
): number | null {
  if (keywords.length === 0) return 0;
  let score = 0;
  let hits = 0;
  let tagHit = false;
  keywords.forEach((keyword, index) => {
    const stem = keywordStems[index] ?? "";
    const alt = alternates[index] ?? [];
    const altStems = alternateStems[index] ?? [];
    const { raw, translated } = groupHit(keyword, stem, alt, altStems, row);
    if (raw === 0) return;
    hits += 1;
    if (tagReached(row.tags, keyword, stem, alt, altStems)) tagHit = true;
    const term = bm25Term(idf[index] ?? 0, raw, length, average);
    score += translated ? Math.floor((term * TRANSLATION_WEIGHT_MILLI) / 1000) : term;
  });
  const floor =
    floorOverride ?? (keywords.length < MULTI_MATCH_FROM ? 1 : MULTI_MATCH_FLOOR);
  // A tag is a synonym the owner wrote on purpose, so one tag match is a
  // deliberate signal and beats the word-count floor that stops stray matches.
  if (hits < floor && !tagHit) return null;
  return score;
}

function cmdBonus(cmdQuery: string | null, row: CorpusRow): number | null {
  if (cmdQuery === null) return 0;
  if (row.source !== "evidence") return null;
  const needle = normalizeCommand(cmdQuery);
  if (needle === "") return 0;
  const haystack = normalizeCommand(row.cmd);
  if (needle === haystack) return CMD_EXACT_WEIGHT;
  if (haystack.includes(needle)) return CMD_SUB_WEIGHT;
  return null;
}

function matchesTags(requested: string[], row: CorpusRow): boolean {
  if (requested.length === 0) return true;
  if (row.source !== "journal") return false;
  const present = new Set(row.tags.map(tagKey).filter((tag) => tag !== ""));
  return requested.every((tag) => present.has(tag));
}

function toHit(row: CorpusRow, strength: number, recency: number): RecallHit {
  return {
    kind: row.kind,
    provenance: row.provenance,
    ts: row.ts,
    text: row.text,
    tags: displayTags(row.tags),
    evidenceId: row.evidenceId,
    cmd: row.cmd,
    exitCode: row.exitCode,
    uses: asCount(row.uses),
    lastOk: row.lastOk ?? null,
    lastExit: row.lastExit ?? null,
    tool: row.tool ?? "",
    strength,
    recency,
  };
}

/** Codepoint order, matching Python's str comparison: localeCompare is
 *  locale-dependent and would let the same query rank differently per host. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Rank already-loaded rows. Does not touch the filesystem. */
export function searchRows(
  journalRows: unknown[],
  evidenceRows: unknown[],
  query: RecallQuery = {},
  eventRows: unknown[] = [],
): RecallResult {
  const kind = validateType(query.type);
  const wantedId = validateEvidenceId(query.evidenceId);
  const bounded = boundedRecallLimit(query.limit);
  const keywords = keywordsOf(query.query);
  const keywordStems = keywords.map((keyword) => stemToken(keyword));
  const alternates = keywords.map((keyword) => translationsOf(keyword));
  const alternateStems = alternates.map((group) => group.map((alternate) => stemToken(alternate)));
  const wantedTags = requestedTags(query.tags);
  const cmdFilter = blankToNull(query.cmd, "recall cmd");

  const corpus: CorpusRow[] = [];
  for (const row of journalRows) {
    const parsed = asJournal(row);
    if (parsed) corpus.push(parsed);
  }
  for (const row of evidenceRows) {
    const parsed = asEvidence(row);
    if (parsed) corpus.push(parsed);
  }
  // A recorded question is not an answer, whichever ledger it landed in: a
  // guard_verify row stores the command that ran the query, so indexing it let
  // it outrank the entries it was searching for. Same rule as commandRows.
  const answerable = corpus.filter((row) => row.cmd === "" || !isQueryCommand(row.cmd));
  corpus.length = 0;
  corpus.push(...answerable);
  // Reuse beats rewriting: a query also reaches commands that already solved a
  // similar task. Not for an empty query (the recent window stays ledger-shaped)
  // and not when the same command is already evidence.
  if (keywords.length > 0 || cmdFilter !== null) {
    const known = new Set(corpus.filter((row) => row.cmd !== "").map((row) => normalizeCommand(row.cmd)));
    for (const row of commandRows(eventRows)) {
      if (known.has(normalizeCommand(row.cmd))) continue;
      corpus.push(row);
    }
    for (const row of fileRows(eventRows)) {
      if (known.has(normalizeCommand(row.cmd))) continue;
      known.add(normalizeCommand(row.cmd));
      corpus.push(row);
    }
  }

  const idf = documentFrequencies(keywords, keywordStems, corpus).map((df) => idfFor(df, corpus.length));
  // BM25 normalises by how long a row is relative to the corpus average, so a
  // verbose row no longer wins just by holding more chances to match.
  const lengths = corpus.map((row) => docLength(row));
  const average =
    lengths.length > 0 ? Math.max(1, Math.floor(lengths.reduce((a, b) => a + b, 0) / lengths.length)) : 1;
  const matched: Array<{ row: CorpusRow; strength: number; seq: number }> = [];
  const collect = (floorOverride?: number): Array<{ row: CorpusRow; strength: number; seq: number }> => {
    const found: Array<{ row: CorpusRow; strength: number; seq: number }> = [];
    corpus.forEach((row, seq) => {
      if (kind !== null && row.kind !== kind) return;
      if (wantedId !== null && row.evidenceId !== wantedId) return;
      if (!matchesTags(wantedTags, row)) return;
      const bonus = cmdBonus(cmdFilter, row);
      if (bonus === null) return;
      const words = keywordScore(
        keywords,
        keywordStems,
        alternates,
        alternateStems,
        row,
        idf,
        lengths[seq] ?? 0,
        average,
        floorOverride,
      );
      if (words === null) return;
      let weighted = row.kind === "command" || row.kind === "file" ? Math.floor(words / 2) : words;
      // A hint whose last observed outcome failed is demoted, not trusted.
      if (row.kind === "command" && row.lastOk === false) weighted = Math.floor(weighted / 2);
      found.push({ row, strength: weighted + bonus + usesBonus(row.uses), seq });
    });
    return found;
  };

  matched.push(...collect());
  let widened = false;
  // The widening ladder: when a long query shares two words with nothing, one
  // shared term still deserves an answer. The strict pass ran first, so this can
  // only add rows to an empty list — precision where it exists, recall where it
  // does not.
  if (matched.length === 0 && keywords.length >= MULTI_MATCH_FROM) {
    matched.push(...collect(1));
    widened = matched.length > 0;
  }

  matched.sort((a, b) => compareText(a.row.ts, b.row.ts) || a.seq - b.seq);
  const ranked = matched.map((item, recency) => toHit(item.row, item.strength, recency));
  ranked.sort((a, b) => b.strength - a.strength || b.recency - a.recency);
  // Collapse rewrites of one entry before the page is cut, so five restatements
  // of a decision cannot fill the answer. `matched` still counts every ranked
  // row; only the displayed page is deduped.
  const page = bounded === 0 ? [] : suppress(ranked.map((hit) => hit.text || hit.cmd), bounded);
  return {
    hits: page.map((index) => ranked[index] as RecallHit),
    scanned: corpus.length,
    matched: ranked.length,
    widened,
  };
}

/** Search the on-disk retained window. Does not create `.agent-guard/`. */
export function searchStore(cwd: string, query: RecallQuery = {}): RecallResult {
  // Read the events ledger only when a keyword query can use it. A cmd-only
  // filter cannot: cmdBonus narrows to evidence rows, so command/file hints
  // are excluded regardless (same rule as recall._cmd_bonus).
  const keywords = keywordsOf(query.query);
  const events = keywords.length > 0 ? readJsonl<unknown>(eventsPath(cwd)) : [];
  return searchRows(readJsonl<unknown>(journalPath(cwd)), readJsonl<unknown>(verifyRunsPath(cwd)), query, events);
}

function hitLine(hit: RecallHit, index: number): string {
  if (hit.kind === "command") {
    const uses = hit.uses > 1 ? ` · ran ${hit.uses}×` : "";
    const exitS = hit.lastExit === null ? "" : ` exit ${hit.lastExit}`;
    let outcome = "";
    if (hit.lastOk === true) outcome = ` · last ok${exitS}`;
    else if (hit.lastOk === false) outcome = ` · last FAILED${exitS} — change it before reuse`;
    const cmd = normalizeOneLine(hit.cmd, 120) || "(no command)";
    return `${index}. ${hit.provenance} · command · re-run to verify${uses}${outcome} · ${cmd}`;
  }
  if (hit.kind === "file") {
    const uses = hit.uses > 1 ? ` · used ${hit.uses}×` : "";
    const tool = normalizeOneLine(hit.tool ?? "tool", 24) || "tool";
    const key = normalizeOneLine(hit.cmd, 120) || "(no path)";
    const outcome = hit.lastOk === false ? " · last FAILED" : "";
    return `${index}. ${hit.provenance} · ${tool} · reuse${uses}${outcome} · ${key}`;
  }
  if (hit.kind === "evidence") {
    const evidenceId = normalizeOneLine(hit.evidenceId, 16) || "(no id)";
    const exit = hit.exitCode === null ? "" : ` · exit ${hit.exitCode}`;
    const cmd = normalizeOneLine(hit.cmd, 80) || "(no command)";
    return `${index}. ${hit.provenance} · evidence · ${evidenceId}${exit} · ${cmd}`;
  }
  const ts = normalizeOneLine(hit.ts, 32) || "unknown-time";
  const text = normalizeOneLine(hit.text, 160) || "(blank)";
  const tags = hit.tags.length > 0 ? ` [${hit.tags.join(",")}]` : "";
  return `${index}. ${hit.provenance} · ${hit.kind} · ${ts} · ${text}${tags}`;
}

function nudge(hits: RecallHit[], widened = false): string {
  if (hits.length === 0) {
    return "Nudge: nothing matched in the retained window — broaden the query or drop a filter.";
  }
  const prefix = widened ? "Widened: no entry shared two words, so these share one term. " : "";
  if (hits.some((hit) => hit.provenance === "agent")) {
    return `${prefix}Nudge: agent hits stay unverified — confirm them before acting; cite evidence ids.`;
  }
  return `${prefix}Nudge: cite evidence ids and re-read trusted hits before acting on them.`;
}

/** Compact hit list. The last line is always a Nudge. */
export function renderRecall(result: RecallResult): string {
  const header =
    result.matched > result.hits.length
      ? `PC recall · ${result.hits.length} of ${result.matched} hits · scanned ${result.scanned}`
      : `PC recall · ${result.hits.length} hits · scanned ${result.scanned}`;
  const lines = [header];
  result.hits.forEach((hit, index) => lines.push(hitLine(hit, index + 1)));
  lines.push(nudge(result.hits, result.widened));
  return lines.join("\n");
}

/** Trusted decision/correction/note rows, newest first, for the brief's tag recall. */
export function trustedRecallPool(journal: JournalEntry[]): JournalEntry[] {
  const pool: JournalEntry[] = [];
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (!entry || entry.type === "risk") continue;
    if (entry.type !== "decision" && entry.type !== "correction" && entry.type !== "note") continue;
    if (hasAgentTag(entry.tags)) continue;
    pool.push(entry);
  }
  return pool;
}
