/**
 * Journal (.agent-guard/journal.jsonl) — decisions/corrections/risks/notes
 * (SPEC §1 #6 #7, §2). No pi imports.
 */

import { appendJsonl, journalPath, readJsonl } from "./store.ts";
import { normalizeOneLine } from "./text.ts";

export type JournalType = "decision" | "correction" | "risk" | "note";

export interface JournalEntry {
  ts: string;
  type: JournalType;
  text: string;
  tags: string[];
}

export function isJournalType(v: unknown): v is JournalType {
  return v === "decision" || v === "correction" || v === "risk" || v === "note";
}

/** Free-text cap (chars): journal text is re-injected into briefs (goal #12). */
export const TEXT_CAP = 500;
export const TAG_COUNT_CAP = 8;
export const TAG_TEXT_CAP = 40;
/** Read-view bounds (mirror journal.READ_LIMIT_* in Python). */
export const READ_LIMIT_DEFAULT = 5;
export const READ_LIMIT_MAX = 20;

/** Replace terminal/control formatting, collapse whitespace and bound output. */
export function sanitizeJournalText(value: unknown, cap = TEXT_CAP): string {
  return normalizeOneLine(value, cap);
}

/** Clean, deduplicate and bound tags before they reach storage or a brief. */
export function sanitizeTags(tags: unknown): string[] {
  const clean: string[] = [];
  const seen = new Set<string>();
  const candidates = Array.isArray(tags) ? tags : typeof tags === "string" ? [tags] : [];
  for (const tag of candidates) {
    const value = sanitizeJournalText(tag, TAG_TEXT_CAP);
    if (value !== "" && !seen.has(value)) {
      clean.push(value);
      seen.add(value);
    }
    if (clean.length >= TAG_COUNT_CAP) break;
  }
  return clean;
}

/** Preserve a required provenance tag even when caller tags fill the cap. */
export function tagsWithRequired(
  tags: unknown,
  required: string,
): string[] {
  const requiredClean = sanitizeJournalText(required, TAG_TEXT_CAP);
  if (requiredClean === "") throw new Error("required journal tag must not be blank");
  const clean = sanitizeTags(tags).filter((tag) => tag !== requiredClean);
  return [...clean.slice(0, TAG_COUNT_CAP - 1), requiredClean];
}

export function appendJournal(
  cwd: string,
  entry: { type: JournalType; text: string; tags?: string[] },
): JournalEntry {
  const cleanText = sanitizeJournalText(entry.text);
  if (cleanText === "") throw new Error("journal text must not be blank");
  const full: JournalEntry = {
    ts: new Date().toISOString(),
    type: entry.type,
    text: cleanText,
    tags: sanitizeTags(entry.tags),
  };
  appendJsonl(journalPath(cwd), full);
  return full;
}

export function readJournal(cwd: string): JournalEntry[] {
  return readJsonl<JournalEntry>(journalPath(cwd));
}

/** Most recent trusted entries of one type, newest first. Model-authored
 * entries carry the reserved `agent` provenance tag and are never re-injected. */
export function recentTrustedEntries(
  journal: JournalEntry[],
  type: "decision" | "correction",
  n: number,
): JournalEntry[] {
  return journal
    .filter((e) => e.type === type && !sanitizeTags(e.tags).includes("agent"))
    .slice(-n)
    .reverse();
}

/** Entries the model wrote itself (reserved `agent` provenance tag).
 *
 * They are never trusted input, but they are the agent's own durable notes:
 * after a compaction the brief surfaces the newest few as explicitly
 * unverified, and `guard_journal` returns the full text on demand (SPEC §1 #6).
 * `risk` entries are excluded — they are telemetry, not memory. */
export function recentAgentEntries(journal: JournalEntry[], n: number): JournalEntry[] {
  // slice(-0) === slice(0) would return the WHOLE journal for n=0.
  if (!(n > 0)) return [];
  return journal
    .filter((entry) => entry.type !== "risk" && sanitizeTags(entry.tags).includes("agent"))
    .slice(-n)
    .reverse();
}
/** All trusted (non-`agent`) entries of one type, newest first. Used by the
 *  brief so its hidden-entry count reflects the whole journal, not a window. */
export function trustedEntries(
  journal: JournalEntry[],
  type: "decision" | "correction",
): JournalEntry[] {
  return recentTrustedEntries(journal, type, journal.length);
}

/** Bounded read limit (mirrors journal._bounded_limit: never negative, never
 *  unbounded). A model-supplied 0 yields no lines rather than a huge view. */
export function boundedReadLimit(limit: unknown): number {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : READ_LIMIT_DEFAULT;
  return Math.max(0, Math.min(value, READ_LIMIT_MAX));
}

/** Entries of one type (or all), oldest first — the read view's window. */
export function recentJournal(journal: JournalEntry[], limit: number, type?: JournalType): JournalEntry[] {
  const bounded = boundedReadLimit(limit);
  if (bounded === 0) return [];
  const filtered = type === undefined ? journal : journal.filter((entry) => entry.type === type);
  return filtered.slice(-bounded);
}

export function countJournal(journal: JournalEntry[], type?: JournalType): number {
  return type === undefined ? journal.length : journal.filter((entry) => entry.type === type).length;
}

/** Render a bounded one-line-per-entry journal view (same shape as
 *  journal.render_recent on the Python side, so both surfaces read alike). */
export function renderJournal(entries: JournalEntry[], total: number, type?: JournalType): string {
  const window = entries.slice(-READ_LIMIT_MAX);
  const scope = type === undefined ? "" : ` ${type}`;
  const lines = [`PC journal${scope} · last ${window.length} of ${Math.max(0, Math.trunc(total))}`];
  for (const entry of window) {
    const ts = normalizeOneLine(entry.ts, 32) || "unknown-time";
    const entryType = normalizeOneLine(entry.type, 16) || "unknown";
    const text = sanitizeJournalText(entry.text) || "(blank legacy entry)";
    const tags = sanitizeTags(entry.tags);
    lines.push(`${ts} · ${entryType} · ${text}${tags.length > 0 ? ` [${tags.join(",")}]` : ""}`);
  }
  lines.push("Nudge: re-read durable decisions and corrections before resuming work.");
  return lines.join("\n");
}

/** Most recent trusted corrections, newest first. */
export function recentCorrections(journal: JournalEntry[], n: number): JournalEntry[] {
  return recentTrustedEntries(journal, "correction", n);
}

/** Most recent trusted decisions, newest first. */
export function recentDecisions(journal: JournalEntry[], n: number): JournalEntry[] {
  return recentTrustedEntries(journal, "decision", n);
}
