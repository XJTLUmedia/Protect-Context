/**
 * Compact pre-agent brief (SPEC §5 before_agent_start) and digest helper.
 * Pure logic — no pi imports.
 */

import { createHash } from "node:crypto";
import type { Constraint } from "./defaults.ts";
import type { LoopInfo } from "./loops.ts";
import { normalizeOneLine, trunc } from "./text.ts";

export function sha1Hex(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

export interface BriefInput {
  /** Owner-stated task captured for this project (SPEC §1 #6): the request that
   *  a compaction summary is most likely to have paraphrased away. */
  task?: string | null;
  contract: Constraint[];
  /** Most recent trusted decisions, newest first (already sliced). */
  decisions?: Array<{ type: string; text: string; tags: string[] }>;
  /** Most recent corrections, newest first (already sliced). */
  corrections: Array<{ type: string; text: string; tags: string[] }>;
  /** Most recent model-written entries, newest first. Shown as explicitly
   *  unverified: they are the agent's own notes, never owner authority. */
  agentNotes?: Array<{ type: string; text: string; tags: string[] }>;
  /** Trusted decision/correction/note rows, newest first. At most
   *  BRIEF_MAX_RECALL are injected when a tag matches the owner task and the
   *  entry is not already visible in the capped sections. */
  recallPool?: Array<{ type: string; text: string; tags: string[] }>;
  loops: LoopInfo[];
  lastEvidence: { id: string; exit: number; cmd: string; ms: number | null } | null;
}

export const BRIEF_MAX_CONTRACT_LINES = 12;
export const BRIEF_MAX_DECISIONS = 3;
export const BRIEF_MAX_CORRECTIONS = 3;
export const BRIEF_MAX_AGENT_NOTES = 2;
export const BRIEF_MAX_LOOPS = 2;
/** Trusted tag matches injected when the owner task names a journal tag the caps hid. */
export const BRIEF_MAX_RECALL = 2;
/** Owner task display cap (chars). */
export const TASK_DISPLAY_MAX = 200;
/** Agent-note display cap (chars) — shorter than a trusted entry on purpose. */
export const AGENT_NOTE_DISPLAY_MAX = 120;
/** Command display cap (chars) — matches Python's cmd[:60] discipline. */
export const CMD_DISPLAY_MAX = 60;

/** One-line cap for brief snippets: collapse whitespace, then truncate with an
 *  ellipsis. Model-supplied text must never bloat the re-injected brief (goal #12). */
export function truncLine(s: unknown, max = 200): string {
  // Normalize before applying the display ellipsis. The normalizer gets a
  // generous pre-cap so trunc(), rather than an invisible hard slice, marks
  // ordinary overlong text.
  return trunc(normalizeOneLine(s, Math.max(max + 1, 10_000)), max);
}

function isTrustedOwnerConstraint(c: Constraint): boolean {
  return c.source === "owner" || c.source === "user";
}

/**
 * Select the constraints that can enter the frozen 12-line brief cap.
 *
 * Authority is more important than append order: newest explicit owner/user
 * constraints come first, then the frozen seed contract, and only then other
 * (including agent-authored) entries. Consequently an agent entry can never
 * crowd a seed constraint out of the brief. Stable source indexes break ties
 * when the day-only `added` field is identical.
 */
export function selectBriefConstraints(contract: Constraint[]): Constraint[] {
  const indexed = contract.map((constraint, index) => ({ constraint, index }));
  const owners = indexed
    .filter(({ constraint }) => isTrustedOwnerConstraint(constraint))
    .sort(
      (a, b) =>
        String(b.constraint.added ?? "").localeCompare(String(a.constraint.added ?? "")) || b.index - a.index,
    );
  const seeds = indexed.filter(({ constraint }) => constraint.source === "seed");
  const others = indexed.filter(
    ({ constraint }) => constraint.source !== "seed" && !isTrustedOwnerConstraint(constraint),
  );
  return [...owners, ...seeds, ...others]
    .slice(0, BRIEF_MAX_CONTRACT_LINES)
    .map(({ constraint }) => constraint);
}

interface SectionInfo {
  hidden: number;
  truncated: boolean;
}

/** Render one journal section within its cap and report what the cap dropped,
 *  so the brief can point at the read path instead of silently truncating. */
function appendJournalSection(
  lines: string[],
  heading: "decisions:" | "corrections:" | "agent notes (unverified):",
  entries: Array<{ text: string; tags: string[] }>,
  cap: number,
  textMax = 200,
): SectionInfo {
  if (entries.length === 0) return { hidden: 0, truncated: false };
  lines.push(heading);
  let truncated = false;
  for (const entry of entries.slice(0, cap)) {
    const full = normalizeOneLine(entry.text, 10_000);
    const shown = trunc(full, textMax);
    if (shown !== full) truncated = true;
    const safeTags = [...new Set((Array.isArray(entry.tags) ? entry.tags : []).map((tag) => truncLine(tag, 40)).filter(Boolean))]
      .slice(0, 8);
    const tags = safeTags.length > 0 ? ` [${safeTags.join(",")}]` : "";
    lines.push(`- ${shown}${tags}`);
  }
  return { hidden: Math.max(0, entries.length - cap), truncated };
}

const RECALL_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "over",
  "when", "than", "your", "have", "will", "just", "about", "only", "also",
  "not", "are", "was", "were", "but", "you", "our", "can", "all", "any",
]);

/** Task tokens that may match a journal tag. Short and function words are dropped. */
export function taskRecallKeywords(task: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const token of normalizeOneLine(task, 2000).toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < 3 || RECALL_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    found.push(token);
    if (found.length >= 12) break;
  }
  return found;
}

