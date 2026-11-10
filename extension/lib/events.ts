/**
 * Event records for `.agent-guard/events.jsonl` (SPEC §2, §5).
 * Pure logic + record shapes — no pi imports.
 */

export type EventKind = "tool_call" | "tool_result";

export interface EventRecord {
  ts: string;
  session: string;
  kind: EventKind;
  tool: string;
  /** null on an ordinary tool_call; false when the call was refused. */
  ok: boolean | null;
  ms: number | null;
  out_chars: number | null;
  /** bash rows only, fingerprint-normalized (tool_call and tool_result). */
  cmd: string | null;
  exit: number | null;
  /** Size of a file change made by edit/write, e.g. "+12/-3". Absent on other
   *  tools and on rows written before the field existed. */
  diff_stat?: string | null;
  /** Changed line range in the new file, e.g. "12-18" or "7". */
  diff_lines?: string | null;
  /** First changed line, trimmed — the practical "which symbol/statement" hint. */
  diff_at?: string | null;
  /** Bounded tail of the result text: out_chars alone cannot say why a run
   *  failed. Absent on tool_call rows and on legacy rows. */
  out_tail?: string | null;
}

/** Enough to carry an error message or a diff stat line, small enough to read. */
export const OUT_TAIL_CAP = 400;

export function boundOutTail(text: string, cap: number = OUT_TAIL_CAP): string {
  const chars = Array.from(text);
  return chars.length <= cap ? text : chars.slice(-cap).join("");
}

function nowIso(): string {
  return new Date().toISOString();
}

export function toolCallEvent(
  session: string,
  tool: string,
  opts: { cmd?: string | null; blocked?: boolean } = {},
): EventRecord {
  return {
    ts: nowIso(),
    session,
    kind: "tool_call",
    tool,
    // A refused call (loop block / declined risk confirm) has no result, so the
    // attempt is recorded as ok=false; an ordinary call has no outcome yet.
    ok: opts.blocked ? false : null,
    ms: null,
    out_chars: null,
    cmd: opts.cmd ?? null,
    exit: null,
  };
}

export function toolResultEvent(
  session: string,
  tool: string,
  opts: {
    ok: boolean | null;
    ms: number | null;
    outChars: number | null;
    cmd?: string | null;
    exit?: number | null;
    outTail?: string | null;
    diffStat?: string | null;
    diffLines?: string | null;
    diffAt?: string | null;
  },
): EventRecord {
  return {
    ts: nowIso(),
    session,
    kind: "tool_result",
    tool,
    ok: opts.ok,
    ms: opts.ms,
    out_chars: opts.outChars,
    cmd: opts.cmd ?? null,
    exit: opts.exit ?? null,
    out_tail: opts.outTail == null ? null : boundOutTail(opts.outTail),
    diff_stat: opts.diffStat ?? null,
    diff_lines: opts.diffLines ?? null,
    diff_at: opts.diffAt ?? null,
  };
}

/**
 * The pi bash tool does not expose the exit code in its details; on nonzero
 * exit it throws with "Command exited with code N" appended to the output.
 * Parse it back out; returns null when unavailable (e.g. cancelled).
 */
export function bashExitFromResult(text: string): number | null {
  const matches = text.matchAll(/Command exited with code (\d+)/g);
  let last: number | null = null;
  for (const m of matches) {
    last = Number(m[1]);
  }
  return last;
}
