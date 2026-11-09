import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LIMIT_MAX,
  RecallError,
  renderRecall,
  searchRows,
  searchStore,
  trustedRecallPool,
  wordHit,
} from "../lib/recall.ts";

const journal = [
  {
    ts: "2026-01-01T00:00:00.000Z",
    type: "decision",
    text: "alpha lives in the ledger",
    tags: ["ledger"],
  },
  {
    ts: "2026-02-01T00:00:00.000Z",
    type: "note",
    text: "alpha mentioned",
    tags: ["agent"],
  },
  {
    ts: "2026-03-01T00:00:00.000Z",
    type: "note",
    text: "no match here",
    tags: ["other"],
  },
];

const evidence = [
  { id: "ev-0007", ts: "2026-01-15T00:00:00.000Z", cmd: "echo alpha", digest: "noise", exit: 0 },
  { id: "ev-0009", ts: "2026-04-01T00:00:00.000Z", cmd: "pytest -q", digest: "alpha failed in output", exit: 1 },
];

test("recall: strength then recency, with agent provenance", () => {
  const result = searchRows(journal, evidence, { query: "alpha" });
  assert.equal(result.scanned, 5);
  assert.equal(result.matched, 4);
  assert.deepEqual(
    result.hits.map((hit) => `${hit.provenance}:${hit.kind}`),
    ["agent:note", "trusted:decision", "trusted:evidence", "trusted:evidence"],
  );
  assert.equal(result.hits[2]?.evidenceId, "ev-0007");
  assert.ok((result.hits[2]?.strength ?? 0) > (result.hits[3]?.strength ?? 0));
  assert.equal(result.hits[0]?.strength, result.hits[1]?.strength);
  assert.ok((result.hits[0]?.recency ?? 0) > (result.hits[1]?.recency ?? 0));
  const rendered = renderRecall(result);
  assert.match(rendered, /agent · note/);
  assert.match(rendered, /trusted · decision/);
  assert.match(rendered, /ev-0007/);
  assert.match(rendered, /exit 1/);
  assert.match(rendered.split("\n").at(-1) ?? "", /^Nudge:.*unverified/);
});

test("recall: keywords rank by match count and a tag is a searchable synonym", () => {
  // A query is a paraphrase, not an exact string: with two keywords one shared
  // word still reaches the row, and the stronger match ranks first.
  const both = searchRows(journal, [], { query: "alpha ledger" });
  assert.deepEqual(both.hits.map((hit) => hit.text), ["alpha lives in the ledger", "alpha mentioned"]);
  // Three or more keywords need two real matches, so one shared word is not
  // enough to answer a longer question.
  const narrow = searchRows(journal, [], { query: "alpha ledger missing" });
  assert.deepEqual(narrow.hits.map((hit) => hit.text), ["alpha lives in the ledger"]);
  // Stopwords alone carry no signal and are dropped before ranking.
  assert.deepEqual(searchRows(journal, [], { query: "did the owner do it" }).hits, []);
  // A tag the owner wrote is a synonym, so it is searchable and it satisfies
  // the multi-word floor on its own.
  const tagsOnly = searchRows([{ ts: "t", type: "note", text: "nothing to see", tags: ["alpha"] }], [], {
    query: "alpha",
  });
  assert.equal(tagsOnly.matched, 1);
  const bridged = searchRows(
    [{ ts: "t2", type: "decision", text: "prefer the broad fix", tags: ["annoyed"] }],
    [],
    { query: "why did the owner get annoyed" },
  );
  assert.equal(bridged.hits[0]?.text, "prefer the broad fix");
});

test("recall: tags are case-insensitive AND and evidence has none", () => {
  const rows = [
    { ts: "t1", type: "note", text: "keep both", tags: ["Search", "py"] },
    { ts: "t2", type: "note", text: "search only", tags: ["search"] },
  ];
  const found = searchRows(rows, [], { tags: ["SEARCH", "py"] });
  assert.deepEqual(found.hits.map((hit) => hit.text), ["keep both"]);
  assert.equal(searchRows(rows, [], { tags: ["search", "missing"] }).matched, 0);
  const evidenceOnly = [{ id: "ev-0001", ts: "t3", cmd: "pytest", digest: "", exit: 0 }];
  assert.equal(searchRows([], evidenceOnly, { tags: ["py"] }).matched, 0);
});

