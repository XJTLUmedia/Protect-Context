/**
 * Contract store CRUD (SPEC §1 #1, §2, §5). No pi imports.
 */

import { existsSync } from "node:fs";
import { DEFAULT_CONTRACT, type Constraint, type Contract } from "./defaults.ts";
import {
  contractPath,
  readJson,
  storeDir,
  userContractPath,
  userDir,
  withStoreLock,
  writeJson,
} from "./store.ts";
import { normalizeOneLine } from "./text.ts";

/** Free-text cap (chars): constraint text flows into re-injected briefs (goal #12). */
export const TEXT_CAP = 500;
export const CONTRACT_RENDER_MAX = 24;

export class ContractIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractIntegrityError";
  }
}

/**
 * Load the contract, seeding `.agent-guard/contract.json` from DEFAULT_CONTRACT
 * only when the file does not exist. A corrupt/unreadable file falls back to
 * in-memory defaults WITHOUT writing, so a transient read error or corruption
 * can never silently destroy the user's constraints (mirrors contract.load()
 * on the Python side).
 */
function cloneDefaultContract(): Contract {
  return JSON.parse(JSON.stringify(DEFAULT_CONTRACT)) as Contract;
}

function isConstraint(value: unknown): value is Constraint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.text === "string" &&
    typeof row.added === "string" &&
    typeof row.source === "string"
  );
}

/** Caller must hold the shared store lease. */
function loadContractUnlocked(cwd: string, forMutation = false): Contract {
  const file = contractPath(cwd);
  if (!existsSync(file)) {
    const seeded = cloneDefaultContract();
    saveContractUnlocked(cwd, seeded);
    return seeded;
  }
  const existing = readJson<unknown>(file);
  if (existing && typeof existing === "object" && Array.isArray((existing as { constraints?: unknown }).constraints)) {
    const rows = (existing as { constraints: unknown[] }).constraints;
    const constraints = rows.filter(isConstraint);
    if (forMutation && constraints.length !== rows.length) {
      throw new ContractIntegrityError(
        "contract contains malformed rows; repair .agent-guard/contract.json before mutating it",
      );
    }
    // A non-empty list with no valid records is effectively corrupt. Serve
    // frozen seeds in memory, but never overwrite the owner's damaged file.
    if (rows.length > 0 && constraints.length === 0) return cloneDefaultContract();
    return { version: 1, constraints };
  }
  if (forMutation) {
    throw new ContractIntegrityError(
      "contract file is malformed; repair .agent-guard/contract.json before mutating it",
    );
  }
  return cloneDefaultContract();
}

/** Caller must hold the shared store lease. */
function saveContractUnlocked(cwd: string, contract: Contract): void {
  writeJson(contractPath(cwd), contract);
}

/** Personal-layer rows: a missing file means "no personal constraints" (never
 * seeded), and an unreadable one is ignored in memory so a transient error can
 * never become a write. SPEC §2: the personal layer is owner-only surface. */
function personalConstraints(): Constraint[] {
  const data = readJson<unknown>(userContractPath());
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const rows = (data as { constraints?: unknown }).constraints;
  return Array.isArray(rows) ? rows.filter(isConstraint) : [];
}

/** Project rows first, then personal rows the project does not already carry
 * (same id or identical text): the project overrides the personal layer. */
export function mergeConstraints(project: Constraint[], personal: Constraint[]): Constraint[] {
  const out: Constraint[] = [];
  const ids = new Set<string>();
  const signatures = new Set<string>();
  for (const row of [...project, ...personal]) {
    const id = normalizeOneLine(row.id, 80);
    const signature = normalizeOneLine(row.text, TEXT_CAP);
    if (ids.has(id) || signatures.has(signature)) continue;
    ids.add(id);
    signatures.add(signature);
    out.push(row);
  }
  return out;
}

