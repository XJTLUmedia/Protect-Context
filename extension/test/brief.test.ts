import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBrief,
  sha1Hex,
  selectBriefConstraints,
  selectTaskRecall,
  BRIEF_MAX_CORRECTIONS,
  BRIEF_MAX_DECISIONS,
  BRIEF_MAX_LOOPS,
  BRIEF_MAX_RECALL,
} from "../lib/brief.ts";
import { DEFAULT_CONTRACT } from "../lib/defaults.ts";

test("brief: digest is stable and hex sha1", () => {
  const input = {
    contract: DEFAULT_CONTRACT.constraints,
    corrections: [],
    loops: [],
    lastEvidence: null,
  };
  const d1 = sha1Hex(buildBrief(input));
  const d2 = sha1Hex(buildBrief({ ...input, contract: [...DEFAULT_CONTRACT.constraints] }));
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{40}$/);
});

test("brief: digest changes when content changes", () => {
  const d1 = sha1Hex(buildBrief({ contract: DEFAULT_CONTRACT.constraints, corrections: [], loops: [], lastEvidence: null }));
  const d2 = sha1Hex(
    buildBrief({
      contract: DEFAULT_CONTRACT.constraints,
      corrections: [{ type: "correction", text: "use pnpm", tags: ["tools"] }],
      loops: [],
      lastEvidence: null,
    }),
  );
  assert.notEqual(d1, d2);
});

test("brief: contract capped at 12 lines, includes ids and texts", () => {
  const brief = buildBrief({ contract: DEFAULT_CONTRACT.constraints, corrections: [], loops: [], lastEvidence: null });
  const lines = brief.split("\n");
  // 1 header + 12 constraints
  assert.equal(lines.filter((l) => l.startsWith("0") || l.startsWith("1")).length, 12);
  assert.ok(lines.some((l) => l.startsWith("01-obey-instructions:")));
  assert.ok(lines.some((l) => l.startsWith("12-budget-context:")));
});

test("brief: free-text lines are capped (model text cannot bloat the brief)", () => {
  const long = "x".repeat(500);
  const brief = buildBrief({
    contract: DEFAULT_CONTRACT.constraints,
    corrections: [{ type: "correction", text: long, tags: [] }],
    loops: [{ cmd: long, failures: 2, lastExit: 1 }],
    lastEvidence: { id: "ev-0001", exit: 1, cmd: long, ms: 10 },
  });
  for (const line of brief.split("\n")) {
    // dynamic text ≤ 200 chars; fixed prefixes (e.g. "last verify: ev-0001 exit=1 '") add ≤ ~40
    assert.ok(line.length <= 240, `line too long (${line.length})`);
  }
  assert.ok(brief.includes("…"), "truncation marker present");
  // multi-line model text collapses to a single brief line
  const brief2 = buildBrief({
    contract: DEFAULT_CONTRACT.constraints,
    corrections: [{ type: "correction", text: "line one\nline two", tags: [] }],
    loops: [],
    lastEvidence: null,
  });
  assert.ok(brief2.includes("line one line two"));
});

test("brief: includes at most 3 corrections and 2 loops and last evidence", () => {
  const corrections = Array.from({ length: 5 }, (_, i) => ({
    type: "correction",
    text: `correction ${i}`,
    tags: [`t${i}`],
  })).reverse(); // newest first, as journal.recentCorrections produces
  const loops = [
    { cmd: "loop-a", failures: 3, lastExit: 1 },
    { cmd: "loop-b", failures: 2, lastExit: 2 },
    { cmd: "loop-c", failures: 2, lastExit: 3 },
  ];
  const brief = buildBrief({
    contract: DEFAULT_CONTRACT.constraints,
    corrections,
    loops,
    lastEvidence: { id: "ev-0007", exit: 0, cmd: "npm test", ms: 1200 },
  });
  const lines = brief.split("\n");
  const corrLines = lines.filter((l) => l.startsWith("- correction "));
  assert.equal(corrLines.length, BRIEF_MAX_CORRECTIONS);
  assert.ok(corrLines.some((l) => l.includes("correction 4")), "newest corrections kept");
  const loopLines = lines.filter((l) => l.startsWith("- '"));
  assert.equal(loopLines.length, BRIEF_MAX_LOOPS);
  assert.ok(lines.some((l) => l.includes("ev-0007") && l.includes("exit=0")));
  assert.ok(lines.some((l) => l.includes("[t4]")));
});

