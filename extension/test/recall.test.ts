import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { translationsOf } from "../lib/glossary.ts";
import {
  LIMIT_MAX,
  RecallError,
  bm25Term,
  idfFor,
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
  // BM25 ranks by term score, not by row kind: the two-word journal note wins,
  // the short command row beats the longer decision row, and a row that only
  // mentions "alpha" in its digest comes last.
  assert.deepEqual(
    result.hits.map((hit) => `${hit.provenance}:${hit.kind}`),
    ["agent:note", "trusted:evidence", "trusted:decision", "trusted:evidence"],
  );
  assert.equal(result.hits[0]?.text, "alpha mentioned");
  assert.equal(result.hits[1]?.evidenceId, "ev-0007");
  assert.ok((result.hits[1]?.strength ?? 0) > (result.hits[3]?.strength ?? 0));
  const strengths = result.hits.map((hit) => hit.strength);
  assert.deepEqual(strengths, [...strengths].sort((a, b) => b - a), "ranked by strength, descending");
  // Pinned: tests/test_recall.py asserts the same four numbers.
  assert.deepEqual(strengths, [512, 447, 426, 235]);
  const rendered = renderRecall(result);
  assert.match(rendered, /agent · note/);
  assert.match(rendered, /trusted · decision/);
  assert.match(rendered, /ev-0007/);
  assert.match(rendered, /exit 1/);
  assert.match(rendered.split("\n").at(-1) ?? "", /^Nudge:.*unverified/);
});

test("recall: BM25 arithmetic is pinned for the Python mirror", () => {
  // The ranking numbers are a cross-runtime contract. tests/test_recall.py
  // asserts these exact values. The two hosts read the same journal, so a score
  // that drifts here would rank the owner's journal differently depending on
  // which one asked.
  const idfCases: Array<[number, number, number]> = [
    [1, 7, 1674],
    [2, 7, 1163],
    [3, 7, 827],
    [7, 7, 65],
    [1, 100, 4210],
    [50, 100, 693],
    [100, 100, 5],
    [0, 5, 0],
  ];
  for (const [df, total, expected] of idfCases) {
    assert.equal(idfFor(df, total), expected, `idf(${df}, ${total})`);
  }
  const termCases: Array<[number, number, number, number, number]> = [
    [1674, 3, 5, 6, 2911],
    [74, 3, 5, 6, 128],
    [1000, 2, 2, 6, 1818],
    [1674, 12, 60, 6, 2125],
    [500, 1, 3, 6, 645],
  ];
  for (const [idf, tf, length, average, expected] of termCases) {
    assert.equal(bm25Term(idf, tf, length, average), expected, `bm25(${idf}, ${tf}, ${length}, ${average})`);
  }
});

test("recall: a long query widens to one shared term and says so", () => {
  // The hard floor returned nothing at all when a five-word question shared a
  // single word. The widening pass answers it, but flags the weaker evidence
  // instead of presenting it as a full match.
  const journal = [
    { ts: "t1", type: "note", text: "the ledger", tags: [] },
    { ts: "t2", type: "note", text: "unrelated chatter about tests", tags: [] },
  ];
  const result = searchRows(journal, [], { query: "explain the ledger rotation policy in detail" });
  assert.equal(result.widened, true);
  assert.deepEqual(result.hits.map((hit) => hit.text), ["the ledger"]);
  assert.match(renderRecall(result), /Widened/);
});

test("recall: a query that matches two words is never widened", () => {
  // Widening must not run when the strict pass already answered: this is the
  // precision the floor was protecting in the first place.
  const journal = [
    { ts: "t1", type: "note", text: "owner prefers broad fixes over docs", tags: [] },
    { ts: "t2", type: "note", text: "the owner", tags: [] },
  ];
  const result = searchRows(journal, [], {
    query: "what did the owner say about tests and docs and release",
  });
  assert.equal(result.widened, false);
  assert.deepEqual(result.hits.map((hit) => hit.text), ["owner prefers broad fixes over docs"]);
  assert.doesNotMatch(renderRecall(result), /Widened/);
});

test("recall: the widening pass still respects type and tag filters", () => {
  const journal = [
    { ts: "t1", type: "note", text: "the ledger", tags: ["other"] },
    { ts: "t2", type: "risk", text: "ledger corruption risk", tags: ["ledger"] },
  ];
  const query = "explain the ledger rotation policy in detail";
  assert.deepEqual(searchRows(journal, [], { query, type: "decision" }).hits, []);
  assert.deepEqual(
    searchRows(journal, [], { query, tags: ["ledger"] }).hits.map((hit) => hit.text),
    ["ledger corruption risk"],
  );
});

