/**
 * config.json load/merge (SPEC §2). Pure merge + fs load — no pi imports.
 */

import { existsSync } from "node:fs";
import { DEFAULT_CONFIG, type GuardConfig } from "./defaults.ts";
import { configPath, readJson, storeDir, userConfigPath, withStoreLock, writeJson } from "./store.ts";

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return null;
  return v as string[];
}

/**
 * Merge a partial config over the frozen defaults. Unknown keys are ignored;
 * wrong-typed values fall back to the default (deterministic, test-pinned).
 */
export function mergeConfig(
  partial: Record<string, unknown> | null | undefined,
  base: GuardConfig = DEFAULT_CONFIG,
): GuardConfig {
  const cfg: GuardConfig = { ...base, preflight_tools: [...base.preflight_tools] };
  if (!partial || typeof partial !== "object") return cfg;

  const p = partial as Record<string, unknown>;
  if (isInteger(p.loop_block_after) && p.loop_block_after >= 1) cfg.loop_block_after = p.loop_block_after;
  if (isInteger(p.diff_warn_lines) && p.diff_warn_lines >= 0) cfg.diff_warn_lines = p.diff_warn_lines;
  if (isInteger(p.diff_hard_lines) && p.diff_hard_lines >= 0) cfg.diff_hard_lines = p.diff_hard_lines;
  if (isInteger(p.diff_warn_files) && p.diff_warn_files >= 0) cfg.diff_warn_files = p.diff_warn_files;
  if (isInteger(p.ctx_warn_pct) && p.ctx_warn_pct >= 0 && p.ctx_warn_pct <= 100) cfg.ctx_warn_pct = p.ctx_warn_pct;
  if (p.brief_mode === "changed" || p.brief_mode === "always") cfg.brief_mode = p.brief_mode;
  if (isInteger(p.brief_max_precedents) && p.brief_max_precedents >= 0 && p.brief_max_precedents <= 10) {
    cfg.brief_max_precedents = p.brief_max_precedents;
  }
  if (typeof p.risk_confirm === "boolean") cfg.risk_confirm = p.risk_confirm;
  const tools = strArray(p.preflight_tools);
  if (tools) cfg.preflight_tools = [...tools];
  return cfg;
}

export interface LoadedConfig {
  config: GuardConfig;
  /** Unknown keys from the personal/project files, preserved but never
   * interpreted by the guard (strongest layer wins). Kept out of
   * `GuardConfig` so a typo in a known key still fails to type-check. */
  extras: Record<string, unknown>;
  path: string;
  existed: boolean;
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

/** Unknown keys of one layer, for pass-through only. */
function layerExtras(raw: Record<string, unknown> | null): Record<string, unknown> {
  if (!raw) return {};
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN_KEYS.has(key)));
}

/** Project values identical to the built-in default mean "no opinion". A seeded
 * project file records every default, so reading those as explicit choices
 * would shadow the personal layer forever. */
function explicitProjectKeys(raw: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const defaults: Record<string, unknown> = Object.fromEntries(Object.entries(DEFAULT_CONFIG));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (JSON.stringify(value) === JSON.stringify(defaults[key])) continue;
    out[key] = value;
  }
  return out;
}

/** Load `.agent-guard/config.json` over the personal layer
 * (`~/.config/protect-context/config.json`) over the defaults (SPEC §2).
 * Extension startup can request an on-disk seed so an extension-only install
 * has the documented configuration surface without the Python CLI; the seed is
 * the built-in defaults, never the merged view. Corrupt files are never
 * overwritten. */
function readLoadedConfig(cwd: string): LoadedConfig {
  const path = configPath(cwd);
  const existed = existsSync(path);
  const personalRaw = readJson<Record<string, unknown>>(userConfigPath());
  const projectRaw = readJson<Record<string, unknown>>(path);
  const personal = mergeConfig(personalRaw ?? undefined);
  const config = mergeConfig(explicitProjectKeys(projectRaw), personal);
  const extras = { ...layerExtras(personalRaw), ...layerExtras(projectRaw) };
  return { config, extras, path, existed };
}

export function loadConfig(cwd: string, seedMissing = false): LoadedConfig {
  if (!seedMissing) return readLoadedConfig(cwd);
  // Serialize and re-check the whole missing→seed transition. Without the
  // second read inside the lease, an owner-written config could be replaced
  // by defaults between an optimistic exists() and writeJson().
  return withStoreLock(storeDir(cwd), () => {
    const loaded = readLoadedConfig(cwd);
    if (!loaded.existed) writeJson(loaded.path, DEFAULT_CONFIG);
    return loaded;
  });
}
