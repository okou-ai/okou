import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type BenchResult } from "vitest";
import { compileScript, evaluateScript, verifyRetained } from "./evaluate.mjs";

const output = process.env.OKOU_CONTRACTS_BENCHMARK_DIR;
if (!output) {
  throw new Error(
    "Run scripts/benchmark-client-contracts/cli.mjs to prepare pinned bundles first.",
  );
}
const directory = output;

// A sink retains every imported binding until the next evaluation. It does not
// traverse schemas, call request helpers, parse data, or warm an ESM module cache.
let retained: unknown;

test("cold production App contract import evaluation", async ({ bench }) => {
  const metadataText = await readFile(
    path.join(directory, "metadata.json"),
    "utf8",
  );
  const metadata: {
    expectedRetained: number;
    repetitions: { rounds: number; iterationsPerRound: number };
  } = JSON.parse(metadataText);
  const scripts = {
    baseline: compileScript(
      await readFile(path.join(directory, "baseline.js"), "utf8"),
      "baseline.iife.js",
    ),
    candidate: compileScript(
      await readFile(path.join(directory, "candidate.js"), "utf8"),
      "candidate.iife.js",
    ),
    empty: compileScript(
      "globalThis.__contractsBenchmarkRetained = [];",
      "empty-control.iife.js",
    ),
  };
  verifyRetained(
    evaluateScript(scripts.baseline).values,
    metadata.expectedRetained,
  );
  verifyRetained(
    evaluateScript(scripts.candidate).values,
    metadata.expectedRetained,
  );

  const rounds: {
    round: number;
    order: string[];
    baseline: BenchResult;
    candidate: BenchResult;
    control: BenchResult;
  }[] = [];
  for (let round = 0; round < metadata.repetitions.rounds; round++) {
    const baseline = bench("baseline", () => {
      retained = evaluateScript(scripts.baseline).values;
    });
    const candidate = bench("candidate", () => {
      retained = evaluateScript(scripts.candidate).values;
    });
    const control = bench("fresh-vm-control", () => {
      retained = evaluateScript(scripts.empty).values;
    });
    const options = {
      name: `cold evaluation round ${String(round + 1)}`,
      iterations: metadata.repetitions.iterationsPerRound,
      time: 0,
      warmupIterations: 5,
      warmupTime: 0,
      retainSamples: true,
      concurrency: null,
      subtractTimerOverhead: false,
    };
    const result =
      round % 2 === 0
        ? await bench.compare(baseline, candidate, control, options)
        : await bench.compare(candidate, baseline, control, options);
    rounds.push({
      round: round + 1,
      order:
        round % 2 === 0
          ? ["baseline", "candidate", "fresh-vm-control"]
          : ["candidate", "baseline", "fresh-vm-control"],
      baseline: result.get("baseline"),
      candidate: result.get("candidate"),
      control: result.get("fresh-vm-control"),
    });
  }

  function summarize(variant: "baseline" | "candidate" | "control") {
    const samples = rounds
      .flatMap((round) => {
        return round[variant].latency.samples ?? [];
      })
      .sort((left, right) => {
        return left - right;
      });
    if (!samples.length)
      throw new Error("Vitest did not retain benchmark samples.");
    function percentile(quantile: number) {
      const index = (samples.length - 1) * quantile;
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      return (
        samples[lower] + (samples[upper] - samples[lower]) * (index - lower)
      );
    }
    return {
      samples: samples.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      meanMs:
        samples.reduce((sum, value) => {
          return sum + value;
        }, 0) / samples.length,
      minMs: samples[0],
      maxMs: samples.at(-1),
    };
  }
  const summary = {
    baseline: summarize("baseline"),
    candidate: summarize("candidate"),
    control: summarize("control"),
  };
  await writeFile(
    path.join(directory, "results.json"),
    JSON.stringify(
      {
        ...JSON.parse(metadataText),
        completedAt: new Date().toISOString(),
        summary,
        p50RatioBaselineToCandidate:
          summary.baseline.p50Ms / summary.candidate.p50Ms,
        rounds,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(summary, null, 2));
  if (!retained) throw new Error("Benchmark sink was not populated.");
}, 120_000);
