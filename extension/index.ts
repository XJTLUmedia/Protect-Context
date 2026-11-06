/**
 * protect-context — pi extension (automatic guardrail layer, SPEC §5).
 *
 * Entry point / wiring only: all logic lives in ./lib/*.ts (pi-import-free,
 * tested via `node --test --experimental-strip-types`). Zero npm runtime
 * dependencies; `typebox`, `@earendil-works/pi-coding-agent` and
 * `@earendil-works/pi-ai` are provided by the pi runtime (loaded via jiti).
 *
 * Hard rules honored here:
 * - no background processes/sockets/timers from the factory (deferred to
 *   session_start; nothing long-lived is started at all);
 * - session_shutdown is idempotent;
 * - every ctx.ui.* dialog is guarded by ctx.hasUI;
 * - event handlers never throw (catch → ctx.ui.notify).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, relative } from "node:path";

import { DEFAULT_CONFIG, type GuardConfig } from "./lib/defaults.ts";
import { loadConfig } from "./lib/config.ts";
import { matchRisk, normalizeCommand } from "./lib/fingerprint.ts";
import {
  appendJsonlLocked,
  defaultState,
  ensureStore,
  eventsPath,
  fileStamp,
  loadState,
  saveState,
  readJsonl,
  sessionState,
  type SessionState,
  storeDir,
  verifyRunsPath,
  withStoreLock,
} from "./lib/store.ts";
import {
  addConstraintWithStatus,
  contractLines,
  loadContract,
  personalConstraintCount,
  removeConstraint,
} from "./lib/contract.ts";
import {
  appendJournal,
  boundedReadLimit,
  countJournal,
  isJournalType,
  type JournalType,
  readJournal,
  READ_LIMIT_DEFAULT,
  recentAgentEntries,
  recentJournal,
  renderJournal,
  tagsWithRequired,
  trustedEntries,
} from "./lib/journal.ts";
import { toolCallEvent, toolResultEvent, bashExitFromResult, type EventRecord } from "./lib/events.ts";
import {
  failedAttemptsFromLedgers,
  loopBlockReason,
  openLoopsFromMap,
  shouldBlockLoop,
  type LoopInfo,
} from "./lib/loops.ts";
import {
  buildBrief,
  sha1Hex,
  BRIEF_MAX_CONTRACT_LINES,
  CMD_DISPLAY_MAX,
  TASK_DISPLAY_MAX,
  truncLine,
} from "./lib/brief.ts";
import { parseNumstat, parseUntrackedPaths, scanUntrackedFiles } from "./lib/gitparse.ts";
import { renderWidget } from "./lib/widget.ts";
import { checkContractSummary, renderChecklist } from "./lib/contract_check.ts";
import { renderOrientation, scanOrientation } from "./lib/orientation.ts";
import {
  clampTimeoutS,
  digestOf,
  formatMs,
  nextEvidenceId,
  readVerifyRuns,
  readVerifyRowsForIds,
  runsForSession,
  type VerifyRun,
} from "./lib/verify.ts";
import { buildStatus, type StatusData } from "./lib/status.ts";
import { LIMIT_DEFAULT as RECALL_LIMIT_DEFAULT, type RecallType, renderRecall, searchStore, trustedRecallPool } from "./lib/recall.ts";

const WIDGET_ID = "protect-context";
const BRIEF_CUSTOM_TYPE = "guard-brief";
/** Upper clamp for guard_verify timeouts (keep in sync with verify.TIMEOUT_MAX_S). */
const MAX_VERIFY_TIMEOUT_S = 900;
/** A prompt shorter than this is a follow-up ("continue", "go on"), not a task
 *  statement — capturing it would erase the real request. */
const TASK_MIN_CAPTURE_CHARS = 20;

