/**
 * git numstat / shortstat parsing and diff verdicts (SPEC §5, §1 #8).
 * Pure logic — no pi imports.
 */

import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const UNTRACKED_MAX_FILES_SCANNED = 1_000;
export const UNTRACKED_MAX_BYTES_PER_FILE = 1_000_000;
export const UNTRACKED_MAX_BYTES_TOTAL = 8_000_000;
const READ_CHUNK = 64 * 1024;

export interface NumstatRow {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface Numstat {
  files: NumstatRow[];
  fileCount: number;
  lines: number;
}

/** Parse `git diff --numstat HEAD` output. Binary rows report "-\t-". */
export function parseNumstat(out: string): Numstat {
  const files: NumstatRow[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const path = parts.slice(2).join("\t");
    const additions = parts[0] === "-" ? 0 : Number(parts[0]);
    const deletions = parts[1] === "-" ? 0 : Number(parts[1]);
    files.push({
      path,
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      binary: parts[0] === "-" || parts[1] === "-",
    });
  }
  return {
    files,
    fileCount: files.length,
    lines: files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
  };
}

/** Parse `git status --porcelain=v1 -z --untracked-files=all --`. Porcelain
 * v1's NUL form is stable and paths are repo-root-relative; ignored files are
 * absent because Git, rather than a home-grown ignore matcher, selects them. */
export function parseUntrackedPaths(out: string, activeStorePath: string | null = ".agent-guard"): string[] {
  const store = activeStorePath
    ?.replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  const paths = new Set<string>();
  for (const record of out.split("\0")) {
    if (!record.startsWith("?? ")) continue;
    const path = record.slice(3);
    // The audit itself creates this runtime store. It is never part of the
    // user's diff, even when the consumer has not installed the recommended
    // .gitignore rule. Every other exclusion remains Git's decision.
    const normalizedPath = path.replaceAll("\\", "/");
    if (store && (normalizedPath === store || normalizedPath.startsWith(`${store}/`))) {
      continue;
    }
    paths.add(path);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export interface UntrackedScan {
  /** Exact number of non-ignored untracked paths reported by Git. */
  files: number;
  lines: number;
  filesScanned: number;
  bytesScanned: number;
  binaryFiles: number;
  skippedFiles: number;
  truncatedFiles: number;
  scanLimited: boolean;
}

/** Count text lines in untracked files under strict I/O caps. Symlinks and
 * paths escaping `root` are never followed. File count remains exact even
 * when content scanning reaches a cap. */
export function scanUntrackedFiles(root: string, paths: string[], hardLineBudget: number): UntrackedScan {
  const rootAbs = resolve(root);
  const budget = Math.max(0, hardLineBudget);
  let lines = 0;
  let filesScanned = 0;
  let bytesScanned = 0;
  let binaryFiles = 0;
  let skippedFiles = 0;
  let truncatedFiles = 0;

  for (const path of paths) {
    if (
      filesScanned >= UNTRACKED_MAX_FILES_SCANNED ||
      bytesScanned >= UNTRACKED_MAX_BYTES_TOTAL ||
      lines >= budget
    ) {
      skippedFiles += 1;
      continue;
    }

    // Windows git.exe on WSL emits backslashes. On POSIX those are not
    // separators, so the file would be skipped and the diff under-counted.
    const relPath = process.platform !== "win32" && path.includes("\\") ? path.replaceAll("\\", "/") : path;
    const candidate = resolve(rootAbs, relPath);
    const rel = relative(rootAbs, candidate);
    if (rel === "" || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || rel === ".." || isAbsolute(rel)) {
      skippedFiles += 1;
      continue;
    }

    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        skippedFiles += 1;
        continue;
      }
    } catch {
      skippedFiles += 1;
      continue;
    }

    let fd: number | null = null;
    let fileBytes = 0;
    let fileLines = 0;
    let lastByte: number | null = null;
    let binary = false;
    let complete = true;
    try {
      fd = openSync(candidate, "r");
      for (;;) {
        const remainingFile = UNTRACKED_MAX_BYTES_PER_FILE - fileBytes;
        const remainingTotal = UNTRACKED_MAX_BYTES_TOTAL - bytesScanned;
        if (remainingFile <= 0 || remainingTotal <= 0 || lines + fileLines >= budget) {
          complete = false;
          break;
        }
        const size = Math.min(READ_CHUNK, remainingFile, remainingTotal);
        const buffer = Buffer.allocUnsafe(size);
        const read = readSync(fd, buffer, 0, size, null);
        if (read === 0) break;
        const chunk = buffer.subarray(0, read);
        fileBytes += read;
        bytesScanned += read;
        if (chunk.includes(0)) {
          binary = true;
          fileLines = 0;
          break;
        }
        for (const byte of chunk) if (byte === 0x0a) fileLines += 1;
        lastByte = chunk[read - 1] ?? null;
      }
    } catch {
      skippedFiles += 1;
      continue;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Best-effort close after a read failure.
        }
      }
    }

    filesScanned += 1;
    if (binary) {
      binaryFiles += 1;
      continue;
    }
    if (complete && fileBytes > 0 && lastByte !== 0x0a) fileLines += 1;
    if (!complete) truncatedFiles += 1;
    lines += fileLines;
  }

  return {
    files: paths.length,
    lines,
    filesScanned,
    bytesScanned,
    binaryFiles,
    skippedFiles,
    truncatedFiles,
    scanLimited: skippedFiles > 0 || truncatedFiles > 0,
  };
}

export interface Shortstat {
  files: number;
  lines: number;
}

/** Parse `git diff --shortstat HEAD` output, e.g.
 *  " 3 files changed, 120 insertions(+), 4 deletions(-)". */
export function parseShortstat(out: string): Shortstat {
  const filesM = out.match(/(\d+)\s+files? changed/);
  const insM = out.match(/(\d+)\s+insertions?\(\+\)/);
  const delM = out.match(/(\d+)\s+deletions?\(-\)/);
  const files = filesM ? Number(filesM[1]) : 0;
  const lines = (insM ? Number(insM[1]) : 0) + (delM ? Number(delM[1]) : 0);
  return { files, lines };
}

export type DiffLevel = "ok" | "warn" | "hard";

export interface DiffVerdict {
  level: DiffLevel;
  lines: number;
  files: number;
}

export interface DiffThresholds {
  diff_warn_lines: number;
  diff_hard_lines: number;
  diff_warn_files: number;
}

/** Verdict of a diff against configured thresholds (SPEC §1 #8). */
export function diffVerdict(lines: number, files: number, t: DiffThresholds): DiffVerdict {
  if (lines >= t.diff_hard_lines) return { level: "hard", lines, files };
  if (lines >= t.diff_warn_lines || files >= t.diff_warn_files) return { level: "warn", lines, files };
  return { level: "ok", lines, files };
}
