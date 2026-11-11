/**
 * Journal (.agent-guard/journal.jsonl) — decisions/corrections/risks/notes
 * (SPEC §1 #6 #7, §2). No pi imports.
 */

import pino from "pino";

import { appendJsonl, journalPath, loadState, readJsonl, rewriteJsonl, saveState } from "./store.ts";
import { normalizeOneLine } from "./text.ts";

export type JournalType = "decision" | "correction" | "risk" | "note";

export interface JournalEntry {
  /** Stable, citable handle (jn-0007), the journal's equivalent of ev-0007. */
  id?: string;
  /** Join key to the events/evidence ledgers, mirroring journal.py. */
  session?: string | null;
  ts: string;
  type: JournalType;
  text: string;
  tags: string[];
  /** Correction only: the shell command that proves the rule still holds. The
   *  brief runs it (bounded, timed out) and labels HONORED / VIOLATED. */
  check?: string;
}

export function isJournalType(v: unknown): v is JournalType {
  return v === "decision" || v === "correction" || v === "risk" || v === "note";
}

/** Free-text cap (chars): journal text is re-injected into briefs (goal #12). */
// 500 silently cut 70% of this project's own journal mid-word (35/50 rows at
// the cap). 4000 keeps a full decision with its rationale; the brief stays
// bounded because only a few entries are re-injected.
export const TEXT_CAP = 4000;

/** Guard diagnostics on raw fd 2: tool output on stdout must stay clean for the
 * agent, and journal truncation used to be silent. */
const journalLog = pino({ level: "warn" }, pino.destination(2));
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
 * tags name what the owner actually expressed — wants, needs, preferences,
 * standing negations and "you are wrong" corrections — and `intent` renders the
 * profile with no query at all (mirrors journal.INTENT_TAGS in Python). */
export const INTENT_TAGS = [
  "owner-want",
  "owner-need",
  "owner-preference",
  "owner-constraint",
  "owner-correction",
] as const;
export type IntentTag = (typeof INTENT_TAGS)[number];

/** Tag the pi `input` handler writes for every substantive owner prompt. It
 *  names no kind, so a row carrying it is judged like owner-typed text and
 *  falls back to STATEMENT_KIND (2026-11-10 amendment). */
export const OWNER_PROMPT_TAG = "owner-prompt";
export const STATEMENT_KIND = "owner-statement";
/** Kinds the intent view renders. INTENT_TAGS are the tags detection writes;
 *  the statement kind exists only when reading. */
export const INTENT_KINDS = [...INTENT_TAGS, STATEMENT_KIND] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

const ATTR = "(?:owner|user)";
// `\s` before the verb, not `\b`: prose that names the tag itself ("tags:
// owner-want") is otherwise a false positive, because `\b` sits between
// "owner" and "-want" and "want" is a listed verb. The gap stops at clause
// punctuation for the same reason: "owner intent; the fix requires" is a
// sentence about the view, not a statement of intent.
const INTENT_PATTERNS: Record<IntentTag, RegExp> = {
  "owner-want": new RegExp(
    `\\b${ATTR}\\b[^.,;:!?]{0,40}\\s(?:wants?|wanted|asked(?: for)?|said|says|chose|chosen|approved|decided|told|took|insists?|expects?|requires?)\\b`,
  ),
  "owner-need": new RegExp(
    `\\b${ATTR}\\b[^.,;:!?]{0,40}\\s(?:needs?|needed|must|required|has to)\\b`,
  ),
  "owner-preference": new RegExp(
    `\\b${ATTR}\\b[^.,;:!?]{0,60}\\s(?:prefers?|preferred|rather|instead)\\b|\\bprefers?\\b`,
  ),
  "owner-constraint": new RegExp(
    `\\b${ATTR}\\s+(?:said|says|told\\s+me|asked)\\b[^.]{0,40}\\b(?:not\\s+to|never|don't|do\\s+not)\\b`,
  ),
  "owner-correction": new RegExp(
    `\\bcorrection\\s*\\(\\s*owner\\s*\\)|\\byou(?:'re| are| were)?\\s+(?:wrong|incorrect)\\b|\\b${ATTR}\\s+(?:said|says|told\\s+me)\\b[^.]{0,40}\\b(?:wrong|incorrect|mistake)\\b`,
  ),
};

