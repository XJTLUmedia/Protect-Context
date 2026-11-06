import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatus, type StatusData } from "../lib/status.ts";

function data(over: Partial<StatusData>): StatusData {
  return {
    session: "sess-abcdef12",
    gitHead: "0123456789abcdef",
    diffLines: 0,
    diffFiles: 0,
    loops: [],
    evidenceCount: 0,
    contractCount: 12,
    lastVerify: null,
    ctxPct: 41,
    diffWarnLines: 400,
    diffHardLines: 800,
    diffWarnFiles: 10,
    ...over,
  };
}

test("status: nudge uses CONFIGURED diff thresholds, not a literal 400", () => {
  // diff_warn_lines tuned down to 100 → 150 lines must warn
  const d = data({ diffLines: 150, diffWarnLines: 100, diffHardLines: 800 });
  assert.match(buildStatus(d), /split work before continuing/);
  // same lines with default 400 → no diff complaint
  const d2 = data({ diffLines: 150 });
  assert.doesNotMatch(buildStatus(d2), /diff is large/);
  // hard limit from config wins over warn
  const d3 = data({ diffLines: 500, diffWarnLines: 100, diffHardLines: 450 });
  assert.match(buildStatus(d3), /hard/);
});

test("status: file-count threshold and unborn repository are visible", () => {
  const out = buildStatus(data({ gitHead: null, gitUnborn: true, diffFiles: 10, diffWarnFiles: 10 }));
  assert.match(out, /git=unborn/);
  assert.match(out, /≥ 10 files/);
});

test("status: loop commands are truncated in the nudge", () => {
  const long = "y".repeat(300);
  const d = data({ loops: [{ cmd: long, failures: 2, lastExit: 1 }] });
  const out = buildStatus(d);
  assert.ok(!out.includes(long), "unbounded cmd leaked into status");
  assert.ok(out.includes("…"), "truncation marker present");
});

test("status: an exit-0 pipeline is not a success nudge", () => {
  const out = buildStatus(
    data({
      lastVerify: {
        id: "ev-0004",
        ts: "",
        session: "",
        cmd: "false | true",
        exit: 0,
        ok: true,
        digest: "",
        ms: 1,
      },
    }),
  );
  assert.match(out, /UNTRUSTED/);
  assert.match(out, /not trustworthy/);
});

test("status: unavailable and bounded diff states never look clean", () => {
  const unavailable = buildStatus(data({ diffAvailable: false }));
  assert.match(unavailable, /Δ=unknown/);
  assert.match(unavailable, /scope audit unavailable/);

  const bounded = buildStatus(
    data({ diffScanLimited: true, diffLines: 25, diffFiles: 4, diffSkippedFiles: 2, diffTruncatedFiles: 1 }),
  );
  assert.match(bounded, /Δ≥25L\/4f/);
  assert.match(bounded, /lower bound \(2 skipped, 1 truncated\)/);
  assert.match(bounded, /treat changed lines as a lower bound/);
});
