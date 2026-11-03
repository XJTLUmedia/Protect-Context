/**
 * Store access for `.agent-guard/` (SPEC §2).
 * Node builtins only. lib modules stay free of pi imports.
 *
 * Appends are serialized by the shared atomic-directory lease below and are
 * single O_APPEND line writes.
 */

import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  existsSync,
  renameSync,
  writeFileSync,
  statSync,
  lstatSync,
  unlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { hostname, homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

export const STORE_DIR_NAME = ".agent-guard";

export function storeDir(cwd: string): string {
  return join(cwd, STORE_DIR_NAME);
}

export function ensureStore(cwd: string): string {
  const dir = storeDir(cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const USER_DIR_ENV = "PC_USER_DIR";

/** Personal layer directory (SPEC §2): PC_USER_DIR, else $XDG_CONFIG_HOME,
 * else ~/.config, always under `protect-context/`. Read at call time so tests
 * and dotfiles-managed machines can redirect it. */
export function userDir(): string {
  const override = (process.env[USER_DIR_ENV] ?? "").trim();
  if (override !== "") return override;
  const xdg = (process.env.XDG_CONFIG_HOME ?? "").trim();
  return join(xdg !== "" ? xdg : join(homedir(), ".config"), "protect-context");
}

export function userContractPath(): string {
  return join(userDir(), "contract.json");
}

export function userConfigPath(): string {
  return join(userDir(), "config.json");
}

export function configPath(cwd: string): string {
  return join(storeDir(cwd), "config.json");
}
export function contractPath(cwd: string): string {
  return join(storeDir(cwd), "contract.json");
}
export function journalPath(cwd: string): string {
  return join(storeDir(cwd), "journal.jsonl");
}
export function eventsPath(cwd: string): string {
  return join(storeDir(cwd), "events.jsonl");
}
export function verifyRunsPath(cwd: string): string {
  return join(storeDir(cwd), "verify_runs.jsonl");
}
export function statePath(cwd: string): string {
  return join(storeDir(cwd), "state.json");
}

// ---------------------------------------------------------------------------
// Cross-runtime store lock. mkdir is the one atomic primitive shared by Node
// and Python without a runtime dependency. The owner record prevents one
// process from releasing another's lease; stale recovery is both age-gated
// and same-host PID-aware, so a live lock is never broken merely because a
// 500 ms timer elapsed.

export const STORE_LOCK_MIN_STALE_MS = 10_000;
export const STORE_LOCK_STALE_MS = 30_000;
export const STORE_LOCK_TIMEOUT_MS = 5_000;
export const STORE_LOCK_RETRY_MS = 25;
const LOCK_DIR_NAME = ".lock.d";
const LOCK_OWNER_NAME = "owner.json";
const LOCK_REAP_MARKER_NAME = ".reap-marker";
const LOCK_RENAME_TIMEOUT_MS = 1_000;
const LOCK_RENAME_RETRY_MS = 5;

export interface StoreLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  created_ms: number;
}

interface LockSnapshot {
  identity: { dev: number; ino: number };
  mtimeMs: number;
  owner: LockOwner | null;
}

interface HeldStoreLock {
  depth: number;
}

const heldStoreLocks = new Map<string, HeldStoreLock>();

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  try {
    Atomics.wait(sleepBuffer, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // busy-wait fallback when Atomics.wait is unavailable on this thread
    }
  }
}

function renameLease(source: string, destination: string): void {
  const deadline = performance.now() + LOCK_RENAME_TIMEOUT_MS;
  for (;;) {
    try {
      renameSync(source, destination);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const transient = process.platform === "win32" && ["EACCES", "EBUSY", "EPERM"].includes(code ?? "");
      if (!transient || performance.now() >= deadline) throw err;
      sleepSync(Math.min(LOCK_RENAME_RETRY_MS, Math.max(1, deadline - performance.now())));
    }
  }
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_NAME), "utf8")) as Partial<LockOwner>;
    return typeof value?.token === "string" && value.token.length > 0 ? (value as LockOwner) : null;
  } catch {
    return null;
  }
}