test("brief: includes at most 3 trusted decisions", () => {
  const decisions = Array.from({ length: 5 }, (_, i) => ({
    type: "decision",
    text: `decision ${i}`,
    tags: [`d${i}`],
  })).reverse();
  const brief = buildBrief({
    contract: [],
    decisions,
    corrections: [],
    loops: [],
    lastEvidence: null,
  });
  assert.equal(brief.split("\n").filter((line) => line.startsWith("- decision ")).length, BRIEF_MAX_DECISIONS);
  assert.ok(brief.includes("decision 4"));
  assert.ok(!brief.includes("decision 0"));
});

test("brief: constraints beyond the 12-line cap get an overflow marker", () => {
  const extra = Array.from({ length: 3 }, (_, i) => ({
    id: `13-extra-${i}`,
    text: `extra constraint ${i}`,
    added: "2026-08-28",
    source: "agent",
  }));
  const brief = buildBrief({
    contract: [...DEFAULT_CONTRACT.constraints, ...extra],
    corrections: [],
    loops: [],
    lastEvidence: null,
  });
  const lines = brief.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("0") || l.startsWith("1")).length, 12);
  assert.ok(lines.some((l) => l.startsWith("+3 more constraints hidden")), "overflow marker present");
  assert.ok(!lines.some((l) => l.startsWith("13-extra-")), "hidden constraints are not injected");
  // and the marker changes the digest, so the brief is re-injected
  const without = buildBrief({ contract: DEFAULT_CONTRACT.constraints, corrections: [], loops: [], lastEvidence: null });
  assert.notEqual(sha1Hex(brief), sha1Hex(without));
});

test("brief: non-seed constraints carry their source tag; seed ones stay clean", () => {
  const brief = buildBrief({
    contract: [
      ...DEFAULT_CONTRACT.constraints.slice(0, 2),
      { id: "13-owner-rule", text: "always use pnpm", added: "2026-08-29", source: "user" },
      { id: "14-agent-rule", text: "never touch main", added: "2026-08-29", source: "agent" },
    ],
    corrections: [],
    loops: [],
    lastEvidence: null,
  });
  assert.ok(brief.includes("13-owner-rule [user]: always use pnpm"));
  assert.ok(brief.includes("14-agent-rule [agent]: never touch main"));
  assert.ok(brief.includes("01-obey-instructions: Obey"), "seed constraints stay untagged");
});

test("brief: newest owner constraints outrank seeds and agent entries never displace seeds", () => {
  const agent = Array.from({ length: 3 }, (_, i) => ({
    id: `13-agent-${i}`,
    text: `agent rule ${i}`,
    added: "2026-09-03",
    source: "agent",
  }));
  const owners = [
    { id: "16-owner-old", text: "old owner rule", added: "2026-09-01", source: "user" },
    { id: "17-owner-new", text: "new owner rule", added: "2026-09-02", source: "owner" },
  ];
  const selected = selectBriefConstraints([...DEFAULT_CONTRACT.constraints, ...agent, ...owners]);
  assert.equal(selected.length, 12);
  assert.deepEqual(selected.slice(0, 2).map((c) => c.id), ["17-owner-new", "16-owner-old"]);
  assert.deepEqual(selected.slice(2).map((c) => c.id), DEFAULT_CONTRACT.constraints.slice(0, 10).map((c) => c.id));
  assert.equal(selected.some((c) => c.source === "agent"), false);
});

test("brief: owner task anchors the top of the brief and is bounded", () => {
  const brief = buildBrief({
    task: "Implement the compaction audit fixes",
    contract: DEFAULT_CONTRACT.constraints,
    corrections: [],
    loops: [],
    lastEvidence: null,
  });
  assert.equal(brief.split("\n")[0], "task: Implement the compaction audit fixes");
  const long = buildBrief({
    task: "x".repeat(500),
    contract: DEFAULT_CONTRACT.constraints,
    corrections: [],
    loops: [],
    lastEvidence: null,
  });
  const taskLine = long.split("\n")[0]!;
  assert.equal(Array.from(taskLine).length, "task: ".length + 200);
  assert.ok(taskLine.endsWith("…"), "an overlong task is marked, not silently cut");
  const none = buildBrief({ task: "", contract: DEFAULT_CONTRACT.constraints, corrections: [], loops: [], lastEvidence: null });
  assert.doesNotMatch(none, /^task:/m);
});

