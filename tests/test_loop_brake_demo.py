"""The checked-in loop-brake script must keep showing a block and an UNTRUSTED mask."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_loop_brake_demo_exits_zero_and_prints_both_results(tmp_path):
    # Launch from a scratch directory, not the checkout: a developer's own
    # `.agent-guard/` in the repo root is legitimate runtime state, so the
    # assertion that matters is that the demo seeds no store where it runs.
    proc = subprocess.run(
        [sys.executable, str(ROOT / "examples" / "loop-brake-demo" / "demo.py")],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "PC verify blocked · false · 2 prior failures" in proc.stdout
    assert "UNTRUSTED" in proc.stdout
    assert "exit 0" in proc.stdout
    assert not (tmp_path / ".agent-guard").exists()