function pidIsLive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || (pid as number) > 2_147_483_647) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    // EPERM and unknown platform failures are conservative: they do not grant
    // permission to steal a possibly-live lock.
    return true;
  }
}

function sameHost(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === hostname().toLowerCase();
}

function lockSnapshot(lockDir: string): LockSnapshot | null {
  try {
    const before = lstatSync(lockDir);
    if (!before.isDirectory()) return null;
    const owner = readLockOwner(lockDir);
    const after = lstatSync(lockDir);
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) return null;
    return { identity: { dev: after.dev, ino: after.ino }, mtimeMs: after.mtimeMs, owner };
  } catch {
    return null;
  }
}

function snapshotIsStale(snapshot: LockSnapshot, staleMs: number): boolean {
  const ageMs = Date.now() - snapshot.mtimeMs;
  if (ageMs < staleMs) return false;
  if (snapshot.owner === null) return true;
  // Age alone cannot prove a foreign-host owner dead. Failing closed avoids
  // stealing a legitimate long-running lease on a shared filesystem.
  if (!sameHost(snapshot.owner.hostname)) return false;
  return !pidIsLive(snapshot.owner.pid);
}

function sameSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.owner?.token === right.owner?.token;
}

function staleTombPath(lockDir: string, snapshot: LockSnapshot): string {
  const token = snapshot.owner?.token ?? "unowned";
  const material = `${snapshot.identity.dev}:${snapshot.identity.ino}:${token}`;
  const key = createHash("sha256").update(material).digest("hex").slice(0, 24);
  return `${lockDir}.stale.${key}`;
}

function markStaleLock(lockDir: string): boolean {
  try {
    writeFileSync(join(lockDir, LOCK_REAP_MARKER_NAME), "protect-context stale lease quarantine\n", {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return true;
    return false;
  }
}

function oldEnoughToReap(lockDir: string, staleMs: number): boolean {
  try {
    const value = lstatSync(lockDir);
    return value.isDirectory() && Date.now() - value.mtimeMs >= staleMs;
  } catch {
    return false;
  }
}

function breakStaleLock(lockDir: string, staleMs: number): boolean {
  // The normal contention path needs only one stat. Avoid repeatedly opening
  // owner.json: on Windows that can transiently prevent the owner from
  // renaming its directory during release.
  if (!oldEnoughToReap(lockDir, staleMs)) return false;
  const observed = lockSnapshot(lockDir);
  if (observed === null || !snapshotIsStale(observed, staleMs)) return false;
  const tomb = staleTombPath(lockDir, observed);
  if (existsSync(tomb) || !markStaleLock(lockDir)) return false;

  // Adding the marker refreshes mtime. The original snapshot was already
  // age/liveness checked, so only identity and owner must remain unchanged.
  const current = lockSnapshot(lockDir);
  if (current === null || !sameSnapshot(observed, current)) return false;
  try {
    renameLease(lockDir, tomb);
  } catch {
    return false;
  }
  const moved = lockSnapshot(tomb);
  if (moved === null || !sameSnapshot(current, moved)) {
    try {
      if (!existsSync(lockDir)) renameLease(tomb, lockDir);
    } catch {
      // Do not delete an object whose identity could not be verified.
    }
    return false;
  }
  // The non-empty tomb is deliberately retained as a durable guard against a
  // delayed breaker moving a replacement lease after this process exits.
  return true;
}

function releaseStoreLock(lockDir: string, token: string): void {
  const observed = lockSnapshot(lockDir);
  if (observed?.owner?.token !== token) {
    throw new Error(`store lock ownership changed before release: ${lockDir}`);
  }
  const tomb = `${lockDir}.release.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    renameLease(lockDir, tomb);
  } catch (err) {
    throw new Error(`could not release store lock ${lockDir}`, { cause: err });
  }
  const moved = lockSnapshot(tomb);
  if (moved === null || !sameSnapshot(observed, moved)) {
    try {
      if (!existsSync(lockDir)) renameLease(tomb, lockDir);
    } catch {
      // Preserve the unexpected object under its quarantine name.
    }
    throw new Error(`store lock ownership changed before release: ${lockDir}`);
  }
  try {
    rmSync(tomb, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`could not clean released store lock ${tomb}`, { cause: err });
  }
}

function lockNumber(value: number | undefined, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

/** Run `fn` while holding the shared cross-runtime store lease for `dir`.
 * Acquisition either succeeds or throws; protected code never runs unlocked. */
export function withStoreLock<T>(dir: string, fn: () => T, options: StoreLockOptions = {}): T {
  mkdirSync(dir, { recursive: true });
  const lockDir = join(realpathSync(dir), LOCK_DIR_NAME);
  const alreadyHeld = heldStoreLocks.get(lockDir);
  if (alreadyHeld) {
    alreadyHeld.depth += 1;
    try {
      return fn();
    } finally {
      alreadyHeld.depth -= 1;
    }
  }

  const timeoutMs = lockNumber(options.timeoutMs, STORE_LOCK_TIMEOUT_MS, 0);
  const staleMs = lockNumber(options.staleMs, STORE_LOCK_STALE_MS, STORE_LOCK_MIN_STALE_MS);
  const retryMs = lockNumber(options.retryMs, STORE_LOCK_RETRY_MS, 1);
  const deadline = performance.now() + timeoutMs;
  const token = randomBytes(16).toString("hex");

  for (;;) {
    try {
      mkdirSync(lockDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      if (breakStaleLock(lockDir, staleMs)) continue;
      if (performance.now() >= deadline) {
        throw new Error(`timed out acquiring store lock ${lockDir}`);
      }
      sleepSync(Math.min(retryMs, Math.max(1, deadline - performance.now())));
      continue;
    }

    const owner: LockOwner = {
      token,
      pid: process.pid,
      hostname: hostname(),
      created_ms: Date.now(),
    };
    try {
      writeFileSync(join(lockDir, LOCK_OWNER_NAME), `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // The original initialization error is more useful to the caller.
      }
      throw err;
    }
    break;
  }
  heldStoreLocks.set(lockDir, { depth: 1 });
  try {
    return fn();
  } finally {
    heldStoreLocks.delete(lockDir);
    releaseStoreLock(lockDir, token);
  }
}

