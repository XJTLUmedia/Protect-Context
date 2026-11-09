import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEDGER_MAX_BYTES, LEDGER_SEGMENTS, appendJsonlLocked, ledgerFiles, readJsonl } from "../lib/store.ts";

function withCwd<T>(fn: (cwd: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "pc-ledger-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Push the live ledger past the rotation bound with one large-but-valid row. */
function forceRotation(file: string, seq: number[]): void {
  const padding = "x".repeat(LEDGER_MAX_BYTES);
  appendJsonlLocked(file, { n: -1, padding });
  for (const n of seq) appendJsonlLocked(file, { n });
}

test("ledger: rotation keeps reads oldest-first and preserves the newest rows", () => {
  withCwd((cwd) => {
    const file = join(cwd, "events.jsonl");
    appendJsonlLocked(file, { n: 1 });
    forceRotation(file, [2, 3]);
    assert.ok(ledgerFiles(file).length >= 2, "the ledger rotated once it passed the size bound");

    const rows = readJsonl<{ n: number }>(file);
    // Live order is 1, then the oversized padding row, then 2 and 3: the first
    // rotation moves `1 + padding` into the segment, so the whole history must
    // come back in exactly that write order.
    assert.deepEqual(
      rows.map((r) => r.n),
      [1, -1, 2, 3],
      "rows come back in write order across the rotated segment",
    );
    assert.equal(rows[rows.length - 1].n, 3, "the newest row is in the live file");
    assert.ok(statSync(file).size < LEDGER_MAX_BYTES, "the live file restarts after rotating");
  });
});

test("ledger: the segment count stays bounded", () => {
  withCwd((cwd) => {
    const file = join(cwd, "events.jsonl");
    for (let index = 0; index < LEDGER_SEGMENTS + 2; index += 1) {
      appendJsonlLocked(file, { n: index });
      forceRotation(file, [100 + index]);
    }
    const segments = ledgerFiles(file).filter((candidate) => candidate !== file);
    assert.ok(segments.length <= LEDGER_SEGMENTS, "rotation drops the oldest segment");
    const rows = readJsonl<{ n: number }>(file);
    assert.equal(rows[rows.length - 1].n, 100 + LEDGER_SEGMENTS + 1, "newest rows survive");
  });
});

test("ledger: rotated segments are valid jsonl and the live file keeps appending", () => {
  withCwd((cwd) => {
    const file = join(cwd, "journal.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "note", n: 1 })}\n`, "utf8");
    forceRotation(file, [2]);
    appendJsonlLocked(file, { type: "note", n: 3 });

    for (const segment of ledgerFiles(file)) {
      for (const line of readFileSync(segment, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        assert.equal(typeof JSON.parse(line), "object");
      }
    }
    assert.ok(existsSync(file));
    assert.deepEqual(readJsonl<{ n: number }>(file).map((r) => r.n), [1, -1, 2, 3]);
  });
});

test("ledger: a pinned lesson survives the rotation that drops its segment", () => {
  withCwd((cwd) => {
    const file = join(cwd, "journal.jsonl");
    const lesson = { ts: "2026-01-01T00:00:00.000Z", type: "decision", text: "durable lesson", tags: ["lesson"] };
    // Two rotations' worth of history: the lesson has reached the last segment,
    // which THIS rotation overwrites in place.
    writeFileSync(`${cwd}/journal.3.jsonl`, `${JSON.stringify(lesson)}\n`, "utf8");
    writeFileSync(`${cwd}/journal.2.jsonl`, `${JSON.stringify({ n: 2, tags: [] })}\n`, "utf8");
    writeFileSync(`${cwd}/journal.1.jsonl`, `${JSON.stringify({ n: 1, tags: [] })}\n`, "utf8");
    forceRotation(file, [7]);

    const rows = readJsonl<{ text?: string }>(file);
    assert.ok(
      rows.some((row) => row.text === "durable lesson"),
      "SPEC §2: a lesson is carried into the fresh live journal instead of being deleted",
    );

    // A carried lesson is not duplicated by the next rotation.
    forceRotation(file, [8]);
    const copies = readJsonl<{ text?: string }>(file).filter((row) => row.text === "durable lesson");
    assert.equal(copies.length, 1, "carrying is once per dropped segment, not per rotation");

    // Only the journal is pinned: events rotation still drops the oldest rows.
    const events = join(cwd, "events.jsonl");
    writeFileSync(`${cwd}/events.2.jsonl`, `${JSON.stringify({ text: "older event", tags: [] })}\n`, "utf8");
    writeFileSync(`${cwd}/events.3.jsonl`, `${JSON.stringify({ text: "old event", tags: ["lesson"] })}\n`, "utf8");
    forceRotation(events, [9]);
    assert.ok(
      !readJsonl<{ text?: string }>(events).some((row) => row.text === "old event"),
      "pinning applies to the journal, not to every ledger",
    );
  });
});