/** Newest trusted rows whose tags match the owner task and that are not already shown. */
export function selectTaskRecall(
  task: string,
  pool: Array<{ type: string; text: string; tags: string[] }>,
  visibleText: ReadonlySet<string>,
): Array<{ type: string; text: string; tags: string[] }> {
  const keywords = new Set(taskRecallKeywords(task));
  if (keywords.size === 0 || pool.length === 0) return [];
  const taskFold = normalizeOneLine(task, 2000).toLowerCase();
  const hits: Array<{ type: string; text: string; tags: string[] }> = [];
  for (const entry of pool) {
    const tags = [
      ...new Set(
        (Array.isArray(entry.tags) ? entry.tags : [])
          .map((tag) => normalizeOneLine(tag, 40).toLowerCase())
          .filter((tag) => tag !== ""),
      ),
    ];
    // Agent notes stay in the unverified section. A matching tag must not
    // promote them into the trusted recall lines.
    if (tags.includes("agent")) continue;
    const matched = tags.some(
      (tag) => keywords.has(tag) || (tag.includes(" ") && taskFold.includes(tag)),
    );
    if (!matched) continue;
    const full = normalizeOneLine(entry.text, 10_000);
    if (full === "" || visibleText.has(full)) continue;
    hits.push(entry);
    if (hits.length >= BRIEF_MAX_RECALL) break;
  }
  return hits;
}

function visibleJournalText(
  decisions: Array<{ text: string }>,
  corrections: Array<{ text: string }>,
): Set<string> {
  const visible = new Set<string>();
  for (const entry of [...decisions.slice(0, BRIEF_MAX_DECISIONS), ...corrections.slice(0, BRIEF_MAX_CORRECTIONS)]) {
    const full = normalizeOneLine(entry.text, 10_000);
    if (full !== "") visible.add(full);
  }
  return visible;
}

/** Build the compact brief: owner task, contract (≤12 lines), ≤3 trusted
 *  decisions, ≤3 trusted corrections, ≤2 unverified agent notes, ≤2 loops, and
 *  last evidence. Anything a cap dropped is announced with the read path.
 *  At most two extra trusted rows are injected when the task names their tag. */
export function buildBrief(input: BriefInput): string {
  const lines: string[] = [];

  const task = truncLine(input.task ?? "", TASK_DISPLAY_MAX);
  if (task !== "") lines.push(`task: ${task}`);

  const contractLines = selectBriefConstraints(input.contract);
  if (contractLines.length > 0) {
    lines.push("contract:");
    for (const c of contractLines) {
      // Provenance: seed constraints are the frozen defaults; anything else is
      // tagged with its source so agent-written constraints are visible as such.
      const source = truncLine(c.source, 40);
      const src = source && source !== "seed" ? ` [${source}]` : "";
      lines.push(`${truncLine(c.id, 80) || "(missing-id)"}${src}: ${truncLine(c.text)}`);
    }
    const hidden = input.contract.length - contractLines.length;
    if (hidden > 0) {
      // Never silently drop owner-added constraints: announce the overflow so
      // the model knows constraints exist beyond the injected 12 (goal #1).
      lines.push(`+${hidden} more constraints hidden — run /guard-contract list`);
    }
  }

  const sections = [
    appendJournalSection(lines, "decisions:", input.decisions ?? [], BRIEF_MAX_DECISIONS),
    appendJournalSection(lines, "corrections:", input.corrections, BRIEF_MAX_CORRECTIONS),
    appendJournalSection(
      lines,
      "agent notes (unverified):",
      input.agentNotes ?? [],
      BRIEF_MAX_AGENT_NOTES,
      AGENT_NOTE_DISPLAY_MAX,
    ),
  ];
  const hiddenEntries = sections.reduce((sum, info) => sum + info.hidden, 0);
  const truncatedEntries = sections.some((info) => info.truncated);
  const recalled = selectTaskRecall(
    input.task ?? "",
    input.recallPool ?? [],
    visibleJournalText(input.decisions ?? [], input.corrections),
  );
  if (recalled.length > 0) {
    lines.push("recall:");
    for (const entry of recalled) {
      const full = normalizeOneLine(entry.text, 10_000);
      const shown = trunc(full, AGENT_NOTE_DISPLAY_MAX);
      const safeTags = [
        ...new Set((Array.isArray(entry.tags) ? entry.tags : []).map((tag) => truncLine(tag, 40)).filter(Boolean)),
      ].slice(0, 8);
      const tags = safeTags.length > 0 ? ` [${safeTags.join(",")}]` : "";
      const kind = truncLine(entry.type, 16) || "entry";
      lines.push(`- ${kind}: ${shown}${tags}`);
    }
  }
  if (input.loops.length > 0) {
    lines.push("loops:");
    for (const l of input.loops.slice(0, BRIEF_MAX_LOOPS)) {
      lines.push(`- '${truncLine(l.cmd, CMD_DISPLAY_MAX)}' failed ${l.failures}x`);
    }
  }

  if (input.lastEvidence) {
    const ms = input.lastEvidence.ms === null ? "" : ` ${(input.lastEvidence.ms / 1000).toFixed(1)}s`;
    lines.push(
      `last verify: ${truncLine(input.lastEvidence.id, 40)} exit=${input.lastEvidence.exit} '${truncLine(input.lastEvidence.cmd, CMD_DISPLAY_MAX)}'${ms}`,
    );
  }

  // The caps above keep the brief constant-cost; these two lines keep the loss
  // recoverable instead of silent (goal #6/#12).
  if (hiddenEntries > 0) {
    lines.push(
      `+${hiddenEntries} more journal entries — guard_journal reads them; guard_recall searches the retained window`,
    );
  }
  if (truncatedEntries) {
    lines.push("journal text truncated — guard_journal shows the full entry");
  }

  return lines.join("\n");
}