/** Append one JSON record as a single O_APPEND line write. The caller must
 *  already hold the store lock (see withStoreLock). */
export function appendJsonlLocked(file: string, record: unknown): void {
  maybeRotateLedger(file);
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** Append one JSON record under the shared cross-runtime store lock. */
export function appendJsonl(file: string, record: unknown): void {
  withStoreLock(dirname(file), () => appendJsonlLocked(file, record));
}

interface StatLike {
  mtimeMs: number;
  size: number;
}

function statOf(file: string): StatLike | null {
  try {
    const st = statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** Cheap change-detection stamp for a file ("mtimeMs:size"), or null when it
 *  does not exist. readJsonl caches the parse by the same signal; this lets
 *  callers also memoize higher-level derived state (e.g. the per-session
 *  evidence slice) so hot paths stay O(1) without re-reading the ledger. */
export function fileStamp(file: string): string | null {
  const st = statOf(file);
  return st ? `${st.mtimeMs}:${st.size}` : null;
}

const jsonlCache = new Map<string, { mtimeMs: number; size: number; data: unknown[] }>();

/** Ledger bounding (SPEC §2): a ledger rotates to `<stem>.N.jsonl` once it
 *  passes LEDGER_MAX_BYTES, keeping at most LEDGER_SEGMENTS rotated files.
 *  Readers concatenate oldest-first, so "last N rows" stays correct and the
 *  newest evidence id (the basis for `ev-NNNN`) is never rotated away. */
export const LEDGER_MAX_BYTES = 1_048_576;
export const LEDGER_SEGMENTS = 3;

function segmentPath(file: string, index: number): string {
  const name = basename(file);
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  return join(dirname(file), `${stem}.${index}${ext}`);
}

/** Existing ledger files for `file`, OLDEST first: rotated segments (highest
 *  index first) and the live file last. */
export function ledgerFiles(file: string): string[] {
  const files: string[] = [];
  for (let index = LEDGER_SEGMENTS; index >= 1; index -= 1) {
    const segment = segmentPath(file, index);
    if (existsSync(segment)) files.push(segment);
  }
  if (existsSync(file)) files.push(file);
  return files;
}

function maybeRotateLedger(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < LEDGER_MAX_BYTES) return;
  // Caller holds the store lease, so the shift cannot race another writer.
  for (let index = LEDGER_SEGMENTS - 1; index >= 1; index -= 1) {
    const src = segmentPath(file, index);
    if (existsSync(src)) renameSync(src, segmentPath(file, index + 1));
  }
  renameSync(file, segmentPath(file, 1));
}

function readOneJsonl<T>(file: string): T[] {
  const st = statOf(file);
  if (!st) return [];
  const cached = jsonlCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.data as T[];
  }
  const data: unknown[] = [];
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const record = JSON.parse(trimmed) as unknown;
      if (record !== null && typeof record === "object" && !Array.isArray(record)) {
        data.push(record);
      }
    } catch {
      // Skip malformed lines; the ledger stays readable.
    }
  }
  jsonlCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data as T[];
}

