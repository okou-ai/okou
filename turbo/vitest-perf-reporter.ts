/**
 * vitest-perf-reporter.ts
 *
 * Custom reporter that prints per-file wall-clock timing after a test run.
 * Enable by setting VITEST_PERF=1 before running vitest:
 *
 *   VITEST_PERF=1 pnpm test
 *   VITEST_PERF=1 pnpm -F @okouai/api exec vitest run
 *   pnpm test:perf
 */
import type { Reporter, TestRunEndReason } from "vitest/node";
import type { TestModule } from "vitest/node";

interface FileStat {
  moduleId: string;
  relativeId: string;
  /** Accumulated test duration (ms) */
  duration: number;
  /** Environment + prepare + collect + setup overhead (ms) */
  overhead: number;
  testCount: number;
  failCount: number;
  state: string;
}

function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtBar(fraction: number, width = 18): string {
  const filled = Math.round(Math.min(fraction, 1) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export default class PerfReporter implements Reporter {
  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    _errors: ReadonlyArray<unknown>,
    _reason: TestRunEndReason,
  ): void {
    const stats: FileStat[] = [];

    for (const mod of testModules) {
      const diag = mod.diagnostic();
      const duration = diag.duration;
      const overhead =
        diag.environmentSetupDuration +
        diag.prepareDuration +
        diag.collectDuration +
        diag.setupDuration;

      let testCount = 0;
      let failCount = 0;
      for (const tc of mod.children.allTests()) {
        testCount++;
        const r = tc.result();
        if (r.state === "failed") failCount++;
      }

      stats.push({
        moduleId: mod.moduleId,
        relativeId: mod.relativeModuleId,
        duration,
        overhead,
        testCount,
        failCount,
        state: mod.state(),
      });
    }

    // Sort by total time (duration + overhead) descending
    stats.sort((a, b) => b.duration + b.overhead - (a.duration + a.overhead));

    const totalDuration = stats.reduce((s, f) => s + f.duration, 0);
    const totalOverhead = stats.reduce((s, f) => s + f.overhead, 0);
    const maxTotal = (stats[0]?.duration ?? 0) + (stats[0]?.overhead ?? 0);

    const W = 114;
    const line = "─".repeat(W);

    console.log(`\n${line}`);
    console.log("📊  vitest per-file timing  (VITEST_PERF=1)");
    console.log(
      "     duration = accumulated test time  |  overhead = env+prepare+collect+setup",
    );
    console.log(line);
    console.log(
      `${"File".padEnd(58)} ${"duration".padStart(10)} ${"overhead".padStart(10)} ${"tests".padStart(7)} ${"fail".padStart(5)}  bar (total)`,
    );
    console.log(line);

    const shown = stats.slice(0, 50);
    for (const s of shown) {
      const truncated =
        s.relativeId.length > 57 ? "…" + s.relativeId.slice(-56) : s.relativeId;
      const dur = fmtMs(s.duration);
      const over = fmtMs(s.overhead);
      const fail = s.failCount > 0 ? String(s.failCount) : "-";
      const bar = fmtBar((s.duration + s.overhead) / (maxTotal || 1));
      const slowMark = s.duration + s.overhead > 5_000 ? "⚠ " : "  ";
      console.log(
        `${slowMark}${truncated.padEnd(56)} ${dur.padStart(10)} ${over.padStart(10)} ${String(s.testCount).padStart(7)} ${fail.padStart(5)}  ${bar}`,
      );
    }

    if (stats.length > 50) {
      console.log(`  … and ${stats.length - 50} more files`);
    }

    console.log(line);

    const top10Total = stats
      .slice(0, 10)
      .reduce((s, f) => s + f.duration + f.overhead, 0);
    const grandTotal = totalDuration + totalOverhead;
    const pct =
      grandTotal > 0 ? Math.round((top10Total / grandTotal) * 100) : 0;
    console.log(
      `  Files: ${stats.length}  |  Accumulated tests: ${fmtMs(totalDuration)}  |  Total overhead: ${fmtMs(totalOverhead)}  |  Top-10: ${fmtMs(top10Total)} (${pct}%)`,
    );
    console.log(
      `  For per-file CPU profiling:  pnpm profile-tests [workspace]`,
    );
    console.log(line);
  }
}
