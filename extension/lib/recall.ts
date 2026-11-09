/**
 * Local recall over the retained journal and evidence window.
 *
 * Readers use readJsonl, so the live ledger plus up to three rotated segments
 * are concatenated oldest-first — the same window every other reader sees.
 * No embeddings and no extra index.
 *
 * Filters combine with AND. Keywords rank by how many of them hit, because a
 * query is a paraphrase rather than an exact string: common English stopwords
 * are dropped, and a query of three or more keywords needs two real matches.
 * Each keyword matches across text, cmd, and digest; a keyword that is itself
 * an evidence id (`ev-NNNN`) also matches that id. Tags are exact,
 * case-insensitive, and AND. Evidence rows have no tags, so a tag filter
 * excludes them.
 *
 * A query also reaches past bash commands from the events ledger (`command`
 * rows, successful calls only, one row per fingerprint, half weight), so a
 * repeated task can reuse the exact command that solved it before.
 *
 * Ranking is match strength, then recency. Journal hits tagged `agent` stay
 * unverified; every other journal hit and every evidence row is trusted.
 *
 * Keep the weights and filter rules aligned with src/protect_context/recall.py.
 */

import { normalizeCommand } from "./fingerprint.ts";
import { isJournalType, sanitizeTags, type JournalEntry } from "./journal.ts";
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
}

/** Tools whose rows are shell runs; every other tool leaves a reuse key. */
const SHELL_TOOLS = new Set(["bash", "guard_verify"]);

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

function isAgent(tags: string[]): boolean {
  // Exact reserved tag, same as the journal's trusted selectors. Do not stop
  // at the display cap: a legacy row can carry `agent` past the first tags.
  return tags.some((tag) => normalizeOneLine(tag, 40) === "agent");
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
    provenance: isAgent(tags) ? "agent" : "trusted",
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
 * Successful bash calls from the events ledger, one row per command family.
 * A refused (`ok === false`) call is not a proven recipe, so it is skipped.
 */
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

function commandRows(events: unknown[]): CorpusRow[] {
  const grouped = new Map<string, CorpusRow>();
  const pending = new Map<string, string>(); // session -> latest unpaired call
  for (const row of events) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const session = typeof record.session === "string" ? record.session : "";
    if (record.kind === "tool_result") {
      const key = pending.get(session);
      pending.delete(session);
      const seen = key === undefined ? undefined : grouped.get(key);
      if (seen) {
        seen.lastOk = typeof record.ok === "boolean" ? record.ok : null;
        seen.lastExit =
          typeof record.exit === "number" && Number.isFinite(record.exit) ? Math.trunc(record.exit) : null;
      }
      continue;
    }
    if (record.kind !== "tool_call") continue;
    if (record.ok === false) continue;
    if (typeof record.cmd !== "string" || record.cmd.trim() === "") continue;
    const key = normalizeCommand(record.cmd);
    if (key === "") continue;
    pending.set(session, key);
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
  let start = 0;
  for (;;) {
    const idx = folded.indexOf(keyword, start);
    if (idx < 0) return false;
    if (idx === 0) return true;
    const code = folded.charCodeAt(idx - 1);
    const alnum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (!alnum) return true;
    start = idx + 1;
  }
}

/** Unweighted hit strength for one keyword against one row. */
function rawHit(keyword: string, canonical: string | null, row: CorpusRow): number {
  let hit = 0;
  if (wordHit(row.text, keyword)) hit += TEXT_WEIGHT;
  if (row.tags.some((tag) => wordHit(tag, keyword))) hit += TAG_WEIGHT;
  if (wordHit(row.cmd, keyword)) hit += CMD_WEIGHT;
  if (wordHit(row.digest, keyword)) hit += DIGEST_WEIGHT;
  if (canonical !== null && canonical === row.evidenceId) hit += ID_WEIGHT;
  return hit;
}

/**
 * Rarity multiplier in thousandths, clamped to [1x, 8x]. Integer math only, so
 * this matches Python's recall._idf exactly.
 */
function idfFor(df: number, total: number): number {
  if (df <= 0) return 1000;
  const scaled = Math.floor((total * 1000) / df);
  return Math.max(1000, Math.min(scaled, 8000));
}

function documentFrequencies(keywords: string[], corpus: CorpusRow[]): number[] {
  const counts = keywords.map(() => 0);
  for (const row of corpus) {
    keywords.forEach((keyword, index) => {
      if (rawHit(keyword, canonicalEvidenceId(keyword), row) > 0) counts[index] = (counts[index] ?? 0) + 1;
    });
  }
  return counts;
}

/** Rarity-weighted partial-match score, or null when the row is too weak. */
function keywordScore(keywords: string[], row: CorpusRow, idf: number[]): number | null {
  if (keywords.length === 0) return 0;
  let score = 0;
  let hits = 0;
  let tagHit = false;
  keywords.forEach((keyword, index) => {
    const raw = rawHit(keyword, canonicalEvidenceId(keyword), row);
    if (raw === 0) return;
    hits += 1;
    if (row.tags.some((tag) => wordHit(tag, keyword))) tagHit = true;
    score += Math.floor((raw * (idf[index] ?? 1000)) / 1000);
  });
  const floor = keywords.length < MULTI_MATCH_FROM ? 1 : MULTI_MATCH_FLOOR;
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
    uses: row.uses ?? 0,
    lastOk: row.lastOk ?? null,
    lastExit: row.lastExit ?? null,
    tool: row.tool ?? "",
    strength,
    recency,
  };
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

  const idf = documentFrequencies(keywords, corpus).map((df) => idfFor(df, corpus.length));
  const matched: Array<{ row: CorpusRow; strength: number; seq: number }> = [];
  corpus.forEach((row, seq) => {
    if (kind !== null && row.kind !== kind) return;
    if (wantedId !== null && row.evidenceId !== wantedId) return;
    if (!matchesTags(wantedTags, row)) return;
    const bonus = cmdBonus(cmdFilter, row);
    if (bonus === null) return;
    const words = keywordScore(keywords, row, idf);
    if (words === null) return;
    let weighted = row.kind === "command" || row.kind === "file" ? Math.floor(words / 2) : words;
    // A hint whose last observed outcome failed is demoted, not trusted.
    if (row.kind === "command" && row.lastOk === false) weighted = Math.floor(weighted / 2);
    matched.push({ row, strength: weighted + bonus, seq });
  });

  matched.sort((a, b) => a.row.ts.localeCompare(b.row.ts) || a.seq - b.seq);
  const ranked = matched.map((item, recency) => toHit(item.row, item.strength, recency));
  ranked.sort((a, b) => b.strength - a.strength || b.recency - a.recency);
  return {
    hits: bounded === 0 ? [] : ranked.slice(0, bounded),
    scanned: corpus.length,
    matched: ranked.length,
  };
}

