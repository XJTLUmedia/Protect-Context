/**
 * Store → BriefInput assembly for the pi extension.
 *
 * The assembly used to live inside index.ts, so a brief could only be built by
 * a running pi session. It is now a pure module, because the Python side grew
 * the same reader (`src/protect_context/brief.py`) and the two must render the
 * same text from the same store: `tests/test_brief.py` runs both from one
 * fixture. Anything changed here needs the Python twin changed with it.
 */

import { spawnSync } from "node:child_process";
import { type BriefInput, BRIEF_MAX_CHECKS, buildBrief } from "./brief.ts";
import { loadConfig } from "./config.ts";
import { loadContract } from "./contract.ts";
import type { GuardConfig } from "./defaults.ts";
import type { EventRecord } from "./events.ts";
import {
  type JournalEntry,
  intentClassified,
  readJournal,
  recentAgentEntries,
  sanitizeTags,
  trustedEntries,
} from "./journal.ts";
import { failedAttemptsFromLedgers, openLoopsFromMap } from "./loops.ts";
import { trustedRecallPool } from "./recall.ts";
import { eventsPath, loadState, readJsonl } from "./store.ts";
import { outcomeLabel, readVerifyRuns, runsForSession } from "./verify.ts";

/** Raw event ledger rows (the disk view of a session's command history). */
function readEvents(cwd: string): EventRecord[] {
  return readJsonl<EventRecord>(eventsPath(cwd));
}

/**
 * Run the commands that prove recent corrections still hold.
 *
 * This is the one place the extension executes store content, so the rules are
 * deliberately narrow (mirrors brief.collect_checks): only `correction` rows,
 * newest first, at most `brief_check_max`, each killed at
 * `brief_check_timeout_s`, output discarded (a proving command answers with its
 * exit code, not its log), and `brief_checks = false` turns execution off while
 * still printing the command in the brief.
 */
export function collectChecks(
  journal: JournalEntry[],
  cfg: GuardConfig,
  cwd: string,
): Array<{ id: string; cmd: string; status: string }> {
  if (!cfg.brief_checks) return [];
  const limit = Math.max(0, Math.min(cfg.brief_check_max, BRIEF_MAX_CHECKS));
  const timeoutMs = Math.max(1, Math.min(cfg.brief_check_timeout_s, 30)) * 1000;
  const out: Array<{ id: string; cmd: string; status: string }> = [];
  for (const entry of [...journal].reverse()) {
    if (out.length >= limit) break;
    if (entry.type !== "correction") continue;
    const command = typeof entry.check === "string" ? entry.check : "";
    if (command === "") continue;
    const run = spawnSync(command, {
      shell: true,
      cwd,
      timeout: timeoutMs,
      stdio: "ignore",
      windowsHide: true,
    });
    let status = "ERROR";
    if (run.error !== undefined && run.error !== null) {
      status = (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "TIMEOUT" : "ERROR";
    } else if (typeof run.status === "number") {
      status = run.status === 0 ? "HONORED" : "VIOLATED";
    }
    out.push({ id: entry.id ?? "(no id)", cmd: command.slice(0, 80), status });
  }
  return out;
}

/** Inputs `buildBrief` needs, read from the shared store. */
export function briefInputsFromStore(
  cwd: string,
  sessionId: string,
  cfg: GuardConfig = loadConfig(cwd).config,
): BriefInput {
  const journal = readJournal(cwd);
  const runs = runsForSession(readVerifyRuns(cwd), sessionId);
  const last = runs.length > 0 ? runs[runs.length - 1] : null;
  const loops = openLoopsFromMap(
    failedAttemptsFromLedgers(readEvents(cwd), readVerifyRuns(cwd), sessionId),
    cfg.loop_block_after,
    cfg.loop_reset_after_s * 1000,
  ).slice(0, 2);
  return {
    task: loadState(cwd)?.task?.text ?? null,
    contract: loadContract(cwd).constraints,
    // Full lists, never pre-sliced: buildBrief owns the caps and reports how
    // many rows each cap hid.
    precedents: [...journal].reverse().filter((entry) => sanitizeTags(entry.tags).includes("lesson")),
    precedentsCap: cfg.brief_max_precedents,
    decisions: trustedEntries(journal, "decision"),
    corrections: trustedEntries(journal, "correction"),
    unverifiedCorrections: recentAgentEntries(journal, journal.length).filter(
      (entry) => entry.type === "correction",
    ),
    agentNotes: recentAgentEntries(journal, journal.length).filter(
      (entry) => entry.type !== "correction",
    ),
    recallPool: trustedRecallPool(journal),
    // Newest first and uncapped: buildBrief applies BRIEF_MAX_INTENT and says
    // how many it hid, so a capped brief never implies the list ended.
    ownerIntent: [...intentClassified(journal)]
      .reverse()
      .map(({ entry }) => ({ type: entry.type, text: entry.text, tags: entry.tags })),
    loops,
    // The trust label travels with the id: a masked exit 0 must never read like
    // a clean run on the line that anchors evidence-before-success.
    // Executed here, not in buildBrief: the renderer stays pure so both
    // runtimes can be compared byte-for-byte on the same input.
    checks: collectChecks(journal, cfg, cwd),
    checksDisabled: !cfg.brief_checks,
    lastEvidence: last
      ? { id: last.id, exit: last.exit, cmd: last.cmd, ms: last.ms, label: outcomeLabel(last) }
      : null,
  };
}

/** Compose the brief for this project and session from the shared store. */
export function composeBriefFromStore(
  cwd: string,
  sessionId: string,
  cfg: GuardConfig = loadConfig(cwd).config,
): string {
  return buildBrief(briefInputsFromStore(cwd, sessionId, cfg));
}