export default function (pi: ExtensionAPI) {
  // Session-scoped state (rebuilt on every session_start; new extension
  // instances are created per session by pi).
  let session = { id: "", started: "", gitHead: null as string | null, gitUnborn: false };
  let cfg: GuardConfig = { ...DEFAULT_CONFIG, preflight_tools: [...DEFAULT_CONFIG.preflight_tools] };
  let state = defaultState("", null);
  // Live view of THIS session's baseline inside `state.sessions`; the scratch
  // default only covers handlers that fire before session_start.
  let view: SessionState = {
    started: "",
    git_head: null,
    brief_digest: null,
    notify_watermarks: { ctx_pct: 0, diff_lines: 0, diff_files: 0 },
  };
  const startTimes = new Map<string, { start: number; tool: string; cmd: string | null }>();
  let lastDiff = { lines: 0, files: 0, available: false, lowerBound: false };
  let lastCtxPct: number | null = null;
  // Mid-run re-injection (SPEC §5): a threshold/overflow compaction retries the
  // run via AgentStart, so before_agent_start never fires for it. session_compact
  // arms this flag; the `context` handler (per LLM request) then re-asserts the
  // guard block until a persisted one is seen again. Outside that window the
  // handler is an O(1) no-op; inside it the block is rebuilt per request, so a
  // note written after the compaction is included.
  let pendingReinject = false;

  // In-memory guardrail state (goal #12: O(1) hot paths — the event handlers
  // and widget never re-parse the JSONL files; disk reads happen once per
  // session and on the cold brief/status paths). Rebuilt on session_start,
  // updated incrementally in the handlers below.
  const loopState = new Map<string, LoopInfo>();
  let loopLedgerMemo: string | null = null;
  let evidenceCount = 0;
  // Evidence memo (goal #12 hot-path invariant): before_agent_start runs every
  // turn, and readJsonl already caches the ledger parse by mtime+size — this
  // memo additionally skips the per-session filter and last-run scan, so the
  // per-turn cost stays O(1) as the ledger grows. Any writer's append
  // (extension, MCP server, CLI) changes mtime+size → memo recomputes, so
  // externally recorded runs are still picked up.
  let evidenceMemo: { stamp: string | null; sessionId: string; last: VerifyRun | null; count: number } | null = null;
  // Blocked tool calls: pi still emits tool_execution_end for them (with the
  // block reason as the "result") — those end events must NOT be recorded as
  // failed tool results, or loop streaks inflate on every blocked attempt.
  const blockedToolCallIds = new Set<string>();
  // Orientation digest (goal #4): one scan per session, injected from
  // before_agent_start when its digest changes.
  let orientationText: string | null = null;

  /** Frozen watermark defaults are zero, so a configured zero threshold needs
   * an explicit first-notification bit instead of the usual `watermark < 0`.
   * Positive thresholds retain the original monotonic watermark behavior. */
  function thresholdDue(value: number, threshold: number, watermark: number, zeroKey: string): boolean {
    if (value < threshold) return false;
    if (threshold === 0) return state.counters[zeroKey] !== 1;
    return watermark < threshold;
  }

  function markZeroThreshold(threshold: number, zeroKey: string): void {
    if (threshold === 0) state.counters[zeroKey] = 1;
  }

  // --- helpers ---------------------------------------------------------

  /** Run an event/command body without ever throwing (SPEC §5). Synchronous
   *  bodies are accepted so a handler that only formats text does not need a
   *  token `async` wrapper. */
  async function attempt<T>(ctx: ExtensionContext, fn: () => Promise<T> | T): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      try {
        if (ctx.hasUI) ctx.ui.notify(`guard: ${err instanceof Error ? err.message : String(err)}`, "error");
      } catch {
        // No UI available; drop the error.
      }
      return undefined;
    }
  }

  function safeSessionId(ctx: ExtensionContext): string {
    try {
      const id = ctx.sessionManager.getSessionId();
      if (id) return id;
    } catch {
      // fall through to random id
    }
    return `pc-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function runGit(_ctx: ExtensionContext, args: string[]): Promise<string | null> {
    try {
      const res = await pi.exec("git", args, { timeout: 5000 });
      if (res.code !== 0) return null;
      return res.stdout;
    } catch {
      return null;
    }
  }

  /** Run a shell command string via sh (mirrors Python shell=True). The
   *  timeout is clamped to [1, MAX_VERIFY_TIMEOUT_S] (keep in sync with
   *  verify.TIMEOUT_MAX_S on the Python side) so a model-supplied value can
   *  never wedge the session for hours. */
  async function shExec(
    command: string,
    timeoutS: number,
    signal?: AbortSignal,
  ): Promise<{ exit: number; stdout: string; stderr: string; ms: number }> {
    const t0 = Date.now();
    const res = await pi.exec("sh", ["-c", command], {
      timeout: Math.min(MAX_VERIFY_TIMEOUT_S, Math.max(1, timeoutS)) * 1000,
      signal,
    });
    const ms = Date.now() - t0;
    const exit = res.killed && res.code === 0 ? 124 : res.code;
    return { exit, stdout: res.stdout ?? "", stderr: res.stderr ?? "", ms };
  }

  function readEvents(cwd: string): EventRecord[] {
    return readJsonl<EventRecord>(eventsPath(cwd));
  }

  function loopLedgerStamp(cwd: string): string {
    return `${fileStamp(eventsPath(cwd)) ?? "-"}|${fileStamp(verifyRunsPath(cwd)) ?? "-"}`;
  }

  /** Replace the in-memory view while the shared store lock is held. */
  function rebuildLoopStateUnlocked(cwd: string): void {
    loopState.clear();
    for (const info of failedAttemptsFromLedgers(readEvents(cwd), readVerifyRuns(cwd), session.id).values()) {
      loopState.set(info.cmd, info);
    }
    loopLedgerMemo = loopLedgerStamp(cwd);
  }

  /** Rebuild at startup, or when a CLI/MCP peer changed either ledger. */
  function rebuildLoopState(cwd: string): void {
    withStoreLock(storeDir(cwd), () => rebuildLoopStateUnlocked(cwd));
  }

  function refreshLoopStateIfChanged(cwd: string): void {
    if (loopLedgerMemo === loopLedgerStamp(cwd)) return;
    withStoreLock(storeDir(cwd), () => {
      if (loopLedgerMemo !== loopLedgerStamp(cwd)) rebuildLoopStateUnlocked(cwd);
    });
  }

  interface DiffSnapshot {
    files: number;
    lines: number;
    repo: boolean;
    unborn: boolean;
    available: boolean;
    scanLimited: boolean;
    skippedFiles: number;
    truncatedFiles: number;
  }

  function unavailableDiff(repo: boolean, unborn: boolean): DiffSnapshot {
    return {
      files: 0,
      lines: 0,
      repo,
      unborn,
      available: false,
      scanLimited: false,
      skippedFiles: 0,
      truncatedFiles: 0,
    };
  }

  /** Count tracked, staged and non-ignored work against the session-start
   * baseline. `git status` supplies the untracked set so .gitignore semantics
   * remain Git's own; the bounded scanner only measures those selected files.
   * An unborn/no-repository-at-start session uses one empty-tree-to-working-
   * tree numstat instead of letting a mid-session commit reset the delta. */
  async function gatherDiff(ctx: ExtensionContext): Promise<DiffSnapshot> {
    const rootOut = await runGit(ctx, ["rev-parse", "--show-toplevel"]);
    if (rootOut === null || rootOut.trim() === "") return unavailableDiff(false, false);
    const root = rootOut.trim();
    const unborn = session.gitUnborn || session.gitHead === null;

    let tracked;
    if (unborn) {
      // A single diff from Git's repository-format-specific empty tree to the
      // final working tree avoids double-counting a staged file edited again.
      // `hash-object` without -w is read-only; pi.exec supplies EOF on stdin.
      const emptyTreeOut = await runGit(ctx, ["hash-object", "-t", "tree", "--stdin"]);
      const emptyTree = emptyTreeOut?.trim() ?? "";
      if (emptyTree === "") return unavailableDiff(true, true);
      const out = await runGit(ctx, ["diff", "--numstat", emptyTree, "--"]);
      if (out === null) return unavailableDiff(true, true);
      tracked = parseNumstat(out);
    } else {
      // A named commit compares the complete current working tree (including
      // commits made after session_start) with the frozen session baseline.
      const out = await runGit(ctx, ["diff", "--numstat", session.gitHead!, "--"]);
      if (out === null) return unavailableDiff(true, false);
      tracked = parseNumstat(out);
    }

    const status = await runGit(ctx, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"]);
    if (status === null) return unavailableDiff(true, unborn);
    const storeRelRaw = relative(root, storeDir(ctx.cwd));
    const storeRel = storeRelRaw.replaceAll("\\", "/");
    const activeStore =
      storeRel !== "" &&
      storeRel !== ".." &&
      !storeRel.startsWith("../") &&
      !isAbsolute(storeRelRaw)
        ? storeRel
        : null;
    const untrackedPaths = parseUntrackedPaths(status, activeStore);
    const untracked = scanUntrackedFiles(
      root,
      untrackedPaths,
      Math.max(0, cfg.diff_hard_lines - tracked.lines),
    );
    return {
      files: tracked.fileCount + untracked.files,
      lines: tracked.lines + untracked.lines,
      repo: true,
      unborn,
      available: true,
      scanLimited: untracked.scanLimited,
      skippedFiles: untracked.skippedFiles,
      truncatedFiles: untracked.truncatedFiles,
    };
  }

  /** Incremental loop-state update for a finished bash call (O(1)). */
  function recordLoopOutcome(cmd: string, ok: boolean, exit: number | null): void {
    if (ok) {
      loopState.delete(cmd); // success resets the streak (mirrors loops.py)
      return;
    }
    const cur = loopState.get(cmd) ?? { cmd, failures: 0, lastExit: null };
    cur.failures += 1;
    if (exit !== null) cur.lastExit = exit;
    loopState.set(cmd, cur);
  }

  /** Evidence for the current session, memoized by the ledger's mtime+size
   *  stamp (judge fix #2): the hot brief/status path never re-filters the
   *  whole ledger per turn. */
  function sessionEvidence(cwd: string): { last: VerifyRun | null; count: number } {
    const stamp = fileStamp(verifyRunsPath(cwd));
    if (evidenceMemo && evidenceMemo.sessionId === session.id && evidenceMemo.stamp === stamp) {
      evidenceCount = evidenceMemo.count;
      return { last: evidenceMemo.last, count: evidenceMemo.count };
    }
    const runs = runsForSession(readVerifyRuns(cwd), session.id);
    evidenceMemo = {
      stamp,
      sessionId: session.id,
      last: runs.length > 0 ? runs[runs.length - 1] : null,
      count: runs.length,
    };
    evidenceCount = evidenceMemo.count;
    return { last: evidenceMemo.last, count: evidenceMemo.count };
  }

  /** Number of fingerprints currently at/over the block threshold. */
  function openLoopCount(): number {
    let n = 0;
    for (const info of loopState.values()) {
      if (shouldBlockLoop(info.failures, cfg.loop_block_after)) n += 1;
    }
    return n;
  }

  function textLengthOf(result: unknown): { outChars: number; text: string } {
    const content = (result as { content?: unknown } | undefined)?.content;
    let outChars = 0;
    const parts: string[] = [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
          const t = (item as { text?: unknown }).text;
          if (typeof t === "string") {
            outChars += t.length;
            parts.push(t);
          }
        }
      }
    }
    return { outChars, text: parts.join("\n") };
  }

  function renderWidgetNow(ctx: ExtensionContext): void {
    try {
      // O(1): renders purely from in-memory counters (no JSONL re-read).
      const line = renderWidget({
        diffLines: lastDiff.lines,
        diffFiles: lastDiff.files,
        diffAvailable: lastDiff.available,
        diffLowerBound: lastDiff.lowerBound,
        loops: openLoopCount(),
        evidence: evidenceCount,
        ctxPct: lastCtxPct,
      });
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, [line]);
    } catch {
      // Widget is best-effort; never break the session over it.
    }
  }

  async function gatherStatus(ctx: ExtensionContext): Promise<StatusData> {
    refreshLoopStateIfChanged(ctx.cwd);
    const d = await gatherDiff(ctx);
    lastDiff = { files: d.files, lines: d.lines, available: d.available, lowerBound: d.scanLimited };
    const ev = sessionEvidence(ctx.cwd);
    const journal = readJournal(ctx.cwd);
    return {
      session: session.id,
      gitHead: session.gitHead,
      gitUnborn: d.unborn,
      diffAvailable: d.available,
      diffLines: d.lines,
      diffFiles: d.files,
      diffScanLimited: d.scanLimited,
      diffSkippedFiles: d.skippedFiles,
      diffTruncatedFiles: d.truncatedFiles,
      loops: openLoopsFromMap(loopState, cfg.loop_block_after),
      evidenceCount: ev.count,
      contractCount: loadContract(ctx.cwd).constraints.length,
      journalCount: journal.length,
      agentNoteCount: journal.filter((entry) =>
        (Array.isArray(entry.tags) ? entry.tags : []).includes("agent"),
      ).length,
      lastVerify: ev.last,
      ctxPct: lastCtxPct,
      diffWarnLines: cfg.diff_warn_lines,
      diffHardLines: cfg.diff_hard_lines,
      diffWarnFiles: cfg.diff_warn_files,
    };
  }

  /** Run + record a verification command; never raises on nonzero exit.
   *  Enforces the SAME policy as bash tool_call — risk confirm + loop check —
   *  so guard_verify cannot be used to bypass either guardrail. */
  async function runVerifyAndRecord(
    ctx: ExtensionContext,
    command: string,
    timeoutSraw: number,
    signal?: AbortSignal,
  ): Promise<string> {
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error("verification command must not be blank");
    }
    const fp = normalizeCommand(command);
    const timeoutS = clampTimeoutS(timeoutSraw);

    // (a) risk patterns → single grouped confirm; no-UI: log only, never block
    // (same semantics as bash tool_call; mirrors verify.match_risk journaling)
    const risk = matchRisk(fp);
    if (risk) {
      if (ctx.hasUI && cfg.risk_confirm) {
        const ok = await ctx.ui.confirm(
          "Risky command",
          `'${truncLine(fp, 160)}' matches '${risk}'. Run anyway?`,
        );
        if (!ok) {
          return `guard: risky command declined (${risk}) — not run, not recorded.\nNudge: split off the destructive step and run the safe part here.`;
        }
      } else {
        try {
          appendJournal(ctx.cwd, {
            type: "risk",
            text: `guard_verify ran a command matching risk pattern '${risk}': ${fp}`,
          });
        } catch {
          // journal is best-effort; never block the evidence write
        }
      }
    }

    // (b) loop check on fingerprint — identical arithmetic to the bash path
    refreshLoopStateIfChanged(ctx.cwd);
    const failures = loopState.get(fp)?.failures ?? 0;
    if (shouldBlockLoop(failures, cfg.loop_block_after)) {
      return `${loopBlockReason(truncLine(fp, CMD_DISPLAY_MAX), failures)}\nNudge: not run, not recorded — change approach or gather new information first.`;
    }

    const res = await shExec(command, timeoutS, signal);
    const run = withStoreLock(storeDir(ctx.cwd), () => {
      // A CLI/MCP writer may have appended while the command ran. Rebuild
      // before applying this outcome so its streak is neither lost nor
      // double-counted.
      if (loopLedgerMemo !== loopLedgerStamp(ctx.cwd)) rebuildLoopStateUnlocked(ctx.cwd);
      const r: VerifyRun = {
        // Id allocated INSIDE the store lock: two concurrent writers
        // (extension + MCP server + CLI) can never mint the same ev-NNNN.
        id: nextEvidenceId(readVerifyRowsForIds(ctx.cwd)),
        ts: new Date().toISOString(),
        session: session.id || "default",
        cmd: command.trim(),
        exit: res.exit,
        ok: res.exit === 0,
        digest: digestOf(res.stdout, res.stderr),
        ms: res.ms,
      };
      appendJsonlLocked(verifyRunsPath(ctx.cwd), r);
      recordLoopOutcome(fp, r.ok, r.exit);
      loopLedgerMemo = loopLedgerStamp(ctx.cwd);
      return r;
    });
    // Recompute from the stamped ledger so concurrent external evidence is
    // reflected in the widget rather than incrementing a stale counter.
    evidenceMemo = null;
    sessionEvidence(ctx.cwd);
    renderWidgetNow(ctx);
    const lines: string[] = [`${run.id} exit=${run.exit} ${formatMs(run.ms)} '${truncLine(run.cmd, CMD_DISPLAY_MAX)}'`];
    if (!run.ok) {
      // Failure diagnostics (pytest summaries, compiler errors) live at the
      // END of output — and the digest rule is "last ≤2000 chars" — so show
      // the TAIL, not the head, or the only visible preview is spent on banners.
      const tail = truncLine(run.digest.slice(-160), 160);
      if (tail) lines.push(`out: ${run.digest.length > 160 ? "…" : ""}${tail}`);
      lines.push(`Nudge: recorded the failure — fix or change approach; do not re-run unchanged.`);
    } else {
      lines.push(`Nudge: cite ${run.id} when claiming success.`);
    }
    return lines.join("\n");
  }

  // --- events ----------------------------------------------------------

  pi.on("session_start", async (_event, ctx) =>
    attempt(ctx, async () => {
      ensureStore(ctx.cwd);
      // Seed defaults for extension-only installs; existing user or corrupt
      // files are preserved by loadConfig.
      cfg = loadConfig(ctx.cwd, true).config;
      session.id = safeSessionId(ctx);
      const repoRoot = await runGit(ctx, ["rev-parse", "--show-toplevel"]);
      const head = await runGit(ctx, ["rev-parse", "--verify", "HEAD"]);
      loadContract(ctx.cwd); // seeds contract.json from DEFAULT_CONTRACT if missing

      const prev = loadState(ctx.cwd);
      state = prev ?? defaultState(session.id, null);
      // A session keeps ITS OWN baseline: a second pi session in the same
      // project must not reset this one's digest or watermarks (SPEC §2).
      const returning = prev !== null && prev.sessions[session.id] !== undefined;
      view = sessionState(state, session.id);
      if (returning && view.started !== "") {
        // Extension reloads can fire session_start again for the same pi
        // session. Preserve the original baseline from state instead of
        // silently resetting it to a newer commit.
        session.started = view.started;
        session.gitHead = view.git_head;
      } else {
        session.started = new Date().toISOString();
        session.gitHead = head?.trim() || null;
        view.started = session.started;
        view.git_head = session.gitHead;
        view.brief_digest = null;
      }
      state.current_session = { id: session.id, started: session.started, git_head: session.gitHead };
      saveState(ctx.cwd, state);
      // A null baseline inside a repository means the session began before a
      // first commit (or before repository creation). Keep using the empty
      // tree even if HEAD appears later, so commits cannot erase session diff.
      session.gitUnborn = repoRoot !== null && session.gitHead === null;
      // Warm the in-memory counters once per session (O(1) hot paths after this).
      pendingReinject = false;
      rebuildLoopState(ctx.cwd);
      evidenceCount = sessionEvidence(ctx.cwd).count;
      try {
        orientationText = renderOrientation(scanOrientation(ctx.cwd));
      } catch {
        orientationText = null; // orientation is best-effort
      }
      renderWidgetNow(ctx);
      return undefined;
    }),
  );

  /** Orientation text, scanned lazily once per session (goal #4). */
  function ensureOrientation(ctx: ExtensionContext): string | null {
    if (orientationText === null) {
      try {
        orientationText = renderOrientation(scanOrientation(ctx.cwd));
      } catch {
        orientationText = null;
      }
    }
    return orientationText;
  }

  /** Compose the brief from the store. Cold path: the digest gate decides
   *  re-injection, so this runs only when the text changed or after a
   *  compaction (goal #12). */
  function composeBrief(ctx: ExtensionContext): string {
    refreshLoopStateIfChanged(ctx.cwd);
    const contract = loadContract(ctx.cwd);
    const journal = readJournal(ctx.cwd);
    // In-memory streaks are the merged view (bash events + guard_verify
    // outcomes) — the disk events alone would miss verify streaks.
    const loops = openLoopsFromMap(loopState, cfg.loop_block_after).slice(0, 2);
    const last = sessionEvidence(ctx.cwd).last;
    return buildBrief({
      task: state.task?.text ?? null,
      contract: contract.constraints,
      // Full lists, not a pre-slice: buildBrief owns the display caps and
      // reports exactly how many entries those caps hid.
      decisions: trustedEntries(journal, "decision"),
      corrections: trustedEntries(journal, "correction"),
      agentNotes: recentAgentEntries(journal, journal.length),
      recallPool: trustedRecallPool(journal),
      loops,
      lastEvidence: last ? { id: last.id, exit: last.exit, cmd: last.cmd, ms: last.ms } : null,
    });
  }

  /** Full guard block (orientation + brief), forced past the digest gate. Only a
   *  compaction needs this: it removed the previously injected block. */
  function composeGuardBlock(ctx: ExtensionContext): string {
    const parts: string[] = [];
    const orientation = ensureOrientation(ctx);
    if (orientation !== null) parts.push(orientation);
    const brief = composeBrief(ctx);
    if (brief.trim() !== "") parts.push(brief);
    return parts.join("\n\n");
  }

  pi.on("before_agent_start", (_event, ctx) =>
    attempt(ctx, () => {
      const brief = composeBrief(ctx);
      const digest = sha1Hex(brief);
      const briefDue = brief.trim() !== "" && (cfg.brief_mode !== "changed" || view.brief_digest !== digest);

      const orientation = ensureOrientation(ctx);
      const orientDigest = orientation === null ? null : sha1Hex(orientation);
      const orientDue = orientDigest !== null && state.counters.orient_sha1 !== orientDigest;

      if (!briefDue && !orientDue) return undefined;

      const parts: string[] = [];
      if (orientDue && orientation !== null) parts.push(orientation);
      if (briefDue) parts.push(brief);
      if (parts.length === 0) return undefined;

      if (orientDue && orientDigest !== null) state.counters.orient_sha1 = orientDigest;
      if (briefDue) view.brief_digest = digest;
      // A persisted block now exists for this conversation, so the mid-run
      // re-assertion below has nothing left to repair.
      pendingReinject = false;
      saveState(ctx.cwd, state);
      return { message: { customType: BRIEF_CUSTOM_TYPE, content: parts.join("\n\n"), display: false } };
    }),
  );

  // Mid-run compaction (threshold / overflow recovery) resumes the run through
  // AgentStart, where before_agent_start never fires — so without this hook the
  // hidden brief would stay gone until the next user prompt (SPEC §1 #6). The
  // hook re-asserts the block on every request until a PERSISTED one is back in
  // the conversation; the restored message itself is per-request, so it must be
  // re-applied rather than remembered.
  pi.on("context", (event, ctx) =>
    attempt(ctx, () => {
      if (!pendingReinject) return undefined;
      const messages = Array.isArray(event.messages) ? event.messages : [];
      const persisted = messages.some(
        (message) => (message as { customType?: unknown } | null)?.customType === BRIEF_CUSTOM_TYPE,
      );
      if (persisted) {
        pendingReinject = false;
        return undefined;
      }
      const block = composeGuardBlock(ctx);
      if (block.trim() === "") return undefined;
      return {
        messages: [
          ...messages,
          {
            role: "custom",
            customType: BRIEF_CUSTOM_TYPE,
            content: block,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    }),
  );

  // Task capture (SPEC §1 #6): the owner's actual request is what a compaction
  // summary paraphrases away most often. The first substantive prompt becomes
  // the project task; `/guard-task` can replace or clear it (owner text wins).
  pi.on("input", (event, ctx) =>
    attempt(ctx, () => {
      // Extension-injected messages are not owner input, and `!` runs a shell
      // command rather than stating a task.
      if (event.source === "extension") return undefined;
      const text = typeof event.text === "string" ? event.text.trim() : "";
      if (text === "" || text.startsWith("/") || text.startsWith("!")) return undefined;
      const captured = truncLine(text, TASK_DISPLAY_MAX);
      if (captured === "" || Array.from(captured).length < TASK_MIN_CAPTURE_CHARS) return undefined;
      const existing = state.task;
      if (existing?.source === "owner" || existing?.text === captured) return undefined;
      state.task = { text: captured, source: "prompt", ts: new Date().toISOString() };
      // The brief changed: let this same turn re-inject it.
      view.brief_digest = null;
      saveState(ctx.cwd, state);
      return undefined;
    }),
  );

  pi.on("tool_call", async (event, ctx) =>
    attempt(ctx, async () => {
      if (event.toolName !== "bash") return undefined;
      if (!isToolCallEventType("bash", event)) return undefined;
      const raw = typeof event.input.command === "string" ? event.input.command : "";
      if (raw.trim() === "") return undefined;
      const fp = normalizeCommand(raw);

      // (a) risk patterns → single grouped confirm; no-UI: log only, never block
      const risk = matchRisk(fp);
      if (risk) {
        if (ctx.hasUI && cfg.risk_confirm) {
          const ok = await ctx.ui.confirm(
            "Risky command",
            `'${truncLine(fp, 160)}' matches '${risk}'. Run anyway?`,
          );
          if (!ok) {
            // pi still emits tool_execution_end for blocked calls (with the
            // block reason as the result) — mark it so the end handler does
            // not record the decline as a failed command.
            blockedToolCallIds.add(event.toolCallId);
            // Record the refused attempt: otherwise the shared audit trail keeps
            // no trace of the command the guard refused to run (SPEC §2).
            withStoreLock(storeDir(ctx.cwd), () => {
              appendJsonlLocked(
                eventsPath(ctx.cwd),
                toolCallEvent(session.id, "bash", { cmd: fp, blocked: true }),
              );
              loopLedgerMemo = loopLedgerStamp(ctx.cwd);
            });
            return { block: true, reason: `guard: risky command declined (${risk})` };
          }
        } else {
          // No-UI parity (judge fix #1): a risky bash run without a confirm
          // dialog must still reach the journal — runVerifyAndRecord and
          // Python verify.match_risk already do this, and a silent risky run
          // would be invisible to /guard-report and the brief.
          try {
            appendJournal(ctx.cwd, {
              type: "risk",
              text: `bash tool_call matched risk pattern '${risk}': ${fp}`,
            });
          } catch {
            // journal is best-effort; never block the tool call over it
          }
        }
      }

      // (b) Recheck + record atomically with respect to CLI/MCP writers. This
      // prevents an external second failure from being missed between a stale
      // in-memory check and the tool-call record.
      const blockedFailures = withStoreLock(storeDir(ctx.cwd), () => {
        if (loopLedgerMemo !== loopLedgerStamp(ctx.cwd)) rebuildLoopStateUnlocked(ctx.cwd);
        const failures = loopState.get(fp)?.failures ?? 0;
        if (shouldBlockLoop(failures, cfg.loop_block_after)) {
          appendJsonlLocked(
            eventsPath(ctx.cwd),
            toolCallEvent(session.id, "bash", { cmd: fp, blocked: true }),
          );
          loopLedgerMemo = loopLedgerStamp(ctx.cwd);
          return failures;
        }
        appendJsonlLocked(eventsPath(ctx.cwd), toolCallEvent(session.id, "bash", { cmd: fp }));
        return null;
      });
      if (blockedFailures !== null) {
        blockedToolCallIds.add(event.toolCallId);
        return { block: true, reason: loopBlockReason(truncLine(fp, CMD_DISPLAY_MAX), blockedFailures) };
      }

      return undefined;
    }),
  );

  pi.on("tool_execution_start", async (event, _ctx) => {
    try {
      let cmd: string | null = null;
      if (event.toolName === "bash") {
        const command = (event.args as { command?: unknown } | undefined)?.command;
        if (typeof command === "string") cmd = normalizeCommand(command);
      }
      startTimes.set(event.toolCallId, { start: Date.now(), tool: event.toolName, cmd });
    } catch {
      // timing is best-effort
    }
    return undefined;
  });

  pi.on("tool_execution_end", async (event, ctx) =>
    attempt(ctx, async () => {
      const meta = startTimes.get(event.toolCallId);
      startTimes.delete(event.toolCallId);

      if (blockedToolCallIds.has(event.toolCallId)) {
        // Blocked in tool_call: the "result" here is the block reason, not a
        // real tool outcome. Recording it as a failed command would inflate
        // loop streaks (risk-declines and loop-blocks are not command runs).
        blockedToolCallIds.delete(event.toolCallId);
        return undefined;
      }

      const ms = meta ? Date.now() - meta.start : null;
      const { outChars, text } = textLengthOf(event.result);

      let cmd: string | null = null;
      let exit: number | null = null;
      let ok: boolean | null = !event.isError;
      if (event.toolName === "bash") {
        cmd = meta?.cmd ?? null;
        if (event.isError) {
          exit = bashExitFromResult(text);
          // isError is authoritative even when a provider omits the textual
          // exit-code suffix. Unknown exit remains null, but the outcome must
          // still count as a failure rather than silently disappearing from
          // loop protection.
          ok = false;
        } else {
          // Pi omits bash exit details on success; persist the known shell
          // convention explicitly so the shared event format is unambiguous.
          exit = 0;
          ok = true;
        }
      }

      withStoreLock(storeDir(ctx.cwd), () => {
        if (loopLedgerMemo !== loopLedgerStamp(ctx.cwd)) rebuildLoopStateUnlocked(ctx.cwd);
        appendJsonlLocked(
          eventsPath(ctx.cwd),
          toolResultEvent(session.id, event.toolName, { ok, ms, outChars, cmd, exit }),
        );
        // Incremental streak update (bash only). The rebuild above first
        // incorporates external writers, then this result is applied once.
        if (cmd !== null && ok !== null) recordLoopOutcome(cmd, ok, exit);
        loopLedgerMemo = loopLedgerStamp(ctx.cwd);
      });

      renderWidgetNow(ctx);
      return undefined;
    }),
  );

  pi.on("turn_end", async (_event, ctx) =>
    attempt(ctx, async () => {
      // Context usage watermarks (goal #12)
      try {
        const usage = ctx.getContextUsage();
        if (usage && usage.percent !== null) {
          lastCtxPct = usage.percent;
          const step = Math.floor(usage.percent / 10) * 10;
          const contextDue =
            step >= cfg.ctx_warn_pct &&
            (step > view.notify_watermarks.ctx_pct ||
              (cfg.ctx_warn_pct === 0 && state.counters.ctx_zero_notified !== 1));
          if (contextDue) {
            view.notify_watermarks.ctx_pct = step;
            markZeroThreshold(cfg.ctx_warn_pct, "ctx_zero_notified");
            saveState(ctx.cwd, state);
            if (ctx.hasUI) {
              ctx.ui.notify(
                `guard: context at ${Math.round(usage.percent)}% — consider /compact to free budget.`,
                "warning",
              );
            }
          }
        }
      } catch {
        // usage is best-effort
      }

      // Diff budget (goal #8)
      const diff = await gatherDiff(ctx);
      lastDiff = {
        files: diff.files,
        lines: diff.lines,
        available: diff.available,
        lowerBound: diff.scanLimited,
      };
      if (diff.repo && diff.available) {
        const { files, lines } = diff;
        const wm = view.notify_watermarks;
        if (lines >= cfg.diff_hard_lines) {
          if (thresholdDue(lines, cfg.diff_hard_lines, wm.diff_lines, "diff_hard_zero_notified")) {
            wm.diff_lines = Math.max(wm.diff_lines, cfg.diff_hard_lines);
            markZeroThreshold(cfg.diff_hard_lines, "diff_hard_zero_notified");
            saveState(ctx.cwd, state);
            if (ctx.hasUI) {
              ctx.ui.notify(
                `guard: diff reached ${lines} lines (hard limit ${cfg.diff_hard_lines}) — split before continuing.`,
                "error",
              );
            }
          }
        } else if (thresholdDue(lines, cfg.diff_warn_lines, wm.diff_lines, "diff_warn_zero_notified")) {
          wm.diff_lines = Math.max(wm.diff_lines, cfg.diff_warn_lines);
          markZeroThreshold(cfg.diff_warn_lines, "diff_warn_zero_notified");
          saveState(ctx.cwd, state);
          if (ctx.hasUI) {
            ctx.ui.notify(
              `guard: diff reached ${lines} lines (warn ${cfg.diff_warn_lines}) — consider splitting.`,
              "warning",
            );
          }
        }
        if (thresholdDue(files, cfg.diff_warn_files, wm.diff_files, "diff_files_zero_notified")) {
          wm.diff_files = Math.max(wm.diff_files, cfg.diff_warn_files);
          markZeroThreshold(cfg.diff_warn_files, "diff_files_zero_notified");
          saveState(ctx.cwd, state);
          if (ctx.hasUI) {
            ctx.ui.notify(`guard: diff touched ${files} files (warn ${cfg.diff_warn_files}) — check scope.`, "warning");
          }
        }
      }

      renderWidgetNow(ctx);
      return undefined;
    }),
  );

  // Compaction removes the previously injected hidden brief from active
  // context. Invalidate both digests so the next turn re-injects constraints,
  // trusted journal entries, the task and orientation even when their text is
  // unchanged, and arm the per-request re-assertion for a mid-run compaction.
  pi.on("session_compact", async (_event, ctx) =>
    attempt(ctx, async () => {
      view.brief_digest = null;
      delete state.counters.orient_sha1;
      pendingReinject = true;
      saveState(ctx.cwd, state);
      return undefined;
    }),
  );

  pi.on("session_shutdown", async (_event, ctx) => {
    // Idempotent persistence; no UI during shutdown.
    try {
      if (ctx?.cwd) saveState(ctx.cwd, state);
    } catch {
      // best-effort
    }
    startTimes.clear();
    loopState.clear();
    blockedToolCallIds.clear();
    loopLedgerMemo = null;
    evidenceMemo = null;
    orientationText = null;
    evidenceCount = 0;
    lastDiff = { lines: 0, files: 0, available: false, lowerBound: false };
    lastCtxPct = null;
    return undefined;
  });

  // --- commands ----------------------------------------------------------

  pi.registerCommand("guard-status", {
    description: "protect-context: compact session status",
    handler: async (_args, ctx) =>
      attempt(ctx, async () => {
        const text = buildStatus(await gatherStatus(ctx));
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        return undefined;
      }),
  });

  pi.registerCommand("guard-contract", {
    description: "protect-context: contract list | add <text> | remove <id>",
    handler: async (args, ctx) =>
      attempt(ctx, async () => {
        const trimmed = (args ?? "").trim();
        // `--global` edits the personal layer (~/.config/protect-context) so one
        // constraint applies to every project; it is a owner-only surface.
        const global_requested = /(^|\s)--global(\s|$)/.test(trimmed);
        const parts = trimmed.split(/\s+/);
        const verb = parts[0] ?? "";
        const rest = parts
          .slice(1)
          .filter((part) => part !== "--global")
          .join(" ")
          .trim();
        const scope = global_requested ? "user" : "project";
        if (verb === "" || verb === "list") {
          const current = loadContract(ctx.cwd);
          const lines = contractLines(current);
          const personal = personalConstraintCount();
          if (ctx.hasUI) {
            const note = personal > 0 ? `\npersonal layer: ${personal} (applies to every project)` : "";
            ctx.ui.notify(
              `contract (${current.constraints.length}):\n${lines.join("\n")}${note}\nNudge: add missing constraints with /guard-contract add <text>.`,
              "info",
            );
          }
          return undefined;
        }
        if (verb === "add") {
          if (rest === "") {
            if (ctx.hasUI) ctx.ui.notify("usage: /guard-contract add <text> [--global]", "warning");
            return undefined;
          }
          // Slash commands are direct owner interaction and therefore trusted
          // by brief prioritization; model-callable writes use provenance tags.
          const result = addConstraintWithStatus(ctx.cwd, rest, "user", scope);
          const c = result.constraint;
          const total = result.total;
          const where = scope === "user" ? " (personal layer — every project)" : "";
          if (ctx.hasUI) {
            // SPEC §5 caps the re-injected brief at 12 contract lines: a
            // constraint past the cap would be silently DROPPED while the
            // owner believes it is enforced — warn instead.
            const over = total > BRIEF_MAX_CONTRACT_LINES;
            const ack = !result.added
              ? `constraint ${c.id} already exists\nNudge: no duplicate was written.`
              : over
              ? `added ${c.id}${where}\nwarning: ${total} constraints exceed the ${BRIEF_MAX_CONTRACT_LINES}-line brief cap — ` +
                `only the ${BRIEF_MAX_CONTRACT_LINES} highest-priority owner/seed constraints are re-injected.` +
                `\nNudge: keep the contract tight — fewer, sharper constraints survive re-injection.`
              : `added ${c.id}${where}\nNudge: the brief re-injects on your next prompt.`;
            ctx.ui.notify(ack, result.added && over ? "warning" : "info");
          }
          return undefined;
        }
        if (verb === "remove") {
          const removed = rest !== "" && removeConstraint(ctx.cwd, rest, scope);
          const safeId = truncLine(rest, 80);
          // A project-scope remove cannot delete personal state: point at it
          // instead of claiming the id does not exist.
          const inPersonalLayer =
            !removed &&
            scope === "project" &&
            loadContract(ctx.cwd).constraints.some((constraint) => constraint.id === rest);
          if (ctx.hasUI) {
            ctx.ui.notify(
              removed
                ? `removed ${safeId}\nNudge: the contract re-injects on your next prompt.`
                : inPersonalLayer
                ? `${safeId} lives in the personal layer\nNudge: re-run with /guard-contract remove ${safeId} --global.`
                : `no constraint '${safeId}'\nNudge: run /guard-contract list first.`,
              removed ? "info" : "warning",
            );
          }
          return undefined;
        }
        if (ctx.hasUI) ctx.ui.notify("usage: /guard-contract list | add <text> | remove <id>", "warning");
        return undefined;
      }),
  });

  pi.registerCommand("guard-verify", {
    description: "protect-context: run a command and record evidence",
    handler: async (args, ctx) =>
      attempt(ctx, async () => {
        const command = (args ?? "").trim();
        if (command === "") {
          if (ctx.hasUI) ctx.ui.notify("usage: /guard-verify <command>", "warning");
          return undefined;
        }
        const out = await runVerifyAndRecord(ctx, command, 180);
        if (ctx.hasUI) ctx.ui.notify(out, "info");
        return undefined;
      }),
  });

  pi.registerCommand("guard-note", {
    description: "protect-context: journal a decision|correction|risk|note",
    handler: async (args, ctx) =>
      attempt(ctx, async () => {
        const m = (args ?? "").trim().match(/^(\S+)\s+([\s\S]+)$/);
        const type = m && isJournalType(m[1]) ? m[1] : null;
        if (!type || !m) {
          if (ctx.hasUI) ctx.ui.notify("usage: /guard-note <decision|correction|risk|note> <text>", "warning");
          return undefined;
        }
        appendJournal(ctx.cwd, { type, text: m[2].trim() });
        if (ctx.hasUI) ctx.ui.notify(`journal: ${type} recorded\nNudge: check corrections before similar work.`, "info");
        return undefined;
      }),
  });

  // Task anchor (SPEC §1 #6): explicit owner control over the `task:` line that
  // the brief re-injects, so a compaction summary cannot redefine the ask.
  pi.registerCommand("guard-task", {
    description: "protect-context: show | set <text> | --clear the owner task anchor",
    handler: (args, ctx) =>
      attempt(ctx, () => {
        const trimmed = (args ?? "").trim();
        let capped = false;
        if (trimmed === "") {
          const current = state.task;
          if (ctx.hasUI) {
            ctx.ui.notify(
              current
                ? `task (${current.source}): ${current.text}\nNudge: use /guard-task <text> to replace it, or /guard-task --clear.`
                : "task: (none captured yet)\nNudge: it is captured from the first substantive prompt; /guard-task <text> sets it explicitly.",
              "info",
            );
          }
          return undefined;
        }
        if (trimmed === "--clear") {
          state.task = undefined;
        } else {
          const text = truncLine(trimmed, TASK_DISPLAY_MAX);
          if (text === "") {
            if (ctx.hasUI) ctx.ui.notify("usage: /guard-task <text> | --clear", "warning");
            return undefined;
          }
          state.task = { text, source: "owner", ts: new Date().toISOString() };
          // Store and display share one cap: the brief can always show what was
          // stored, and the owner is told when the input was cut.
          capped = Array.from(trimmed).length > TASK_DISPLAY_MAX;
        }
        // The brief text changed: force the next prompt to re-inject it.
        view.brief_digest = null;
        saveState(ctx.cwd, state);
        if (ctx.hasUI) {
          ctx.ui.notify(
            trimmed === "--clear"
              ? "task cleared\nNudge: the brief no longer anchors the original request."
              : `task recorded${capped ? ` (capped at ${TASK_DISPLAY_MAX} chars)` : ""}\nNudge: the brief re-injects it on your next prompt and after compaction.`,
            "info",
          );
        }
        return undefined;
      }),
  });

  pi.registerCommand("guard-report", {
    description: "protect-context: full session summary",
    handler: async (_args, ctx) =>
      attempt(ctx, async () => {
        const st = await gatherStatus(ctx);
        const lines: string[] = [buildStatus(st), "---"];
        lines.push(
          `config: loop_block_after=${cfg.loop_block_after} diff_warn=${cfg.diff_warn_lines}L/${cfg.diff_warn_files}f ` +
            `diff_hard=${cfg.diff_hard_lines}L ctx_warn=${cfg.ctx_warn_pct}% brief=${cfg.brief_mode} risk_confirm=${cfg.risk_confirm}`,
        );
        if (st.loops.length > 0) {
          const visibleLoops = st.loops.slice(0, 5);
          const hidden = st.loops.length - visibleLoops.length;
          lines.push(
            `loops: ${visibleLoops.map((l) => `'${truncLine(l.cmd, CMD_DISPLAY_MAX)}'x${l.failures}`).join(", ")}` +
              (hidden > 0 ? `, +${hidden} more` : ""),
          );
        }
        lines.push("Nudge: use /guard-verify for evidence and /guard-note to persist decisions.");
        if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
        return undefined;
      }),
  });

  // --- model-callable tools ---------------------------------------------

  pi.registerTool({
    name: "guard_verify",
    label: "Guard Verify",
    description:
      "Run a verification command and record evidence (id, exit, digest) in .agent-guard/verify_runs.jsonl. " +
      "Never raises on nonzero exit — it records the failure. Cite the evidence id when claiming success. " +
      "timeout_s is clamped to [1, 900] so a runaway value cannot wedge the session.",
    promptSnippet: "Run a verification command and record evidence",
    promptGuidelines: [
      "Use guard_verify to run verification commands; cite the returned evidence id when claiming success.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run for verification" }),
      timeout_s: Type.Optional(Type.Integer({ description: "Timeout in seconds (default 180, clamped to 1–900)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const out = await runVerifyAndRecord(ctx, params.command, params.timeout_s ?? 180, signal);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "guard_note",
    label: "Guard Note",
    description:
      "Append a decision/correction/risk/note to the persistent journal (.agent-guard/journal.jsonl). " +
      "Model-written entries are tagged agent and persisted for owner review; they are not trusted brief input, " +
      "though the brief shows the newest few under an explicitly unverified heading. " +
      "Only trusted slash-command/CLI decisions and corrections are re-injected as authority; read any entry back with guard_journal.",
    promptSnippet: "Record a durable decision or correction in the journal",
    promptGuidelines: [
      "Use guard_note to record durable decisions; when corrected, log a tagged correction with type=correction.",
      "After a compaction, use guard_journal to re-read earlier decisions and your own notes.",
    ],
    parameters: Type.Object({
      // Enum as a plain string schema: providers that reject anyOf/const still
      // get `{type:"string", enum:[...]}`, and the generic keeps params.type
      // narrowed to JournalType (pi-ai's StringEnum is a pi-schema type, which
      // typebox's Object inference degrades to `unknown`).
      type: Type.Unsafe<JournalType>({
        type: "string",
        enum: ["decision", "correction", "risk", "note"],
      }),
      text: Type.String({ description: "What happened / what was decided" }),
      tags: Type.Optional(Type.Array(Type.String({ description: "Optional tags" }))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entry = appendJournal(ctx.cwd, {
        type: params.type,
        text: params.text,
        tags: tagsWithRequired(params.tags ?? [], "agent"),
      });
      return {
        content: [
          {
            type: "text",
            text: `journal: ${entry.type} recorded${entry.tags.length > 0 ? ` [${entry.tags.join(",")}]` : ""}\nNudge: check corrections before similar work.`,
          },
        ],
        details: {},
      };
    },
  });

  // Read path for the journal (SPEC §4 parity with the MCP tool of the same
  // name). Without it, the agent's own notes would be write-only in pi: the
  // brief excludes `agent` entries from trusted sections, and a compaction then
  // leaves no route back to them (SPEC §1 #6).
  pi.registerTool({
    name: "guard_journal",
    label: "Guard Journal",
    description:
      "Read recent journal entries (read-only): timestamp, type, text, tags. limit is clamped to 0-20; type filters " +
      "decision|correction|risk|note. Entries tagged agent are model-written notes — unverified, never owner authority, " +
      "but the durable record of earlier reasoning; read them to recover decisions and rejected approaches.",
    promptSnippet: "Read recent journal entries",
    promptGuidelines: [
      "Use guard_journal to recover earlier decisions, corrections, and your own notes after a compaction.",
      "When you need a tag, evidence id, or older row outside this recent slice, use guard_recall.",
    ],
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ description: "How many entries to read (0-20, default 5)" })),
      type: Type.Optional(
        Type.Unsafe<JournalType>({
          type: "string",
          enum: ["decision", "correction", "risk", "note"],
        }),
      ),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const journal = readJournal(ctx.cwd);
      const type = params.type;
      const limit = params.limit === undefined ? READ_LIMIT_DEFAULT : boundedReadLimit(params.limit);
      const text = renderJournal(recentJournal(journal, limit, type), countJournal(journal, type), type);
      return Promise.resolve({ content: [{ type: "text", text }], details: {} });
    },
  });

  pi.registerTool({
    name: "guard_recall",
    label: "Guard Recall",
    description:
      "Search the retained journal and evidence window (read-only, no embeddings). Keywords are case-insensitive " +
      "substrings of text, command, and digest; every keyword must match. tags are AND. type filters " +
      "decision|correction|risk|note|evidence. evidence_id matches one ev-NNNN row. cmd is a fingerprint or " +
      "substring of a verify run. Hits are ranked by match strength, then recency, and labelled trusted or agent " +
      "(agent notes are unverified).",
    promptSnippet: "Search retained journal entries and evidence",
    promptGuidelines: [
      "Use guard_recall when the brief hid older decisions or you need an evidence id, tag, or command from the retained window.",
      "Treat hits labelled agent as unverified; cite evidence ids before claiming success.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Keywords (AND). Case-insensitive substring over text, cmd, and digest." }),
      ),
      type: Type.Optional(
        Type.Unsafe<RecallType>({
          type: "string",
          enum: ["decision", "correction", "risk", "note", "evidence"],
        }),
      ),
      tags: Type.Optional(Type.Array(Type.String({ description: "Tag that must be present (AND)" }))),
      limit: Type.Optional(Type.Integer({ description: "Max hits (0–20, default 5)" })),
      evidence_id: Type.Optional(Type.String({ description: "Exact evidence id, ev-NNNN" })),
      cmd: Type.Optional(Type.String({ description: "Verify-run fingerprint or substring" })),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const text = renderRecall(
          searchStore(ctx.cwd, {
            query: params.query ?? "",
            type: params.type,
            tags: params.tags,
            limit: params.limit === undefined ? RECALL_LIMIT_DEFAULT : params.limit,
            evidenceId: params.evidence_id,
            cmd: params.cmd,
          }),
        );
        return Promise.resolve({ content: [{ type: "text", text }], details: {} });
      } catch (err) {
        const message = err instanceof Error ? err.message : "recall failed";
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: `PC recall · error: ${message}\nNudge: pass a valid type, evidence id, or integer limit.`,
            },
          ],
          details: {},
        });
      }
    },
  });

  pi.registerTool({
    name: "guard_contract_check",
    label: "Guard Contract Check",
    description:
      "Deterministic checklist: marks each contract constraint addressed/unclear based on keyword coverage of a change summary. No LLM involved.",
    promptSnippet: "Check a change summary against the contract constraints",
    promptGuidelines: [
      "Use guard_contract_check with a change summary before claiming a task satisfies the contract.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "Summary of the change made" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const contract = loadContract(ctx.cwd);
      const text = renderChecklist(checkContractSummary(params.summary, contract));
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "guard_status",
    label: "Guard Status",
    description:
      "Compact guardrail dashboard: session, diff, loop streaks, evidence count, contract size, last verify.",
    promptSnippet: "Show the protect-context status dashboard",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const text = buildStatus(await gatherStatus(ctx));
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
