import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SESSION_KEEP, defaultState, loadState, saveState, sessionState, statePath } from "../lib/store.ts";

function withCwd<T>(fn: (cwd: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "pc-state-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readOnDisk(cwd: string): { sessions: Record<string, { brief_digest?: string | null }> } {
  return JSON.parse(readFileSync(statePath(cwd), "utf8")) as { sessions: Record<string, { brief_digest?: string | null }> };
}

test("state: two sessions keep separate baselines", () => {
  withCwd((cwd) => {
    const state = defaultState("session-a", null);
    state.current_session.started = "2026-10-30T00:00:00Z";
    const a = sessionState(state, "session-a");
    a.brief_digest = "digest-a";
    a.notify_watermarks.ctx_pct = 70;
    saveState(cwd, state);

    // A second pi process starts in the same project.
    const second = loadState(cwd)!;
    const b = sessionState(second, "session-b");
    assert.equal(b.brief_digest, null, "a new session starts with an empty baseline");
    assert.equal(b.notify_watermarks.ctx_pct, 0);
    b.brief_digest = "digest-b";
    second.current_session = { id: "session-b", started: "2026-10-30T01:00:00Z", git_head: null };
    saveState(cwd, second);

    const final = loadState(cwd)!;
    assert.equal(final.sessions["session-a"].brief_digest, "digest-a", "session A is not clobbered");
    assert.equal(final.sessions["session-a"].notify_watermarks.ctx_pct, 70);
    assert.equal(final.sessions["session-b"].brief_digest, "digest-b");
    assert.equal(final.current_session.id, "session-b");
  });
});

test("state: a legacy flat file is migrated in memory", () => {
  withCwd((cwd) => {
    mkdirSync(join(cwd, ".agent-guard"), { recursive: true });
    writeFileSync(
      statePath(cwd),
      JSON.stringify({
        current_session: { id: "legacy", started: "2026-10-01T00:00:00Z", git_head: "abc" },
        brief_digest: "old-digest",
        notify_watermarks: { ctx_pct: 30, diff_lines: 120, diff_files: 2 },
        counters: { orient_sha1: "xyz" },
      }),
      "utf8",
    );
    const state = loadState(cwd)!;
    const entry = state.sessions["legacy"];
    assert.equal(entry.brief_digest, "old-digest", "a v1 flat baseline is not silently dropped");
    assert.deepEqual(entry.notify_watermarks, { ctx_pct: 30, diff_lines: 120, diff_files: 2 });
    assert.equal(entry.git_head, "abc");
    assert.equal(state.counters.orient_sha1, "xyz");
  });
});

test("state: save prunes old sessions but never the current one", () => {
  withCwd((cwd) => {
    const state = defaultState("s-0", null);
    for (let index = 0; index < SESSION_KEEP + 4; index += 1) {
      const entry = sessionState(state, `s-${index}`);
      entry.updated = `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00Z`;
    }
    // The current session is the OLDEST, so it must survive on purpose.
    state.current_session = { id: "s-0", started: "2026-10-01", git_head: null };
    state.sessions["s-0"].updated = "2026-10-01T00:00:00Z";
    saveState(cwd, state);

    const saved = readOnDisk(cwd);
    assert.equal(Object.keys(saved.sessions).length, SESSION_KEEP);
    assert.ok("s-0" in saved.sessions, "the current session is never pruned");
    assert.ok(`s-${SESSION_KEEP + 3}` in saved.sessions, "the newest session is retained");
    assert.ok(!("s-1" in saved.sessions), "the oldest non-current session is dropped");
  });
});

test("state: owner task survives concurrent sessions and rewrites", () => {
  withCwd((cwd) => {
    const state = defaultState("session-task", null);
    state.task = { text: "Ship the audit fixes", source: "owner", ts: "2026-11-03T00:00:00Z" };
    sessionState(state, "session-task").brief_digest = "digest";
    saveState(cwd, state);

    // Another session (or a Python CLI write) must not erase the project task.
    const reloaded = loadState(cwd)!;
    assert.deepEqual(reloaded.task, { text: "Ship the audit fixes", source: "owner", ts: "2026-11-03T00:00:00Z" });
    sessionState(reloaded, "session-other");
    saveState(cwd, reloaded);
    assert.equal(loadState(cwd)!.task?.text, "Ship the audit fixes");
  });
});

test("state: malformed task records are dropped, not rendered", () => {
  withCwd((cwd) => {
    mkdirSync(join(cwd, ".agent-guard"), { recursive: true });
    writeFileSync(
      statePath(cwd),
      JSON.stringify({ current_session: { id: "s", started: "", git_head: null }, sessions: {}, counters: {}, task: { text: 7 } }),
      "utf8",
    );
    assert.equal(loadState(cwd)!.task, undefined);
    writeFileSync(
      statePath(cwd),
      JSON.stringify({ current_session: { id: "s", started: "", git_head: null }, sessions: {}, counters: {}, task: "nope" }),
      "utf8",
    );
    assert.equal(loadState(cwd)!.task, undefined);
  });
});
