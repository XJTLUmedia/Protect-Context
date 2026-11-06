import { test } from "node:test";
import assert from "node:assert/strict";
import {
  failedAttempts,
  failedAttemptsFromLedgers,
  noteLoopOutcome,
  openLoops,
  openLoopsFromMap,
  shouldBlockLoop,
  loopBlockReason,
} from "../lib/loops.ts";
import { toolResultEvent, toolCallEvent } from "../lib/events.ts";
import type { VerifyRun } from "../lib/verify.ts";

function ev(session: string, cmd: string, ok: boolean, exit: number): ReturnType<typeof toolResultEvent> {
  return toolResultEvent(session, "bash", { ok, ms: 10, outChars: 5, cmd, exit });
}

const S = "sess-1";

test("loops: counts prior failed attempts per fingerprint and session", () => {
  const events = [
    toolCallEvent(S, "bash"),
    ev(S, "npm test", false, 1),
    ev(S, "npm test", false, 1),
    ev(S, "other cmd", false, 2),
    ev("sess-2", "npm test", false, 1), // other session must not count
  ];
  const map = failedAttempts(events, S);
  assert.equal(map.get("npm test")?.failures, 2);
  assert.equal(map.get("npm test")?.lastExit, 1);
  assert.equal(map.get("other cmd")?.failures, 1);
  assert.equal(map.size, 2);
});

test("loops: success of the same command resets the streak", () => {
  // fail,fail,SUCCESS,fail → 1 (mirrors Python test_success_of_same_command_resets_streak)
  const events = [
    ev(S, "npm test", false, 1),
    ev(S, "npm test", false, 1),
    ev(S, "npm test", true, 0),
    ev(S, "npm test", false, 1),
  ];
  const map = failedAttempts(events, S);
  assert.equal(map.get("npm test")?.failures, 1);
  // a success alone leaves no open streak behind
  assert.equal(failedAttempts([ev(S, "x", false, 1), ev(S, "x", true, 0)], S).size, 0);
});

test("loops: a failing OTHER command does not reset the streak", () => {
  const events = [ev(S, "a", false, 1), ev(S, "b", false, 1), ev(S, "a", false, 1)];
  const map = failedAttempts(events, S);
  assert.equal(map.get("a")?.failures, 2);
  assert.equal(map.get("b")?.failures, 1);
});

test("loops: blocks on the loop_block_after-th attempt (default 3 → 2 prior failures)", () => {
  assert.equal(shouldBlockLoop(0, 3), false);
  assert.equal(shouldBlockLoop(1, 3), false);
  assert.equal(shouldBlockLoop(2, 3), true);
  assert.equal(shouldBlockLoop(5, 3), true);
});

test("loops: threshold clamped so loop_block_after=1 never blocks a fresh command", () => {
  assert.equal(shouldBlockLoop(0, 1), false); // 0 prior failures → never blocked
  assert.equal(shouldBlockLoop(1, 1), true); // 1 prior failure → 2nd attempt blocked
});

test("loops: openLoops only lists commands at/over the threshold", () => {
  const events = [ev(S, "a", false, 1), ev(S, "a", false, 1), ev(S, "b", false, 1)];
  const loops = openLoops(events, S, 3);
  assert.equal(loops.length, 1);
  assert.equal(loops[0]?.cmd, "a");
  assert.equal(loops[0]?.failures, 2);
});

test("loops: openLoops clears after an intervening success", () => {
  const events = [ev(S, "a", false, 1), ev(S, "a", false, 1), ev(S, "a", true, 0)];
  assert.equal(openLoops(events, S, 3).length, 0);
});

test("loops: block reason uses the frozen format", () => {
  const reason = loopBlockReason("npm test", 2);
  assert.equal(
    reason,
    "guard: 'npm test' already failed 2 times this session — do not re-run unchanged; " +
      "change approach or read the error. (Raise loop_block_after in .agent-guard/config.json to override.)",
  );
});

test("loops: openLoopsFromMap mirrors openLoops on the failedAttempts map", () => {
  const events = [ev(S, "a", false, 1), ev(S, "a", false, 1), ev(S, "b", false, 1)];
  const map = failedAttempts(events, S);
  const fromEvents = openLoops(events, S, 3);
  const fromMap = openLoopsFromMap(map, 3);
  assert.deepEqual(fromMap, fromEvents);
  assert.equal(fromMap.length, 1);
  // a success reset in the map clears it too
  map.delete("a");
  assert.equal(openLoopsFromMap(map, 3).length, 0);
});

test("loops: restart reconstruction merges same-session bash events and verify ledger chronologically", () => {
  const events = [ev(S, "npm test", false, 1)];
  events[0]!.ts = "2026-09-01T00:00:01.000Z";
  const run = (over: Partial<VerifyRun>): VerifyRun => ({
    id: "ev-0001",
    ts: "2026-09-01T00:00:02.000Z",
    session: S,
    cmd: "npm test",
    exit: 1,
    ok: false,
    digest: "",
    ms: 1,
    ...over,
  });
  const map = failedAttemptsFromLedgers(events, [run({}), run({ session: "other" })], S);
  assert.equal(map.get("npm test")?.failures, 2, "both ledgers contribute, other session does not");

  const reset = failedAttemptsFromLedgers(events, [run({ ok: true, exit: 0 })], S);
  assert.equal(reset.has("npm test"), false, "later verify success resets earlier bash failure");
});

test("loops: cross-runtime ISO offsets are ordered as instants, not raw strings", () => {
  const events = [ev(S, "npm test", true, 0)];
  events[0]!.ts = "2026-09-01T00:00:00.900+00:00";
  const earlierFailure: VerifyRun = {
    id: "ev-0001",
    ts: "2026-09-01T00:00:00.100Z",
    session: S,
    cmd: "npm test",
    exit: 1,
    ok: false,
    digest: "",
    ms: 1,
  };

  const map = failedAttemptsFromLedgers(events, [earlierFailure], S);

  assert.equal(map.has("npm test"), false, "later success resets the earlier failure");
});

test("loops: a trailing semicolon and a failure mask share the underlying streak", () => {
  const events = [
    ev(S, "pytest -q", false, 1),
    ev(S, "pytest -q;", false, 1),
  ];
  const map = failedAttempts(events, S);
  assert.equal(map.get("pytest -q")?.failures, 2);
  assert.equal(map.has("pytest -q;"), false);

  const masked = [
    ev(S, "npm test", false, 1),
    ev(S, "npm test", false, 1),
    ev(S, "npm test || true", true, 0),
  ];
  const held = failedAttempts(masked, S);
  assert.equal(held.get("npm test")?.failures, 2, "|| true must not reset the streak");

  const live = new Map(held);
  noteLoopOutcome(live, "npm test", true, 0);
  assert.equal(live.has("npm test"), false, "a real success still resets");
});

test("loops: malformed persisted command fields are ignored defensively", () => {
  const malformed = [
    { kind: "tool_result", session: S, cmd: 7, ok: false, exit: 1, ts: null },
    { kind: "tool_result", session: S, cmd: "valid", ok: false, exit: 1, ts: "bad" },
  ] as any;

  const map = failedAttemptsFromLedgers(malformed, [], S);

  assert.deepEqual([...map.keys()], ["valid"]);
});