test("recall: evidence id is exact, including the short form", () => {
  const runs = [
    { id: "ev-0007", ts: "t1", cmd: "true", digest: "ok", exit: 0 },
    { id: "ev-0008", ts: "t2", cmd: "false", digest: "no", exit: 1 },
  ];
  assert.deepEqual(searchRows([], runs, { evidenceId: "ev-7" }).hits.map((hit) => hit.evidenceId), ["ev-0007"]);
  assert.deepEqual(searchRows([], runs, { query: "ev-0007" }).hits.map((hit) => hit.evidenceId), ["ev-0007"]);
  assert.throws(() => searchRows([], [], { evidenceId: "not-an-id" }), RecallError);
});

test("recall: exact command fingerprint outranks a newer substring", () => {
  const runs = [
    { id: "ev-0003", ts: "2026-03-01T00:00:00.000Z", cmd: "pytest   -q", digest: "", exit: 0 },
    { id: "ev-0004", ts: "2026-04-01T00:00:00.000Z", cmd: "pytest -q --tb=short", digest: "", exit: 0 },
    { id: "ev-0005", ts: "2026-05-01T00:00:00.000Z", cmd: "npm test", digest: "", exit: 0 },
  ];
  const journalRow = [{ ts: "2026-06-01T00:00:00.000Z", type: "note", text: "pytest -q", tags: [] }];
  const found = searchRows(journalRow, runs, { cmd: "  pytest   -q " });
  assert.deepEqual(found.hits.map((hit) => hit.evidenceId), ["ev-0003", "ev-0004"]);
  assert.ok((found.hits[0]?.strength ?? 0) > (found.hits[1]?.strength ?? 0));
  const substring = searchRows([], runs, { cmd: "pytest" });
  assert.deepEqual(substring.hits.map((hit) => hit.evidenceId), ["ev-0004", "ev-0003"]);
});

test("recall: type, limit, and empty-query recency", () => {
  const notes = [
    { ts: "2026-01-01T00:00:00.000Z", type: "note", text: "old", tags: [] },
    { ts: "2026-03-01T00:00:00.000Z", type: "decision", text: "mid", tags: [] },
  ];
  const runs = [
    { id: "ev-0001", ts: "2026-02-01T00:00:00.000Z", cmd: "true", digest: "", exit: 0 },
    { id: "ev-0002", ts: "2026-04-01T00:00:00.000Z", cmd: "pytest -q", digest: "alpha", exit: 0 },
  ];
  const newest = searchRows(notes, runs, { limit: 2 });
  assert.deepEqual(newest.hits.map((hit) => hit.kind), ["evidence", "decision"]);
  assert.equal(newest.hits[0]?.evidenceId, "ev-0002");
  const onlyEvidence = searchRows(notes, runs, { query: "alpha", type: "evidence" });
  assert.deepEqual(onlyEvidence.hits.map((hit) => hit.evidenceId), ["ev-0002"]);
  const many = Array.from({ length: 25 }, (_, i) => ({
    ts: `t${String(i).padStart(2, "0")}`,
    type: "note",
    text: String(i),
    tags: [],
  }));
  const capped = searchRows(many, [], { limit: 100 });
  assert.equal(capped.hits.length, LIMIT_MAX);
  assert.equal(capped.matched, 25);
  assert.match(renderRecall(capped), new RegExp(`${LIMIT_MAX} of 25 hits`));
  const none = searchRows(notes, runs, { limit: 0 });
  assert.deepEqual(none.hits, []);
  assert.equal(none.matched, 4);
  assert.throws(() => searchRows([], [], { type: "invalid" }), /unknown recall type/);
});

test("recall: malformed rows are skipped and controls stay one line", () => {
  const rows = [
    [],
    { type: "nope", text: "skip" },
    { type: "note", text: 12 },
    { type: "note", text: "hello\nworld\u0000next", tags: ["ok"], ts: "t1" },
  ];
  const result = searchRows(rows, [{ digest: "" }]);
  assert.equal(result.scanned, 1);
  const rendered = renderRecall(result);
  assert.match(rendered, /hello world next/);
  assert.equal(rendered.split("\n").length, 3);
});

