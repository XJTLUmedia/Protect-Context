/**
 * Frozen defaults for protect-context (SPEC.md v1.0 §2 and §6).
 *
 * These must stay byte-identical to `src/protect_context/defaults.py`
 * (both sides are pinned by tests: same 12 constraint ids and exact texts).
 * Do not reword, reorder, or renumber.
 */

export interface Constraint {
  id: string;
  text: string;
  added: string;
  source: string;
}

export interface Contract {
  version: 1;
  constraints: Constraint[];
}

export interface GuardConfig {
  loop_block_after: number;
  diff_warn_lines: number;
  diff_hard_lines: number;
  diff_warn_files: number;
  ctx_warn_pct: number;
  brief_mode: "changed" | "always";
  /** How many `lesson` precedents the brief re-injects (0 disables it). */
  brief_max_precedents: number;
  risk_confirm: boolean;
  preflight_tools: string[];
}

/** Seed date = SPEC freeze date. */
export const SEED_ADDED = "2026-08-28";

/** Seed contract — SPEC §6, FROZEN ids and texts. */
export const DEFAULT_CONTRACT: Contract = {
  version: 1,
  constraints: [
    {
      id: "01-obey-instructions",
      text: "Obey the owner's explicit instructions and stated constraints exactly; when instructions conflict, ask instead of guessing.",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "02-evidence-before-success",
      text: "Never claim success without citing a fresh verification run (evidence id or pasted output) for the exact claim.",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "03-stay-in-scope",
      text: "Change only files the stated task requires; no unrelated refactors, reformatting, or \"improvements\".",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "04-orient-first",
      text: "Before the first edit in an unfamiliar area, read the relevant files and conventions; never code from guesses.",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "05-simplest-correct",
      text: "Prefer the simplest implementation satisfying stated behavior; add or update a test for every behavior change.",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "06-journal-decisions",
      text: "Record durable decisions and constraints in the journal when made; re-read them before resuming work.",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "07-log-corrections",
      text: "When the owner corrects behavior, log a tagged correction; check corrections before similar work.",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "08-keep-diffs-reviewable",
      text: "Keep diffs small: split work into logical steps; treat 400+ changed lines per task as a stop-and-split signal.",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "09-no-identical-retries",
      text: "After 2 failures of the same command, change approach or gather new information; never re-run identical failing commands.",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "10-preflight-env",
      text: "When tools behave unexpectedly, run preflight (tool presence/versions) before blaming code.",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "11-batch-operations",
      text: "Batch related shell operations; prefer commands that avoid per-command permission prompts.",
      added: SEED_ADDED,
      source: "seed",
    },
    {
      id: "12-budget-context",
      text: "Keep tool outputs bounded (head/tail/digest); use targeted reads; avoid re-reading large files.",
      added: SEED_ADDED,
      source: "seed",
    },
  ],
};

/** Default thresholds — SPEC §2, FROZEN. */
export const DEFAULT_CONFIG: GuardConfig = {
  loop_block_after: 3,
  diff_warn_lines: 400,
  diff_hard_lines: 800,
  diff_warn_files: 10,
  ctx_warn_pct: 70,
  brief_mode: "changed",
  brief_max_precedents: 3,
  risk_confirm: true,
  preflight_tools: ["git", "python3", "pip", "node", "npm", "rg", "pytest"],
};
