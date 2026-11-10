"""Near-duplicate suppression for recall results.

A journal accumulates the same decision several times — re-stated, re-confirmed,
re-pasted — and the old ranker happily spent the whole top-5 on five rewrites of
one entry. The measured result was 2 distinct rows out of 5.

The classifier is IDF-weighted cosine plus a rare-token veto, which is the part
of claude-mem's dedup that survives without a vector store. Plain token overlap
is not enough: "rotation drops pinned lessons" and "rotation keeps pinned
lessons" share almost every token yet say opposite things. The veto is what
separates them, because the differing token is rare.

Two tiers, both deterministic and both cheap:

* ``exact`` — equal after punctuation/space/case normalisation. Safe to drop.
* ``candidate`` — cosine at or above the threshold with no veto, and at least
  ``MIN_SHARED`` shared tokens. Dropped from the *result list*, never from the
  ledger: this is a view, not a merge.

Mirror of ``extension/lib/dedup.ts``. Keep the constants equal.
"""

from __future__ import annotations

import math

# A candidate must be this similar (IDF-weighted cosine, thousandths).
COSINE_MILLI = 900
# Fewer shared tokens than this and cosine is noise: one shared rare token can
# drag a sparse pair to ~1.0 while the two rows are otherwise unrelated.
MIN_SHARED = 2
# A token present in at most this many corpus rows is "discriminating": if it
# appears on only one side of a pair, the pair is describing different things.
VETO_DF = 2


def words(text: str) -> list[str]:
    """Split on whitespace and lowercase, keeping compound identifiers whole.

    ``rdlp-api`` and ``ffmpeg-7.1.conf`` stay single tokens: splitting them would
    make ``api`` look common and disarm the veto that separates
    ``rdlp-api`` from ``rdlp-plugin``.
    """
    if not isinstance(text, str) or not text:
        return []
    return [word for word in text.lower().split() if word]


def normalized(text: str) -> str:
    """Canonical form for exact-tier equality: letters, digits, single spaces."""
    if not isinstance(text, str):
        return ""
    kept: list[str] = []
    for char in text.lower():
        if char.isalnum():
            kept.append(char)
        elif kept and kept[-1] != " ":
            kept.append(" ")
    return "".join(kept).strip()


def idf(document_frequency: int, total: int) -> float:
    """Smoothed IDF: ``log(1 + N / (df + 0.5))``.

    The ``+0.5`` keeps ``df = 0`` finite, so a token absent from the corpus
    still weights maximally instead of dividing by zero.
    """
    return math.log(1.0 + total / (document_frequency + 0.5))


def tfidf_cosine(left: list[str], right: list[str], idf_fn) -> float:
    """Cosine similarity of two IDF vectors (tf=1: these rows are short)."""
    unique_left = {token: idf_fn(token) for token in set(left)}
    unique_right = {token: idf_fn(token) for token in set(right)}
    dot = 0.0
    norm_left = 0.0
    for token, weight in unique_left.items():
        norm_left += weight * weight
        other = unique_right.get(token)
        if other is not None:
            dot += weight * other
    norm_right = 0.0
    for weight in unique_right.values():
        norm_right += weight * weight
    if norm_left == 0.0 or norm_right == 0.0:
        return 0.0
    return dot / math.sqrt(norm_left * norm_right)


def veto_fires(left: list[str], right: list[str], df_lookup) -> bool:
    """True when a rare token sits on exactly one side of the pair."""
    only_left = set(left) - set(right)
    only_right = set(right) - set(left)
    return any(df_lookup.lookup(token) <= VETO_DF for token in only_left | only_right)


def classify(left: str, right: str, df_lookup) -> str:
    """``exact``, ``candidate``, or ``none`` for the pair ``left``/``right``."""
    canonical_left = normalized(left)
    # An empty normal form is not a duplicate of another empty one: two rows that
    # are pure punctuation are not the same entry.
    if canonical_left != "" and canonical_left == normalized(right):
        return "exact"
    tokens_left = words(left)
    tokens_right = words(right)
    if len(set(tokens_left) & set(tokens_right)) < MIN_SHARED:
        return "none"

    def weight(token: str) -> float:
        return idf(df_lookup.lookup(token), df_lookup.total)

    similarity = tfidf_cosine(tokens_left, tokens_right, weight)
    if similarity * 1000.0 >= COSINE_MILLI and not veto_fires(tokens_left, tokens_right, df_lookup):
        return "candidate"
    return "none"


class DocumentFrequencies:
    """Token → row count over the corpus, with ``total`` for the IDF formula."""

    def __init__(self, documents: list[list[str]]) -> None:
        self.total = max(1, len(documents))
        self._counts: dict[str, int] = {}
        for document in documents:
            for token in set(document):
                self._counts[token] = self._counts.get(token, 0) + 1

    def lookup(self, token: str) -> int:
        return self._counts.get(token, 0)


def suppress(rows: list[str], keep: int) -> list[int]:
    """Indexes of ``rows`` to keep, in order, with near-duplicates dropped.

    ``rows`` must already be ranked best-first. Stops as soon as ``keep`` indexes
    are collected, so the cost is bounded by the answer size rather than by the
    corpus.
    """
    if keep <= 0:
        return []
    frequencies = DocumentFrequencies([words(row) for row in rows])
    kept: list[int] = []
    for index, row in enumerate(rows):
        if len(kept) >= keep:
            break
        if any(classify(rows[chosen], row, frequencies) != "none" for chosen in kept):
            continue
        kept.append(index)
    return kept