/** Imperative verbs that start an owner request. The list is broad on purpose:
 *  the first version had 17 verbs, so "audit the plugin", "reinstall the venv"
 *  and "install many packages" were captured as prompts but detected as no
 *  intent at all (2026-11-10). */
const IMPERATIVE_VERBS =
  "add|audit|build|bump|change|check|clean|clone|commit|delete|document|drop|" +
  "ensure|explain|finish|fix|implement|install|investigate|keep|land|make|merge|" +
  "move|port|publish|pull|push|refactor|reinstall|reload|remove|rename|replace|" +
  "restart|revert|review|run|ship|split|test|update|use|vendor|verify|wire";
/** Owner prompts are imperative and often open with a connective ("now reload
 *  X", "then fix Y"); the lead-in must not hide the verb that names the ask. */
const LEAD_IN = "^(?:\\s*(?:please|now|then|also|and|next|first|so|ok|okay)\\b[,: ]*)*\\s*";
/** Double-quoted and backticked spans are quotations, not statements.
 *  「」/『』 are the Chinese equivalent of the quotation marks above. */
const QUOTED = /"[^"]*"|`[^`]*`|\u201c[^\u201d]*\u201d|\u300c[^\u300d]*\u300d|\u300e[^\u300f]*\u300f/g;

/** Extra patterns that only apply to text the owner typed (mirrors Python's
 * `_OWNER_AUTHORED`): a first-person want or a leading imperative is the
 * owner's own voice, so it needs no attribution noun. */
const OWNER_AUTHORED: Record<IntentTag, RegExp> = {
  "owner-want": new RegExp(
    `\\b(?:i|we)\\s+(?:want|wanted|would like|'d like|asked for|expect)\\b` +
      `|${LEAD_IN}(?:${IMPERATIVE_VERBS})\\b`,
  ),
  "owner-need": new RegExp(`\\b(?:i|we)\\s+(?:need|needs|must|have to|require)\\b`),
  "owner-preference": new RegExp(
    `\\b(?:i|we)\\s*(?:'d|would)?\\s*(?:prefer|rather)\\b|\\bprefer\\b|\\binstead\\b`,
  ),
  // A start-anchored negation is a standing instruction, not a correction of
  // past behaviour: "never commit to main", "do not touch the README".
  "owner-constraint": new RegExp(
    `${LEAD_IN}(?:do\\s+not|don'?t|never|avoid|always|must|stop|no\\s+more)\\b`,
  ),
  "owner-correction": new RegExp(
    `\\b(?:you|it|that|this)\\s+(?:is|was|are|were)\\s+(?:wrong|incorrect)\\b` +
      `|\\bthat'?s not what\\b|\\byou (?:broke|missed|forgot|ignored)\\b` +
      `|\\bdo not do that again\\b|\\bstop (?:doing|adding|guessing|re-?running)\\b`,
  ),
};

/** Chinese pattern set. Chinese has no word boundaries, so `\b` is meaningless
 *  and the English patterns never fired on the text the owner actually writes
 *  (measured 2026-11-11: 我要求…, 不要再…, 记住… all returned [] in both
 *  runtimes, so a 中文 correction was stored and then invisible to the intent
 *  view). Mirrors journal._CJK_INTENT_PATTERNS; keep the two in sync. */
const CJK_ATTR = "(?:我|我们|主人|用户)";
const CJK_LEAD_IN =
  "^(?:\\s*(?:请|麻烦|另外|然后|现在|接下来|还有|顺便|并且|同时)[,，、:： ]*)*\\s*";
const CJK_INTENT_PATTERNS: Record<IntentTag, RegExp> = {
  "owner-want": new RegExp(
    // The gap excludes 需: otherwise 我需要 (“I need”) reaches the bare 要 and
    // reports a want, which is the wrong kind (mirrors journal.py).
    `${CJK_ATTR}[^\\n。；;需]{0,20}?(?:要|想要|要求|希望|需要你|麻烦你|请你|帮我|替我)`,
  ),
  "owner-need": new RegExp(`${CJK_ATTR}[^\\n。；;]{0,20}?(?:需要|必须有|离不开)|需要你`),
  "owner-preference": new RegExp(
    `${CJK_ATTR}[^\\n。；;]{0,20}?(?:更喜欢|倾向|偏好)|最好|优先用|建议`,
  ),
  "owner-constraint": new RegExp(
    `${CJK_ATTR}[^\\n。；;]{0,20}?(?:不要|别|禁止|不得|不能|必须|只能|只允许|一律|永远)`,
  ),
  "owner-correction": new RegExp(
    `(?:你|这|那|刚才|上面|前面)[^\\n。；;]{0,12}?(?:错了|不对|不是这样|搞错|理解错|弄错)` +
      `|纠正|我说的是|我指的是|别再`,
  ),
};
/** Bare 中文 imperatives that only count for text the owner typed (mirrors
 *  `_CJK_OWNER_AUTHORED`): a bare 必须/不要 in agent prose is the agent's own
 *  instruction, not the owner's. */
