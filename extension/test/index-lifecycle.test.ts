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
    assert.deepEqual(entries[1]?.tags, [], "slash command remains trusted");

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
    const results = readJsonl<EventRecord>(eventsPath(dir)).filter((event) => event.kind === "tool_result");
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
      (event) => event.kind === "tool_call",
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