test("recall: rotation window keeps segments and drops the overflow", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-recall-"));
  try {
    const guard = join(dir, ".agent-guard");
    mkdirSync(guard);
    writeFileSync(
      join(guard, "journal.1.jsonl"),
      `${JSON.stringify({ ts: "t0", type: "decision", text: "rotated-marker", tags: ["keep"] })}\n`,
    );
    writeFileSync(
      join(guard, "journal.4.jsonl"),
      `${JSON.stringify({ ts: "t9", type: "note", text: "dropped-marker", tags: [] })}\n`,
    );
    writeFileSync(
      join(guard, "journal.jsonl"),
      `not json\n[]\n${JSON.stringify({ ts: "t1", type: "note", text: "live-marker", tags: [] })}\n`,
    );
    writeFileSync(
      join(guard, "verify_runs.2.jsonl"),
      `${JSON.stringify({ id: "ev-0004", ts: "t2", cmd: "old-rotated-cmd", digest: "from-segment", exit: 0 })}\n`,
    );
    assert.equal(searchStore(dir, { query: "rotated-marker" }).matched, 1);
    assert.equal(searchStore(dir, { query: "dropped-marker" }).matched, 0);
    assert.equal(searchStore(dir, { query: "live-marker" }).hits[0]?.text, "live-marker");
    const found = searchStore(dir, { query: "from-segment" });
    assert.equal(found.hits[0]?.evidenceId, "ev-0004");
    assert.equal(found.hits[0]?.cmd, "old-rotated-cmd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall: reading an empty directory does not create the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-recall-empty-"));
  try {
    const result = searchStore(dir, { query: "anything" });
    assert.equal(result.scanned, 0);
    assert.equal(existsSync(join(dir, ".agent-guard")), false);
    const rendered = renderRecall(result);
    assert.match(rendered, /^PC recall · 0 hits · scanned 0/);
    assert.match(rendered, /broaden the query/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall: trusted pool is newest-first and skips agent and risk rows", () => {
  const pool = trustedRecallPool([
    { ts: "1", type: "decision", text: "owner old", tags: [] },
    { ts: "2", type: "risk", text: "risky", tags: [] },
    { ts: "3", type: "note", text: "model", tags: ["agent"] },
    { ts: "4", type: "note", text: "owner note", tags: ["ledger"] },
    { ts: "5", type: "correction", text: "owner fix", tags: ["api"] },
  ]);
  assert.deepEqual(pool.map((entry) => entry.text), ["owner fix", "owner note", "owner old"]);
});

test("recall: a past command is reusable and a refused one is not", () => {
  const events = [
    { ts: "2026-11-01T00:00:00.000Z", kind: "tool_call", tool: "bash", cmd: "rsync -a src/ /backup/folder/" },
    { ts: "2026-11-02T00:00:00.000Z", kind: "tool_call", tool: "bash", cmd: "rsync -a src/ /backup/folder/" },
    { ts: "2026-11-03T00:00:00.000Z", kind: "tool_call", tool: "bash", cmd: "true", ok: false },
    { ts: "2026-11-04T00:00:00.000Z", kind: "tool_result", tool: "bash", ok: true },
  ];
  const result = searchRows([], [], { query: "copy folder backup" }, events);
  const commands = result.hits.filter((hit) => hit.kind === "command");
  assert.equal(commands.length, 1, "one row per command family");
  assert.equal(commands[0]?.cmd, "rsync -a src/ /backup/folder/");
  assert.equal(commands[0]?.uses, 2);
  assert.match(renderRecall(result), /re-run to verify/);
  // An empty query keeps the recent-window shape: no command rows.
  assert.equal(searchRows([], [], {}, events).hits.length, 0);
});

test("recall: a keyword must start a word", () => {
  assert.equal(wordHit("raise the threshold", "old"), false);
  assert.equal(wordHit("the old policy is gone", "old"), true);
  assert.equal(wordHit("patches land", "patch"), true);
  assert.equal(wordHit("patches land", "atch"), false);
  const hits = searchRows(
    [
      { ts: "1", type: "note", text: "raise the threshold", tags: [] },
      { ts: "2", type: "decision", text: "the old policy is gone", tags: [] },
    ],
    [],
    { query: "old" },
  );
  assert.deepEqual(
    hits.hits.map((hit) => hit.text),
    ["the old policy is gone"],
  );
});

test("recall: a read tool leaves a reusable file hint", () => {
  const events = [
    { kind: "tool_result", session: "s", tool: "read", cmd: "src/store.py", ok: true },
    { kind: "tool_result", session: "s", tool: "read", cmd: "src/store.py", ok: true },
  ];
  const result = searchRows([], [], { query: "store.py" }, events);
  assert.deepEqual(result.hits.map((hit) => hit.kind), ["file"]);
  const hit = result.hits[0];
  assert.equal(hit?.uses, 2);
  assert.equal(hit?.tool, "read");
  assert.match(renderRecall(result), /read · reuse · used 2×/);
});
