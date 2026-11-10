#!/usr/bin/env node
/**
 * protect-context Node CLI.
 *
 * The pi extension and the Python CLI/MCP share one on-disk store
 * (.agent-guard/). This binary gives the npm side its own front door to that
 * same store, which is the surface `commander` (argument parsing), `ora`
 * (progress) and `glob` (path expansion) exist for.
 *
 * It deliberately only reads: every mutation still goes through the Python CLI
 * or the extension, so there is exactly one writer per concern.
 */

import boxen from "boxen";
import { Command } from "commander";
import Table from "cli-table3";
import { globSync } from "glob";
import { minimatch } from "minimatch";
import ora from "ora";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const STORE = ".agent-guard";

function storePath(name) {
  return join(process.cwd(), STORE, name);
}

const JournalRow = z.object({
  ts: z.string().optional(),
  type: z.string().optional(),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row !== null);
}

const program = new Command();

program
  .name("pc")
  .description("Read the protect-context store (.agent-guard/) from Node")
  .version("3.3.1");

program
  .command("journal")
  .description("show the most recent journal entries")
  .option("-n, --tail <count>", "how many entries", "5")
  .action((options) => {
    const spin = ora("reading journal").start();
    const rows = readJsonl(storePath("journal.jsonl"));
    spin.stop();
    if (rows.length === 0) {
      console.log("journal: no entries yet");
      return;
    }
    const tail = Math.max(1, Number.parseInt(options.tail, 10) || 5);
    const table = new Table({ head: ["ts", "type", "text"], wordWrap: true, colWidths: [26, 12, 80] });
    for (const row of rows.slice(-tail)) {
      const parsed = JournalRow.safeParse(row);
      if (!parsed.success) continue;
      table.push([parsed.data.ts ?? "?", parsed.data.type ?? "?", parsed.data.text ?? ""]);
    }
    console.log(table.toString());
  });

program
  .command("files <pattern>")
  .description("expand a glob inside the project")
  .option("-l, --limit <count>", "maximum hits", "20")
  .action((pattern, options) => {
    const spin = ora(`globbing ${pattern}`).start();
    const ignore = ["node_modules/**", "vendor/**"];
    const hits = globSync(pattern, { nodir: true, ignore }).filter(
      (hit) => !ignore.some((rule) => minimatch(hit, rule)),
    );
    spin.stop();
    const limit = Math.max(1, Number.parseInt(options.limit, 10) || 20);
    for (const hit of hits.slice(0, limit)) console.log(hit);
    if (hits.length > limit) console.log(`… ${hits.length - limit} more`);
  });

program
  .command("status")
  .description("count rows in each store ledger")
  .action(() => {
    const spin = ora("reading store").start();
    const counts = ["events.jsonl", "journal.jsonl", "verify_runs.jsonl"].map((name) => [
      name,
      readJsonl(storePath(name)).length,
    ]);
    spin.stop();
    if (!existsSync(storePath(""))) {
      console.log(`status: no store at ${STORE}/ (run the Python CLI once)`);
      return;
    }
    const table = new Table({ head: ["ledger", "rows"] });
    for (const [name, count] of counts) table.push([name, count]);
    console.log(boxen(table.toString(), { padding: 1, borderStyle: "round", title: "protect-context store" }));
  });

program.parse();
