/**
 * Loop detection from events.jsonl (SPEC §1 #9, §5).
 * Pure logic — no pi imports.
 */

import type { EventRecord } from "./events.ts";
import { normalizeOneLine } from "./text.ts";
import { failureMasked, loopKey, type VerifyRun } from "./verify.ts";

export interface LoopInfo {
  cmd: string;
  failures: number;
  lastExit: number | null;
}

interface LoopOutcome {
  ts: string;
  cmd: string;
  ok: boolean | null;
  exit: number | null;
  order: number;
}

function timestampMillis(value: string): number | null {
  const raw = value.trim();
  if (raw === "") return null;
  // Python's legacy writer could omit a zone; both runtimes treat such store
  // rows as UTC so reconstruction does not depend on the host timezone.
  const zoned = /(?:z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareOutcomes(a: LoopOutcome, b: LoopOutcome): number {
  const aMs = timestampMillis(a.ts);
  const bMs = timestampMillis(b.ts);
  if (aMs !== null && bMs !== null) return aMs - bMs || a.order - b.order;
  if (aMs !== null) return -1;
  if (bMs !== null) return 1;
  return a.ts.localeCompare(b.ts) || a.order - b.order;
}

function applyOutcome(map: Map<string, LoopInfo>, outcome: LoopOutcome): void {
  const cmd = loopKey(outcome.cmd);
  if (cmd === "") return;
  if (outcome.ok === true) {
    // `|| true` / `; true` exits 0 without proving the command. Leaving the
    // streak in place keeps that mask from disarming the loop brake.
    if (!failureMasked(outcome.cmd)) map.delete(cmd);
    return;
  }
  if (outcome.ok !== false) return;
  const cur = map.get(cmd) ?? { cmd, failures: 0, lastExit: null };
  cur.failures += 1;
  if (outcome.exit !== null) cur.lastExit = outcome.exit;
  map.set(cmd, cur);
}

/**
 * Failing-command streaks per fingerprint-normalized command for a session.
 * SPEC §1 #9 calls these "streaks": the count of failures since the LAST
 * SUCCESSFUL run of that same fingerprint — a success (ok=true) resets the
 * streak, a failure of a different command does not. This mirrors
 * loops.streaks() on the Python side exactly (same store, same arithmetic).
 */
export function failedAttempts(events: EventRecord[], session: string): Map<string, LoopInfo> {
  const map = new Map<string, LoopInfo>();
  for (const e of events) {
    if (e.kind !== "tool_result" || e.session !== session) continue;
    if (typeof e.cmd !== "string" || e.cmd === "") continue;
    applyOutcome(map, {
      ts: typeof e.ts === "string" ? e.ts : "",
      cmd: e.cmd,
      ok: typeof e.ok === "boolean" ? e.ok : null,
      exit: typeof e.exit === "number" && Number.isFinite(e.exit) ? e.exit : null,
      order: 0,
    });
  }
  return map;
}

/** Reconstruct streaks from both persisted sources in timestamp order.
 * guard_verify writes the evidence ledger rather than events.jsonl, so using
 * events alone forgets its failures after a restart. Session scoping is
 * applied before merging; older sessions can never affect the new one. */
export function failedAttemptsFromLedgers(
  events: EventRecord[],
  runs: VerifyRun[],
  session: string,
): Map<string, LoopInfo> {
  const outcomes: LoopOutcome[] = [];
  let order = 0;
  for (const event of events) {
    if (event.kind !== "tool_result" || event.session !== session || typeof event.cmd !== "string" || event.cmd === "") continue;
    outcomes.push({
      ts: typeof event.ts === "string" ? event.ts : "",
      cmd: event.cmd,
      ok: typeof event.ok === "boolean" ? event.ok : null,
      exit: typeof event.exit === "number" && Number.isFinite(event.exit) ? event.exit : null,
      order: order++,
    });
  }
  for (const run of runs) {
    if (run.session !== session || typeof run.cmd !== "string" || run.cmd === "") continue;
    outcomes.push({
      ts: typeof run.ts === "string" ? run.ts : "",
      cmd: run.cmd,
      ok: typeof run.ok === "boolean" ? run.ok : null,
      exit: typeof run.exit === "number" && Number.isFinite(run.exit) ? run.exit : null,
      order: order++,
    });
  }
  outcomes.sort(compareOutcomes);

  const map = new Map<string, LoopInfo>();
  for (const outcome of outcomes) applyOutcome(map, outcome);
  return map;
}

/**
 * Block when prior failures >= loop_block_after - 1 (3rd default attempt).
 * The max(1, …) clamp mirrors loops.block_threshold() on the Python side:
 * loop_block_after=1 must never block a command with zero prior failures.
 */
export function shouldBlockLoop(priorFailures: number, loopBlockAfter: number): boolean {
  return priorFailures >= Math.max(1, loopBlockAfter - 1);
}

/** FROZEN block reason format (SPEC §5). */
export function loopBlockReason(cmd: string, priorFailures: number): string {
  const safeCommand = normalizeOneLine(cmd, 60);
  return (
    `guard: '${safeCommand}' already failed ${priorFailures} times this session — do not re-run unchanged; ` +
    `change approach or read the error. ` +
    `(Raise loop_block_after in .agent-guard/config.json to override.)`
  );
}

/** Commands currently in a failing loop (would be blocked on next attempt). */
export function openLoopsFromMap(map: Map<string, LoopInfo>, loopBlockAfter: number): LoopInfo[] {
  const out: LoopInfo[] = [];
  for (const info of map.values()) {
    if (shouldBlockLoop(info.failures, loopBlockAfter)) out.push(info);
  }
  out.sort((a, b) => b.failures - a.failures || a.cmd.localeCompare(b.cmd));
  return out;
}

/** Apply one finished command to an in-memory streak map (same rules as the
 * ledger rebuild). */
export function noteLoopOutcome(
  map: Map<string, LoopInfo>,
  cmd: string,
  ok: boolean,
  exit: number | null,
): void {
  applyOutcome(map, { ts: "", cmd, ok, exit, order: 0 });
}

/** Same, computed from raw events (disk path). */
export function openLoops(events: EventRecord[], session: string, loopBlockAfter: number): LoopInfo[] {
  return openLoopsFromMap(failedAttempts(events, session), loopBlockAfter);
}
