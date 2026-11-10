/**
 * guard_contract_check — deterministic checklist over a change summary
 * (SPEC §5). No LLM, no pi imports.
 *
 * Two of the twelve constraints can be checked against the store instead of
 * against prose: 02 (a trustworthy verification run exists and is cited) and 08
 * (the diff is small enough to review). Those use `facts` when the caller has
 * them. Everything else is keyword coverage of the summary the model wrote —
 * self-report, and now labelled as such, because a checklist that certifies its
 * own summary told the owner nothing (audit 2026-11-10).
 */

import type { Contract } from "./defaults.ts";

/**
 * Keyword coverage per constraint id (lowercased substring matching against
 * the supplied summary).
 */
export const CONSTRAINT_KEYWORDS: Record<string, string[]> = {
  "01-obey-instructions": ["instruct", "constraint", "owner", "ask instead", "conflict"],
  "02-evidence-before-success": ["evidence", "verif", "ev-", "proof", "test run"],
  "03-stay-in-scope": ["scope", "unrelated", "refactor", "only file", "in scope"],
  "04-orient-first": ["read", "orient", "convention", "familiar", "reviewed"],
  "05-simplest-correct": ["simple", "test", "behavior", "minimal"],
  "06-journal-decisions": ["journal", "decision", "noted", "recorded"],
  "07-log-corrections": ["correction", "tag", "corrected", "feedback"],
  "08-keep-diffs-reviewable": ["diff", "lines", "split", "small", "reviewable"],
  "09-no-identical-retries": ["retry", "failing", "approach", "loop", "changed strategy"],
  "10-preflight-env": ["preflight", "tool", "version", "env", "sandbox"],
  "11-batch-operations": ["batch", "permission", "prompt", "grouped"],
  "12-budget-context": ["budget", "context", "digest", "head", "tail", "targeted"],
};

/** What the caller measured, so a check can be a check instead of a keyword. */
export interface CheckFacts {
  /** Newest recorded run; `label` is the trust label, not the raw exit code. */
  lastEvidence: { id: string; label: "ok" | "FAIL" | "UNTRUSTED" } | null;
  /** Working-tree change size, or null when Git scope is unavailable. */
  diffLines: number | null;
  diffFiles: number | null;
  /** Configured 400-line-style stop-and-split threshold. */
  diffHardLines: number;
}

/** How an item was decided: measured (`evidence`/`diff`) or asserted. */
export type CheckBasis = "keyword" | "evidence" | "diff";

export interface ChecklistItem {
  id: string;
  addressed: boolean;
  basis: CheckBasis;
}

const CHECKLIST_IDS_MAX = 24;
const EVIDENCE_ID = "02-evidence-before-success";
const DIFF_ID = "08-keep-diffs-reviewable";

function compactIds(items: ChecklistItem[]): string {
  const ids = items.slice(0, CHECKLIST_IDS_MAX).map((item) => String(item.id).slice(0, 2));
  const omitted = items.length - ids.length;
  return `${ids.length > 0 ? ids.join(" ") : "(none)"}${omitted > 0 ? ` +${omitted} more` : ""}`;
}

function keywordItem(id: string, hay: string): ChecklistItem {
  const keywords = CONSTRAINT_KEYWORDS[id] ?? [];
  return { id, addressed: keywords.some((k) => hay.includes(k)), basis: "keyword" };
}

/** True when the summary cites an evidence id (contract 02 says "cite"). */
function citesEvidence(hay: string, facts: CheckFacts): boolean {
  const id = facts.lastEvidence?.id.toLowerCase() ?? "";
  return hay.includes("ev-") || (id !== "" && hay.includes(id));
}

/** Mark each constraint addressed/unclear from the facts and the summary.
 *
 * `facts` is optional so a caller with no store access keeps the old behavior,
 * but the render then says so instead of implying a real check. */
export function checkContractSummary(
  summary: string,
  contract: Contract,
  facts?: CheckFacts,
): ChecklistItem[] {
  const hay = summary.toLowerCase();
  return contract.constraints.map((c) => {
    if (facts && c.id === EVIDENCE_ID) {
      // A run only counts when its label is `ok`: a masked exit 0 (UNTRUSTED)
      // is exactly what this constraint exists to refuse.
      const verified = facts.lastEvidence?.label === "ok";
      return { id: c.id, addressed: verified && citesEvidence(hay, facts), basis: "evidence" };
    }
    if (facts && c.id === DIFF_ID && facts.diffLines !== null) {
      return { id: c.id, addressed: facts.diffLines <= facts.diffHardLines, basis: "diff" };
    }
    return keywordItem(c.id, hay);
  });
}

function factLine(items: ChecklistItem[], facts: CheckFacts): string {
  const parts: string[] = [];
  const ev = facts.lastEvidence;
  parts.push(`evidence ${ev ? `${ev.id} ${ev.label}` : "(none)"}`);
  parts.push(
    facts.diffLines === null
      ? "diff (unavailable)"
      : `diff ${facts.diffFiles ?? "?"} files ${facts.diffLines} lines (hard ${facts.diffHardLines})`,
  );
  const keyword = items.filter((i) => i.basis === "keyword").map((i) => String(i.id).slice(0, 2));
  parts.push(`self-report: ${keyword.length > 0 ? keyword.join(" ") : "(none)"}`);
  return `basis: ${parts.join(" · ")}`;
}

/** Compact rendering: addressed ids grouped, unclear ids grouped, the basis of
 *  each measurement, then a Nudge. */
export function renderChecklist(items: ChecklistItem[], facts?: CheckFacts): string {
  const addressed = items.filter((i) => i.addressed);
  const unclear = items.filter((i) => !i.addressed);
  const lines: string[] = [];
  lines.push(`addressed: ${compactIds(addressed)}`);
  lines.push(`unclear: ${compactIds(unclear)}`);
  if (facts) {
    lines.push(factLine(items, facts));
    const failed = facts.lastEvidence && facts.lastEvidence.label !== "ok";
    if (unclear.some((i) => i.id === EVIDENCE_ID)) {
      lines.push(
        failed
          ? `02 unclear: last run ${facts.lastEvidence?.id} is ${facts.lastEvidence?.label} — re-run without a pipe or failure mask, then cite the id.`
          : `02 unclear: cite the newest evidence id in the summary (${facts.lastEvidence?.id ?? "run guard_verify first"}).`,
      );
    }
  } else {
    lines.push("basis: keyword only (self-report)");
  }
  lines.push(
    unclear.length > 0
      ? `Nudge: resolve unclear constraints (guard_contract list) or state why they don't apply.`
      : `Nudge: all constraints addressed — verify before claiming success.`,
  );
  return lines.join("\n");
}
