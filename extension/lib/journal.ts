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

/** Raw tag candidates, before the display cap: provenance must not be missed
 *  when a legacy row carries many tags. */
function tagCandidates(tags: unknown): unknown[] {
  return Array.isArray(tags) ? tags : typeof tags === "string" ? [tags] : [];
}

/** True when the reserved `agent` provenance tag is present.
 *
 * Case-insensitive and unbounded, mirroring recall._tag_key / _is_agent on the
 * Python side: a stored `Agent` tag must be both filterable and labelled
 * unverified instead of being promoted into a trusted brief section. */
export function hasAgentTag(tags: unknown): boolean {
  return tagCandidates(tags).some(
    (tag) => normalizeOneLine(tag, TAG_TEXT_CAP).toLowerCase() === "agent",
  );
}

/** Owner intent (SPEC §1 #6/#7). The journal already keeps the owner's words,
 * but a new session has to guess how they were phrased to find them. These
 * four tags name what the owner actually expressed — wants, needs, preferences
 * and "you are wrong" corrections — and `intent` renders the profile with no
 * query at all (mirrors journal.INTENT_TAGS in Python). */
export const INTENT_TAGS = [
  "owner-want",
  "owner-need",
  "owner-preference",
  "owner-correction",
] as const;
export type IntentTag = (typeof INTENT_TAGS)[number];

const ATTR = "(?:owner|user)";
const INTENT_PATTERNS: Record<IntentTag, RegExp> = {
  "owner-want": new RegExp(
    `\\b${ATTR}\\b[^.]{0,40}\\b(?:wants?|wanted|asked(?: for)?|said|says|chose|chosen|approved|decided|told|took|insists?|expects?|requires?)\\b`,
  ),
  "owner-need": new RegExp(`\\b${ATTR}\\b[^.]{0,40}\\b(?:needs?|needed|must|required|has to)\\b`),
  "owner-preference": new RegExp(
    `\\b${ATTR}\\b[^.]{0,60}\\b(?:prefers?|preferred|rather|instead)\\b|\\bprefers?\\b`,
  ),
  "owner-correction": new RegExp(
    `\\bcorrection\\s*\\(\\s*owner\\s*\\)|\\byou(?:'re| are| were)?\\s+(?:wrong|incorrect)\\b|\\b${ATTR}\\s+(?:said|says|told\\s+me)\\b[^.]{0,40}\\b(?:wrong|incorrect|mistake)\\b`,
  ),
};

/** Extra patterns that only apply to text the owner typed (mirrors Python's
 * `_OWNER_AUTHORED`): a first-person want or a leading imperative is the
 * owner's own voice, so it needs no attribution noun. */
const OWNER_AUTHORED: Record<IntentTag, RegExp> = {
  "owner-want": new RegExp(
    `\\b(?:i|we)\\s+(?:want|wanted|would like|'d like|asked for|expect)\\b` +
      `|^\\s*(?:please\\s+)?(?:fix|add|build|implement|change|make|use|remove|rename|update|ensure|keep|drop|replace|ship|finish|land|wire|port)\\b`,
  ),
  "owner-need": new RegExp(`\\b(?:i|we)\\s+(?:need|needs|must|have to|require)\\b`),
  "owner-preference": new RegExp(
    `\\b(?:i|we)\\s*(?:'d|would)?\\s*(?:prefer|rather)\\b|\\bprefer\\b|\\binstead\\b`,
  ),
  "owner-correction": new RegExp(
    `\\b(?:you|it|that|this)\\s+(?:is|was|are|were)\\s+(?:wrong|incorrect)\\b` +
      `|\\bthat'?s not what\\b|\\byou (?:broke|missed|forgot|ignored)\\b` +
      `|\\bdo not do that again\\b|\\bstop (?:doing|adding|guessing|re-?running)\\b`,
  ),
};

/** The owner-intent tags the text expresses, in INTENT_TAGS order.
 *
 * Deterministic and query-free. Attribution is required for wants/needs (an
 * agent's own "I want to check" is not owner intent); a bare "prefer" counts
 * because the owner writes it that way.
 *
 * `ownerAuthored` relaxes the attribution requirement for text the owner typed
 * themselves (the pi `input` event), so a paraphrase with no owner/user noun —
 * "ship it faster" — is still captured. Only pass true for owner-typed text. */
export function detectIntent(text: unknown, ownerAuthored = false): IntentTag[] {
  const folded = normalizeOneLine(text, TEXT_CAP).toLowerCase();
  return INTENT_TAGS.filter(
    (tag) =>
      INTENT_PATTERNS[tag].test(folded) ||
      (ownerAuthored && OWNER_AUTHORED[tag].test(folded)),
  );
}

/** Explicit owner-intent tags plus text detection (covers legacy rows). */
function intentOf(entry: JournalEntry): IntentTag[] {
  const tags = new Set(
    tagCandidates(entry.tags).map((tag) => normalizeOneLine(tag, TAG_TEXT_CAP).toLowerCase()),
  );
  const detected = new Set<string>(detectIntent(entry.text));
  return INTENT_TAGS.filter((tag) => tags.has(tag) || detected.has(tag));
}

/** Tag a captured owner intent so a future session can find it by tag.
 *
 * The reserved `agent` provenance tag keeps the last slot, exactly like
 * tagsWithRequired: a capped list must never drop provenance and promote a
 * model note to trusted memory. */