/** Effective contract (project + personal) while the caller holds the lease. */
function effectiveContractUnlocked(cwd: string, forMutation = false): Contract {
  const project = loadContractUnlocked(cwd, forMutation);
  return { version: 1, constraints: mergeConstraints(project.constraints, personalConstraints()) };
}

export function loadContract(cwd: string): Contract {
  return withStoreLock(storeDir(cwd), () => effectiveContractUnlocked(cwd));
}

export function saveContract(cwd: string, contract: Contract): void {
  withStoreLock(storeDir(cwd), () => saveContractUnlocked(cwd, contract));
}

/** Next sequential id, e.g. "13" after the 12 seeded constraints. */
export function nextConstraintId(constraints: Constraint[]): string {
  let max = 0;
  for (const c of constraints) {
    const m = c.id.match(/^(\d+)(?:-|$)/);
    if (m && m[1] !== undefined) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1).padStart(2, "0");
}

/** Slug limits, mirrored from contract.py (MAX_SLUG / MIN_SLUG / MAX_CJK_SLUG). */
export const MAX_SLUG = 40;
const MIN_SLUG = 4;
const MAX_CJK_SLUG = 8;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/** A readable id fragment: ASCII words when they describe the text, the text's
 *  own characters when they cannot.
 *
 *  This surface used to emit a bare number, so `/guard-contract add` wrote id
 *  "13" while the CLI wrote "13-never-run-sql" for the same rule — two id
 *  formats in one store, and `guard_contract remove` had to know which surface
 *  created the row (measured 2026-11-11). Non-Latin text used to keep only its
 *  ASCII remnant (永远不要…SQL -> "14-sql"), which told the owner nothing. */
export function slugify(text: string): string {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 4);
  const asciiSlug = words.join("-").slice(0, MAX_SLUG).replace(/^-+|-+$/g, "");
  const cjk = (text.match(CJK_RUN) ?? []).join("").slice(0, MAX_CJK_SLUG);
  if (cjk === "") return asciiSlug === "" ? "constraint" : asciiSlug;
  if (asciiSlug.length >= MIN_SLUG && words.length >= 2) {
    return `${asciiSlug.slice(0, MAX_SLUG - cjk.length - 1)}-${cjk}`;
  }
  return asciiSlug === "" ? cjk : `${cjk}-${asciiSlug}`;
}

/** `NN-<slug>`, the id shape contract.py's `add` produces. */
export function constraintId(number: string, text: string): string {
  return `${number}-${slugify(text)}`;
}

export interface AddConstraintResult {
  constraint: Constraint;
  added: boolean;
  total: number;
}

export type ContractScope = "project" | "user";

/** Lease for the layer being written: the project store, or the personal
 * directory (two projects must never share the wrong lease). */
function scopeRoot(cwd: string, scope: ContractScope): string {
  return scope === "user" ? userDir() : storeDir(cwd);
}

/** Personal rows for a read-modify-write cycle. A missing personal layer is not
 * an error (it is never seeded); a damaged one fails closed so a mutation
 * cannot silently erase owner data. */
function personalForMutation(): Constraint[] {
  const file = userContractPath();
  if (!existsSync(file)) return [];
  const data = readJson<unknown>(file);
  if (!data || typeof data !== "object" || !Array.isArray((data as { constraints?: unknown }).constraints)) {
    throw new ContractIntegrityError(`personal contract is malformed; repair ${file} before mutating it`);
  }
  const rows = (data as { constraints: unknown[] }).constraints;
  const valid = rows.filter(isConstraint);
  if (valid.length !== rows.length) {
    throw new ContractIntegrityError(`personal contract contains malformed rows; repair ${file} before mutating it`);
  }
  return valid;
}

/** Project rows without seeding or writing, as a basis for personal-layer
 * mutations (never hold the user lease while writing the project store). */
