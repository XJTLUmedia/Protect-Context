import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampTimeoutS,
  digestOf,
  failureMasked,
  formatVerifyLine,
  loopKey,
  nextEvidenceId,
  renderVerifyReport,
  TIMEOUT_DEFAULT_S,
  TIMEOUT_MAX_S,
  TIMEOUT_MIN_S,
  type VerifyRun,
} from "../lib/verify.ts";

test("verify: timeout clamped to a sane range (mirrors Python _clamp_timeout)", () => {
  assert.equal(clampTimeoutS(10 ** 9), TIMEOUT_MAX_S);
  assert.equal(clampTimeoutS(0), TIMEOUT_MIN_S);
  assert.equal(clampTimeoutS(-5), TIMEOUT_MIN_S);
  assert.equal(clampTimeoutS(180), 180);
  assert.equal(clampTimeoutS(undefined), TIMEOUT_DEFAULT_S);
  assert.equal(clampTimeoutS(null), TIMEOUT_DEFAULT_S);
  assert.equal(clampTimeoutS(Number.NaN), TIMEOUT_DEFAULT_S);
  assert.equal(clampTimeoutS(Number.POSITIVE_INFINITY), TIMEOUT_DEFAULT_S);
  assert.equal(clampTimeoutS(45.9), 45); // truncated to whole seconds
});

test("verify: digest keeps the LAST 2000 chars of stdout+stderr", () => {
  assert.equal(digestOf("abc", "def"), "abcdef");
  const long = "x".repeat(2500);
  assert.equal(digestOf(long, "").length, 2000);
  const combined = "a".repeat(10) + long;
  assert.equal(digestOf("", combined), combined.slice(-2000));
});

test("verify: next evidence id allocates the sequential ev-NNNN", () => {
  const run = (id: string): VerifyRun => ({
    id,
    ts: "t",
    session: "s",
    cmd: "c",
    exit: 0,
    ok: true,
    digest: "",
    ms: 1,
  });
  assert.equal(nextEvidenceId([]), "ev-0001");
  assert.equal(nextEvidenceId([run("ev-0001"), run("ev-0002")]), "ev-0003");
  assert.equal(nextEvidenceId([run("ev-0041")]), "ev-0042");
  // malformed ids are ignored, not crashing the allocation
  assert.equal(nextEvidenceId([run("junk"), run("ev-0007")]), "ev-0008");
});

test("verify: ansi sequences are stripped before the 2000-char cap", () => {
  const colored = `\u001b[31m${"x".repeat(2500)}\u001b[0m`;
  const digest = digestOf(colored, "");
  assert.equal(digest.length, 2000);
  assert.equal(digest.includes("\u001b"), false);
});

test("verify: failure masks and pipelines are visible, quoted ones are not", () => {
  assert.equal(failureMasked("false || true"), true);
  assert.equal(failureMasked("pytest -q; true"), true);
  assert.equal(failureMasked("pytest -q; exit 0"), true);
  assert.equal(loopKey("npm test; exit 0"), "npm test");
  assert.equal(failureMasked('echo "|| true"'), false);
  assert.equal(loopKey("pytest -q;"), "pytest -q");
  assert.equal(loopKey("npm test || true"), "npm test");
  assert.equal(loopKey('echo "|| true"'), 'echo "|| true"');
  assert.equal(loopKey('echo ";"'), 'echo ";"');
});

test("verify: failure report says why and how to re-run; masked exit 0 is untrusted", () => {
  const failed = renderVerifyReport({
    id: "ev-0003",
    ts: "",
    session: "s",
    cmd: "definitely-missing-binary-xyz",
    exit: 127,
    ok: false,
    digest: "sh: definitely-missing-binary-xyz: not found",
    ms: 4,
  }, "/work/repo");
  assert.match(failed, /FAIL/);
  assert.match(failed, /cwd: \/work\/repo/);
  assert.match(failed, /PATH/);
  assert.match(failed, /^Nudge:/m);
  assert.equal(failed.trimEnd().split("\n").at(-1)?.startsWith("Nudge:"), true);

  const masked = renderVerifyReport({
    id: "ev-0004",
    ts: "",
    session: "s",
    cmd: "false | true",
    exit: 0,
    ok: true,
    digest: "",
    ms: 2,
  });
  assert.match(masked, /UNTRUSTED/);
  assert.match(masked, /pipefail/);
  assert.match(masked, /not evidence of success/);
});

test("verify: long commands are truncated in compact lines", () => {
  const line = formatVerifyLine({
    id: "ev-0009", ts: "", session: "", cmd: "z".repeat(300), exit: 1, ok: false, digest: "", ms: 5,
  });
  assert.ok(!line.includes("z".repeat(300)), "unbounded cmd leaked into evidence line");
  assert.ok(line.includes("…"), "truncation marker present");
});
