/**
 * Compact renderers for the read-only guard surfaces SPEC §4 lists next to the
 * MCP server: evidence list, loop streaks, diff audit, context budget and
 * preflight (2026-11-10 parity fix — the pi extension used to expose 7 tools
 * while MCP exposed 13, so an agent under the extension alone could not look up
 * evidence, audit its own diff, or see why a re-run was blocked).
 *
 * Text assembly only: the caller supplies the facts, so every line is testable
 * without a store, a git binary, or a subprocess.
 */

import type { GuardConfig } from "./defaults.ts";
import { type LoopInfo, loopIsStale, shouldBlockLoop } from "./loops.ts";
import { normalizeOneLine } from "./text.ts";
import { type VerifyRun, outcomeLabel } from "./verify.ts";

export const STREAKS_SHOWN = 5;
export const PREFLIGHT_TOOLS_MAX = 20;
export const PROBE_TIMEOUT_MS = 2000;
export const PROBE_DEADLINE_MS = 15000;
export const VERSION_DISPLAY_MAX = 60;
export const TOP_TOOLS = 5;

function lastDigestLine(digest: string | null | undefined): string {
  if (typeof digest !== "string") return "";
  const lines = digest.split("\n").filter((l) => l.trim().length > 0);
  return lines.length > 0 ? normalizeOneLine(lines[lines.length - 1], 160) : "";
}

/** Evidence ledger window (mirrors Python `verify.render_recent`). */
export function renderEvidenceList(runs: VerifyRun[], total: number): string {
  if (runs.length === 0) {
    // A limit of 0 is a legitimate request for the count only; saying "none
    // recorded" there would be a lie about the ledger.
    if (total > 0) {
      return (
        `PC evidence · 0 of ${total} shown\n` +
        "Nudge: raise limit to list the newest runs, or pass evidence_id for one full report."
      );
    }
    return (
      "PC evidence · none recorded\n" +
      "Nudge: run guard_verify on the claim you are about to make — an id is the only proof."
    );
  }
  const lines = [`PC evidence · last ${runs.length} of ${total}`];
  const labels: string[] = [];
  for (const run of runs) {
    const label = outcomeLabel(run);
    labels.push(label);
    lines.push(`${run.id} ${label} exit ${run.exit} · ${run.ms}ms · ${normalizeOneLine(run.cmd, 60)}`);
    if (label !== "ok") {
      const last = lastDigestLine(run.digest);
      if (last) lines.push(`  └ ${last}`);
    }
  }
  // One nudge for the worst row present: telling the model to cite evidence
  // when the window is all failures would be actively wrong.
  if (labels.includes("FAIL")) {
    lines.push("Nudge: a FAIL row proves the check failed — fix the cause and re-verify before claiming success.");
  } else if (labels.includes("UNTRUSTED")) {
    lines.push("Nudge: UNTRUSTED rows exited 0 but do not prove the check — re-run them without a pipe or || true.");
  } else {
    lines.push("Nudge: cite an ok evidence id when claiming success; re-read a digest instead of re-running.");
  }
  return lines.join("\n");
}

/** One line per failing streak (count descending), then whether a re-run
 *  blocks. A streak below the threshold is still shown: knowing that the next
 *  failure arms the brake is the point of asking. */