test("recall: a reused hint outranks an equivalent one-shot", () => {
  const events: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 3; index += 1) {
    events.push({ ts: `t${index}`, session: "s", kind: "tool_call", tool: "bash", cmd: "rsync a b" });
  }
  events.push({ ts: "t9", session: "s", kind: "tool_call", tool: "bash", cmd: "rsync c d" });
  const result = searchRows([], [], { query: "rsync" }, events);
  assert.deepEqual(result.hits.map((hit) => hit.cmd), ["rsync a b", "rsync c d"]);
  assert.equal(result.hits[0]?.uses, 3);
  assert.ok((result.hits[0]?.strength ?? 0) > (result.hits[1]?.strength ?? 0));
});

test("recall: the reinforcement boost is capped", () => {
  // A row reused a hundred times must not buy an unbounded advantage.
  const journal = [
    { ts: "t1", type: "note", text: "alpha ledger note one", tags: [], uses: 8 },
    { ts: "t2", type: "note", text: "alpha ledger note two", tags: [], uses: 100 },
  ];
  const result = searchRows(journal, [], { query: "alpha" });
  assert.equal(result.hits[0]?.strength, result.hits[1]?.strength);
});

test("recall: relevance still beats reinforcement", () => {
  // The boost settles near-ties; it may never outvote a genuinely better match.
  const journal = [
    { ts: "t1", type: "note", text: `alpha ${"filler ".repeat(40)}`, tags: [], uses: 100 },
    { ts: "t2", type: "note", text: "alpha ledger", tags: [], uses: 0 },
  ];
  const result = searchRows(journal, [], { query: "alpha ledger" });
  assert.equal(result.hits[0]?.text, "alpha ledger");
  assert.ok((result.hits[0]?.strength ?? 0) > (result.hits[1]?.strength ?? 0));
});

test("recall: a journal row keeps its recorded reuse count", () => {
  // Regression: asJournal() used to drop `uses`, so a row that recorded its own
  // reuse counted as never reused.
  const journal = [{ ts: "t1", type: "note", text: "owned it", tags: [], uses: 4 }];
  const result = searchRows(journal, [], { query: "owned" });
  assert.equal(result.hits[0]?.uses, 4);
  // A non-integer or negative count is not a count.
  const bad = searchRows([{ ts: "t1", type: "note", text: "owned it", tags: [], uses: "4" }], [], {
    query: "owned",
  });
  assert.equal(bad.hits[0]?.uses, 0);
  const negative = searchRows([{ ts: "t1", type: "note", text: "owned it", tags: [], uses: -3 }], [], {
    query: "owned",
  });
  assert.equal(negative.hits[0]?.uses, 0);
});

test("recall: equal strength breaks the tie on recency", () => {
  // Two rows of identical length and weight score the same, so the newer one
  // must rank first.
  const rows = [
    { ts: "2026-01-01T00:00:00.000Z", type: "note", text: "alpha ledger note one", tags: [] },
    { ts: "2026-02-01T00:00:00.000Z", type: "note", text: "alpha ledger note two", tags: [] },
  ];
  const result = searchRows(rows, [], { query: "alpha" });
  assert.equal(result.hits[0]?.strength, result.hits[1]?.strength);
  assert.ok((result.hits[0]?.recency ?? 0) > (result.hits[1]?.recency ?? 0));
  assert.match(result.hits[0]?.text ?? "", /note two/);
});

