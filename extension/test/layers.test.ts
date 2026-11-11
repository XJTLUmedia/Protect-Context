import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addConstraintWithStatus, loadContract, removeConstraint } from "../lib/contract.ts";
import { loadConfig } from "../lib/config.ts";
import { DEFAULT_CONFIG, DEFAULT_CONTRACT } from "../lib/defaults.ts";
import { contractPath, configPath } from "../lib/store.ts";

/** Run `fn` with `PC_USER_DIR` pointed at a fresh personal layer. */
function withPersonalLayer<T>(fn: (userDir: string, cwd: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "pc-layers-"));
  const previous = process.env.PC_USER_DIR;
  process.env.PC_USER_DIR = join(root, "user");
  try {
    return fn(join(root, "user"), join(root, "project"));
  } finally {
    if (previous === undefined) delete process.env.PC_USER_DIR;
    else process.env.PC_USER_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function writePersonal(userDir: string, constraints: unknown[]): void {
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, "contract.json"), JSON.stringify({ version: 1, constraints }), "utf8");
}

const row = (id: string, text: string) => ({ id, text, added: "2026-10-30", source: "user" });

test("contract: personal constraints apply to the project without being copied into it", () => {
  withPersonalLayer((userDir, cwd) => {
    writePersonal(userDir, [row("13-personal", "Prefer boring technology.")]);
    const effective = loadContract(cwd);
    assert.deepEqual(
      effective.constraints.map((c) => c.id),
      [...DEFAULT_CONTRACT.constraints.map((c) => c.id), "13-personal"],
    );
    const onDisk = JSON.parse(readFileSync(contractPath(cwd), "utf8")) as { constraints: { id: string }[] };
    assert.deepEqual(onDisk.constraints.map((c) => c.id), DEFAULT_CONTRACT.constraints.map((c) => c.id));
  });
});

test("contract: the project overrides a personal row with the same id", () => {
  withPersonalLayer((userDir, cwd) => {
    writePersonal(userDir, [row("03-stay-in-scope", "Personal wording of scope.")]);
    const effective = loadContract(cwd);
    const row03 = effective.constraints.find((c) => c.id === "03-stay-in-scope");
    assert.match(row03!.text, /^Change only files/);
    assert.equal(effective.constraints.length, DEFAULT_CONTRACT.constraints.length, "shadowed, not appended");
  });
});

test("contract: identical personal text is not listed twice", () => {
  withPersonalLayer((userDir, cwd) => {
    const seedText = DEFAULT_CONTRACT.constraints[0].text;
    writePersonal(userDir, [row("99-dup", seedText)]);
    const effective = loadContract(cwd);
    assert.equal(effective.constraints.filter((c) => c.text === seedText).length, 1);
    assert.equal(effective.constraints.length, DEFAULT_CONTRACT.constraints.length);
  });
});

test("contract: a corrupt personal layer is ignored and never overwritten", () => {
  withPersonalLayer((userDir, cwd) => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "contract.json"), "{not json", "utf8");
    const effective = loadContract(cwd);
    assert.equal(effective.constraints.length, DEFAULT_CONTRACT.constraints.length);
    assert.equal(readFileSync(join(userDir, "contract.json"), "utf8"), "{not json");
  });
});

test("contract: personal-scope add writes the personal file and skips project duplicates", () => {
  withPersonalLayer((userDir, cwd) => {
    const result = addConstraintWithStatus(cwd, "Personal rule.", "user", "user");
    assert.equal(result.added, true);
    // The extension used to number ids bare ("13") while Python slugged the same
    // row ("13-personal-rule"), so one store held two id formats.
    assert.ok(
      result.constraint.id.startsWith("13-"),
      "ids continue after the project's 12 seeds and carry the slug contract.py uses",
    );
    const personal = JSON.parse(readFileSync(join(userDir, "contract.json"), "utf8")) as {
      constraints: { id: string }[];
    };
    assert.deepEqual(personal.constraints.map((c) => c.id), ["13-personal-rule"]);
    assert.ok(!existsSync(contractPath(cwd)), "a personal write does not seed the project store");

    const duplicate = addConstraintWithStatus(cwd, "Personal rule.", "user", "project");
    assert.equal(duplicate.added, false, "a personal constraint is not duplicated into the project");
  });
});

test("contract: project-scope remove cannot delete personal state", () => {
  withPersonalLayer((_userDir, cwd) => {
    const added = addConstraintWithStatus(cwd, "Keep me.", "user", "user").constraint;
    assert.equal(removeConstraint(cwd, added.id, "project"), false);
    assert.ok(loadContract(cwd).constraints.some((c) => c.id === added.id));
    assert.equal(removeConstraint(cwd, added.id, "user"), true);
    assert.ok(!loadContract(cwd).constraints.some((c) => c.id === added.id));
  });
});

test("config: the personal layer is weaker than the project but stronger than defaults", () => {
  withPersonalLayer((userDir, cwd) => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "config.json"), JSON.stringify({ ctx_warn_pct: 55, risk_confirm: false }), "utf8");

    const inherited = loadConfig(cwd).config;
    assert.equal(inherited.ctx_warn_pct, 55, "a seeded project snapshot is not an explicit choice");
    assert.equal(inherited.risk_confirm, false);
    assert.equal(inherited.loop_block_after, DEFAULT_CONFIG.loop_block_after);

    mkdirSync(join(cwd, ".agent-guard"), { recursive: true });
    writeFileSync(join(cwd, ".agent-guard", "config.json"), JSON.stringify({ ctx_warn_pct: 66 }), "utf8");
    const overridden = loadConfig(cwd).config;
    assert.equal(overridden.ctx_warn_pct, 66, "an explicit project value wins");
    assert.equal(overridden.risk_confirm, false, "personal value survives for keys the project omits");
  });
});

test("config: the seed is the built-in default snapshot, never the merged view", () => {
  withPersonalLayer((userDir, cwd) => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "config.json"), JSON.stringify({ ctx_warn_pct: 55 }), "utf8");
    const loaded = loadConfig(cwd, true);
    assert.equal(loaded.existed, false);
    assert.deepEqual(JSON.parse(readFileSync(configPath(cwd), "utf8")), DEFAULT_CONFIG);
    assert.equal(loadConfig(cwd).config.ctx_warn_pct, 55, "the personal value still applies");
  });
});

test("config: unknown keys are preserved per layer and never interpreted", () => {
  withPersonalLayer((userDir, cwd) => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, "config.json"),
      JSON.stringify({ ctx_warn_pct: 55, my_knob: "personal", shared_note: "from-personal" }),
      "utf8",
    );
    const inherited = loadConfig(cwd);
    assert.equal(inherited.config.ctx_warn_pct, 55);
    assert.equal(inherited.extras.my_knob, "personal");
    assert.equal(inherited.extras.shared_note, "from-personal");
    assert.deepEqual(Object.keys(inherited.config).sort(), Object.keys(DEFAULT_CONFIG).sort(), "known keys stay strict");

    mkdirSync(join(cwd, ".agent-guard"), { recursive: true });
    writeFileSync(join(cwd, ".agent-guard", "config.json"), JSON.stringify({ shared_note: "from-project" }), "utf8");
    const overridden = loadConfig(cwd);
    assert.equal(overridden.extras.shared_note, "from-project", "the strongest layer wins per unknown key");
    assert.equal(overridden.extras.my_knob, "personal");
  });
});
