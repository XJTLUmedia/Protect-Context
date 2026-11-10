/**
 * Near-duplicate suppression for recall results.
 *
 * A journal accumulates the same decision several times — re-stated,
 * re-confirmed, re-pasted — and the old ranker happily spent the whole top-5 on
 * five rewrites of one entry. The measured result was 2 distinct rows out of 5.
 *
 * The classifier is IDF-weighted cosine plus a rare-token veto, which is the part
 * of claude-mem's dedup that survives without a vector store. Plain token overlap
 * is not enough: "rotation drops pinned lessons" and "rotation keeps pinned
 * lessons" share almost every token yet say opposite things. The veto is what
 * separates them, because the differing token is rare.
 *
 * Two tiers, both deterministic and both cheap:
 *
 *   - `exact`     — equal after punctuation/space/case normalisation. Safe to drop.
 *   - `candidate` — cosine at or above the threshold with no veto, and at least
 *                   MIN_SHARED shared tokens. Dropped from the *result list*,
 *                   never from the ledger: this is a view, not a merge.
 *
 * Mirror of src/protect_context/dedup.py. Keep the constants equal.
 */

/** A candidate must be this similar (IDF-weighted cosine, thousandths). */
export const COSINE_MILLI = 900;
/** Fewer shared tokens than this and cosine is noise. */
export const MIN_SHARED = 2;
/** A token present in at most this many rows is "discriminating". */
export const VETO_DF = 2;

/**
 * Split on whitespace and lowercase, keeping compound identifiers whole.
 *
 * `rdlp-api` and `ffmpeg-7.1.conf` stay single tokens: splitting them would make
 * `api` look common and disarm the veto that separates `rdlp-api` from
 * `rdlp-plugin`.
 */
export function words(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  return text.toLowerCase().split(/\s+/).filter((word) => word !== "");
}

/**
 * Canonical form for exact-tier equality: letters, digits, single spaces.
 */
export function normalized(text: string): string {
  if (typeof text !== "string") return "";
  const kept: string[] = [];
  for (const char of text.toLowerCase()) {
    if (/^[\p{L}\p{N}]$/u.test(char)) {
      kept.push(char);
    } else if (kept.length > 0 && kept[kept.length - 1] !== " ") {
      kept.push(" ");
    }
  }
  return kept.join("").trim();
}

/**
 * Smoothed IDF: `log(1 + N / (df + 0.5))`.
 *
 * The `+0.5` keeps `df = 0` finite, so a token absent from the corpus still
 * weights maximally instead of dividing by zero.
 */
export function idf(documentFrequency: number, total: number): number {
  return Math.log(1 + total / (documentFrequency + 0.5));
}

/** Cosine similarity of two IDF vectors (tf=1: these rows are short). */
export function tfidfCosine(
  left: string[],
  right: string[],
  idfFn: (token: string) => number,
): number {
  const uniqueLeft = new Map<string, number>();
  for (const token of new Set(left)) uniqueLeft.set(token, idfFn(token));
  const uniqueRight = new Map<string, number>();
  for (const token of new Set(right)) uniqueRight.set(token, idfFn(token));
  let dot = 0;
  let normLeft = 0;
  for (const [token, weight] of uniqueLeft) {
    normLeft += weight * weight;
    const other = uniqueRight.get(token);
    if (other !== undefined) dot += weight * other;
  }
  let normRight = 0;
  for (const weight of uniqueRight.values()) normRight += weight * weight;
  if (normLeft === 0 || normRight === 0) return 0;
  return dot / Math.sqrt(normLeft * normRight);
}

/** True when a rare token sits on exactly one side of the pair. */
export function vetoFires(left: string[], right: string[], dfLookup: DfLookup): boolean {
  const setLeft = new Set(left);
  const setRight = new Set(right);
  const differing = new Set<string>();
  for (const token of setLeft) if (!setRight.has(token)) differing.add(token);
  for (const token of setRight) if (!setLeft.has(token)) differing.add(token);
  for (const token of differing) {
    if (dfLookup.lookup(token) <= VETO_DF) return true;
  }
  return false;
}

/** A token -> row-count lookup, plus the corpus size for the IDF formula. */
export interface DfLookup {
  readonly total: number;
  lookup(token: string): number;
}

/** `exact`, `candidate`, or `none` for the pair `left`/`right`. */
export function classify(
  left: string,
  right: string,
  dfLookup: DfLookup,
): "exact" | "candidate" | "none" {
  const canonicalLeft = normalized(left);
  // An empty normal form is not a duplicate of another empty one: two rows that
  // are pure punctuation are not the same entry.
  if (canonicalLeft !== "" && canonicalLeft === normalized(right)) return "exact";
  const tokensLeft = words(left);
  const tokensRight = words(right);
  const setRight = new Set(tokensRight);
  let shared = 0;
  for (const token of new Set(tokensLeft)) if (setRight.has(token)) shared += 1;
  if (shared < MIN_SHARED) return "none";
  const weight = (token: string): number => idf(dfLookup.lookup(token), dfLookup.total);
  const similarity = tfidfCosine(tokensLeft, tokensRight, weight);
  if (similarity * 1000 >= COSINE_MILLI && !vetoFires(tokensLeft, tokensRight, dfLookup)) {
    return "candidate";
  }
  return "none";
}

/** Token -> row count over the corpus, with `total` for the IDF formula. */
export class DocumentFrequencies implements DfLookup {
  readonly total: number;
  private readonly counts = new Map<string, number>();

  constructor(documents: string[][]) {
    this.total = Math.max(1, documents.length);
    for (const document of documents) {
      for (const token of new Set(document)) {
        this.counts.set(token, (this.counts.get(token) ?? 0) + 1);
      }
    }
  }

  lookup(token: string): number {
    return this.counts.get(token) ?? 0;
  }
}

/**
 * Indexes of `rows` to keep, in order, with near-duplicates dropped.
 *
 * `rows` must already be ranked best-first. Stops as soon as `keep` indexes are
 * collected, so the cost is bounded by the answer size rather than the corpus.
 */
export function suppress(rows: string[], keep: number): number[] {
  if (keep <= 0) return [];
  const frequencies = new DocumentFrequencies(rows.map((row) => words(row)));
  const kept: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (kept.length >= keep) break;
    const row = rows[index] as string;
    let duplicate = false;
    for (const chosen of kept) {
      if (classify(rows[chosen] as string, row, frequencies) !== "none") {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) kept.push(index);
  }
  return kept;
}