test("recall: a verbose row does not outrank a precise one", () => {
  // The measured length bias: a 60-word filler row used to beat a precise
  // five-word row because the old score was an unbounded sum of weights.
  const rows = [
    { ts: "t1", type: "decision", text: "rotation keeps three segments", tags: [] },
    { ts: "t2", type: "note", text: `rotation ${"filler ".repeat(60)}`, tags: [] },
  ];
  const result = searchRows(rows, [], { query: "rotation" });
  assert.equal(result.hits[0]?.text, "rotation keeps three segments");
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

test("recall: an inflected query reaches the row about another form", () => {
  // Word-start matching was one-way, so every one of these returned nothing.
  const journal = [
    { ts: "t1", type: "decision", text: "The retrieval path walks every row.", tags: [] },
    { ts: "t2", type: "decision", text: "Every decision is journalled.", tags: [] },
  ];
  for (const query of ["retrieving", "retrieval", "retrieved"]) {
    const hits = searchRows(journal, [], { query }).hits;
    assert.ok(hits.length > 0, query);
    assert.ok(hits[0]?.text.includes("retrieval"), query);
  }
  assert.equal(searchRows(journal, [], { query: "decisions" }).matched, 1);
  assert.equal(searchRows(journal, [], { query: "journalling" }).matched, 1);
});

test("recall: stemming does not reintroduce mid-word noise", () => {
  // A stem must be a whole token, never a substring: "arch" may not reach
  // "search" and "old" may not reach "threshold" just because stems exist.
  const rows = [
    { ts: "1", type: "note", text: "raise the threshold", tags: [] },
    { ts: "2", type: "note", text: "search the index", tags: [] },
  ];
  assert.equal(searchRows(rows, [], { query: "old" }).matched, 0);
  assert.equal(searchRows(rows, [], { query: "arch" }).matched, 0);
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

test("recall: a non-ASCII letter also ends a word (mirrors Python str.isalnum)", () => {
  assert.equal(wordHit("naïold", "old"), false);
  assert.equal(wordHit("表格old", "old"), false);
  assert.equal(wordHit("a — old", "old"), true);
  assert.equal(wordHit("😀old", "old"), true, "an emoji is not an alphanumeric character");
});

test("recall: a result is paired with its own command, never another tool's", () => {
  const events = [
    { ts: "t1", kind: "tool_call", session: "s", tool: "bash", cmd: "make build", ok: null },
    { ts: "t2", kind: "tool_result", session: "s", tool: "read", cmd: "src/x.py", ok: true },
  ];
  const result = searchRows([], [], { query: "make build" }, events);
  const command = result.hits.find((hit) => hit.kind === "command");
  assert.equal(command?.cmd, "make build");
  assert.equal(command?.lastOk, null, "a read result proves nothing about the bash command");

  const paired = [
    { ts: "t3", kind: "tool_call", session: "s", tool: "bash", cmd: "make build", ok: null },
    { ts: "t4", kind: "tool_result", session: "s", tool: "bash", cmd: "make build", ok: false, exit: 1 },
  ];
  const matched = searchRows([], [], { query: "make build" }, paired).hits.find(
    (hit) => hit.kind === "command",
  );
  assert.equal(matched?.lastOk, false);
  assert.equal(matched?.lastExit, 1);
});

test("recall: searchStore reads the events ledger for a keyword query", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-recall-events-"));
  try {
    mkdirSync(join(dir, ".agent-guard"));
    writeFileSync(
      join(dir, ".agent-guard", "events.jsonl"),
      `${JSON.stringify({ ts: "t", session: "s", kind: "tool_call", tool: "bash", cmd: "rsync -a src/ /backup/" })}\n`,
    );
    const found = searchStore(dir, { query: "rsync" });
    assert.equal(found.hits.length, 1);
    assert.equal(found.hits[0]?.kind, "command");
    // A cmd-only filter narrows to evidence rows (mirrors recall._cmd_bonus),
    // so no command hint can match it.
    assert.equal(searchStore(dir, { cmd: "rsync" }).hits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall: a case-variant Agent tag stays unverified", () => {
  const rows = [{ ts: "t", type: "note", text: "model reasoning", tags: ["Agent"] }];
  const hit = searchRows(rows, [], { query: "reasoning" }).hits[0];
  assert.equal(hit?.provenance, "agent", "a stored `Agent` tag is not owner authority");
  assert.deepEqual(trustedRecallPool([{ ts: "t", type: "note", text: "x", tags: ["Agent"] }]), []);
});

test("recall: a 中文 keyword matches inside an unsegmented run (mirrors Python)", () => {
  // CJK has no word starts: the boundary rule hid every 中文 match (measured
  // 2026-11-11, 生产库 found nothing in 在生产库上). ASCII keeps the strict rule.
  const row = "永远不要在生产库上执行破坏性 SQL 迁移";
  assert.equal(wordHit(row, "生产库"), true);
  assert.equal(wordHit(row, "破坏性"), true);
  assert.equal(wordHit(row, "生产表"), false);
  assert.equal(wordHit("表格old", "old"), false);

  const rows = [{ ts: "1", type: "correction", text: row, tags: [] }];
  const result = searchRows(rows, [], { query: "生产库" });
  assert.deepEqual(result.hits.map((hit) => hit.text), [row]);
});

test("recall: a search never answers itself", () => {
  // The store records the query a search ran; that echo is not knowledge.
  // On the real store a 中文 query returned four rows, all of them the
  // commands that ran that query.
  const events = [
    { ts: "t1", kind: "tool_result", session: "s", tool: "guard_recall", cmd: "拆分改动 400 行", ok: true },
    { ts: "t2", kind: "tool_result", session: "s", tool: "mcp__protect_context__guard_recall", cmd: "拆分改动", ok: true },
    { ts: "t3", kind: "tool_result", session: "s", tool: "read", cmd: "src/protect_context/recall.py", ok: true },
  ];
  assert.deepEqual(searchRows([], [], { query: "拆分改动" }, events).hits, []);
  // Non-query hints still index: the fix must not blind the reuse ledger.
  const fileHits = searchRows([], [], { query: "recall.py" }, events).hits;
  assert.deepEqual(fileHits.map((hit) => hit.cmd), ["src/protect_context/recall.py"]);
});

test("recall: a 中文 query reaches the English row with the same rule", () => {
  // Mirrors tests/test_recall.py. SPEC excludes embeddings, so the bridge is the
  // curated dictionary in glossary.ts applied at query time; the stored rows are
  // untouched. A literal row of the same rarity still ranks first (0.6 scale).
  const english = {
    ts: "t1",
    type: "correction",
    text: "Never run destructive SQL on the production database.",
    tags: [],
  };
  const chinese = {
    ts: "t2",
    type: "correction",
    text: "永远不要在生产库上执行破坏性 SQL 迁移",
    tags: [],
  };
  const rows = [english, chinese];

  const zh = searchRows(rows, [], { query: "生产库" }).hits.map((hit) => hit.text);
  assert.deepEqual(zh, [chinese.text, english.text]);

  const en = searchRows(rows, [], { query: "production database" }).hits.map((hit) => hit.text);
  assert.deepEqual(en, [english.text, chinese.text]);

  const zhOne = searchRows(rows, [], { query: "破坏性" }).hits.map((hit) => hit.text);
  assert.deepEqual(zhOne, [chinese.text, english.text]);
});

test("recall: a recall command does not answer its own query", () => {
  // Mirrors tests/test_recall.py. protect-context recall "…" is the question;
  // indexing it as a reusable command made the echo a hit for its own text
  // (rank 1-2 in all four of its own result sets, measured 2026-11-11).
  const events = [
    { ts: "t1", kind: "tool_call", session: "s", tool: "bash", ok: true, cmd: 'python -m protect_context recall "production database"' },
    { ts: "t2", kind: "tool_call", session: "s", tool: "bash", ok: true, cmd: "grep -rn 'production database' deploy/" },
    // Same question in another shape: the surface, not the verb spelling.
    { ts: "t3", kind: "tool_call", session: "s", tool: "bash", ok: true, cmd: "python -c \"from protect_context import recall; recall.search('production database')\"" },
  ];
  const hits = searchRows([], [], { query: "production database" }, events).hits;
  assert.deepEqual(hits.map((hit) => hit.kind), ["command"]);
  assert.ok(hits[0]?.cmd?.includes("grep"));
  assert.ok(!hits.some((hit) => hit.cmd?.includes("recall")));
  // guard_verify stores the command it ran, so verifying a recall made the
  // verify row the top hit for the queried words.
  const evidence = [
    { id: "ev-9001", cmd: 'python -m protect_context recall "production database"' },
    { id: "ev-9002", cmd: "grep -rn 'production database' deploy/" },
  ];
  const found = searchRows([], evidence, { query: "production database" }).hits;
  assert.deepEqual(found.map((hit) => hit.evidenceId), ["ev-9002"]);
});

test("recall: a one-character 中文 query does not guess", () => {
  // Chinese substring matching runs both ways, so 库 reaches 数据库 *and* 生产库
  // and would bridge to English rows for each. One character is not a term.
  assert.deepEqual(translationsOf("库"), []);
  assert.notDeepEqual(translationsOf("生产库"), []);
  const rows = [
    { ts: "t1", type: "note", text: "在生产库执行破坏性 SQL", tags: [] },
    { ts: "t2", type: "note", text: "Drop the production database.", tags: [] },
  ];
  const hits = searchRows(rows, [], { query: "库" }).hits;
  assert.deepEqual(hits.map((hit) => hit.text), ["在生产库执行破坏性 SQL"]);
});

test("glossary: the dictionary widens the bridge", () => {
  // Mirrors tests/test_recall.py::test_the_dictionary_widens_the_bridge.
  assert.ok(translationsOf("deadlock").includes("死锁"));
  assert.ok(translationsOf("死锁").includes("deadlock"));
  assert.ok(translationsOf("firewall").includes("防火墙"));
  // Curated first: the domain pair leads, dictionary senses follow.
  assert.deepEqual(translationsOf("生产库").slice(0, 2), ["production", "production database"]);
  // Capped, so one word cannot fan out across the dictionary.
  assert.ok(translationsOf("cache").length <= 6);
  // The one-character guard survives the wider table.
  assert.deepEqual(translationsOf("库"), []);
});
