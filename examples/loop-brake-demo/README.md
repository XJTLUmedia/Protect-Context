# Loop-brake demo

A temporary git repository, four calls to `guard_verify` (the function the MCP server registers), then the temp directory is deleted. Nothing is written under this checkout’s `.agent-guard/`.

From the repository root, with the dev environment from [CONTRIBUTING.md](../../CONTRIBUTING.md):

```sh
python3 examples/loop-brake-demo/demo.py
```

If `python3` cannot import `fastmcp` and `.venv/bin/python` exists, the script re-execs that interpreter. Exit 0 means both checks held: the third identical `false` was blocked without a new evidence id, and `python3 -c 'raise SystemExit(1)' || true` was recorded as exit 0 `UNTRUSTED`.

The masked command is not `false || true`. A trailing `|| true` shares a loop streak with the command it masks, so using it for the trust check would also advance the `false` streak. The script uses a different command for that check.

## See it work

This is the output of one run. The temporary directory name and the millisecond timings change on every run. The evidence ids, exit codes, `PC verify blocked` line, and `UNTRUSTED` label do not.

```console
temporary repo: /tmp/pc-loop-brake-4tqwi013
same function the MCP server registers as guard_verify

$ guard_verify('false')
PC verify ev-0001 · exit 1 · FAIL · 1ms
cwd: /tmp/pc-loop-brake-4tqwi013
cmd: false
tail: (no output)
why: Exit 1 — the command failed.
fix: Read the tail, fix the cause, and re-verify the same claim. Do not claim success from this id.
Nudge: do not claim success from this run — fix the cause and re-verify.

$ guard_verify('false')
PC verify ev-0002 · exit 1 · FAIL · 1ms
cwd: /tmp/pc-loop-brake-4tqwi013
cmd: false
tail: (no output)
why: Exit 1 — the command failed.
fix: Read the tail, fix the cause, and re-verify the same claim. Do not claim success from this id.
Nudge: do not claim success from this run — fix the cause and re-verify.

$ guard_verify('false')
PC verify blocked · false · 2 prior failures
Nudge: change approach or gather new information — do not re-run unchanged.

$ guard_verify("python3 -c 'raise SystemExit(1)' || true")
PC verify ev-0003 · exit 0 · UNTRUSTED · 16ms
cwd: /tmp/pc-loop-brake-4tqwi013
cmd: python3 -c 'raise SystemExit(1)' || true
digest: (no output)
why: The command masks failure (`|| true`, `|| :`, `; true`, or similar), so exit 0 does not prove the check passed.
fix: drop the trailing failure mask and re-run the command as-is. Do not cite this id as proof.
Nudge: this run is recorded, but exit 0 here is not evidence of success.

checks ok: loop brake blocked the third `false`; masked exit 0 is UNTRUSTED
```

The README GIF at `docs/assets/demo.gif` is a separate productivity explainer. The transcript above is this script's output. The pi status widget is a different illustration.