/** Search the on-disk retained window. Does not create `.agent-guard/`. */
export function searchStore(cwd: string, query: RecallQuery = {}): RecallResult {
  const events = query.query !== undefined && query.query !== "" ? readJsonl<unknown>(eventsPath(cwd)) : [];
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

function nudge(hits: RecallHit[]): string {
  if (hits.length === 0) {
    return "Nudge: nothing matched in the retained window — broaden the query or drop a filter.";
  }
  if (hits.some((hit) => hit.provenance === "agent")) {
    return "Nudge: agent hits stay unverified — confirm them before acting; cite evidence ids.";
  }
  return "Nudge: cite evidence ids and re-read trusted hits before acting on them.";
}

/** Compact hit list. The last line is always a Nudge. */
export function renderRecall(result: RecallResult): string {
  const header =
    result.matched > result.hits.length
      ? `PC recall · ${result.hits.length} of ${result.matched} hits · scanned ${result.scanned}`
      : `PC recall · ${result.hits.length} hits · scanned ${result.scanned}`;
  const lines = [header];
  result.hits.forEach((hit, index) => lines.push(hitLine(hit, index + 1)));
  lines.push(nudge(result.hits));
  return lines.join("\n");
}

/** Trusted decision/correction/note rows, newest first, for the brief's tag recall. */
export function trustedRecallPool(journal: JournalEntry[]): JournalEntry[] {
  const pool: JournalEntry[] = [];
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (!entry || entry.type === "risk") continue;
    if (entry.type !== "decision" && entry.type !== "correction" && entry.type !== "note") continue;
    if (sanitizeTags(entry.tags).includes("agent")) continue;
    pool.push(entry);
  }
  return pool;
}
