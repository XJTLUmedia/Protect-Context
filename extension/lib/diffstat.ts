/**
 * Bounded "what changed" digest for edit/write tool calls (SPEC §2 events).
 *
 * The ledgers recorded that an edit happened and on which path, but never how
 * much changed — so a past task could not be reconstructed without git. A line
 * count is the smallest unit that answers "was this a one-liner or a rewrite"
 * while staying far too small to reconstruct content the owner did not want
 * stored. Pure logic, no pi imports, mirrored by diffstat.py.
 */

export interface DiffStat {
  added: number;
  removed: number;
}

/** Strip one trailing newline so a POSIX-terminated file does not read as
 *  having a phantom final line. */
function lines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** Line count of a text block; "" is zero lines, not one. */
export function lineCount(text: string): number {
  return lines(text).length;
}

/**
 * Added/removed lines between two texts, computed by stripping the common
 * leading and trailing lines and counting what is left. This deliberately does
 * not run an LCS diff: a full diff costs O(n*m) on a large file and the extra
 * accuracy does not change "how big was this change".
 */
export function boundedDiffStat(before: string, after: string): DiffStat {
  if (before === after) return { added: 0, removed: 0 };
  const a = lines(before);
  const b = lines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

/** Compact ledger form, e.g. "+12/-3". Null when nothing changed. */
export function formatDiffStat(stat: DiffStat | null): string | null {
  if (!stat) return null;
  if (stat.added === 0 && stat.removed === 0) return null;
  return `+${stat.added}/-${stat.removed}`;
}

export interface ChangedSpan {
  /** 1-based first changed line in the NEW text; 0 when nothing changed. */
  startLine: number;
  /** 1-based last changed line in the NEW text; 0 when nothing changed. */
  endLine: number;
  /** The first changed line, trimmed and capped — the practical location hint. */
  firstLine: string;
}

/** Where the change landed, from the same common prefix/suffix walk.
 *
 *  Line numbers refer to the new text. A change that only deletes lines has an
 *  empty new range, so the span collapses to the surrounding line and the
 *  caller still learns where the deletion happened.
 */
export function changedSpan(before: string, after: string, hintCap = 80): ChangedSpan {
  const none: ChangedSpan = { startLine: 0, endLine: 0, firstLine: "" };
  if (before === after) return none;
  const a = lines(before);
  const b = lines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const changed = b.length - head - tail;
  const startLine = head + 1;
  // A pure deletion has no new lines; collapse the range onto the line the
  // deletion sits after so "where" is still answerable.
  const endLine = changed === 0 ? startLine : b.length - tail;
  const hint = changed === 0 ? (b[head - 1] ?? "") : (b[head] ?? "");
  return {
    startLine,
    endLine,
    firstLine: hint.trim().slice(0, hintCap),
  };
}
