import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import protectContext from "../index.ts";
import { loadState } from "../lib/store.ts";

type Handler = (event: any, ctx: any) => unknown;

/** Minimal pi surface: no repository, so scope measurement stays "unknown" and
 *  the test exercises only the context/journal behaviour under audit. */
class FakePi {
  handlers = new Map<string, Handler>();
  commands = new Map<string, any>();
  tools = new Map<string, any>();
  cwd = "";

  on(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  registerCommand(name: string, command: any): void {
    this.commands.set(name, command);
  }

  registerTool(tool: any): void {
    this.tools.set(tool.name, tool);
  }

  async exec(): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
    return { code: 128, stdout: "", stderr: "not a repository", killed: false };
  }
}

function handler(pi: FakePi, name: string): Handler {
  const value = pi.handlers.get(name);
  assert.ok(value, `handler ${name} registered`);
  return value;
}

function makeCtx(dir: string) {
  return {
    cwd: dir,
    hasUI: false,
    sessionManager: { getSessionId: () => "session-recovery" },
    getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
  };
}

function textOf(result: any): string {
  return String(result?.content?.[0]?.text ?? "");
}

test("compaction recovery: mid-run re-assertion, journal read path, task anchor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-recovery-"));
  try {
    const pi = new FakePi();
    pi.cwd = dir;
    protectContext(pi as unknown as ExtensionAPI);
    const ctx = makeCtx(dir);
    await handler(pi, "session_start")({}, ctx);

    const before = handler(pi, "before_agent_start");
    const context = handler(pi, "context");
    const input = handler(pi, "input");

    // --- task capture -----------------------------------------------------
    assert.equal(await input({ type: "input", text: "short" }, ctx), undefined, "short follow-ups are ignored");
    assert.equal(await input({ type: "input", text: "/guard-status" }, ctx), undefined, "slash commands are ignored");
    await input(
      { type: "input", text: "Implement the compaction audit fixes without touching SPEC.md" },
      ctx,
    );
    const first = (await before({}, ctx)) as any;
    assert.match(first.message.content, /^task: Implement the compaction audit fixes/m);

    // --- agent notes are recoverable, but only as unverified --------------
    const note = pi.tools.get("guard_note");
    await note.execute(
      "n1",
      { type: "decision", text: "rejected approach: retry the flaky suite — owner said no because of cost" },
      null,
      null,
      ctx,
    );
    const withNote = (await before({}, ctx)) as any;
    assert.match(withNote.message.content, /agent notes \(unverified\):/);
    assert.match(withNote.message.content, /rejected approach: retry the flaky suite/);
    assert.doesNotMatch(withNote.message.content, /^decisions:$/m, "agent text never becomes a trusted decision");

    // --- read path: the full entry is reachable on demand ----------------
    const journalTool = pi.tools.get("guard_journal");
    assert.ok(journalTool, "pi exposes a read path for the journal");
    const read = textOf(await journalTool.execute("j1", {}, null, null, ctx));
    assert.match(read, /^PC journal · last 1 of 1/);
    assert.match(read, /rejected approach: retry the flaky suite/);
    assert.match(read, /Nudge: re-read durable decisions and corrections/);
    const typed = textOf(await journalTool.execute("j2", { type: "correction", limit: 20 }, null, null, ctx));
    assert.match(typed, /^PC journal correction · last 0 of 0/);
    const clamped = textOf(await journalTool.execute("j3", { limit: 500 }, null, null, ctx));
    assert.match(clamped, /last 1 of 1/, "limit is bounded, not trusted");
    const empty = textOf(await journalTool.execute("j4", { limit: 0 }, null, null, ctx));
    assert.match(empty, /last 0 of 1/);

    // --- owner override wins over prompt capture -------------------------
    await pi.commands.get("guard-task").handler("Ship the audit fixes", ctx);
    await input({ type: "input", text: "Another long instruction that must not replace the owner task" }, ctx);
    const overridden = (await before({}, ctx)) as any;
    assert.match(overridden.message.content, /^task: Ship the audit fixes/);
    assert.doesNotMatch(overridden.message.content, /must not replace the owner task/);

    // --- mid-run compaction: context re-asserts the block ----------------
    await handler(pi, "session_compact")({ reason: "threshold", willRetry: true }, ctx);
    const reinjected = (await context({ type: "context", messages: [] }, ctx)) as any;
    assert.ok(reinjected?.messages, "a mid-run compaction re-asserts the guard block");
    const block = String(reinjected.messages.at(-1).content);
    assert.match(block, /PC orientation/);
    assert.match(block, /01-obey-instructions/);
    assert.match(block, /^task: Ship the audit fixes/m);
    assert.equal(reinjected.messages.at(-1).customType, "guard-brief");
    assert.equal(reinjected.messages.at(-1).display, false);

    // The injected message is per-request: the next request needs it again.
    const again = (await context({ type: "context", messages: [] }, ctx)) as any;
    assert.ok(again?.messages, "an ephemeral injection is re-applied, never remembered");

    // Once a persisted block is back in the conversation, stop re-asserting.
    assert.equal(await context({ type: "context", messages: reinjected.messages }, ctx), undefined);
    assert.equal(await context({ type: "context", messages: [] }, ctx), undefined, "flag is cleared");

    // --- quiet turns stay quiet (no per-request cost without a compaction)
    await handler(pi, "session_compact")({ reason: "manual" }, ctx);
    assert.ok(await context({ type: "context", messages: [] }, ctx));
    assert.equal(await context({ type: "context", messages: [{ customType: "guard-brief" }] }, ctx), undefined);

    // --- status surfaces the journal, so the read path is discoverable ---
    const status = textOf(await pi.tools.get("guard_status").execute("s1", {}, null, null, ctx));
    assert.match(status, /journal: 1 entries \(1 agent\) — guard_journal reads them/);

    // --- the task anchor stores exactly what the brief can show ----------
    await pi.commands.get("guard-task").handler(`long ${"w".repeat(400)}`, ctx);
    const stored = loadState(dir)!.task!;
    assert.equal(Array.from(stored.text).length, 200, "store and display share one cap");
    assert.ok(stored.text.endsWith("…"));
    assert.equal(stored.source, "owner");

    // --- clear ------------------------------------------------------------
    await pi.commands.get("guard-task").handler("--clear", ctx);
    const cleared = (await before({}, ctx)) as any;
    assert.doesNotMatch(cleared.message.content, /^task:/m);

    await handler(pi, "session_shutdown")({}, ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