export function renderLoops(
  streaks: LoopInfo[],
  cfg: GuardConfig,
  session: string,
  nowMs = Date.now(),
): string {
  const lines = [`PC loops · session ${normalizeOneLine(session, 80)}`];
  const ranked = [...streaks].filter((s) => s.failures > 0).sort((a, b) => b.failures - a.failures);
  if (ranked.length === 0) {
    lines.push("no repeated failing commands");
    lines.push("Nudge: before re-running a failed command, read the error and change something.");
    return lines.join("\n");
  }
  for (const info of ranked.slice(0, STREAKS_SHOWN)) {
    const failedAt = info.lastFailedAt ? Date.parse(info.lastFailedAt) : Number.NaN;
    const when = Number.isFinite(failedAt) ? ` · last ${Math.max(0, Math.round((nowMs - failedAt) / 1000))}s ago` : "";
    lines.push(`${normalizeOneLine(info.cmd, 60)} ×${info.failures}${when}`);
  }
  const blocking = ranked.some((info) =>
    shouldBlockLoop(info.failures, cfg.loop_block_after, info.lastFailedAt, cfg.loop_reset_after_s * 1000, nowMs),
  );
  if (blocking) {
    lines.push(`next identical run will be blocked (loop_block_after=${cfg.loop_block_after})`);
    lines.push(
      "Nudge: change approach or gather new information — do not re-run unchanged; " +
        "raise loop_block_after in .agent-guard/config.json to override.",
    );
  } else {
    // A streak that aged past loop_reset_after_s will NOT block: the brake
    // treats the next identical run as a probe. Saying "will trigger a block"
    // there is a false promise about the brake (mirrors Python's aged-out
    // branch, which the TS layer used to lack).
    const stale = ranked.filter((info) =>
      loopIsStale(info.lastFailedAt, cfg.loop_reset_after_s * 1000, nowMs),
    ).length;
    if (stale > 0) {
      lines.push(
        `${stale} streak(s) aged past loop_reset_after_s=${cfg.loop_reset_after_s}s — the next identical run is a probe`,
      );
      lines.push("Nudge: the brake forgets an idle streak, so a repeat is measured again — say what changed.");
    } else {
      lines.push("Nudge: another identical failure will trigger a block — change approach now.");
    }
  }
  return lines.join("\n");
}

export interface DiffAuditFacts {
  available: boolean;
  repo: boolean;
  unborn: boolean;
  files: number;
  lines: number;
  scanLimited: boolean;
  skippedFiles: number;
  truncatedFiles: number;
  warnLines: number;
  warnFiles: number;
  hardLines: number;
}

/** Same verdict boundaries as the status line, with the reason spelled out. */
export function renderDiffAudit(facts: DiffAuditFacts, baseline = "HEAD"): string {
  if (!facts.available) {
    const why = facts.repo ? "no baseline to diff against yet" : "not a git work tree";
    return `PC diff · error: ${why}\nNudge: run inside a git repository, or pass an explicit baseline ref.`;
  }
  const verdict =
    facts.lines >= facts.hardLines ? "hard" : facts.lines >= facts.warnLines || facts.files >= facts.warnFiles ? "warn" : "ok";
  const advice =
    verdict === "hard"
      ? `Nudge: ≥ ${facts.hardLines} changed lines — stop and split; large diffs are unreviewable.`
      : verdict === "warn"
        ? `Nudge: ≥ ${facts.warnLines} changed lines or ≥ ${facts.warnFiles} files — split the change into logical steps.`
        : "Nudge: diff is within budget — keep unrelated changes out.";
  const bounded = facts.scanLimited
    ? ` · bounded scan (${facts.skippedFiles} skipped, ${facts.truncatedFiles} truncated)`
    : "";
  const scope = facts.scanLimited && verdict !== "hard"
    ? "Nudge: untracked scope is only a lower bound — inspect skipped or truncated files before treating the diff as within budget."
    : advice;
  return (
    `PC diff · vs ${baseline}${facts.unborn ? " (unborn)" : ""} · ${facts.files} files · ${facts.lines} lines · verdict ${verdict}\n` +
    `${scope}${bounded}`
  );
}

export interface BudgetFacts {
  session: string;
  chars: number;
  events: number;
  top: Array<[string, number]>;
}

export function renderBudget(facts: BudgetFacts): string {
  const top = facts.top
    .slice(0, TOP_TOOLS)
    .map(([tool, chars]) => `${normalizeOneLine(tool, 40) || "unknown"}=${chars}`)
    .join(" · ");
  return (
    `PC budget · session ${normalizeOneLine(facts.session, 80)}\n` +
    `tool output: ${facts.chars} chars (~${Math.floor(facts.chars / 4)} tokens est) over ${facts.events} tool results\n` +
    `top: ${top || "none"}\n` +
    "Nudge: keep tool outputs bounded (head/tail/digest); use targeted reads, not whole-file dumps."
  );
}

export interface ToolProbe {
  tool: string;
  present: boolean;
  /** Compact version, or null when the probe did not prove one. */
  version: string | null;
  /** The tool ran but its version could not be read (timeout, nonzero exit). */
  incomplete: boolean;
}

export interface PreflightFacts {
  gitRepo: boolean;
  tools: ToolProbe[];
  missing: string[];
  omitted: number;
}

