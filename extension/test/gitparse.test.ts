import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffVerdict,
  parseNumstat,
  parseShortstat,
  parseUntrackedPaths,
  scanUntrackedFiles,
} from "../lib/gitparse.ts";

const NUMSTAT_FIXTURE = [
  "12\t3\tsrc/a.py",
  "0\t5\tlib/b.ts",
  "-\t-\tlogo.png",
  "1\t0\tdir with space/c d.md",
  "",
].join("\n");

test("numstat: parses additions/deletions/paths incl. binary rows", () => {
  const parsed = parseNumstat(NUMSTAT_FIXTURE);
  assert.equal(parsed.fileCount, 4);
  assert.equal(parsed.lines, 21);
  assert.equal(parsed.files[0]?.path, "src/a.py");
  assert.equal(parsed.files[0]?.additions, 12);
  assert.equal(parsed.files[0]?.deletions, 3);
  assert.equal(parsed.files[2]?.binary, true);
  assert.equal(parsed.files[2]?.additions, 0);
  assert.equal(parsed.files[3]?.path, "dir with space/c d.md");
});

test("numstat: empty output", () => {
  const parsed = parseNumstat("");
  assert.equal(parsed.fileCount, 0);
  assert.equal(parsed.lines, 0);
});

test("numstat: filename whitespace is data, not formatting", () => {
  // Git can report a name that begins or ends with a space; trimming the line
  // before splitting would silently rename the path (Python splits raw).
  const parsed = parseNumstat("1\t2\t leading and trailing \n");
  assert.equal(parsed.files[0]?.path, " leading and trailing ");
  assert.equal(parsed.fileCount, 1);
});

const SHORTSTAT_FIXTURE = " 3 files changed, 120 insertions(+), 4 deletions(-)";

test("shortstat: parses files and summed lines", () => {
  assert.deepEqual(parseShortstat(SHORTSTAT_FIXTURE), { files: 3, lines: 124 });
});

test("shortstat: partial fixtures default missing parts to 0", () => {
  assert.deepEqual(parseShortstat(" 2 files changed, 7 insertions(+)"), { files: 2, lines: 7 });
  assert.deepEqual(parseShortstat(" 1 file changed, 2 deletions(-)"), { files: 1, lines: 2 });
  assert.deepEqual(parseShortstat(""), { files: 0, lines: 0 });
});

test("verdict: ok / warn / hard levels against thresholds", () => {
  const t = { diff_warn_lines: 400, diff_hard_lines: 800, diff_warn_files: 10 };
  assert.equal(diffVerdict(10, 2, t).level, "ok");
  assert.equal(diffVerdict(400, 2, t).level, "warn");
  assert.equal(diffVerdict(401, 2, t).level, "warn");
  assert.equal(diffVerdict(100, 10, t).level, "warn", "file-count warn");
  assert.equal(diffVerdict(800, 2, t).level, "hard");
  assert.equal(diffVerdict(900, 2, t).level, "hard");
});

test("verdict: a bounded untracked scan can never be ok", () => {
  const t = { diff_warn_lines: 400, diff_hard_lines: 800, diff_warn_files: 10 };
  assert.equal(diffVerdict(10, 2, t, true).level, "warn", "an incomplete count is a warning");
  assert.equal(diffVerdict(900, 2, t, true).level, "hard", "the hard limit still wins");
});

test("untracked paths: porcelain -z parser accepts only Git-selected ?? records", () => {
  const out =
    "?? src/new.ts\0!! ignored.log\0 M tracked.ts\0?? name with\nnewline.txt\0" +
    "?? .agent-guard/state.json\0?? .agent-guard\\events.jsonl\0";
  assert.deepEqual(parseUntrackedPaths(out), ["name with\nnewline.txt", "src/new.ts"]);
});

test("untracked paths: nested cwd excludes only its exact active store", () => {
  const out =
    "?? .agent-guard/root-state.json\0" +
    "?? packages/app/.agent-guard/state.json\0" +
    "?? packages/other/.agent-guard/user-file.txt\0";

  assert.deepEqual(parseUntrackedPaths(out, "packages/app/.agent-guard"), [
    ".agent-guard/root-state.json",
    "packages/other/.agent-guard/user-file.txt",
  ]);
});

test("untracked scan: counts bounded text lines and does not treat binary content as lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-untracked-"));
  try {
    writeFileSync(join(dir, "text.txt"), "one\ntwo", "utf8");
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0, 10, 10]));
    const scan = scanUntrackedFiles(dir, ["text.txt", "binary.bin", "missing.txt"], 800);
    assert.equal(scan.files, 3, "file count follows Git's exact path set");
    assert.equal(scan.lines, 2);
    assert.equal(scan.binaryFiles, 1);
    assert.equal(scan.skippedFiles, 1);
    assert.equal(scan.scanLimited, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("untracked scan: POSIX treats a Windows-git backslash as a separator", () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "pc-untracked-"));
  try {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.txt"), "a\nb\n", "utf8");
    const scan = scanUntrackedFiles(dir, ["sub\\nested.txt"], 800);
    assert.equal(scan.lines, 2);
    assert.equal(scan.skippedFiles, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("untracked scan: a symlinked parent cannot escape the repository root", () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "pc-untracked-link-"));
  try {
    // The git path `link/secret.txt` is lexically inside the repo while the
    // bytes live outside it: only resolving both sides proves containment.
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "a\nb\nc\n", "utf8");
    const repo = join(dir, "repo");
    mkdirSync(repo);
    symlinkSync(outside, join(repo, "link"), "dir");

    const scan = scanUntrackedFiles(repo, ["link/secret.txt"], 800);
    assert.equal(scan.lines, 0, "the outside file is never counted");
    assert.equal(scan.filesScanned, 0);
    assert.equal(scan.skippedFiles, 1);
    assert.equal(scan.scanLimited, true, "an unread path makes the count incomplete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
