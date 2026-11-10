/**
 * Loop detection from events.jsonl (SPEC §1 #9, §5).
 * Pure logic — no pi imports.
 */


import CircuitBreaker from "opossum";

import type { EventRecord } from "./events.ts";
import { normalizeOneLine } from "./text.ts";
import { failureMasked, loopKey, trustIssues, type VerifyRun } from "./verify.ts";

export interface LoopInfo {
  cmd: string;
  failures: number;
  lastExit: number | null;
  /** Timestamp of the most recent failure, or null when none was recorded. */
  lastFailedAt?: string | null;
}

interface LoopOutcome {
  ts: string;
  cmd: string;
  ok: boolean | null;
  exit: number | null;
  order: number;
  /** exit 0 that proves nothing (pipeline or mask) on a guard_verify run. */
  unproven?: boolean;
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
  // `|| true` / `; true` exits 0 without proving the command, and neither does
  // a pipeline that never checked its earlier stages. Both are unproven
  // attempts, not resets: they count like failures and keep the brake armed
  // (Python loops.streaks applies the same rule).
  if (outcome.ok === true && !outcome.unproven && !failureMasked(outcome.cmd)) {
    map.delete(cmd);
    return;
  }
  if (outcome.ok !== true && outcome.ok !== false) return;
  const cur = map.get(cmd) ?? { cmd, failures: 0, lastExit: null, lastFailedAt: null };
  cur.failures += 1;
  if (outcome.exit !== null) cur.lastExit = outcome.exit;
  cur.lastFailedAt = outcome.ts || null;
  map.set(cmd, cur);
}

/** Tools whose runs may accumulate a streak; everything else only records a
 *  reuse key for recall (a path or pattern is not a command). */
const STREAK_TOOLS = new Set(["bash", "guard_verify"]);

/** Only shell runs and the evidence tool can form a streak. A missing tool is
 *  treated as a shell run for legacy rows (mirrors loops.streaks). */
function toolMayStreak(tool: unknown): boolean {
  return typeof tool !== "string" || tool === "" || STREAK_TOOLS.has(tool);
}

/**
 * Failing-command streaks per fingerprint-normalized command for a session.
 * SPEC §1 #9 calls these "streaks": the count of failures since the LAST
 * SUCCESSFUL run of that same fingerprint — a success (ok=true) resets the
 * streak, a failure of a different command does not. This mirrors
 * loops.streaks() on the Python side exactly (same store, same arithmetic,
 * same tool filter).
 */
export function failedAttempts(events: EventRecord[], session: string): Map<string, LoopInfo> {
  const map = new Map<string, LoopInfo>();
  for (const e of events) {
    if (e.kind !== "tool_result" || e.session !== session) continue;
    if (!toolMayStreak(e.tool)) continue;
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
    // Other tools record a reuse key (a path or pattern) in `cmd` so recall can
    // point back at it. That key is not a command: it must never form a streak.
    if (!toolMayStreak(event.tool)) continue;
    // A guard_verify run is mirrored into events.jsonl so every interface has
    // command history, but verify_runs is authoritative for its outcome: count
    // the ledger row, never both, or the brake trips after half the failures.
    if (event.tool === "guard_verify") continue;
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
      unproven: run.ok === true && trustIssues(run.cmd).length > 0,
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
export function loopIsStale(
  lastFailedAt: string | null | undefined,
  resetAfterMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (resetAfterMs <= 0) return false;
  if (lastFailedAt === null || lastFailedAt === undefined || lastFailedAt === "") return false; // unknown age never disarms
  const at = timestampMillis(lastFailedAt);
  if (at === null) return false;
  // opossum owns the OPEN -> HALF_OPEN transition: rebuild the breaker in the
  // state the elapsed time implies and let it answer instead of comparing here.
  const aged = nowMs - at > resetAfterMs;
  const breaker = new CircuitBreaker(() => true, {
    resetTimeout: resetAfterMs,
    state: aged ? { closed: false, halfOpen: true } : { closed: false, open: true },
  });
  return breaker.halfOpen;
}

/**
 * Block when prior failures >= loop_block_after - 1 (3rd default attempt).
 * The max(1, …) clamp mirrors loops.block_threshold() on the Python side:
 * loop_block_after=1 must never block a command with zero prior failures.
 *
 * A streak older than loop_reset_after_s is a half-open circuit (the
 * pybreaker/opossum model): the probe is allowed, and a failure re-arms the
 * brake because the streak itself is still counted.
 */
export function shouldBlockLoop(
  priorFailures: number,
  loopBlockAfter: number,
  lastFailedAt: string | null | undefined = null,
  resetAfterMs: number = 0,
  nowMs: number = Date.now(),
): boolean {
  if (priorFailures < Math.max(1, loopBlockAfter - 1)) return false;
  return !loopIsStale(lastFailedAt, resetAfterMs, nowMs);
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
export function openLoopsFromMap(
  map: Map<string, LoopInfo>,
  loopBlockAfter: number,
  resetAfterMs: number = 0,
  nowMs: number = Date.now(),
): LoopInfo[] {
  const out: LoopInfo[] = [];
  for (const info of map.values()) {
    if (shouldBlockLoop(info.failures, loopBlockAfter, info.lastFailedAt, resetAfterMs, nowMs)) {
      out.push(info);
    }
  }
  out.sort((a, b) => b.failures - a.failures || a.cmd.localeCompare(b.cmd));
  return out;
}

/** Apply one finished command to an in-memory streak map (same rules as the
 * ledger rebuild, including the tool filter). `tool` defaults to bash so an
 * existing call site keeps its old meaning; non-shell tools leave the map
 * untouched because their `cmd` is a reuse key, not a command. */
export function noteLoopOutcome(
  map: Map<string, LoopInfo>,
  cmd: string,
  ok: boolean,
  exit: number | null,
  tool = "bash",
): void {
  if (!toolMayStreak(tool)) return;
  applyOutcome(map, { ts: "", cmd, ok, exit, order: 0 });
}

/** Same, computed from raw events (disk path). */
export function openLoops(events: EventRecord[], session: string, loopBlockAfter: number): LoopInfo[] {
  return openLoopsFromMap(failedAttempts(events, session), loopBlockAfter);
}
