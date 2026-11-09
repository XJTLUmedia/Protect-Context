import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import protectContext from "../index.ts";
import { appendJsonl, eventsPath, readJsonl, verifyRunsPath } from "../lib/store.ts";
import { readJournal } from "../lib/journal.ts";
import type { EventRecord } from "../lib/events.ts";

type Handler = (event: any, ctx: any) => unknown;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

class FakePi {
  handlers = new Map<string, Handler>();
  commands = new Map<string, any>();
  tools = new Map<string, any>();
  cwd = "";
  lastShellSignal: AbortSignal | undefined;
  failStatus = false;
  failDiff = false;
  /** Exit code for `sh` (guard_verify/bash runs); 0 means success. */
  shellCode = 0;

  on(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  registerCommand(name: string, command: any): void {
    this.commands.set(name, command);
  }

  registerTool(tool: any): void {
    this.tools.set(tool.name, tool);
  }

  async exec(
    command: string,
    args: string[],
    options?: { signal?: AbortSignal },
  ): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
    if (command === "sh") {
      this.lastShellSignal = options?.signal;
      if (this.shellCode !== 0) {
        return { code: this.shellCode, stdout: "", stderr: "failed\n", killed: false };
      }
      return { code: 0, stdout: "verified\n", stderr: "", killed: false };
    }
    assert.equal(command, "git");
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") return { code: 0, stdout: `${this.cwd}\n`, stderr: "", killed: false };
    if (key === "rev-parse --verify HEAD") return { code: 128, stdout: "", stderr: "unborn", killed: false };
    if (key === "hash-object -t tree --stdin") return { code: 0, stdout: `${EMPTY_TREE}\n`, stderr: "", killed: false };
    if (key === `diff --numstat ${EMPTY_TREE} --`) {
      if (this.failDiff) return { code: 1, stdout: "", stderr: "diff failed", killed: false };
      // Final working-tree content is two lines. The former cached+unstaged
      // merge returned three changed lines for this staged-then-edited file.
      return { code: 0, stdout: "2\t0\tstaged.txt\n", stderr: "", killed: false };
    }
    if (key === "status --porcelain=v1 -z --untracked-files=all --") {
      if (this.failStatus) return { code: 1, stdout: "", stderr: "status failed", killed: false };
      return {
        code: 0,
        stdout: "?? visible.txt\0?? .agent-guard/state.json\0",
        stderr: "",
        killed: false,
      };
    }
    throw new Error(`unexpected exec: ${command} ${key}`);
  }
}

function handler(pi: FakePi, name: string): Handler {
  const value = pi.handlers.get(name);
  assert.ok(value, `handler ${name} registered`);
  return value;
}