/** Read a ledger into object records, oldest row first across rotated
 *  segments; missing file → []. Malformed and non-object lines are skipped,
 *  matching the Python ledger reader. Results are cached by mtime+size. */
export function readJsonl<T>(file: string): T[] {
  const data: unknown[] = [];
  for (const segment of ledgerFiles(file)) data.push(...readOneJsonl<unknown>(segment));
  return data as T[];
}

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic-ish JSON write: unique tmp file + rename. Creates parent dirs.
 *  Unique per-write tmp name avoids clobbering a concurrent writer's tmp. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// state.json (SPEC §2)

export interface SessionState {
  started: string;
  git_head: string | null;
  brief_digest: string | null;
  notify_watermarks: { ctx_pct: number; diff_lines: number; diff_files: number };
  /** ISO timestamp of the last touch, used only to bound the file. */
  updated?: string;
}

/** Owner-stated task for this project (SPEC §2). Captured from the first real
 *  prompt of a session or set explicitly with `/guard-task`; re-injected at the
 *  top of the brief so a compaction summary cannot silently redefine the ask. */
export interface TaskCapture {
  text: string;
  source: "prompt" | "owner";
  ts: string;
}

/** Baseline that belongs to ONE pi session. Concurrent sessions in one project
 *  keep separate entries so they cannot clobber each other (SPEC §2). */
export interface GuardState {
  current_session: { id: string; started: string; git_head: string | null };
  sessions: Record<string, SessionState>;
  /** Opaque passthrough on the Python side; the extension stores digests here
   *  (e.g. the orientation digest) alongside numeric counters. */
  counters: Record<string, number | string>;
  /** Project-level task capture (absent = nothing captured yet). */
  task?: TaskCapture;
}

/** How many per-session baselines to retain (newest first, current always). */
export const SESSION_KEEP = 8;

export function defaultState(sessionId: string, gitHead: string | null): GuardState {
  return {
    current_session: { id: sessionId, started: new Date().toISOString(), git_head: gitHead },
    sessions: {},
    counters: {},
  };
}

function freshSession(started: string, gitHead: string | null): SessionState {
  return {
    started,
    git_head: gitHead,
    brief_digest: null,
    notify_watermarks: { ctx_pct: 0, diff_lines: 0, diff_files: 0 },
  };
}

/** Live per-session entry of `state`, created (and touched) when absent. */
export function sessionState(state: GuardState, sessionId: string): SessionState {
  const existing = state.sessions[sessionId];
  const entry = existing ?? freshSession(state.current_session.started || "", state.current_session.git_head ?? null);
  entry.updated = new Date().toISOString();
  state.sessions[sessionId] = entry;
  return entry;
}

function numberOrZero(candidate: unknown): number {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
}

function readWatermarks(raw: unknown): SessionState["notify_watermarks"] {
  const value =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    ctx_pct: numberOrZero(value.ctx_pct),
    diff_lines: numberOrZero(value.diff_lines),
    diff_files: numberOrZero(value.diff_files),
  };
}

