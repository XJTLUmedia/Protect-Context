/**
 * Evidence ledger (.agent-guard/verify_runs.jsonl) formatting (SPEC §1 #2, §2).
 * Pure logic — no pi imports; command execution lives in index.ts.
 */

import { appendJsonl, readJsonl, verifyRunsPath } from "./store.ts";
import { CMD_DISPLAY_MAX, truncLine } from "./brief.ts";
import { normalizeCommand } from "./fingerprint.ts";

export interface VerifyRun {
  id: string;
  ts: string;
  session: string;
  cmd: string;
  exit: number;
  ok: boolean;
  digest: string;
  ms: number;
}

/** CSI / OSC / single-character escapes. Stripped before the digest cap so
 * color from pytest and compilers does not crowd out the error text. */
const ANSI =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** FROZEN digest rule: last ≤2000 chars of combined stdout+stderr. */
export function digestOf(stdout: string, stderr: string): string {
  return stripAnsi(`${stdout}${stderr}`).slice(-2000);
}

/** A trailing failure mask, applied to unquoted text only. */
const MASK_TAIL = /(?:\|\||;)\s*(?:true|:|exit\s+0)\s*;*\s*$/;

export interface ShellShape {
  outside: string;
  pipe: boolean;
  orOp: boolean;
  closed: boolean;
}

/** Diagnostic scan. Quoted regions are ignored; this is not a shell parser. */
export function shellShape(command: string): ShellShape {
  const outside: string[] = [];
  let pipe = false;
  let orOp = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? "";
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) {
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      outside.push(" ");
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      outside.push(command[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") {
        orOp = true;
        outside.push("||");
        i += 1;
        continue;
      }
      pipe = true;
      outside.push("|");
      continue;
    }
    outside.push(ch);
  }
  return { outside: outside.join(""), pipe, orOp, closed: quote === null };
}

export function failureMasked(command: string): boolean {
  return MASK_TAIL.test(normalizeCommand(shellShape(command).outside));
}

/** POSIX single-quote escape for the shell rewrite below. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Exact trusted rewrite for a piped command, or "" when it does not apply.
 *  POSIX sh has no `pipefail`, so the rewrite runs the same command under bash
 *  instead of asking the model to hand-edit a pipeline. Mirrors
 *  verify.pipefail_rewrite() on the Python side. */
export function pipefailRewrite(command: unknown): string {
  if (typeof command !== "string" || command.trim() === "" || command.includes("pipefail")) return "";
  if (!shellShape(command).pipe) return "";
  return `bash -o pipefail -c ${shellQuote(command)}`;
}

/** Reasons an exit-0 result must not be cited as proof. Empty when clean. */
export function trustIssues(command: string): string[] {
  if (command.trim() === "") return [];
  const shape = shellShape(command);
  const issues: string[] = [];
  if (failureMasked(command)) {
    issues.push(
      "The command masks failure (`|| true`, `|| :`, `; true`, or similar), so exit 0 does not prove the check passed.",
    );
  }
  if (shape.pipe) {
    issues.push(
      "The command contains a pipeline. Without `set -o pipefail`, the shell exit status is only the last stage, so an earlier failure can still look like success.",
    );
  } else if (shape.orOp && !failureMasked(command)) {
    issues.push(
      "The command uses `||`. Exit 0 can come from a later alternative rather than the check you meant to run.",
    );
  }
  return issues;
}

/** Streak identity on top of the frozen fingerprint (`normalizeCommand` is unchanged).
 * A trailing `;` outside quotes and a trailing failure mask (`|| true`, `; :`)
 * collapse onto the underlying command. Quoted masks are left alone. */
export function loopKey(command: string): string {
  let fp = normalizeCommand(command);
  while (fp.endsWith(";") && shellShape(fp).closed) fp = fp.slice(0, -1).trim();
  const outside = normalizeCommand(shellShape(fp).outside);
  const stripped = outside.replace(MASK_TAIL, "").trim();
  if (stripped !== "" && stripped !== outside) return stripped;
  return fp;
}