const CJK_OWNER_AUTHORED: Record<IntentTag, RegExp> = {
  "owner-want": new RegExp(`我要|我想要|我希望|我要求|我想|请你|麻烦你|帮我|替我|给我`),
  "owner-need": new RegExp(`我需要|必须有|需要你|务必`),
  "owner-preference": new RegExp(`最好|优先|建议|我喜欢|我倾向|我更喜欢|沿用`),
  "owner-constraint": new RegExp(
    `${CJK_LEAD_IN}(?:不要|别|禁止|不得|必须|务必|只能|只允许|一律|永远不要|绝不要)`,
  ),
  "owner-correction": new RegExp(`错了|不对|不是这样|搞错|理解错|弄错|纠正|我说的是|我指的是|别再`),
};

/** The owner-intent tags the text expresses, in INTENT_TAGS order.
 *
 * Deterministic and query-free. Attribution is required for wants/needs (an
 * agent's own "I want to check" is not owner intent); a bare "prefer" counts
 * because the owner writes it that way.
 *
 * `ownerAuthored` relaxes the attribution requirement for text the owner typed
 * themselves (the pi `input` event), so a paraphrase with no owner/user noun —
 * "ship it faster" — is still captured. Only pass true for owner-typed text.
 *
 * Quoted text is blanked first: an entry that quotes the owner's words (or an
 * example string) is *about* intent, not an expression of it — the false
 * positive that pushed agent prose into the view the view exists to protect
 * (2026-11-10).
 *
 * Chinese is matched by a parallel pattern set (CJK_INTENT_PATTERNS /
 * CJK_OWNER_AUTHORED) because there is no word boundary to anchor on. Both sets
 * are consulted per tag, so the result order stays INTENT_TAGS order. */
export function detectIntent(text: unknown, ownerAuthored = false): IntentTag[] {
  const folded = normalizeOneLine(text, TEXT_CAP).toLowerCase().replace(QUOTED, " ");
  return INTENT_TAGS.filter(
    (tag) =>
      INTENT_PATTERNS[tag].test(folded) ||
      CJK_INTENT_PATTERNS[tag].test(folded) ||
      (ownerAuthored &&
        (OWNER_AUTHORED[tag].test(folded) || CJK_OWNER_AUTHORED[tag].test(folded))),
  );
}

/** Kinds of owner intent a row carries (tags first, then text detection).
 *
 * An `owner-prompt` row is the owner's own words, so it is judged like
 * owner-typed text (no attribution noun needed) and always counts: when no
 * want/need/preference/constraint/correction pattern matches, the row is still
 * an owner statement. Without this the literal request was journaled trusted
 * and then invisible to `guard_intent` — captured, not tellable (2026-11-10).
 *
 * The tag is self-describing, so an agent-written row can carry it by accident
 * (or on purpose). `owner-prompt` therefore only counts on a row without the
 * reserved `agent` tag: provenance outranks the claim, and a model note must
 * never borrow the owner-typed relaxation. */
