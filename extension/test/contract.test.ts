import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadContract,
  addConstraint,
  addConstraintWithStatus,
  removeConstraint,
  contractLines,
  constraintId,
  nextConstraintId,
  slugify,
} from "../lib/contract.ts";
import { checkContractSummary, renderChecklist } from "../lib/contract_check.ts";
import { DEFAULT_CONTRACT } from "../lib/defaults.ts";

function tmpStore(): string {
  return mkdtempSync(join(tmpdir(), "pc-contract-"));
}

const pythonExe = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const projectSrc = fileURLToPath(new URL("../../src", import.meta.url));

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

test("contract: load seeds contract.json with the 12 frozen constraints", () => {
  const dir = tmpStore();
  try {
    const contract = loadContract(dir);
    assert.equal(contract.constraints.length, 12);
    assert.equal(contract.constraints[0]?.id, "01-obey-instructions");
    assert.equal(
      contract.constraints[1]?.text,
      "Never claim success without citing a fresh verification run (evidence id or pasted output) for the exact claim.",
    );
    assert.ok(existsSync(join(dir, ".agent-guard", "contract.json")));
    // Second load reads the same file (idempotent seed).
    assert.deepEqual(loadContract(dir), contract);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: add/remove CRUD roundtrip", () => {
  const dir = tmpStore();
  try {
    const added = addConstraint(dir, "Never deploy on Fridays");
    // Slugged like contract.py: the bare number was a cross-surface id split
    // (`/guard-contract add` wrote "13", the CLI wrote "13-never-deploy-on").
    assert.equal(added.id, "13-never-deploy-on-fridays");
    assert.equal(added.source, "agent");
    const raw = JSON.parse(readFileSync(join(dir, ".agent-guard", "contract.json"), "utf8"));
    assert.equal(raw.constraints.length, 13);
    assert.equal(nextConstraintId(raw.constraints), "14");
    assert.ok(removeConstraint(dir, added.id));
    assert.equal(removeConstraint(dir, added.id), false, "removing twice fails cleanly");
    assert.equal(loadContract(dir).constraints.length, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: corrupt file falls back to defaults WITHOUT overwriting", () => {
  const dir = tmpStore();
  try {
    const file = join(dir, ".agent-guard", "contract.json");
    mkdirSync(join(dir, ".agent-guard"), { recursive: true });
    const corrupt = '{"version":1,"constraints":[{"id":"13-my-rule","tex'; // truncated JSON
    writeFileSync(file, corrupt, "utf8");
    const contract = loadContract(dir);
    assert.equal(contract.constraints.length, 12, "in-memory defaults served");
    assert.equal(readFileSync(file, "utf8"), corrupt, "user file must not be clobbered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: add caps free-text at 500 chars (brief re-injection budget)", () => {
  const dir = tmpStore();
  try {
    const added = addConstraint(dir, "x".repeat(900));
    assert.equal(added.text.length, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: rejects blank text without appending", () => {
  const dir = tmpStore();
  try {
    assert.throws(() => addConstraint(dir, " \n\t "), /must not be blank/);
    assert.equal(loadContract(dir).constraints.length, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: added and legacy values render as safe single lines", () => {
  const dir = tmpStore();
  try {
    const added = addConstraint(dir, " owner\nrule\u0000with\u200Bcontrols ");
    assert.equal(added.text, "owner rule with controls");
    const rendered = contractLines({
      version: 1,
      constraints: [{ id: "13\nlegacy", text: "legacy\u0000 text\nnext", added: "", source: "agent" }],
    });
    assert.deepEqual(rendered, ["13 legacy: legacy text next"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: normalized duplicates are returned without another write", () => {
  const dir = tmpStore();
  try {
    const first = addConstraintWithStatus(dir, "owner rule", "user");
    const duplicate = addConstraintWithStatus(dir, " owner\nrule\u200B ", "user");
    assert.equal(first.added, true);
    assert.equal(duplicate.added, false);
    assert.equal(duplicate.constraint.id, first.constraint.id);
    assert.equal(loadContract(dir).constraints.length, 13);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: malformed legacy rows are filtered instead of crashing readers", () => {
  const dir = tmpStore();
  try {
    const file = join(dir, ".agent-guard", "contract.json");
    mkdirSync(join(dir, ".agent-guard"), { recursive: true });
    const valid = { id: "13-valid", text: "keep me", added: "2026-09-01", source: "user" };
    writeFileSync(file, JSON.stringify({ version: 1, constraints: [null, 7, { id: "broken" }, valid] }), "utf8");
    const loaded = loadContract(dir);
    assert.deepEqual(loaded.constraints, [valid]);
    assert.deepEqual(contractLines(loaded), ["13-valid: keep me"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: wholly malformed non-empty list falls back to seeds without overwrite", () => {
  const dir = tmpStore();
  try {
    const file = join(dir, ".agent-guard", "contract.json");
    mkdirSync(join(dir, ".agent-guard"), { recursive: true });
    const malformed = JSON.stringify({ version: 1, constraints: [null, 7, { id: "broken" }] });
    writeFileSync(file, malformed, "utf8");
    assert.deepEqual(loadContract(dir), DEFAULT_CONTRACT);
    assert.equal(readFileSync(file, "utf8"), malformed, "damaged owner file is not overwritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: concurrent Python and Node adds preserve all cross-runtime updates", async () => {
  const dir = tmpStore();
  try {
    const pythonScript = [
      "import os, sys, time",
      "from protect_context import contract",
      "os.chdir(sys.argv[1])",
      "for i in range(20):",
      "    contract.add(f'python constraint {i}')",
      "    time.sleep(0.001)",
    ].join("\n");
    const contractUrl = pathToFileURL(fileURLToPath(new URL("../lib/contract.ts", import.meta.url))).href;
    const nodeScript = [
      `import { addConstraint } from ${JSON.stringify(contractUrl)};`,
      "const cwd = process.argv[1];",
      "const sleeper = new Int32Array(new SharedArrayBuffer(4));",
      "for (let i = 0; i < 20; i += 1) {",
      "  addConstraint(cwd, `node constraint ${i}`);",
      "  Atomics.wait(sleeper, 0, 0, 1);",
      "}",
    ].join("\n");
    const pythonEnv = {
      ...process.env,
      PYTHONPATH: [projectSrc, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    };

    await Promise.all([
      runChild(pythonExe, ["-c", pythonScript, dir], pythonEnv),
      runChild(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "--eval", nodeScript, dir],
        process.env,
      ),
    ]);

    const constraints = loadContract(dir).constraints;
    const concurrent = constraints.filter((constraint) => constraint.text.includes(" constraint "));
    assert.equal(concurrent.length, 40);
    assert.equal(new Set(concurrent.map((constraint) => constraint.id)).size, 40);
    assert.equal(new Set(concurrent.map((constraint) => constraint.text)).size, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("contract: one compact line per constraint", () => {
  const lines = contractLines(DEFAULT_CONTRACT);
  assert.equal(lines.length, 12);
  assert.ok(lines[0]?.startsWith("01-obey-instructions: Obey the owner's"));
});

test("contract: rendered list is bounded while retaining seeds and newest entries", () => {
  const extras = Array.from({ length: 30 }, (_, index) => ({
    id: `${index + 13}-extra`,
    text: `extra ${index + 13}`,
    added: "2026-09-02",
    source: "user",
  }));
  const lines = contractLines({ version: 1, constraints: [...DEFAULT_CONTRACT.constraints, ...extras] });

  assert.equal(lines.length, 25, "one omission line plus 24 constraints");
  assert.match(lines[0] ?? "", /18 older non-seed constraints omitted/);
  assert.ok(lines.some((line) => line.startsWith("01-obey-instructions:")));
  assert.ok(lines.some((line) => line.startsWith("42-extra:")));
  assert.ok(!lines.some((line) => line.startsWith("13-extra:")));
});

test("contract_check: heuristic marks addressed vs unclear", () => {
  const summary =
    "Added a test for the new behavior; kept the diff small and split commits; " +
    "ran the verification run for evidence; recorded the decision in the journal.";
  const items = checkContractSummary(summary, DEFAULT_CONTRACT);
  const addressed = items.filter((i) => i.addressed).map((i) => i.id.slice(0, 2));
  const unclear = items.filter((i) => !i.addressed).map((i) => i.id.slice(0, 2));
  assert.ok(addressed.includes("02"), "evidence keyword hit");
  assert.ok(addressed.includes("05"), "test keyword hit");
  assert.ok(addressed.includes("06"), "journal keyword hit");
  assert.ok(!addressed.includes("01"), "no instruction keywords");
  assert.ok(unclear.includes("01"));
  const rendered = renderChecklist(items);
  assert.ok(rendered.startsWith("addressed:"));
  assert.ok(rendered.includes("unclear: 01"));
  assert.ok(rendered.trimEnd().split("\n").pop()?.startsWith("Nudge:"));
});

test("contract_check: empty summary marks everything unclear with a Nudge", () => {
  const rendered = renderChecklist(checkContractSummary("", DEFAULT_CONTRACT));
  assert.ok(rendered.includes("addressed: (none)"));
  assert.ok(rendered.includes("unclear: 01 02 03 04 05 06 07 08 09 10 11 12"));
  assert.ok(rendered.includes("Nudge:"));
});

test("contract_check: large custom contracts produce bounded id lists", () => {
  const rendered = renderChecklist(
    Array.from({ length: 80 }, (_, index) => ({
      id: String(index).padStart(2, "0"),
      addressed: false,
      basis: "keyword" as const,
    })),
  );

  assert.match(rendered, /unclear: .* \+56 more/);
  assert.ok(rendered.length < 250);
});

test("contract_check: facts measure 02 and 08 instead of the summary", () => {
  const facts = {
    lastEvidence: { id: "ev-0042", label: "ok" as const },
    diffLines: 12,
    diffFiles: 2,
    diffHardLines: 400,
  };
  const items = checkContractSummary("cited ev-0042", DEFAULT_CONTRACT, facts);
  const byId = (prefix: string) => items.find((item) => item.id.startsWith(prefix))!;

  assert.equal(byId("02").basis, "evidence");
  assert.equal(byId("02").addressed, true);
  assert.equal(byId("08").basis, "diff");
  assert.equal(byId("08").addressed, true);

  const rendered = renderChecklist(items, facts);
  assert.match(rendered, /basis: evidence ev-0042 ok · diff 2 files 12 lines \(hard 400\) · self-report: /);
  // 02 and 08 are measured, so they must not be listed as self-report.
  const selfReport = /self-report: ([^\n]*)/.exec(rendered)?.[1] ?? "";
  assert.ok(!selfReport.includes("02") && !selfReport.includes("08"), selfReport);
});

test("contract_check: 02 needs a trustworthy, cited run; 08 fails a huge diff", () => {
  const base = { diffLines: 10, diffFiles: 1, diffHardLines: 400 };
  const item = (items: ReturnType<typeof checkContractSummary>, prefix: string) =>
    items.find((entry) => entry.id.startsWith(prefix))!;

  const untrusted = checkContractSummary("ran ev-0042", DEFAULT_CONTRACT, {
    ...base,
    lastEvidence: { id: "ev-0042", label: "UNTRUSTED" },
  });
  assert.equal(item(untrusted, "02").addressed, false, "masked exit 0 is not evidence");

  const uncited = checkContractSummary("all good", DEFAULT_CONTRACT, {
    ...base,
    lastEvidence: { id: "ev-0042", label: "ok" },
  });
  assert.equal(item(uncited, "02").addressed, false, "an uncited run does not satisfy 02");
  assert.match(renderChecklist(uncited, { ...base, lastEvidence: { id: "ev-0042", label: "ok" } }), /02 unclear: cite the newest evidence id/);

  const huge = checkContractSummary("kept the diff small", DEFAULT_CONTRACT, {
    ...base,
    diffLines: 401,
    lastEvidence: null,
  });
  assert.equal(item(huge, "08").addressed, false, "401 lines is a stop-and-split signal");
});

test("contract: a 中文 constraint keeps a meaningful id (mirrors Python)", () => {
  // The ASCII slug rule reduced 中文 text to its ASCII remnant (14-sql), so two
  // 中文 constraints read as "14-sql" and "15-sql" in every brief.
  assert.equal(slugify("永远不要在生产库执行破坏性 SQL"), "永远不要在生产库-sql");
  assert.equal(constraintId("14", "永远不要在生产库执行破坏性 SQL"), "14-永远不要在生产库-sql");
  // English text keeps exactly the id it had before the fallback existed.
  assert.equal(slugify("Always run pytest before committing"), "always-run-pytest-before");
  // Mixed text keeps the ASCII words readable and appends the 中文 head.
  assert.equal(slugify("永远不要在生产库执行 npm publish"), "npm-publish-永远不要在生产库");
});
