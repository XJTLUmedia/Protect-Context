import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../lib/defaults.ts";
import {
  compactVersion,
  probePreflight,
  renderBudget,
  renderDiffAudit,
  renderEvidenceList,
  renderLoops,
  renderPreflight,
} from "../lib/report.ts";
import type { VerifyRun } from "../lib/verify.ts";

function run(over: Partial<VerifyRun>): VerifyRun {
  return {
    id: "ev-0001",
    ts: "2026-11-10T00:00:00Z",
    cmd: "npm test",
    exit: 0,
    ms: 12,
    ok: true,
    digest: "ok",
    session: "s",
    trust: [],
    ...over,
  } as VerifyRun;
}

test("report: the evidence window labels rows by trust, not by exit code", () => {
  const text = renderEvidenceList(
    [
      run({ id: "ev-0001", exit: 0, digest: "346 passed" }),
      run({ id: "ev-0002", exit: 0, cmd: "npm test | tail", digest: "line\n1 failed" }),
      run({ id: "ev-0003", exit: 1, ok: false, cmd: "pytest", digest: "2 failed\n1 passed" }),
    ],
    129,
  );
  assert.match(text, /^PC evidence · last 3 of 129$/m);
  assert.match(text, /ev-0001 ok exit 0/);
  assert.match(text, /ev-0002 UNTRUSTED exit 0 · 12ms · npm test \| tail/);
  assert.match(text, /└ 1 failed/, "a masked exit 0 carries the digest line that shows the failure");
  assert.match(text, /ev-0003 FAIL exit 1/);
  // One nudge for the worst row present — a FAIL outranks an UNTRUSTED row.
  assert.match(text, /Nudge: a FAIL row proves the check failed/);
  assert.doesNotMatch(text, /UNTRUSTED rows exited 0/);

  // limit=0 is a count request, not an empty ledger.
  assert.match(renderEvidenceList([], 12), /^PC evidence · 0 of 12 shown$/m);
  assert.match(renderEvidenceList([], 0), /^PC evidence · none recorded$/m);
});

test("report: loops show the streak, then whether the next re-run blocks", () => {
  const blocked = renderLoops(
    [{ cmd: "npm test", failures: 2, lastExit: 1, lastFailedAt: "2026-11-10T00:00:00Z" }],
    DEFAULT_CONFIG,
    "s",
    Date.parse("2026-11-10T00:00:10Z"),
  );
  assert.match(blocked, /^PC loops · session s$/m);
  assert.match(blocked, /^npm test ×2 · last 10s ago$/m);
  assert.match(blocked, /next identical run will be blocked \(loop_block_after=3\)/);

  // One failure is below the threshold: report the streak without claiming a block.
  const armed = renderLoops([{ cmd: "pytest", failures: 1, lastExit: 1 }], DEFAULT_CONFIG, "s");
  assert.match(armed, /^pytest ×1$/m);
  assert.doesNotMatch(armed, /will be blocked/);
  assert.match(armed, /Nudge: another identical failure will trigger a block/);

  assert.match(renderLoops([], DEFAULT_CONFIG, "s"), /no repeated failing commands/);
});

test("report: the diff audit states the verdict boundary that was crossed", () => {
  const base = {
    available: true,
    repo: true,
    unborn: false,
    files: 3,
    lines: 120,
    scanLimited: false,
    skippedFiles: 0,
    truncatedFiles: 0,
    warnLines: DEFAULT_CONFIG.diff_warn_lines,
    warnFiles: DEFAULT_CONFIG.diff_warn_files,
    hardLines: DEFAULT_CONFIG.diff_hard_lines,
  };
  assert.match(renderDiffAudit(base), /verdict ok[\s\S]*Nudge: diff is within budget/);
  assert.match(renderDiffAudit({ ...base, lines: 450 }), /verdict warn[\s\S]*split the change/);
  assert.match(renderDiffAudit({ ...base, lines: 900 }), /verdict hard[\s\S]*stop and split/);
  // A warn-sized diff whose untracked scan was bounded is only a lower bound.
  const bounded = renderDiffAudit({ ...base, lines: 450, scanLimited: true, skippedFiles: 27, truncatedFiles: 1 });
  assert.match(bounded, /bounded scan \(27 skipped, 1 truncated\)/);
  assert.match(bounded, /untracked scope is only a lower bound/);
  assert.match(renderDiffAudit({ ...base, available: false, repo: false }), /PC diff · error: not a git work tree/);
});

