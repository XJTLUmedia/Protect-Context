"""A small English suffix stemmer for recall matching.

``word_hit`` only matches a keyword at a word *start*, so the useful direction
is one-way: ``patch`` finds ``patches`` but ``patches`` finds nothing, and
``retrieving`` never reaches a row about ``retrieval``. That is the measured
morphology gap (three of three probe queries returned no rows).

A full Porter stemmer is the usual answer, but it over-stems for a small
personal journal: ``organization`` collapses to ``organ`` and starts matching
``organic``. This module strips only the inflectional and derivational endings
that actually appear in pasted commands and decision notes, with length guards
so short words keep their identity. It is deliberately conservative: a missed
match costs one paraphrase, a wrong match costs precision the owner has to
notice.

Everything here is pure, deterministic, and ASCII-only: a token that is not all
ASCII letters is returned unchanged, so a CJK run or ``ev-0007`` is never
mangled. ``extension/lib/stem.ts`` must stay a line-for-line mirror.

Keep in sync with ``extension/lib/stem.ts``.
"""

from __future__ import annotations

# Below this length nothing is stripped: "is", "was", "old", "notes" -> "note"
# stay distinguishable from their neighbours.
MIN_STEM = 4

_VOWELS = frozenset("aeiou")


def _is_consonant(word: str, index: int) -> bool:
    """True when ``word[index]`` is a consonant.

    ``y`` is a consonant at the start and after a vowel, a vowel otherwise, so
    "cry" stems like "cries".
    """
    char = word[index]
    if char in _VOWELS:
        return False
    if char != "y":
        return True
    return index == 0 or not _is_consonant(word, index - 1)


def _doubled_final(word: str) -> bool:
    """True when the word ends in the same consonant twice ("runn", "stopp")."""
    return len(word) >= 2 and word[-1] == word[-2] and _is_consonant(word, len(word) - 1)


def _cvc(word: str) -> bool:
    """True when the word ends consonant-vowel-consonant ("hop", "run")."""
    if len(word) < 3:
        return False
    return (
        _is_consonant(word, len(word) - 3)
        and not _is_consonant(word, len(word) - 2)
        and _is_consonant(word, len(word) - 1)
        and word[-1] not in "wxy"
    )


def _valid_stem(word: str) -> bool:
    """A stem must keep at least one vowel, or word-initial noise survives."""
    return len(word) >= 2 and any(char in _VOWELS for char in word)


def _after_inflection(word: str) -> str:
    """Undo -ing/-ed and repair the consonant the suffix swallowed."""
    # The collapse keeps three letters: "adding" must reach "add", not "ad",
    # because a three-letter word is below MIN_STEM and is never stripped.
    # -l/-s/-z are kept doubled for short words ("filling" -> "fill", never
    # "fil") but collapse in long ones, which is what joins the British spelling
    # "journalling" to "journal".
    collapse = word[-1] not in "lsz" or len(word) > 5
    if _doubled_final(word) and collapse and len(word) > 3:
        return word[:-1]
    # "hoped" would otherwise stem to "hop" and collide with "hop" itself;
    # restoring the e keeps "hope" and "hop" apart.
    if _cvc(word):
        return word + "e"
    return word


def stem(token: str) -> str:
    """Return the stem of ``token``. Never raises, never returns "".

    ``Retrieving`` -> ``retriev``, ``retrieval`` -> ``retriev``,
    ``decisions`` -> ``decision``, ``journalled`` -> ``journal``.
    """
    if not isinstance(token, str):
        return ""
    word = token.strip().lower()
    if len(word) < MIN_STEM or not word.isascii() or not word.isalpha():
        return word

    # Step 1: plurals and third-person -s.
    if word.endswith("ies") and len(word) > 4:
        word = word[:-3] + "y"
    elif word.endswith("ied") and len(word) > 4:
        # "verified" is "verify" + "ied", not "verifi" + "ed"; without this the
        # past tense stops matching the present ("verifying" -> "verify").
        word = word[:-3] + "y"
    elif word.endswith(("sses", "xes", "zes", "ches", "shes")):
        word = word[:-2]
    elif word.endswith("s") and not word.endswith(("ss", "us", "is")):
        word = word[:-1]

    # Step 2: -ing / -ed. The guards are inclusive so a five-letter past tense
    # ("hoped") still reaches its stem; both sides then land on "hope".
    if word.endswith("ing") and len(word) >= MIN_STEM + 2:
        word = _after_inflection(word[:-3])
    elif word.endswith("ed") and len(word) >= MIN_STEM + 1:
        word = _after_inflection(word[:-2])

    # Step 3: adjective and adverb endings. The length guards keep "normal" and
    # "formal" intact while still joining "retrieval" to "retrieve".
    if word.endswith("est") and len(word) > 6:
        word = word[:-3]
    elif word.endswith("er") and len(word) > 6:
        word = word[:-2]
    if word.endswith("ly") and len(word) > MIN_STEM + 1:
        word = word[:-2]
    if word.endswith("al") and len(word) > 7:
        word = word[:-2]

    # Step 4: a trailing -e carries no signal once the suffix is gone, and
    # dropping it is what makes "retrieve" meet "retrieving".
    if word.endswith("e") and len(word) > MIN_STEM:
        word = word[:-1]

    return word if _valid_stem(word) else token.strip().lower()


def tokens(text: str) -> list[str]:
    """Split ``text`` into lowercased word tokens, dropping punctuation.

    Splits on every non-alphanumeric character, so ``src/recall.py`` yields
    ``src``, ``recall``, ``py``. A run of non-ASCII letters is kept whole: an
    unsegmented CJK sentence has no spaces and must not be cut into bytes.
    """
    if not isinstance(text, str) or not text:
        return []
    found: list[str] = []
    current: list[str] = []
    for char in text.lower():
        if char.isalnum():
            current.append(char)
        elif current:
            found.append("".join(current))
            current = []
    if current:
        found.append("".join(current))
    return found


def stems(text: str) -> frozenset[str]:
    """The set of stems in ``text``: the membership test for stem matching."""
    return frozenset(stem(token) for token in tokens(text))


def count_tokens(text: str) -> int:
    """How many word tokens ``text`` holds, without allocating a list.

    BM25 needs a document length, and the length must be counted the same way
    ``tokens`` splits, or two rows with identical text would normalise
    differently.
    """
    if not isinstance(text, str) or not text:
        return 0
    count = 0
    inside = False
    for char in text:
        if char.isalnum():
            if not inside:
                count += 1
                inside = True
        else:
            inside = False
    return count
