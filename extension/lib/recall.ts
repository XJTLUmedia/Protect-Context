/**
 * Local recall over the retained journal and evidence window.
 *
 * Readers use readJsonl, so the live ledger plus up to three rotated segments
 * are concatenated oldest-first — the same window every other reader sees.
 * No embeddings and no extra index.
 *
 * Filters combine with AND. Keywords are AND across the query and OR across
 * text, cmd, and digest; a keyword that is itself an evidence id (`ev-NNNN`)
 * also matches that id. Tags are exact, case-insensitive, and AND. Evidence
 * rows have no tags, so a tag filter excludes them.
 *
 * Ranking is match strength, then recency. Journal hits tagged `agent` stay
 * unverified; every other journal hit and every evidence row is trusted.
 *
 * Keep the weights and filter rules aligned with src/protect_context/recall.py.
 */

import { normalizeCommand } from "./fingerprint.ts";
import { isJournalType, sanitizeTags, type JournalEntry } from "./journal.ts";
import { journalPath, readJsonl, verifyRunsPath } from "./store.ts";
import { normalizeOneLine } from "./text.ts";

export const RECALL_TYPES = ["decision", "correction", "risk", "note", "evidence"] as const;
export type RecallType = (typeof RECALL_TYPES)[number];
export const LIMIT_DEFAULT = 5;
export const LIMIT_MAX = 20;
const MAX_KEYWORDS = 12;
const QUERY_CAP = 500;

const TEXT_WEIGHT = 3;
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
  strength: number;
  recency: number;
}

export interface RecallResult {
  hits: RecallHit[];
  scanned: number;
  matched: number;
}

interface CorpusRow {
  source: "journal" | "evidence";
  kind: string;
  text: string;
  cmd: string;
  digest: string;
  ts: string;
  tags: string[];
  evidenceId: string | null;
  exitCode: number | null;
  provenance: "trusted" | "agent";
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

function keywordsOf(query: unknown): string[] {
  if (query === undefined || query === null) return [];
  if (typeof query !== "string") throw new RecallError("recall query must be a string");
  const raw = normalizeOneLine(query, QUERY_CAP).toLowerCase();
  const found: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(" ")) {
    if (part === "" || seen.has(part)) continue;
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

function keywordScore(keywords: string[], row: CorpusRow): number | null {
  if (keywords.length === 0) return 0;
  const text = row.text.toLowerCase();
  const cmd = row.cmd.toLowerCase();
  const digest = row.digest.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    let hit = 0;
    if (text.includes(keyword)) hit += TEXT_WEIGHT;
    if (cmd.includes(keyword)) hit += CMD_WEIGHT;
    if (digest.includes(keyword)) hit += DIGEST_WEIGHT;
    const canonical = canonicalEvidenceId(keyword);
    if (canonical !== null && canonical === row.evidenceId) hit += ID_WEIGHT;
    if (hit === 0) return null;
    score += hit;
  }
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
    strength,
    recency,
  };
}

/** Rank already-loaded rows. Does not touch the filesystem. */
export function searchRows(journalRows: unknown[], evidenceRows: unknown[], query: RecallQuery = {}): RecallResult {
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

  const matched: Array<{ row: CorpusRow; strength: number; seq: number }> = [];
  corpus.forEach((row, seq) => {
    if (kind !== null && row.kind !== kind) return;
    if (wantedId !== null && row.evidenceId !== wantedId) return;
    if (!matchesTags(wantedTags, row)) return;
    const bonus = cmdBonus(cmdFilter, row);
    if (bonus === null) return;
    const words = keywordScore(keywords, row);
    if (words === null) return;
    matched.push({ row, strength: words + bonus, seq });
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
  return searchRows(readJsonl<unknown>(journalPath(cwd)), readJsonl<unknown>(verifyRunsPath(cwd)), query);
}

function hitLine(hit: RecallHit, index: number): string {
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
