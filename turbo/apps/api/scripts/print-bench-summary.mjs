#!/usr/bin/env node
// Print a one-line-per-bench summary of the custom P90 reporter output.
// Usage: node print-bench-summary.mjs <bench-results-p90.json>

import { readFileSync, existsSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";

const path = argv[2] ?? "bench-results-p90.json";
if (!existsSync(path)) {
  stderr.write(`::warning::${path} not found\n`);
  exit(0);
}

const report = JSON.parse(readFileSync(path, "utf8"));
const lines = [];
let hasMissingSamples = false;
for (const file of report.files ?? []) {
  for (const group of file.groups ?? []) {
    lines.push(`\n${group.fullName}`);
    for (const bench of group.benchmarks ?? []) {
      if (typeof bench.mean !== "number") {
        hasMissingSamples = true;
        lines.push(`  ${bench.name}: no samples`);
        continue;
      }
      const fmt = (n) => {
        return n.toFixed(2);
      };
      const p90 =
        typeof bench.p90 === "number" ? `  p90=${fmt(bench.p90)}ms` : "";
      lines.push(
        `  ${bench.name}: hz=${fmt(bench.hz)} ops/s  mean=${fmt(bench.mean)}ms${p90}  p99=${fmt(bench.p99)}ms  rme=±${fmt(bench.rme)}%`,
      );
    }
  }
}
stdout.write(lines.join("\n") + "\n");
if (hasMissingSamples) {
  stderr.write("::error::bench report contains benchmarks with no samples\n");
  exit(1);
}
