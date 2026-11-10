"""Single source of truth for DEFAULT_CONTRACT and DEFAULT_CONFIG (SPEC §2, §6).

The pi extension (TypeScript side) pins identical values via its own tests:
the same 12 constraint ids with the exact same texts, and the same config
keys and values. Do not vary these between sides.
"""

SPEC_FROZEN = "2026-08-28"

_SEED_CONSTRAINTS: list[tuple[str, str]] = [
    ("01-obey-instructions",
     "Obey the owner's explicit instructions and stated constraints exactly; "
     "when instructions conflict, ask instead of guessing."),
    ("02-evidence-before-success",
     "Never claim success without citing a fresh verification run (evidence id "
     "or pasted output) for the exact claim."),
    ("03-stay-in-scope",
     "Change only files the stated task requires; no unrelated refactors, "
     "reformatting, or \"improvements\"."),
    ("04-orient-first",
     "Before the first edit in an unfamiliar area, read the relevant files and "
     "conventions; never code from guesses."),
    ("05-simplest-correct",
     "Prefer the simplest implementation satisfying stated behavior; add or "
     "update a test for every behavior change."),
    ("06-journal-decisions",
     "Record durable decisions and constraints in the journal when made; "
     "re-read them before resuming work."),
    ("07-log-corrections",
     "When the owner corrects behavior, log a tagged correction; check "
     "corrections before similar work."),
    ("08-keep-diffs-reviewable",
     "Keep diffs small: split work into logical steps; treat 400+ changed "
     "lines per task as a stop-and-split signal."),
    ("09-no-identical-retries",
     "After 2 failures of the same command, change approach or gather new "
     "information; never re-run identical failing commands."),
    ("10-preflight-env",
     "When tools behave unexpectedly, run preflight (tool presence/versions) "
     "before blaming code."),
    ("11-batch-operations",
     "Batch related shell operations; prefer commands that avoid per-command "
     "permission prompts."),
    ("12-budget-context",
     "Keep tool outputs bounded (head/tail/digest); use targeted reads; avoid "
     "re-reading large files."),
]

DEFAULT_CONTRACT: list[dict] = [
    {"id": cid, "text": text, "added": SPEC_FROZEN, "source": "seed"}
    for cid, text in _SEED_CONSTRAINTS
]

DEFAULT_CONFIG: dict = {
    "loop_block_after": 3,
    # Seconds after which an idle failing streak stops blocking (0 = never).
    # A streak older than this is a half-open circuit: the next identical run is
    # a deliberate probe, and if it fails again the brake closes immediately.
    "loop_reset_after_s": 300,
    "diff_warn_lines": 400,
    "diff_hard_lines": 800,
    "diff_warn_files": 10,
    "ctx_warn_pct": 70,
    "brief_mode": "changed",
    # How many `lesson` precedents the brief re-injects (0 disables the
    # section). Owner-tunable because a project with many lessons needs more
    # than the default three.
    "brief_max_precedents": 3,
    "risk_confirm": True,
    "preflight_tools": ["git", "python3", "pip", "node", "npm", "rg", "pytest"],
}
