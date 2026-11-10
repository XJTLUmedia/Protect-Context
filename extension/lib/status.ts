/**
 * Compact status dashboard shared by /guard-status, /guard-report and the
 * guard_status tool (SPEC §5). Pure formatting — no pi imports.
 */

import type { LoopInfo } from "./loops.ts";
import { CMD_DISPLAY_MAX, truncLine } from "./brief.ts";
import { formatVerifyLine, outcomeLabel, type VerifyRun } from "./verify.ts";

export interface StatusData {
  session: string;
  gitHead: string | null;
  /** True when inside a repository that has no first commit yet. */
  gitUnborn?: boolean;
  /** False when Git scope measurement failed or the cwd is not a worktree. */
  diffAvailable?: boolean;
  diffLines: number;
  diffFiles: number;
  /** Bounded untracked scanning makes diffLines a disclosed lower bound. */
  diffScanLimited?: boolean;
  diffSkippedFiles?: number;
  diffTruncatedFiles?: number;
  loops: LoopInfo[];
  evidenceCount: number;
  contractCount: number;
  lastVerify: VerifyRun | null;
  ctxPct: number | null;
  /** Configured diff thresholds (gatherStatus populates these from config.json,
   *  so the nudge never lies about a tuned threshold). */
  diffWarnLines: number;
  diffHardLines: number;
  diffWarnFiles: number;
  /** Journal size (optional: only populated where the view can read it). */
  journalCount?: number;
  /** Subset of journalCount tagged `agent` (model-written, never trusted). */
  agentNoteCount?: number;
  /** Task anchor (SPEC §1 #6). The dashboard answers "what am I doing" too, so
   *  it shows the same anchor the brief injects (audit 2026-11-10). */
  task?: { text: string; source?: string | null; ageS?: number | null } | null;
}

/** Two compact lines + Nudge. */
export function buildStatus(d: StatusData): string {
  const pct = d.ctxPct === null ? "?" : `${Math.round(d.ctxPct)}%`;
  const head = d.gitUnborn ? "unborn" : d.gitHead === null ? "norepo" : d.gitHead.slice(0, 8);
  const diff = d.diffAvailable === false
    ? "Δ=unknown"
    : `${d.diffScanLimited ? "Δ≥" : "Δ+"}${d.diffLines}L/${d.diffFiles}f`;
  const lines: string[] = [];
  lines.push(
    `PC s=${d.session.slice(0, 8)} git=${head} ${diff} ` +
      `loops=${d.loops.length} ev=${d.evidenceCount} contract=${d.contractCount} ctx=${pct}`,
  );
  if (d.diffAvailable === false) {
    lines.push("diff audit: scope unavailable");
  }
  if (d.diffScanLimited) {
    lines.push(
      `diff scan: lower bound (${d.diffSkippedFiles ?? 0} skipped, ${d.diffTruncatedFiles ?? 0} truncated)`,
    );
  }
  if (d.task && d.task.text) {
    const age = d.task.ageS === null || d.task.ageS === undefined ? "" : ` · ${formatAge(d.task.ageS)} ago`;
    const source = d.task.source ? ` · ${truncLine(d.task.source, 16)}` : "";
    lines.push(`task: ${truncLine(d.task.text, 120)}${source}${age}`);
  }
  if ((d.journalCount ?? 0) > 0) {
    // Make the read path discoverable: journal entries are not all re-injected.
    lines.push(
      `journal: ${d.journalCount} entries (${d.agentNoteCount ?? 0} agent) — guard_journal reads them; guard_recall searches`,
    );
  }
  if (d.lastVerify) {
    lines.push(`last verify: ${formatVerifyLine(d.lastVerify)}`);
  } else {
    lines.push("last verify: (none)");
  }
  lines.push(`Nudge: ${statusNudge(d)}`);
  return lines.join("\n");
}

function formatAge(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function statusNudge(d: StatusData): string {
  if (d.loops.length > 0) {
    return `change strategy — '${truncLine(d.loops[0]?.cmd ?? "", CMD_DISPLAY_MAX)}' failed ${d.loops[0]?.failures}x; do not re-run unchanged.`;
  }
  if (d.diffAvailable === false) {
    return "scope audit unavailable — inspect Git before treating the working tree as clean.";
  }
  if (d.diffLines >= d.diffHardLines) {
    return `diff hit the hard limit (≥ ${d.diffHardLines} lines) — stop and split before continuing.`;
  }
  if (d.diffLines >= d.diffWarnLines || d.diffFiles >= d.diffWarnFiles) {
    const threshold =
      d.diffFiles >= d.diffWarnFiles && d.diffLines < d.diffWarnLines
        ? `≥ ${d.diffWarnFiles} files`
        : `≥ ${d.diffWarnLines} lines`;
    return `diff is large (${threshold}) — split work before continuing.`;
  }
  if (d.diffScanLimited) {
    return "untracked scan was bounded — treat changed lines as a lower bound and inspect skipped files.";
  }
  if (d.lastVerify === null) {
    return "run /guard-verify <cmd> to create evidence before claiming success.";
  }
  if (outcomeLabel(d.lastVerify) === "UNTRUSTED") {
    return `last verify ${truncLine(d.lastVerify.id, 40)} exited 0 but is not trustworthy — re-run without a pipe or failure mask before claiming success.`;
  }
  return "verify before success claims; keep tool outputs bounded.";
}