function projectRowsReadonly(cwd: string): Constraint[] {
  const data = readJson<unknown>(contractPath(cwd));
  if (!data || typeof data !== "object" || !Array.isArray((data as { constraints?: unknown }).constraints)) {
    return cloneDefaultContract().constraints;
  }
  const rows = (data as { constraints: unknown[] }).constraints;
  const valid = rows.filter(isConstraint);
  return rows.length > 0 && valid.length === 0 ? cloneDefaultContract().constraints : valid;
}

function scopeRows(cwd: string, scope: ContractScope): Constraint[] {
  return scope === "user" ? personalForMutation() : loadContractUnlocked(cwd, true).constraints;
}

function saveScope(cwd: string, scope: ContractScope, constraints: Constraint[]): void {
  const contract: Contract = { version: 1, constraints };
  if (scope === "user") {
    writeJson(userContractPath(), contract);
    return;
  }
  saveContractUnlocked(cwd, contract);
}

/** Constraints the personal layer contributes to the effective contract. */
export function personalConstraintCount(): number {
  return personalConstraints().length;
}

export function addConstraintWithStatus(
  cwd: string,
  text: string,
  source = "agent",
  scope: ContractScope = "project",
): AddConstraintResult {
  const cleanText = normalizeOneLine(text, TEXT_CAP);
  if (cleanText === "") throw new Error("constraint text must not be blank");
  return withStoreLock(scopeRoot(cwd, scope), () => {
    const rows = scopeRows(cwd, scope);
    // Dedupe and number against the EFFECTIVE contract: a personal constraint
    // must never be duplicated into a project, and ids never collide.
    const effective =
      scope === "user"
        ? mergeConstraints(projectRowsReadonly(cwd), personalConstraints())
        : mergeConstraints(rows, personalConstraints());
    const existing = effective.find((constraint) => normalizeOneLine(constraint.text, TEXT_CAP) === cleanText);
    if (existing) return { constraint: existing, added: false, total: effective.length };
    const constraint: Constraint = {
      id: constraintId(nextConstraintId(effective), cleanText),
      text: cleanText,
      added: new Date().toISOString().slice(0, 10),
      source: normalizeOneLine(source, 40) || "agent",
    };
    rows.push(constraint);
    saveScope(cwd, scope, rows);
    return { constraint, added: true, total: effective.length + 1 };
  });
}

export function addConstraint(cwd: string, text: string, source = "agent", scope: ContractScope = "project"): Constraint {
  return addConstraintWithStatus(cwd, text, source, scope).constraint;
}

export function removeConstraint(cwd: string, id: string, scope: ContractScope = "project"): boolean {
  return withStoreLock(scopeRoot(cwd, scope), () => {
    const rows = scopeRows(cwd, scope);
    const kept = rows.filter((c) => c.id !== id);
    if (kept.length === rows.length) return false;
    saveScope(cwd, scope, kept);
    return true;
  });
}

/** Bounded compact lines: frozen seeds plus the newest remaining entries. */
export function contractLines(contract: Contract): string[] {
  const constraints = contract.constraints;
  let visible = constraints;
  if (constraints.length > CONTRACT_RENDER_MAX) {
    const seedIndexes = constraints
      .map((constraint, index) => ({ constraint, index }))
      .filter(({ constraint }) => constraint.source === "seed")
      .map(({ index }) => index)
      .slice(0, CONTRACT_RENDER_MAX);
    const selected = new Set(seedIndexes);
    for (let index = constraints.length - 1; index >= 0 && selected.size < CONTRACT_RENDER_MAX; index -= 1) {
      selected.add(index);
    }
    visible = constraints.filter((_constraint, index) => selected.has(index));
  }
  const lines = visible.map((c) => {
    const id = normalizeOneLine(c.id, 80) || "(missing-id)";
    return `${id}: ${normalizeOneLine(c.text, TEXT_CAP)}`;
  });
  if (visible.length < constraints.length) {
    lines.unshift(`… ${constraints.length - visible.length} older non-seed constraints omitted`);
  }
  return lines;
}
