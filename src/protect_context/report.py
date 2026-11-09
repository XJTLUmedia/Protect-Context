"""guard_status dashboard (SPEC §4): session, Δdiff, loop streaks, evidence
count, contract size, last verify — compact, ends with an actionable Nudge.
"""

from __future__ import annotations

from . import contract, diffscope, loops, orientation, store, verify


def status() -> tuple[str, int]:
    """Returns (dashboard_text, warning_level) where level is 0 or 1."""
    store.ensure()
    cfg = store.load_config()
    sid = store.session_id()

    head = diffscope.git_head()
    hard = warn = diff_unavailable = diff_limited = False
    d = diffscope.diff_audit(cfg=cfg)
    git_label = head or ("unborn" if d.get("unborn") else "no repo")
    lines = [
        f"PC status · session {store.display_text(sid, 80)} · "
        f"git {store.display_text(git_label, 80)}"
    ]
    if "error" in d:
        lines.append("Δdiff n/a (not a git repo)")
        diff_unavailable = True
    else:
        lines.append(
            f"Δdiff +{d['added']}/-{d['deleted']} · {d['files']} files · verdict {d['verdict']}"
        )
        if d.get("untracked_scan_limited"):
            diff_limited = True
            lines.append(
                "scope note: untracked line count is a lower bound "
                f"({d.get('untracked_skipped_files', 0)} skipped, "
                f"{d.get('untracked_truncated_files', 0)} truncated)"
            )
        hard = d["verdict"] == "hard"
        warn = d["verdict"] == "warn"

    streak_list = loops.streaks(session=sid)
    blocked = bool(loops.would_block(streak_list, cfg))
    if streak_list:
        lines.append(
            "loops: "
            + ", ".join(
                f"{store.display_text(s['cmd'], 40)} ×{s['count']}"
                for s in streak_list[:3]
            )
        )
    else:
        lines.append("loops: none")

    runs, evidence_total = verify.recent_with_total(1, session=sid)
    last_label = verify.outcome_label(runs[0]) if runs else None
    if runs:
        r = runs[0]
        lines.append(
            f"evidence {evidence_total} · "
            f"last {store.display_text(r['id'], 40)} exit {r['exit']} {last_label}"
        )
    else:
        lines.append(f"evidence {evidence_total} · last none")

    lines.append(f"contract {len(contract.load())} constraints")
    # Goal #4: conventions files are the first thing to read in an unfamiliar
    # repo — surface them on every dashboard (cheap: root stat calls only).
    conv = orientation.conventions()
    lines.append("conventions: " + (", ".join(conv) if conv else "none found"))

    if hard:
        nudge = f"Nudge: diff ≥ {cfg['diff_hard_lines']} lines — stop and split the change."
    elif blocked:
        nudge = "Nudge: identical failing command at the block threshold — change approach, do not re-run."
    elif diff_unavailable:
        nudge = "Nudge: run inside a git repository before treating scope status as healthy."
    elif diff_limited:
        nudge = (
            "Nudge: scope scan is incomplete — inspect skipped or truncated "
            "untracked files before treating the diff as within budget."
        )
    elif warn:
        nudge = f"Nudge: diff ≥ {cfg['diff_warn_lines']} lines — split it before it grows."
    elif last_label == "UNTRUSTED":
        nudge = (
            "Nudge: the latest verify exited 0 but is not trustworthy — "
            "re-run without a pipe or failure mask before citing it."
        )
    else:
        nudge = "Nudge: verify changes with guard_verify and cite the evidence id before claiming success."
    lines.append(nudge)
    # diff_audit owns verdict normalization: every limited scan is promoted to
    # "warn" before it reaches this renderer. Keep the exit level derived from
    # that single verdict source rather than independently reclassifying an
    # impossible (limited + ok) internal combination.
    return "\n".join(lines), (1 if (hard or warn or blocked or diff_unavailable) else 0)