function readSession(raw: unknown): SessionState | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const gitHead = value.git_head;
  return {
    started: typeof value.started === "string" ? value.started : "",
    git_head: typeof gitHead === "string" || gitHead === null ? gitHead : null,
    brief_digest: typeof value.brief_digest === "string" ? value.brief_digest : null,
    notify_watermarks: readWatermarks(value.notify_watermarks),
    updated: typeof value.updated === "string" ? value.updated : undefined,
  };
}

/** Parse the optional task capture; malformed legacy values are dropped rather
 *  than rendered into a brief. */
function readTask(raw: unknown): TaskCapture | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.text !== "string") return undefined;
  return {
    text: value.text,
    source: value.source === "owner" ? "owner" : "prompt",
    ts: typeof value.ts === "string" ? value.ts : "",
  };
}

export function loadState(cwd: string): GuardState | null {
  const raw = readJson<unknown>(statePath(cwd));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const rawSession =
    value.current_session !== null &&
    typeof value.current_session === "object" &&
    !Array.isArray(value.current_session)
      ? (value.current_session as Record<string, unknown>)
      : {};
  const gitHead = rawSession.git_head;
  const sessions: Record<string, SessionState> = {};
  if (value.sessions !== null && typeof value.sessions === "object" && !Array.isArray(value.sessions)) {
    for (const [id, entry] of Object.entries(value.sessions as Record<string, unknown>)) {
      const parsed = readSession(entry);
      if (parsed) sessions[id] = parsed;
    }
  }
  const currentId = typeof rawSession.id === "string" ? rawSession.id : "";
  // Legacy v1 files kept one digest/watermark pair at the top level; migrate it
  // into the current session's entry in memory rather than dropping it.
  if (currentId !== "" && sessions[currentId] === undefined) {
    const legacyDigest = typeof value.brief_digest === "string" ? value.brief_digest : null;
    const legacyWatermarks = readWatermarks(value.notify_watermarks);
    if (legacyDigest !== null || Object.values(legacyWatermarks).some((n) => n > 0)) {
      sessions[currentId] = {
        started: typeof rawSession.started === "string" ? rawSession.started : "",
        git_head: typeof gitHead === "string" || gitHead === null ? gitHead : null,
        brief_digest: legacyDigest,
        notify_watermarks: legacyWatermarks,
      };
    }
  }
  const rawCounters =
    value.counters !== null && typeof value.counters === "object" && !Array.isArray(value.counters)
      ? (value.counters as Record<string, unknown>)
      : {};
  const counters: Record<string, number | string> = {};
  for (const [key, candidate] of Object.entries(rawCounters)) {
    if (typeof candidate === "string" || (typeof candidate === "number" && Number.isFinite(candidate))) {
      counters[key] = candidate;
    }
  }
  const task = readTask(value.task);
  return {
    current_session: {
      id: currentId,
      started: typeof rawSession.started === "string" ? rawSession.started : "",
      git_head: typeof gitHead === "string" || gitHead === null ? gitHead : null,
    },
    sessions,
    counters,
    ...(task === undefined ? {} : { task }),
  };
}

/** Persist state.json, keeping the file bounded (SESSION_KEEP entries, the
 *  current session always among them so its baseline is never pruned). */
export function saveState(cwd: string, state: GuardState): void {
  const currentId = state.current_session.id;
  const ordered = Object.entries(state.sessions).sort(([, a], [, b]) =>
    String(b.updated ?? b.started ?? "").localeCompare(String(a.updated ?? a.started ?? "")),
  );
  const reserve = currentId !== "" && state.sessions[currentId] !== undefined ? 1 : 0;
  const kept: Record<string, SessionState> = {};
  for (const [id, entry] of ordered) {
    if (id === currentId) continue;
    if (Object.keys(kept).length >= SESSION_KEEP - reserve) break;
    kept[id] = entry;
  }
  if (reserve === 1) kept[currentId] = state.sessions[currentId];
  writeJson(statePath(cwd), { ...state, sessions: kept });
}