function mergeIntentTags(text: string, tags: string[]): string[] {
  const present = new Set(tags.map((tag) => tag.toLowerCase()));
  const missing = detectIntent(text).filter((tag) => !present.has(tag));
  if (missing.length === 0) return tags;
  const provenance = tags.filter((tag) => tag.toLowerCase() === "agent");
  const rest = tags.filter((tag) => tag.toLowerCase() !== "agent");
  const room = Math.max(0, TAG_COUNT_CAP - provenance.length);
  return [...[...missing, ...rest].slice(0, room), ...provenance];
}

/** Clean, deduplicate and bound tags before they reach storage or a brief. */
export function sanitizeTags(tags: unknown): string[] {
  const clean: string[] = [];
  const seen = new Set<string>();
  const candidates = tagCandidates(tags);
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
  // Runtime validation, not just the type: tool parameters can arrive as
  // unvalidated strings, and a row with an unknown type is ignored by every
  // reader on both runtimes (mirrors journal._validate_type).
  if (!isJournalType(entry.type)) {
    throw new Error(
      `unknown journal type ${JSON.stringify(entry.type)}; use one of decision, correction, risk, note`,
    );
  }
  const cleanText = sanitizeJournalText(entry.text);
  if (cleanText === "") throw new Error("journal text must not be blank");
  // The display cap must never drop provenance: a row written as an agent note
  // stays unverified even when the caller's tag list overflows.
  let tags = sanitizeTags(entry.tags);
  const suppliedAgent = tagCandidates(entry.tags).some(
    (tag) => normalizeOneLine(tag, TAG_TEXT_CAP).toLowerCase() === "agent",
  );
  if (suppliedAgent && !tags.some((tag) => tag.toLowerCase() === "agent")) {
    tags = [...tags.slice(0, TAG_COUNT_CAP - 1), "agent"];
  }
  const full: JournalEntry = {
    ts: new Date().toISOString(),
    type: entry.type,
    text: cleanText,
    tags: mergeIntentTags(cleanText, tags),
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
  // slice(-0) === slice(0) would return the WHOLE journal for n=0.
  if (!(n > 0)) return [];
  return journal
    .filter((e) => e.type === type && !hasAgentTag(e.tags))
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
    .filter((entry) => entry.type !== "risk" && hasAgentTag(entry.tags))
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

export interface IntentRow {
  entry: JournalEntry;
  kinds: IntentTag[];
}

/** Owner-intent rows (oldest first, like every journal view) plus counts.
 *
 * A row counts when it carries an `owner-*` tag or when its text detects as
 * owner intent, so rows written before this view existed are still captured.
 * `counts` covers every row, not the page, so a bounded render never lies
 * about how much the owner asked for. */
export function intentWithTotal(
  journal: JournalEntry[],
  limit: number,
): { rows: IntentRow[]; total: number; counts: Record<IntentTag | "owner" | "agent", number> } {
  const classified: IntentRow[] = [];
  for (const entry of journal) {
    if (entry === null || typeof entry !== "object") continue;
    const kinds = intentOf(entry);
    if (kinds.length > 0) classified.push({ entry, kinds });
  }
  const counted: Record<IntentTag | "owner" | "agent", number> = Object.fromEntries(
    INTENT_TAGS.map((tag) => [tag, classified.filter((row) => row.kinds.includes(tag)).length]),
  ) as Record<IntentTag | "owner" | "agent", number>;
  // Provenance split: how much of the profile is the owner's own record and how
  // much the agent's report of it. Without it a page of [agent] lines reads as
  // owner authority.
  counted.owner = classified.filter((row) => !hasAgentTag(row.entry.tags)).length;
  counted.agent = classified.length - counted.owner;
  const bounded = Math.max(0, Math.min(Math.trunc(limit) || 0, READ_LIMIT_MAX));
  const rows = bounded === 0 ? [] : classified.slice(-bounded);
  return { rows, total: classified.length, counts: counted };
}

/** One line per owner statement, newest first, with per-kind counts. */
export function renderIntent(
  rows: IntentRow[],
  total: number,
  counts: Record<IntentTag | "owner" | "agent", number>,
): string {
  const shown = rows.slice(-READ_LIMIT_MAX);
  const countsText = INTENT_TAGS.map(
    (tag) => `${tag.slice("owner-".length)} ${counts[tag] ?? 0}`,
  ).join(" · ");
  const lines = [
    `PC intent · ${shown.length} of ${Math.max(0, Math.trunc(total))} owner statements · ${countsText} · owner ${counts.owner ?? 0} · agent ${counts.agent ?? 0}`,
  ];
  for (const { entry, kinds } of [...shown].reverse()) {
    const ts = normalizeOneLine(entry.ts, 32) || "unknown-time";
    const text = normalizeOneLine(entry.text, 160) || "(blank legacy entry)";
    const provenance = hasAgentTag(entry.tags) ? "agent" : "owner";
    lines.push(`${kinds[0]} · ${ts} · ${text} [${provenance}]`);
  }
  if (shown.length === 0) {
    const hint = total > 0 ? "raise the limit" : "capture one with guard_note";
    lines.push(`Nudge: no owner statement shown — ${hint}.`);
  } else {
    lines.push(
      "Nudge: re-read the owner's wants, needs and corrections before acting; agent lines stay unverified.",
    );
  }
  return lines.join("\n");
}