test("brief: agent notes are explicitly unverified and shorter than trusted entries", () => {
  const agentNotes = Array.from({ length: 4 }, (_, i) => ({
    type: "decision",
    text: `model note ${i} ${"y".repeat(200)}`,
    tags: ["agent"],
  }));
  const brief = buildBrief({
    contract: DEFAULT_CONTRACT.constraints,
    corrections: [],
    agentNotes,
    loops: [],
    lastEvidence: null,
  });
  assert.match(brief, /\nagent notes \(unverified\):\n/);
  const noteLines = brief.split("\n").filter((line) => line.startsWith("- model note"));
  assert.equal(noteLines.length, 2, "only the newest two notes are shown");
  assert.ok(noteLines.every((line) => line.includes("…")), "notes are truncated to the shorter cap");
  assert.match(brief, /\+2 more journal entries — guard_journal reads them/);
});

test("brief: trusted journal text is never silently cut", () => {
  const long = `reasoning ${"z".repeat(260)}`;
  const brief = buildBrief({
    contract: DEFAULT_CONTRACT.constraints,
    decisions: [{ type: "decision", text: long, tags: [] }],
    corrections: [],
    loops: [],
    lastEvidence: null,
  });
  assert.match(brief, /^journal text truncated — guard_journal shows the full entry$/m);
  const short = buildBrief({
    contract: DEFAULT_CONTRACT.constraints,
    decisions: [{ type: "decision", text: "short decision", tags: [] }],
    corrections: [],
    loops: [],
    lastEvidence: null,
  });
  assert.doesNotMatch(short, /guard_journal/);
  assert.doesNotMatch(short, /guard_recall/);
});

test("brief: hidden journal entries point at guard_recall", () => {
  const brief = buildBrief({
    contract: [],
    decisions: [],
    corrections: Array.from({ length: 5 }, (_, i) => ({
      type: "correction",
      text: `correction ${i}`,
      tags: [],
    })).reverse(),
    loops: [],
    lastEvidence: null,
  });
  assert.match(
    brief,
    /\+2 more journal entries — guard_journal reads them; guard_recall searches the retained window/,
  );
});

test("brief: task tag matches inject at most two trusted rows the caps hid", () => {
  const decisions = [
    { type: "decision", text: "newest unrelated", tags: ["other"] },
    { type: "decision", text: "also unrelated", tags: ["misc"] },
    { type: "decision", text: "third unrelated", tags: ["misc"] },
    { type: "decision", text: "use ripgrep for search", tags: ["Search"] },
    { type: "decision", text: "older ledger rule", tags: ["ledger"] },
  ];
  const notes = [
    { type: "note", text: "trusted ledger note", tags: ["ledger"] },
    { type: "note", text: "agent ledger note", tags: ["ledger", "agent"] },
  ];
  const brief = buildBrief({
    task: "Repair the ledger window and the search path",
    contract: [],
    decisions,
    corrections: [],
    recallPool: [...notes, ...decisions.slice(3)],
    loops: [],
    lastEvidence: null,
  });
  const recallLines = brief.split("\n").filter((line) => line.startsWith("- ") && line.includes(":"));
  const injected = brief.split("\n").filter((line) => line.startsWith("- note:") || line.startsWith("- decision:"));
  assert.equal(injected.length, BRIEF_MAX_RECALL);
  assert.match(brief, /recall:/);
  assert.match(brief, /trusted ledger note/);
  assert.match(brief, /use ripgrep for search/);
  assert.doesNotMatch(brief, /older ledger rule/, "only the two newest tag matches are injected");
  assert.doesNotMatch(brief, /agent ledger note/);
  assert.ok(recallLines.length >= injected.length);

  const alreadyVisible = buildBrief({
    task: "follow the newest unrelated plan",
    contract: [],
    decisions: [{ type: "decision", text: "newest unrelated", tags: ["newest"] }],
    corrections: [],
    recallPool: [{ type: "decision", text: "newest unrelated", tags: ["newest"] }],
    loops: [],
    lastEvidence: null,
  });
  assert.doesNotMatch(alreadyVisible, /^recall:/m);

  assert.deepEqual(
    selectTaskRecall("the and for", [{ type: "note", text: "stopwords only", tags: ["the"] }], new Set()),
    [],
  );
});