test("report: the budget names the tools that produced the bytes", () => {
  const text = renderBudget({ session: "s", chars: 4001, events: 3, top: [["read", 3000], ["bash", 1001]] });
  assert.match(text, /^PC budget · session s$/m);
  assert.match(text, /tool output: 4001 chars \(~1000 tokens est\) over 3 tool results/);
  assert.match(text, /^top: read=3000 · bash=1001$/m);
  assert.match(text, /Nudge: keep tool outputs bounded/);
  assert.match(renderBudget({ session: "s", chars: 0, events: 0, top: [] }), /^top: none$/m);
});

test("report: preflight distinguishes missing from slow, and never hangs on a tool", async () => {
  const calls: string[] = [];
  const exec = async (cmd: string) => {
    calls.push(cmd);
    if (cmd === "git") return { code: 0, stdout: "git version 2.43.0\n" };
    if (cmd === "node") return { code: 0, stdout: "v26.13.0\n" };
    if (cmd === "rg") return { code: 0, killed: true, stdout: "" };
    if (cmd === "pytest") return { code: 2, stdout: "usage error" };
    throw new Error("ENOENT");
  };
  const facts = await probePreflight(["git", "node", "rg", "pytest", "php"], exec, { gitRepo: true });
  assert.deepEqual(calls, ["git", "node", "rg", "pytest", "php"]);
  assert.deepEqual(
    facts.tools.map((t) => [t.tool, t.present, t.version]),
    [
      ["git", true, "2.43.0"],
      ["node", true, "v26.13.0"],
      ["rg", true, null],
      ["pytest", true, null],
      ["php", false, null],
    ],
    "a killed or nonzero probe stays present — absence must not be inferred from slowness",
  );
  assert.deepEqual(facts.missing, ["php"]);

  const text = renderPreflight(facts);
  assert.match(text, /^PC preflight · git repo: yes$/m);
  assert.match(text, /git 2\.43\.0 · node v26\.13\.0 · rg \(version unavailable\)/);
  assert.match(text, /version probe incomplete: rg, pytest/);
  assert.match(text, /missing: php/);
  assert.match(text, /Nudge: install the missing tools/);

  // Past the 20-tool cap the extras are counted, not silently dropped.
  const many = await probePreflight(Array.from({ length: 25 }, (_, i) => `t${i}`), exec, {
    gitRepo: false,
    now: () => 0,
  });
  assert.equal(many.tools.length, 20);
  assert.equal(many.omitted, 5);

  // An expired deadline degrades to "present but unproven" instead of a lie.
  let clock = 0;
  const late = await probePreflight(["git", "node"], exec, {
    gitRepo: true,
    deadlineMs: 0,
    now: () => (clock += 1),
  });
  assert.equal(late.tools.every((t) => t.present && t.incomplete), true);
});

test("report: an aged-out streak is reported as a probe, not as a future block", () => {
  // The brake forgets a streak older than loop_reset_after_s, so promising a
  // block there would be false (Python had this branch; the TS renderer did not).
  const cfg = { ...DEFAULT_CONFIG, loop_block_after: 3, loop_reset_after_s: 60 };
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const aged = renderLoops(
    [{ cmd: "npm run check", failures: 2, lastExit: 1, lastFailedAt: "2026-11-10T11:00:00.000Z" }],
    cfg,
    "default",
    now,
  );
  assert.match(aged, /aged past loop_reset_after_s=60s — the next identical run is a probe/);
  assert.doesNotMatch(aged, /will trigger a block/);
  // A fresh streak under the threshold still promises the block.
  const fresh = renderLoops(
    [{ cmd: "npm run check", failures: 1, lastExit: 1, lastFailedAt: "2026-11-10T11:59:30.000Z" }],
    cfg,
    "default",
    now,
  );
  assert.match(fresh, /another identical failure will trigger a block/);
});

test("report: a probed version repeats neither the tool name nor the install path", () => {
  // The renderer prints "<tool> <version>", so "git git 2.43.0" and a truncated
  // pip path were the real output before 2026-11-10.
  assert.equal(compactVersion("git", "git version 2.43.0\n"), "2.43.0");
  assert.equal(compactVersion("pytest", "pytest 9.1.1\n"), "9.1.1");
  assert.equal(
    compactVersion("pip", "pip 24.0 from /home/you/.venvs/very-long-name/lib/python3.12/site-packages/pip (python 3.12)\n"),
    "24.0",
  );
  assert.equal(compactVersion("node", "v26.13.0\n"), "v26.13.0");
  // ripgrep names itself differently from the binary, so the token survives.
  assert.equal(compactVersion("rg", "ripgrep 14.1.0 (rev 4649aa9)\n"), "ripgrep 14.1.0 (rev 4649aa9)");
  assert.equal(compactVersion("git", "   \n\n"), null);
});
