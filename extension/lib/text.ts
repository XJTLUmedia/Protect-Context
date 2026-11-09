/**
 * Shared text utilities (goal #12): hard one-line caps so model-supplied text
 * can never bloat re-injected briefs, journals or evidence lines.
 * Pure logic — no pi imports.
 */

/** Truncate `s` to `max` chars with a trailing ellipsis when longer. */
export function trunc(s: string, max = 200): string {
  // A zero/negative cap means "show nothing": the ellipsis itself would
  // exceed the requested budget (and callers pass model-supplied caps).
  if (max <= 0) return "";
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : s;
}

/** Normalize untrusted/legacy text into one printable bounded line. Unicode
 * control, format and surrogate code points are replaced before whitespace is
 * collapsed so they cannot forge terminal/brief lines or invisibly join words. */
export function normalizeOneLine(value: unknown, max: number): string {
  const normalized = String(value ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Slice code points, not UTF-16 code units: cutting a valid astral symbol
  // in half would manufacture the very unpaired surrogate we just removed.
  return Array.from(normalized).slice(0, Math.max(0, max)).join("").trim();
}