test("index lifecycle: compaction re-injects, provenance holds, bash outcomes and unborn diff are accurate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-index-"));
  try {
    writeFileSync(join(dir, "visible.txt"), "one\ntwo", "utf8");
    writeFileSync(join(dir, "ignored.log"), "must not count\n", "utf8");

    const fake = new FakePi();
    fake.cwd = dir;
    protectContext(fake as unknown as ExtensionAPI);

    let uiAccesses = 0;
    const ctx = {
      cwd: dir,
      hasUI: false,
      get ui(): never {
        uiAccesses += 1;
        throw new Error("ctx.ui accessed while hasUI=false");
      },
      sessionManager: { getSessionId: () => "session-lifecycle" },
      getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    };

    await handler(fake, "session_start")({}, ctx);
    assert.ok(existsSync(join(dir, ".agent-guard", "config.json")), "extension-only startup seeds config");

    const before = handler(fake, "before_agent_start");
    const first = (await before({}, ctx)) as any;
    assert.match(first.message.content, /PC orientation/);
    assert.match(first.message.content, /01-obey-instructions/);
    assert.equal(await before({}, ctx), undefined, "unchanged digest skips duplicate injection");

    await handler(fake, "session_compact")({}, ctx);
    const afterCompact = (await before({}, ctx)) as any;
    assert.match(afterCompact.message.content, /PC orientation/);
    assert.match(afterCompact.message.content, /01-obey-instructions/);

    const modelNote = fake.tools.get("guard_note");
    assert.ok(modelNote);
    assert.match(modelNote.description, /persisted for owner review/);
    assert.match(modelNote.description, /Only trusted slash-command\/CLI/);
    await modelNote.execute("n1", { type: "decision", text: "model-only decision", tags: ["architecture"] }, null, null, ctx);
    // Agent entries may now re-enter the brief, but only as an explicitly
    // unverified section: they never join the trusted decisions section.
    const afterModelNote = (await before({}, ctx)) as any;
    assert.match(afterModelNote.message.content, /agent notes \(unverified\):/);
    assert.match(afterModelNote.message.content, /model-only decision/);
    assert.doesNotMatch(afterModelNote.message.content, /decisions:\n- model-only decision/);
    await assert.rejects(
      modelNote.execute("n2", { type: "note", text: " \n ", tags: [] }, null, null, ctx),
      /must not be blank/,
    );

    const slashNote = fake.commands.get("guard-note");
    assert.ok(slashNote);
    await slashNote.handler("decision owner-approved architecture", ctx);
    const afterOwnerNote = (await before({}, ctx)) as any;
    assert.match(afterOwnerNote.message.content, /owner-approved architecture/);
    assert.match(
      afterOwnerNote.message.content,
      /agent notes \(unverified\):[\s\S]*model-only decision/,
      "the agent note stays in the unverified section, not the trusted one",
    );
    assert.doesNotMatch(afterOwnerNote.message.content, /decisions:\n- model-only decision/);
    const entries = readJournal(dir);
    assert.ok(entries[0]?.tags.includes("agent"), "model tool always records agent provenance");
    assert.ok(!entries[1]?.tags.includes("agent"), "slash command remains trusted");
    assert.ok(
      entries[1]?.tags.includes("owner-want"),
      "an owner-approved decision is tagged as owner intent",
    );

    const slashContract = fake.commands.get("guard-contract");
    assert.ok(slashContract);
    await slashContract.handler("add owner constraint", ctx);
    const contractRaw = JSON.parse(readFileSync(join(dir, ".agent-guard", "contract.json"), "utf8"));
    assert.equal(contractRaw.constraints.at(-1).source, "user");
    await slashContract.handler("add \u0000", ctx); // provoke attempt()'s error path with no UI

    const verifyTool = fake.tools.get("guard_verify");
    await assert.rejects(verifyTool.execute("v1", { command: " \n " }, null, null, ctx), /must not be blank/);
    const abort = new AbortController();
    await verifyTool.execute("v2", { command: "true" }, abort.signal, null, ctx);
    assert.equal(fake.lastShellSignal, abort.signal, "model cancellation signal reaches pi.exec");

    const start = handler(fake, "tool_execution_start");
    const end = handler(fake, "tool_execution_end");
    await start({ toolCallId: "ok", toolName: "bash", args: { command: "echo ok" } }, ctx);
    await end(
      { toolCallId: "ok", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "ok" }] } },
      ctx,
    );
    await start({ toolCallId: "bad", toolName: "bash", args: { command: "opaque failure" } }, ctx);
    await end(
      { toolCallId: "bad", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "cancelled" }] } },
      ctx,
    );
    const results = readJsonl<EventRecord>(eventsPath(dir)).filter(
      // guard_verify writes its own mirrored pair from runVerifyAndRecord; this
      // assertion is about the bash outcome shape.
      (event) => event.kind === "tool_result" && event.tool === "bash",
    );
    assert.deepEqual(
      results.map((event) => ({ cmd: event.cmd, exit: event.exit, ok: event.ok })),
      [
        { cmd: "echo ok", exit: 0, ok: true },
        { cmd: "opaque failure", exit: null, ok: false },
      ],
    );

    // The attempted command is now on the call row too, so a call that is
    // refused or never finishes is not anonymous in the audit trail.
    const cleanCall = await handler(fake, "tool_call")(
      { toolCallId: "call-1", toolName: "bash", input: { command: "echo ok" } },
      ctx,
    );
    assert.equal(cleanCall, undefined, "an unchanged successful command is not blocked");

    const statusTool = fake.tools.get("guard_status");
    const status = await statusTool.execute("s1", {}, null, null, ctx);
    const statusText = status.content[0].text as string;
    assert.match(statusText, /git=unborn/);
    assert.match(
      statusText,
      /Δ\+4L\/2f/,
      "final staged-then-edited content is counted once plus one Git-selected untracked file",
    );

    // CLI/MCP writers can append while the extension is live. The status and
    // next tool_call must rebuild from changed ledger stamps and block the
    // third identical failure without double-counting in-memory outcomes.
    for (const id of ["ev-0002", "ev-0003"]) {
      appendJsonl(verifyRunsPath(dir), {
        id,
        ts: new Date().toISOString(),
        session: "session-lifecycle",
        cmd: "external failure",
        exit: 1,
        ok: false,
        digest: "failed",
        ms: 1,
      });
    }
    const refreshed = await statusTool.execute("s2", {}, null, null, ctx);
    assert.match(refreshed.content[0].text as string, /loops=1/);
    const blocked = (await handler(fake, "tool_call")(
      { toolCallId: "external-third", toolName: "bash", input: { command: "external failure" } },
      ctx,
    )) as any;
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /already failed 2 times/);
    const calls = readJsonl<EventRecord>(eventsPath(dir)).filter(
      // guard_verify mirrors its own pair from runVerifyAndRecord.
      (event) => event.kind === "tool_call" && event.tool === "bash",
    );
    assert.deepEqual(
      calls.map((event) => ({ cmd: event.cmd, ok: event.ok })),
      [
        { cmd: "echo ok", ok: null },
        { cmd: "external failure", ok: false },
      ],
      "calls record their command; the refused attempt is kept with ok=false",
    );

    fake.failStatus = true;
    const unavailableStatus = await statusTool.execute("s3", {}, null, null, ctx);
    assert.match(unavailableStatus.content[0].text as string, /Δ=unknown/);
    assert.match(unavailableStatus.content[0].text as string, /scope unavailable/);
    fake.failStatus = false;

    fake.failDiff = true;
    const unavailableDiff = await statusTool.execute("s4", {}, null, null, ctx);
    assert.match(unavailableDiff.content[0].text as string, /Δ=unknown/);
    fake.failDiff = false;

    const recallTool = fake.tools.get("guard_recall");
    assert.ok(recallTool, "guard_recall is model-callable");
    const recalled = await recallTool.execute(
      "r1",
      { query: "owner-approved", type: "decision" },
      null,
      null,
      ctx,
    );
    const recallText = recalled.content[0].text as string;
    assert.match(recallText, /trusted · decision/);
    assert.match(recallText, /owner-approved architecture/);
    assert.match(recallText, /Nudge:/);
    assert.doesNotMatch(recallText, /model-only/);

    await handler(fake, "turn_end")({}, ctx);
    await handler(fake, "session_shutdown")({}, ctx);
    assert.equal(uiAccesses, 0, "no ctx.ui property is touched when hasUI=false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("index lifecycle: guard_intent renders owner intent without a query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-index-intent-"));
  try {
    const fake = new FakePi();
    fake.cwd = dir;
    protectContext(fake as unknown as ExtensionAPI);
    const ctx = {
      cwd: dir,
      hasUI: false,
      sessionManager: { getSessionId: () => "session-intent" },
      getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    };
    await handler(fake, "session_start")({}, ctx);

    const note = fake.tools.get("guard_note");
    assert.ok(note);
    await note.execute(
      "n1",
      { type: "decision", text: "owner wants both runtimes green", tags: [] },
      null,
      null,
      ctx,
    );
    await note.execute("n2", { type: "note", text: "unrelated bookkeeping", tags: [] }, null, null, ctx);

    const intent = fake.tools.get("guard_intent");
    assert.ok(intent, "guard_intent is model-callable");
    const text = (await intent.execute("i1", { limit: 5 }, null, null, ctx)).content[0].text;
    assert.match(text, /^PC intent · 1 of 1 owner statements · want 1/);
    assert.match(text, /owner-want · .*owner wants both runtimes green \[agent\]/);
    assert.match(text.split("\n").at(-1)!, /^Nudge: /);

    // The owner's own typed directive is captured as a TRUSTED row: the words
    // are the owner's, so the profile does not depend on the agent's paraphrase.
    await handler(fake, "input")(
      { source: "user", text: "ship it faster, the whole release pipeline" },
      ctx,
    );
    // A later prompt still states intent even though the task anchor is set.
    await handler(fake, "input")(
      { source: "user", text: "I need both suites green before you push" },
      ctx,
    );
    const owned = (await intent.execute("i2", { limit: 5 }, null, null, ctx)).content[0].text;
    assert.match(owned, /owner-want · .*ship it faster.*\[owner\]/);
    assert.match(owned, /owner 2 · agent 1/);

    // The brief carries the owner's statements too, so they survive compaction
    // without a tool call (both rows are notes, so they are unique here).
    const brief = (await handler(fake, "before_agent_start")({}, ctx)) as any;
    assert.match(brief.message.content, /owner intent:/);
    assert.match(brief.message.content, /- ship it faster/);
    assert.match(brief.message.content, /- I need both suites green before you push/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("index lifecycle: a failing guard_verify counts once and blocks its own re-run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-index-verify-count-"));
  try {
    const fake = new FakePi();
    fake.cwd = dir;
    fake.shellCode = 1; // every verification run fails
    protectContext(fake as unknown as ExtensionAPI);
    const ctx = {
      cwd: dir,
      hasUI: false,
      sessionManager: { getSessionId: () => "session-verify-count" },
      getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    };
    await handler(fake, "session_start")({}, ctx);

    const verify = fake.tools.get("guard_verify");
    assert.ok(verify);
    const start = handler(fake, "tool_execution_start");
    const end = handler(fake, "tool_execution_end");
    // Drive the tool exactly as pi does: start -> execute -> end.
    const run = async (id: string) => {
      await start({ toolCallId: id, toolName: "guard_verify", args: { command: "pytest -q" } }, ctx);
      const out = (await verify.execute(id, { command: "pytest -q" }, null, null, ctx)).content[0].text;
      await end(
        { toolCallId: id, toolName: "guard_verify", isError: false, result: { content: [{ type: "text", text: out }] } },
        ctx,
      );
      return out as string;
    };

    // loop_block_after is 3, so the threshold is two prior failures: the first
    // two runs execute and the third is refused. Counting the outcome twice (or
    // resetting it with `!isError` at tool_execution_end) breaks this exactly.
    assert.match(await run("gv1"), /PC verify ev-0001/);
    assert.match(await run("gv2"), /PC verify ev-0002/);
    assert.match(await run("gv3"), /already failed 2 times|do not re-run/);
    const runs = readJsonl<{ id: string }>(verifyRunsPath(dir));
    assert.equal(runs.length, 2, "a blocked run records no evidence");

    // events.jsonl tells the truth about a failed verify: the extension used to
    // write ok=!isError (true here) with exit null from tool_execution_end.
    const mirrored = readJsonl<EventRecord>(eventsPath(dir)).filter((e) => e.tool === "guard_verify");
    assert.deepEqual(
      mirrored.map((e) => [e.kind, e.ok, e.exit]),
      [
        ["tool_call", null, null],
        ["tool_result", false, 1],
        ["tool_call", null, null],
        ["tool_result", false, 1],
      ],
      "two failing runs leave two truthful call/result pairs",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