function intentOf(entry: JournalEntry): IntentKind[] {
  const tags = new Set(
    tagCandidates(entry.tags).map((tag) => normalizeOneLine(tag, TAG_TEXT_CAP).toLowerCase()),
  );
  const ownerPrompt = tags.has(OWNER_PROMPT_TAG) && !hasAgentTag(entry.tags);
  const detected = new Set<string>(detectIntent(entry.text, ownerPrompt));
  const kinds = INTENT_TAGS.filter((tag) => tags.has(tag) || detected.has(tag));
  if (kinds.length === 0 && ownerPrompt) return [STATEMENT_KIND];
  return kinds;
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

function nextJournalSeq(cwd: string, existing: JournalEntry[]): number {
  const state = loadState(cwd);
  let current = (state?.counters as Record<string, number | string> | undefined)?.journal_seq;
  if (typeof current !== "number" || !Number.isInteger(current)) {
    current = existing.reduce((high, row) => {
      const raw = typeof row.id === "string" ? row.id : "";
      const n = raw.startsWith("jn-") ? Number.parseInt(raw.slice(3), 10) : Number.NaN;
      return Number.isInteger(n) ? Math.max(high, n) : high;
    }, 0);
  }
  const seq = (current as number) + 1;
  if (state) {
    state.counters = { ...state.counters, journal_seq: seq };
    saveState(cwd, state);
  }
  return seq;
}

/** One-shot repair: give every legacy row an id, in file order. Mirrors
 *  journal._ensure_ids — numbering the ledger in file order is the only
 *  assignment that cannot reorder history, and it is a no-op afterwards. */
function ensureIds(cwd: string): void {
  const rows = readJournal(cwd);
  if (rows.length === 0 || rows.every((row) => typeof row.id === "string" && row.id !== "")) return;
  const repaired = rows.map((row, index) => ({ ...row, id: `jn-${String(index + 1).padStart(4, "0")}` }));
  rewriteJsonl(journalPath(cwd), repaired);
  const state = loadState(cwd);
  if (state) {
    state.counters = { ...state.counters, journal_seq: repaired.length };
    saveState(cwd, state);
  }
}

/** A check is one shell command, not a script: one line, bounded length. */
export const CHECK_CAP = 200;

export function appendJournal(
  cwd: string,
  entry: {
    type: JournalType;
    text: string;
    tags?: string[];
    session?: string | null;
    check?: string | null;
  },
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
  // A check proves a correction; anywhere else it would execute with nothing to
  // prove (mirrors journal.add).
  const cleanCheck = entry.check === null || entry.check === undefined
    ? ""
    : sanitizeJournalText(entry.check, CHECK_CAP);
  if (cleanCheck !== "" && entry.type !== "correction") {
    throw new Error("check applies to a correction");
  }
  const supplied = typeof entry.text === "string" ? entry.text.length : 0;
  if (supplied > cleanText.length) {
    journalLog.warn(
      { supplied, kept: cleanText.length, cap: TEXT_CAP },
      "journal text truncated to TEXT_CAP",
    );
  }
  // The display cap must never drop provenance: a row written as an agent note
  // stays unverified even when the caller's tag list overflows.
  // Repair legacy rows before allocating so ids stay chronological.
  ensureIds(cwd);
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
    id: `jn-${String(nextJournalSeq(cwd, readJournal(cwd))).padStart(4, "0")}`,
    session: entry.session ?? null,
    text: cleanText,
    tags: mergeIntentTags(cleanText, tags),
    ...(cleanCheck === "" ? {} : { check: cleanCheck }),
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
  kinds: IntentKind[];
}

/** Owner-intent rows (oldest first, like every journal view) plus counts.
 *
 * A row counts when it carries an owner-intent tag, the `owner-prompt` tag
 * (always a statement), or when its text detects as owner intent, so rows
 * written before this view existed are still captured. `counts` covers every
 * row, not the page, so a bounded render never lies about how much the owner
 * asked for. */
/** Every row that expresses owner intent, oldest first, UNCAPPED.
 *
 * `intentWithTotal` pages the read view at READ_LIMIT_MAX; the brief needs the
 * full length so `+N more owner statements` counts every hidden row instead of
 * the untouched part of a 20-row page (2026-11-10 cross-runtime check). */
export function intentClassified(journal: JournalEntry[]): IntentRow[] {
  const classified: IntentRow[] = [];
  for (const entry of journal) {
    if (entry === null || typeof entry !== "object") continue;
    const kinds = intentOf(entry);
    if (kinds.length > 0) classified.push({ entry, kinds });
  }
  return classified;
}

export function intentWithTotal(
  journal: JournalEntry[],
  limit: number,
): { rows: IntentRow[]; total: number; counts: Record<IntentKind | "owner" | "agent", number> } {
  const classified = intentClassified(journal);
  const counted: Record<IntentKind | "owner" | "agent", number> = Object.fromEntries(
    INTENT_KINDS.map((tag) => [tag, classified.filter((row) => row.kinds.includes(tag)).length]),
  ) as Record<IntentKind | "owner" | "agent", number>;
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
  counts: Record<IntentKind | "owner" | "agent", number>,
): string {
  const shown = rows.slice(-READ_LIMIT_MAX);
  const countsText = INTENT_KINDS.map(
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