export function outcomeLabel(run: { ok: boolean; cmd: string }): "ok" | "FAIL" | "UNTRUSTED" {
  if (run.ok !== true) return "FAIL";
  return trustIssues(run.cmd).length > 0 ? "UNTRUSTED" : "ok";
}

// Timeout clamps (mirrors verify._clamp_timeout on the Python side): a
// model-supplied timeout_s can never wedge the session.
export const TIMEOUT_MIN_S = 1;
export const TIMEOUT_MAX_S = 900;
export const TIMEOUT_DEFAULT_S = 180;

/** Clamp a timeout to [TIMEOUT_MIN_S, TIMEOUT_MAX_S]; non-finite input falls
 *  back to the default. Fractions are truncated to whole seconds. */
export function clampTimeoutS(v: number | null | undefined): number {
  const t = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : TIMEOUT_DEFAULT_S;
  return Math.max(TIMEOUT_MIN_S, Math.min(TIMEOUT_MAX_S, t));
}

/** Next evidence id "ev-NNNN" based on the max existing suffix. */
export function nextEvidenceId(runs: readonly unknown[]): string {
  let max = 0;
  for (const r of runs) {
    const id = r && typeof r === "object" ? (r as { id?: unknown }).id : null;
    const m = typeof id === "string" ? id.match(/^ev-(\d+)$/) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `ev-${String(max + 1).padStart(4, "0")}`;
}

export function readVerifyRuns(cwd: string): VerifyRun[] {
  return readJsonl<unknown>(verifyRunsPath(cwd)).filter(isVerifyRun);
}

/** Raw object rows are used only for collision-free id allocation. A damaged
 * row with a valid ev-NNNN id still reserves that id, even though typed views
 * correctly ignore the rest of the malformed record. */
export function readVerifyRowsForIds(cwd: string): unknown[] {
  return readJsonl<unknown>(verifyRunsPath(cwd));
}

function isVerifyRun(value: unknown): value is VerifyRun {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.ts === "string" &&
    typeof row.session === "string" &&
    typeof row.cmd === "string" &&
    typeof row.exit === "number" &&
    Number.isFinite(row.exit) &&
    typeof row.ok === "boolean" &&
    typeof row.digest === "string" &&
    typeof row.ms === "number" &&
    Number.isFinite(row.ms)
  );
}

export function appendVerifyRun(cwd: string, run: VerifyRun): void {
  appendJsonl(verifyRunsPath(cwd), run);
}

