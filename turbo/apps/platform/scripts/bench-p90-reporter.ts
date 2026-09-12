import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Reporter, TestModule, TestRunEndReason } from "vitest/node";

interface BenchmarkJson {
  files: {
    filepath: string;
    groups: {
      fullName: string;
      benchmarks: Record<string, unknown>[];
    }[];
  }[];
}

function percentile(sortedSamples: number[], percentileValue: number): number {
  if (sortedSamples.length === 0) {
    return Number.NaN;
  }
  const index = Math.ceil(percentileValue * sortedSamples.length) - 1;
  return sortedSamples[Math.max(0, Math.min(sortedSamples.length - 1, index))]!;
}

// Vitest custom reporters are loaded from the default export.
export default class BenchP90Reporter implements Reporter {
  onTestRunEnd(
    testModules: readonly TestModule[],
    _errors: readonly unknown[],
    _reason: TestRunEndReason,
  ): void {
    const report: BenchmarkJson = { files: [] };

    for (const mod of testModules) {
      const groupsByName = new Map<string, Record<string, unknown>[]>();

      for (const test of mod.children.allTests()) {
        const groupName =
          test.parent.type === "suite"
            ? test.parent.fullName
            : mod.relativeModuleId;
        for (const group of test.benchmarks()) {
          for (const result of group.tasks) {
            const samples = result.latency.samples;
            if (!samples || samples.length === 0) {
              throw new Error(
                `Benchmark ${result.name} has no retained latency samples`,
              );
            }
            const sortedSamples = [...samples].sort((a, b) => {
              return a - b;
            });
            const benchmarks = groupsByName.get(groupName) ?? [];
            benchmarks.push({
              id: test.id,
              name: result.name,
              ...result.latency,
              hz: result.throughput.mean,
              totalTime: result.totalTime,
              p90: percentile(sortedSamples, 0.9),
              sampleCount: samples.length,
            });
            groupsByName.set(groupName, benchmarks);
          }
        }
      }

      if (groupsByName.size > 0) {
        report.files.push({
          filepath: mod.relativeModuleId,
          groups: [...groupsByName.entries()].map(([groupName, benchmarks]) => {
            return {
              fullName: groupName,
              benchmarks,
            };
          }),
        });
      }
    }

    const outputPath = resolve(
      process.cwd(),
      process.env.VITEST_BENCH_P90_JSON ?? "bench-results-p90.json",
    );
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}