export type ProbeExec = (
  command: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<{ code: number; killed?: boolean; stdout?: string }>;

/** `git version 2.43.0` → `2.43.0`; anything else is truncated as-is. */
/** `git version 2.43.0` → `2.43.0`; `pip 24.0 from /x (python 3.12)` → `24.0`.
 *
 * The renderer prints the tool name itself, so a repeated token is noise; the
 * path after " from " is cut before truncation so a long directory cannot eat
 * the whole budget and hide the number (mirrors Python `_compact_version`). */
export function compactVersion(tool: string, stdout: string): string | null {
  const first = stdout.split("\n").find((line) => line.trim().length > 0) ?? "";
  const line = first.trim().split(" from ")[0] ?? "";
  if (!line) return null;
  let words = line.split(/\s+/).filter((w) => w.length > 0);
  const toolToken = tool.split("/").at(-1)?.toLowerCase() ?? "";
  // `git version 2.43.0` and `pytest 9.1.1` both lead with a token the renderer
  // already prints; strip tool name and the literal "version", in either order.
  while (words.length > 1 && ["version", toolToken].includes(words[0].toLowerCase())) {
    words = words.slice(1);
  }
  const compact = normalizeOneLine(words.join(" "), VERSION_DISPLAY_MAX);
  return compact || null;
}

/**
 * Probe each configured tool with `<tool> --version`, bounded per tool and by
 * one overall deadline, mirroring `preflight.run_preflight`. A probe that times
 * out or exits nonzero is "present but incomplete", never silently "missing":
 * the model must not conclude a tool is absent because it was slow.
 */
export async function probePreflight(
  tools: string[],
  exec: ProbeExec,
  opts: { gitRepo: boolean; deadlineMs?: number; now?: () => number },
): Promise<PreflightFacts> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? PROBE_DEADLINE_MS);
  const bounded = tools.slice(0, PREFLIGHT_TOOLS_MAX);
  const probes: ToolProbe[] = [];
  for (const tool of bounded) {
    if (now() >= deadline) {
      probes.push({ tool, present: true, version: null, incomplete: true });
      continue;
    }
    let res: { code: number; killed?: boolean; stdout?: string } | null = null;
    try {
      res = await exec(tool, ["--version"], { timeout: PROBE_TIMEOUT_MS });
    } catch {
      res = null;
    }
    if (res === null) {
      probes.push({ tool, present: false, version: null, incomplete: false });
      continue;
    }
    const incomplete = Boolean(res.killed) || res.code !== 0;
    const version = incomplete ? null : compactVersion(tool, res.stdout ?? "");
    probes.push({ tool, present: true, version, incomplete: incomplete || version === null });
  }
  return {
    gitRepo: opts.gitRepo,
    tools: probes,
    missing: probes.filter((p) => !p.present).map((p) => p.tool),
    omitted: Math.max(0, tools.length - bounded.length),
  };
}

export function renderPreflight(facts: PreflightFacts): string {
  const lines = [`PC preflight · git repo: ${facts.gitRepo ? "yes" : "NO"}`];
  const present = facts.tools.filter((t) => t.present);
  if (present.length > 0) {
    lines.push(present.map((t) => `${t.tool} ${t.version ?? "(version unavailable)"}`).join(" · "));
  }
  const issues = present.filter((t) => t.incomplete).map((t) => t.tool);
  if (issues.length > 0) {
    const visible = issues.slice(0, 5);
    const suffix = issues.length > visible.length ? ` (+${issues.length - visible.length} more)` : "";
    lines.push("version probe incomplete: " + visible.join(", ") + suffix);
  }
  if (facts.missing.length > 0) {
    lines.push("missing: " + facts.missing.join(", "));
    lines.push(
      facts.gitRepo
        ? "Nudge: install the missing tools before debugging code — this is an environment problem."
        : "Nudge: install the missing tools and run inside a git repository before debugging code.",
    );
  } else if (facts.omitted > 0 || issues.length > 0) {
    lines.push("missing: none among checked tools");
    lines.push("Nudge: preflight is incomplete — inspect unavailable versions and check omitted tools separately.");
  } else {
    lines.push("missing: none");
    lines.push(
      facts.gitRepo
        ? "Nudge: environment looks sane — investigate code, not the sandbox."
        : "Nudge: not a git repository — a diff audit cannot attribute changes here.",
    );
  }
  return lines.join("\n");
}
