import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bashExitFromResult, toolCallEvent, toolResultEvent } from "../lib/events.ts";
import {
  appendVerifyRun,
  digestOf,
  formatVerifyLine,
  nextEvidenceId,
  readVerifyRowsForIds,
  readVerifyRuns,
} from "../lib/verify.ts";
import {
  STORE_LOCK_MIN_STALE_MS,
  appendJsonl,
  appendJsonlLocked,
  ensureStore,
  readJsonl,
  storeDir,
  verifyRunsPath,
  withStoreLock,
} from "../lib/store.ts";
import { DEFAULT_CONFIG, DEFAULT_CONTRACT } from "../lib/defaults.ts";

function tmpStore(): string {
  return mkdtempSync(join(tmpdir(), "pc-store-"));
}

const cleanupSleep = new Int32Array(new SharedArrayBuffer(4));

function removeTreeAfterChildren(dir: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (attempt >= 40 || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(code ?? "")) throw err;
      Atomics.wait(cleanupSleep, 0, 0, 25);
    }
  }
}

const pythonExe = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const projectSrc = fileURLToPath(new URL("../../src", import.meta.url));

function pythonEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONPATH: [projectSrc, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  };
}

function runChild(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

test("events: tool_call keeps the command but records no outcome", () => {
  const e = toolCallEvent("s1", "bash", { cmd: "npm test" });
  assert.equal(e.kind, "tool_call");
  assert.equal(e.cmd, "npm test", "an attempted call keeps what was run");
  assert.equal(e.ok, null, "no outcome yet");
  assert.equal(e.ms, null);
  assert.equal(e.out_chars, null);
  assert.equal(e.exit, null);
});

test("events: refused tool_call is ok=false and keeps its command", () => {
  const e = toolCallEvent("s1", "bash", { cmd: "pytest -q", blocked: true });
  assert.equal(e.kind, "tool_call");
  assert.equal(e.ok, false);
  assert.equal(e.cmd, "pytest -q", "a blocked attempt is never anonymous");
  assert.equal(e.exit, null, "nothing ran, so there is no exit code");
});

test("events: bash tool_result carries normalized cmd + exit", () => {
  const e = toolResultEvent("s1", "bash", { ok: false, ms: 12, outChars: 30, cmd: "npm test", exit: 1 });
  assert.equal(e.kind, "tool_result");
  assert.equal(e.ok, false);
  assert.equal(e.cmd, "npm test");
  assert.equal(e.exit, 1);
  const nonBash = toolResultEvent("s1", "read", { ok: true, ms: 1, outChars: 10 });
  assert.equal(nonBash.cmd, null);
  assert.equal(nonBash.exit, null);
});

test("events: exit code parsed from bash error text (last occurrence wins)", () => {
  assert.equal(bashExitFromResult("output...\nCommand exited with code 2"), 2);
  assert.equal(bashExitFromResult("Command exited with code 1\nlater\nCommand exited with code 127"), 127);
  assert.equal(bashExitFromResult("no exit marker here"), null);
});

test("store: shared lease wraps appends, supports nesting, and is removed", () => {
  const dir = tmpStore();
  try {
    ensureStore(dir);
    const file = join(dir, ".agent-guard", "events.jsonl");
    appendJsonl(file, { a: 1 });
    assert.equal(existsSync(join(dir, ".agent-guard", ".lock.d")), false, "no lingering lease");
    const inside = withStoreLock(join(dir, ".agent-guard"), () => {
      // Public appendJsonl reacquires the lock. Same-thread nesting must reuse
      // the lease instead of timing out on itself.
      appendJsonl(file, { b: 2 });
      withStoreLock(join(dir, ".agent-guard"), () => appendJsonlLocked(file, { c: 3 }));
      return readJsonl(file).length;
    });
    assert.equal(inside, 3);
    assert.equal(existsSync(join(dir, ".agent-guard", ".lock.d")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: appendJsonl + readJsonl roundtrip with cache invalidation", () => {
  const dir = tmpStore();
  try {
    ensureStore(dir);
    const file = join(dir, ".agent-guard", "events.jsonl");
    appendJsonl(file, toolCallEvent("s1", "bash"));
    appendJsonl(file, toolResultEvent("s1", "bash", { ok: true, ms: 5, outChars: 1, cmd: "ls", exit: 0 }));
    assert.equal(readJsonl(file).length, 2);
    appendJsonl(file, toolCallEvent("s1", "bash")); // cache must invalidate
    assert.equal(readJsonl(file).length, 3);
    assert.equal(readJsonl(join(dir, ".agent-guard", "missing.jsonl")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: malformed lines are skipped, valid records survive", () => {
  const dir = tmpStore();
  try {
    ensureStore(dir);
    const file = join(dir, ".agent-guard", "journal.jsonl");
    appendFileSync(file, "{\"ts\":\"t\",\"type\":\"note\",\"text\":\"ok\",\"tags\":[]}\n", "utf8");
    appendFileSync(file, "NOT JSON AT ALL\n", "utf8");
    appendFileSync(file, "null\n42\n\"scalar\"\n[]\n", "utf8");
    appendFileSync(file, "{\"ts\":\"t2\",\"type\":\"risk\",\"text\":\"ok2\",\"tags\":[]}\n", "utf8");
    assert.equal(readJsonl(file).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: an old live-owner lease is never stolen", () => {
  const dir = tmpStore();
  try {
    const guard = ensureStore(dir);
    const lockDir = join(guard, ".lock.d");
    mkdirSync(lockDir);
    const owner = { token: "live-owner", pid: process.pid, hostname: hostname(), created_ms: 0 };
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner), "utf8");
    const old = new Date(Date.now() - STORE_LOCK_MIN_STALE_MS - 1_000);
    utimesSync(lockDir, old, old);

    assert.throws(
      () => withStoreLock(guard, () => assert.fail("live lease was stolen"), {
        timeoutMs: 20,
        staleMs: STORE_LOCK_MIN_STALE_MS,
        retryMs: 2,
      }),
      /timed out acquiring store lock/,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")), owner);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: an old foreign-host lease fails closed", () => {
  const dir = tmpStore();
  try {
    const guard = ensureStore(dir);
    const lockDir = join(guard, ".lock.d");
    mkdirSync(lockDir);
    const owner = {
      token: "foreign-owner",
      pid: 2_147_483_647,
      hostname: `not-${hostname()}`,
      created_ms: 0,
    };
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner), "utf8");
    const old = new Date(Date.now() - STORE_LOCK_MIN_STALE_MS - 1_000);
    utimesSync(lockDir, old, old);

    assert.throws(
      () => withStoreLock(guard, () => assert.fail("foreign lease was stolen"), {
        timeoutMs: 20,
        staleMs: STORE_LOCK_MIN_STALE_MS,
        retryMs: 2,
      }),
      /timed out acquiring store lock/,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")), owner);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: an old lease from a dead local PID is reclaimed", () => {
  const dir = tmpStore();
  try {
    const guard = ensureStore(dir);
    const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
    assert.equal(dead.status, 0);
    assert.equal(typeof dead.pid, "number");
    const lockDir = join(guard, ".lock.d");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ token: "abandoned", pid: dead.pid, hostname: hostname(), created_ms: 0 }),
      "utf8",
    );
    const old = new Date(Date.now() - STORE_LOCK_MIN_STALE_MS - 1_000);
    utimesSync(lockDir, old, old);

    withStoreLock(guard, () => {
      const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")) as { token: string };
      assert.notEqual(owner.token, "abandoned");
    }, { timeoutMs: 200, staleMs: STORE_LOCK_MIN_STALE_MS });

    assert.equal(existsSync(lockDir), false);
    assert.deepEqual(readdirSync(guard).filter((name) => name.startsWith(".lock.d.reap.")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: body failures release the lease", () => {
  const dir = tmpStore();
  try {
    const guard = ensureStore(dir);
    assert.throws(
      () => withStoreLock(guard, () => { throw new Error("body failed"); }),
      /body failed/,
    );
    assert.equal(existsSync(join(guard, ".lock.d")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: release refuses to remove a replacement owner", () => {
  const dir = tmpStore();
  try {
    const guard = ensureStore(dir);
    const lockDir = join(guard, ".lock.d");
    const replacement = {
      token: "replacement",
      pid: process.pid,
      hostname: hostname(),
      created_ms: Date.now(),
    };
    assert.throws(
      () => withStoreLock(guard, () => {
        writeFileSync(join(lockDir, "owner.json"), JSON.stringify(replacement), "utf8");
      }),
      /ownership changed before release/,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")), replacement);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: Python and Node contend on one lease", () => {
  const dir = tmpStore();
  try {
    const guard = ensureStore(dir);
    const script = [
      "import os, sys",
      "from protect_context import store",
      "os.chdir(sys.argv[1])",
      "try:",
      "    with store.store_lock(timeout_s=0.05, retry_s=0.005):",
      "        raise SystemExit(9)",
      "except TimeoutError:",
      "    print('blocked')",
    ].join("\n");

    const result = withStoreLock(guard, () => spawnSync(
      pythonExe,
      ["-c", script, dir],
      { cwd: process.cwd(), env: pythonEnv(), encoding: "utf8", timeout: 5_000 },
    ));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /blocked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: concurrent Python and Node allocators produce unique evidence ids", async () => {
  const dir = tmpStore();
  try {
    ensureStore(dir);
    const pythonScript = [
      "import os, sys, time",
      "from protect_context import store",
      "os.chdir(sys.argv[1])",
      "def allocate():",
      "    rows = store.read_jsonl(store.verify_path())",
      "    nums = [int(r['id'][3:]) for r in rows if str(r.get('id', '')).startswith('ev-')]",
      "    return {'id': f\"ev-{max(nums, default=0) + 1:04d}\", 'writer': 'python'}",
      "for _ in range(30):",
      "    store.locked_append(store.verify_path(), allocate)",
      "    time.sleep(0.001)",
      "os.chdir(sys.argv[2])",
    ].join("\n");

    const storeUrl = pathToFileURL(fileURLToPath(new URL("../lib/store.ts", import.meta.url))).href;
    const verifyUrl = pathToFileURL(fileURLToPath(new URL("../lib/verify.ts", import.meta.url))).href;
    const nodeScript = [
      `import { appendJsonlLocked, readJsonl, storeDir, verifyRunsPath, withStoreLock } from ${JSON.stringify(storeUrl)};`,
      `import { nextEvidenceId } from ${JSON.stringify(verifyUrl)};`,
      "const cwd = process.argv[1];",
      "const file = verifyRunsPath(cwd);",
      "const sleeper = new Int32Array(new SharedArrayBuffer(4));",
      "for (let i = 0; i < 30; i += 1) {",
      "  withStoreLock(storeDir(cwd), () => {",
      "    const rows = readJsonl(file);",
      "    appendJsonlLocked(file, { id: nextEvidenceId(rows), writer: 'node' });",
      "  });",
      "  Atomics.wait(sleeper, 0, 0, 1);",
      "}",
    ].join("\n");

    const outcomes = await Promise.allSettled([
      runChild(pythonExe, ["-c", pythonScript, dir, process.cwd()], {
        cwd: process.cwd(),
        env: pythonEnv(),
      }),
      runChild(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", nodeScript, dir], {
        cwd: process.cwd(),
        env: process.env,
      }),
    ]);
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failures.length > 0) {
      throw new Error(
        `cross-runtime writers failed:\n${failures.map((failure) => String(failure.reason)).join("\n")}`,
      );
    }

    const rows = readJsonl<{ id: string; writer: string }>(verifyRunsPath(dir));
    assert.equal(rows.length, 60);
    assert.equal(new Set(rows.map((row) => row.id)).size, 60);
    assert.deepEqual(
      rows.map((row) => Number(row.id.slice(3))).sort((a, b) => a - b),
      Array.from({ length: 60 }, (_, index) => index + 1),
    );
    assert.equal(rows.filter((row) => row.writer === "python").length, 30);
    assert.equal(rows.filter((row) => row.writer === "node").length, 30);
  } finally {
    // Windows may briefly retain a just-exited child's directory handle.
    removeTreeAfterChildren(dir);
  }
});

test("verify: digest = last ≤2000 chars of combined stdout+stderr", () => {
  assert.equal(digestOf("abc", "def"), "abcdef");
  const big = "x".repeat(2500);
  const d = digestOf(big, "ERR");
  assert.equal(d.length, 2000);
  assert.equal(d.slice(-3), "ERR");
});

test("verify: evidence ids sequence per file", () => {
  assert.equal(nextEvidenceId([]), "ev-0001");
  const dir = tmpStore();
  try {
    ensureStore(dir);
    appendVerifyRun(dir, { id: "ev-0003", ts: "", session: "s", cmd: "x", exit: 0, ok: true, digest: "", ms: 1 });
    assert.equal(nextEvidenceId(readVerifyRuns(dir)), "ev-0004");
    assert.equal(readVerifyRuns(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: a torn jsonl tail does not swallow the next record", () => {
  const dir = tmpStore();
  try {
    const file = join(dir, "events.jsonl");
    writeFileSync(file, '{"n":1}\n{"n":"torn"', "utf8");
    appendJsonl(file, { n: 2 });
    assert.deepEqual(
      readJsonl<{ n: number }>(file).map((row) => row.n),
      [1, 2],
    );

    const whole = join(dir, "whole.jsonl");
    writeFileSync(whole, '{"n":1}', "utf8");
    appendJsonl(whole, { n: 2 });
    assert.deepEqual(
      readJsonl<{ n: number }>(whole).map((row) => row.n),
      [1, 2],
    );
  } finally {
    removeTreeAfterChildren(dir);
  }
});

test("verify: malformed ledger objects are ignored by the typed reader", () => {
  const dir = tmpStore();
  try {
    ensureStore(dir);
    appendFileSync(
      verifyRunsPath(dir),
      '{"id":"ev-0099","session":"s","ok":false}\n' +
        '{"id":"ev-0002","ts":"2026-09-02T00:00:00.000Z","session":"s","cmd":"x","exit":1,"ok":false,"digest":"bad","ms":1}\n',
      "utf8",
    );

    assert.deepEqual(readVerifyRuns(dir).map((run) => run.id), ["ev-0002"]);
    assert.equal(nextEvidenceId(readVerifyRowsForIds(dir)), "ev-0100");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify: compact line format", () => {
  assert.equal(
    formatVerifyLine({ id: "ev-0002", ts: "", session: "", cmd: "npm test", exit: 0, ok: true, digest: "", ms: 3200 }),
    "ev-0002 exit=0 'npm test' 3.2s",
  );
});

test("defaults: frozen sizes (pinned shape shared with Python)", () => {
  assert.equal(DEFAULT_CONTRACT.constraints.length, 12);
  assert.equal(DEFAULT_CONTRACT.version, 1);
  // 9 since brief_max_precedents joined the frozen config shape (both runtimes).
  assert.equal(Object.keys(DEFAULT_CONFIG).length, 9);
});