export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "?s";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One compact evidence line: `ev-0002 exit=0 'npm test' 3.2s`. The command
 *  is truncated (goal #12) — never inject an unbounded one-liner. */
export function formatVerifyLine(run: VerifyRun): string {
  const id = truncLine(run.id, 40) || "unknown-id";
  const exit = Number.isFinite(run.exit) ? run.exit : "?";
  const trust = outcomeLabel(run) === "UNTRUSTED" ? " UNTRUSTED" : "";
  return `${id} exit=${exit}${trust} '${truncLine(run.cmd, CMD_DISPLAY_MAX)}' ${formatMs(run.ms)}`;
}

const TAIL_LINES = 4;
const TAIL_WIDTH = 160;

function tailLines(digest: string, n = TAIL_LINES, width = TAIL_WIDTH): string[] {
  const lines = digest
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.slice(-n).map((line) => truncLine(line, width));
}

function failureGuidance(run: VerifyRun): { why: string; fix: string } {
  const digest = run.digest;
  const low = digest.toLowerCase();
  if (digest.startsWith("[guard_verify: could not run command]")) {
    return {
      why: "The verification runner could not start the command, so nothing was verified.",
      fix: "Check that the working directory still exists and the command is a valid shell string, then re-verify.",
    };
  }
  if (run.exit === 124 || low.includes("guard_verify: timeout")) {
    return {
      why: "Timed out (recorded as exit 124). The child was killed.",
      fix: "Fix the hang, or pass a larger timeout_s (max 900). A command that waits on input should not be used for verification.",
    };
  }
  if (run.exit === 127 || low.includes("command not found") || low.includes("not found")) {
    return {
      why: "Exit 127 usually means the program is not on PATH.",
      fix: "Check the executable name, the cwd above, and that the tool is installed. Then re-verify.",
    };
  }
  if (run.exit === 126) {
    return {
      why: "Exit 126 means the command was found but could not be executed.",
      fix: "Check that the path is a program rather than a directory, and that it has execute permission.",
    };
  }
  if (run.exit < 0) {
    return {
      why: `The process was killed by signal ${-run.exit}.`,
      fix: "Read the tail for the crash. Do not treat this as a passing run.",
    };
  }
  if (low.includes("syntax error") && (run.cmd.includes("[[") || digest.includes("[["))) {
    return {
      why: "The shell rejected the command. guard_verify uses `/bin/sh`, which may not be bash.",
      fix: "Rewrite without bashisms, or run `bash -c '...'` explicitly, then re-verify.",
    };
  }
  if (low.includes("no such file") || low.includes("cannot find the path")) {
    return {
      why: "A path in the command does not exist from this working directory.",
      fix: "Paths are relative to the cwd above. `cd` inside the command, or pass a path that exists, then re-verify.",
    };
  }
  return {
    why: `Exit ${run.exit} — the command failed.`,
    fix: "Read the tail, fix the cause, and re-verify the same claim. Do not claim success from this id.",
  };
}

/** Same report shape as Python `verify.render_entry` (ends with Nudge). */
export function renderVerifyReport(run: VerifyRun, cwd?: string): string {
  const label = outcomeLabel(run);
  const lines = [
    `PC verify ${truncLine(run.id, 40)} · exit ${run.exit} · ${label} · ${run.ms}ms`,
  ];
  if (cwd && cwd.trim() !== "") lines.push(`cwd: ${truncLine(cwd, 200)}`);
  const cmd = truncLine(run.cmd, 160);
  if (cmd) lines.push(`cmd: ${cmd}`);
  if (label === "FAIL") {
    const tail = tailLines(run.digest);
    lines.push(tail.length > 0 ? "tail:" : "tail: (no output)");
    for (const line of tail) lines.push(`  ${line}`);
    const guidance = failureGuidance(run);
    lines.push(`why: ${guidance.why}`);
    lines.push(`fix: ${guidance.fix}`);
    lines.push("Nudge: do not claim success from this run — fix the cause and re-verify.");
    return lines.join("\n");
  }
  const first = run.digest
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  lines.push(`digest: ${first ? truncLine(first, 160) : "(no output)"}`);
  if (label === "UNTRUSTED") {
    lines.push(`why: ${trustIssues(run.cmd).join(" ")}`);
    const rewrite = pipefailRewrite(run.cmd);
    if (rewrite !== "") {
      lines.push(`fix: re-run exactly this so every pipeline stage counts: ${rewrite} — do not cite this id as proof.`);
    } else {
      lines.push(
        "fix: drop the trailing failure mask and re-run the command as-is. Do not cite this id as proof.",
      );
    }
    lines.push("Nudge: this run is recorded, but exit 0 here is not evidence of success.");
    return lines.join("\n");
  }
  if (run.digest.trim() === "") {
    lines.push(
      "Nudge: cite this evidence id when claiming success. The command printed nothing — confirm it actually checks the claim.",
    );
  } else {
    lines.push("Nudge: cite this evidence id when claiming success.");
  }
  return lines.join("\n");
}

export function runsForSession(runs: VerifyRun[], session: string): VerifyRun[] {
  return runs.filter((r) => r.session === session);
}
