#!/usr/bin/env node
// Print a one-line-per-bench summary of the custom P90 reporter output.
// Usage: node print-bench-summary.mjs <bench-results-p90.json>

import { readFileSync, existsSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";

function fmt(value) {
  return value.toFixed(2);
}

function benchLine(bench) {
  if (typeof bench.mean !== "number") {
    return { line: `  ${bench.name}: no samples`, missingSamples: true };
  }
  const p90 = typeof bench.p90 === "number" ? `  p90=${fmt(bench.p90)}ms` : "";
  return {
    line: `  ${bench.name}: hz=${fmt(bench.hz)} ops/s  mean=${fmt(bench.mean)}ms${p90}  p99=${fmt(bench.p99)}ms  rme=±${fmt(bench.rme)}%`,
    missingSamples: false,
  };
}

function main() {
  const path = argv[2] ?? "bench-results-p90.json";
  if (!existsSync(path)) {
    stderr.write(`::warning::${path} not found\n`);
    exit(0);
  }

  const report = JSON.parse(readFileSync(path, "utf8"));
  const entries = (report.files ?? []).flatMap((file) => {
    return (file.groups ?? []).flatMap((group) => {
      return [
        { line: `\n${group.fullName}`, missingSamples: false },
        ...(group.benchmarks ?? []).map(benchLine),
      ];
    });
  });

  stdout.write(
    entries
      .map((entry) => {
        return entry.line;
      })
      .join("\n") + "\n",
  );
  if (
    entries.some((entry) => {
      return entry.missingSamples;
    })
  ) {
    stderr.write("::error::bench report contains benchmarks with no samples\n");
    exit(1);
  }
}

main();
