import type { RunArtifactResult } from "@okouai/api-contracts/contracts/runs";
import { describe, expect, it } from "vitest";
import {
  buildRunPhaseTimingRollups,
  preserveRunPhaseTimingRollup,
  runPhaseTimingMarkedRunIds,
  runPhaseTimingRollupSchema,
  runPhaseTimingSourceWindow,
  type RunPhaseTimingMetadata,
  type RunPhaseTimingRollup,
} from "../run-phase-timing-rollup";

const RUN_A = "00000000-0000-4000-8000-000000000001";
const RUN_B = "00000000-0000-4000-8000-000000000002";
const RUN_C = "00000000-0000-4000-8000-000000000003";
const RUN_D = "00000000-0000-4000-8000-000000000004";
const START = "2026-11-14T16:00:00.000Z";
const END = "2026-11-14T16:00:10.000Z";

function run(id = RUN_A, status = "completed"): RunPhaseTimingMetadata {
  return {
    id,
    userId: "user_a",
    orgId: "org_a",
    status,
    artifactResult: "success",
    startedAt: START,
    completedAt: END,
  };
}
function research(at: string, id = RUN_A) {
  return {
    schema_version: 1,
    type: "run_phase_mark",
    _time: at,
    run_id: id,
    user_id: "user_a",
    org_id: "org_a",
    phase: "research-start",
  };
}
function generation(at: string, skipped = false, id = RUN_A, kind = "image") {
  return {
    ...research(at, id),
    phase: "generation-start",
    generation_kind: kind,
    research_skipped: skipped,
  };
}
function rollup(
  records: readonly unknown[],
  runs: readonly RunPhaseTimingMetadata[] = [run()],
): RunPhaseTimingRollup {
  const results = buildRunPhaseTimingRollups({
    dataset: "vm0-web-logs-prod",
    window: runPhaseTimingSourceWindow(new Date("2026-11-16T00:00:00.000Z")),
    records,
    runs,
  });
  const day = results.find((result) => {
    return result.date === "2026-11-15";
  });
  if (!day) {
    throw new Error("Missing completed Beijing day");
  }
  return runPhaseTimingRollupSchema.parse(day);
}
function group(
  day: RunPhaseTimingRollup,
  kind = "image",
  status = "completed",
  artifactResult: RunArtifactResult | null = "success",
) {
  const cohort = day.groups.find((entry) => {
    return (
      entry.generationKind === kind &&
      entry.status === status &&
      entry.artifactResult === artifactResult
    );
  });
  if (!cohort) {
    throw new Error("Missing cohort");
  }
  return cohort;
}

describe("Run phase timing rollup", () => {
  it("uses two completed Beijing days and one exact three-day source window", () => {
    expect(
      runPhaseTimingSourceWindow(new Date("2026-11-16T00:00:00.000Z")),
    ).toStrictEqual({
      startTime: "2026-11-13T00:00:00.000Z",
      endTime: "2026-11-16T00:00:00.000Z",
      days: [
        {
          date: "2026-11-14",
          startTime: "2026-11-13T16:00:00.000Z",
          endTime: "2026-11-14T16:00:00.000Z",
        },
        {
          date: "2026-11-15",
          startTime: "2026-11-14T16:00:00.000Z",
          endTime: "2026-11-15T16:00:00.000Z",
        },
      ],
    });
  });

  it("attributes a cross-midnight Run by completion, not its phase date", () => {
    const day = rollup(
      [
        research("2026-11-14T15:59:58.000Z"),
        generation("2026-11-14T15:59:59.000Z"),
      ],
      [
        {
          ...run(),
          startedAt: "2026-11-14T15:59:57.000Z",
          completedAt: "2026-11-14T16:00:00.000Z",
        },
      ],
    );
    expect(day.counts.markedRuns).toBe(1);
    expect(group(day).metrics.prepare).toMatchObject({ count: 1, minMs: 1000 });
    expect(group(day).metrics.research).toMatchObject({
      count: 1,
      minMs: 1000,
    });
    expect(group(day).metrics.makingDelivery).toMatchObject({
      count: 1,
      minMs: 1000,
    });
    expect(group(day).metrics.total.minMs).toBe(3000);
  });

  it("selects the earliest valid marks deterministically and counts repeats/conflicts", () => {
    const rows = [
      generation("2026-11-14T16:00:06.000Z", false, RUN_A, "report"),
      research("2026-11-14T15:59:59.000Z"),
      research("2026-11-14T16:00:01.000Z"),
      generation("2026-11-14T16:00:02.000Z"),
      research("2026-11-14T16:00:05.000Z"),
      generation("2026-11-14T16:00:02.000Z"),
    ];
    const day = rollup(rows);
    expect(rollup([...rows].reverse())).toStrictEqual(day);
    expect(day.counts).toMatchObject({
      markedRuns: 1,
      duplicateMarks: 3,
      conflictingMarks: 1,
      invalidMarks: 2,
    });
    expect(group(day).metrics.prepare.minMs).toBe(1000);
    expect(group(day).metrics.research.minMs).toBe(1000);
    expect(group(day).metrics.makingDelivery.minMs).toBe(8000);
    expect(group(day, "report").runs).toBe(0);
  });

  it("keeps explicit skipped research zero separate from missing research", () => {
    const day = rollup(
      [
        generation("2026-11-14T16:00:02.000Z", true),
        generation("2026-11-14T16:00:03.000Z", false, RUN_B),
      ],
      [run(), run(RUN_B)],
    );
    expect(day.counts).toMatchObject({
      skippedResearchRuns: 1,
      missingResearchRuns: 1,
    });
    expect(group(day).metrics.research).toMatchObject({
      count: 1,
      p50Ms: 0,
      p90Ms: 0,
      missing: 1,
      histogram: { zeroCount: 1, positiveBins: {} },
    });
    expect(group(day).metrics.prepare).toMatchObject({
      count: 1,
      missing: 1,
      minMs: 2000,
    });
    expect(group(day).metrics.makingDelivery.count).toBe(2);
  });

  it("does not manufacture zero research from a conflicting skip declaration", () => {
    const day = rollup([
      research("2026-11-14T16:00:01.000Z"),
      generation("2026-11-14T16:00:02.000Z", true),
    ]);
    expect(day.counts).toMatchObject({
      skippedResearchRuns: 0,
      conflictingMarks: 1,
    });
    expect(group(day).metrics.research).toMatchObject({
      count: 0,
      p50Ms: null,
      p90Ms: null,
      invalid: 1,
    });
    expect(group(day).metrics.prepare.invalid).toBe(1);
    expect(group(day).metrics.makingDelivery.count).toBe(1);
  });

  it("retains research-only Runs and distinguishes zero samples from null statistics", () => {
    const day = rollup([research("2026-11-14T16:00:01.000Z")]);
    expect(group(day, "unknown").runs).toBe(1);
    expect(group(day, "unknown").metrics.prepare.count).toBe(1);
    expect(group(day, "unknown").metrics.research).toMatchObject({
      count: 0,
      p50Ms: null,
      p90Ms: null,
      missing: 1,
    });
    expect(group(day).metrics.total).toMatchObject({
      count: 0,
      p50Ms: null,
      p90Ms: null,
      minMs: null,
      maxMs: null,
    });
    expect(day.groups).toHaveLength(132);
  });

  it("separates unsuccessful statuses from successful-delivery distributions", () => {
    const day = rollup(
      [
        generation("2026-11-14T16:00:01.000Z", true, RUN_A),
        generation("2026-11-14T16:00:02.000Z", true, RUN_B),
        generation("2026-11-14T16:00:03.000Z", true, RUN_C),
        generation("2026-11-14T16:00:04.000Z", true, RUN_D),
      ],
      [
        run(),
        run(RUN_B, "failed"),
        run(RUN_C, "cancelled"),
        run(RUN_D, "timeout"),
      ],
    );
    expect(day.counts).toMatchObject({
      completed: 1,
      failed: 1,
      cancelled: 1,
      timeout: 1,
    });
    expect(group(day).metrics.makingDelivery).toMatchObject({
      count: 1,
      minMs: 9000,
    });
    expect(group(day, "image", "failed").metrics.makingDelivery.minMs).toBe(
      8000,
    );
    expect(group(day, "image", "cancelled").runs).toBe(1);
    expect(group(day, "image", "timeout").runs).toBe(1);
  });

  it("selects completed artifact success independently of execution and intent diagnostics", () => {
    const day = rollup(
      [
        generation("2026-11-14T16:00:01.000Z", true, RUN_A),
        generation("2026-11-14T16:00:02.000Z", true, RUN_B, "report"),
        generation("2026-11-14T16:00:03.000Z", true, RUN_C),
      ],
      [
        run(),
        {
          ...run(RUN_B),
          artifactResult: null,
          completedAt: "2026-11-14T16:15:00.000Z",
        },
        run(RUN_C, "failed"),
      ],
    );
    expect(day.counts).toMatchObject({
      markedRuns: 3,
      completed: 2,
      completedArtifactRuns: 1,
      failed: 1,
      unknownArtifactRuns: 1,
      noContentRuns: 0,
    });
    const artifacts = day.groups.filter((entry) => {
      return (
        entry.status === day.metricCohort.status &&
        entry.artifactResult === day.metricCohort.artifactResult &&
        entry.runs > 0
      );
    });
    expect(artifacts).toMatchObject([
      {
        generationKind: "image",
        runs: 1,
        metrics: { total: { count: 1, minMs: 10_000 } },
      },
    ]);
    expect(group(day, "report", "completed", null)).toMatchObject({
      runs: 1,
      metrics: { total: { count: 1, minMs: 900_000 } },
    });
  });

  it("preserves a verified artifact cohort when later native evidence is unavailable", () => {
    const marks = [generation("2026-11-14T16:00:02.000Z", true)];
    const previous = rollup(marks);
    const unknown = rollup(marks, [{ ...run(), artifactResult: null }]);
    expect(previous.counts.completedArtifactRuns).toBe(1);
    expect(unknown.counts.completedArtifactRuns).toBe(0);
    expect(preserveRunPhaseTimingRollup(previous, unknown)).toBeTruthy();
    expect(preserveRunPhaseTimingRollup(unknown, previous)).toBeFalsy();
  });

  it("preserves verified Run identities across mixed evidence loss and gain while allowing kind corrections", () => {
    const image = generation("2026-11-14T16:00:02.000Z", true);
    const previous = rollup([image]);
    const replacement = rollup(
      [image, generation("2026-11-14T16:00:03.000Z", true, RUN_B, "report")],
      [{ ...run(), artifactResult: null }, run(RUN_B)],
    );
    expect(previous.counts.completedArtifactRuns).toBe(1);
    expect(replacement.counts.completedArtifactRuns).toBe(1);
    expect(preserveRunPhaseTimingRollup(previous, replacement)).toBeTruthy();
    const corrected = rollup([
      image,
      generation("2026-11-14T16:00:02.000Z", true, RUN_A, "report"),
    ]);
    expect(group(corrected, "unknown").runs).toBe(1);
    expect(corrected.artifactResults).toStrictEqual(previous.artifactResults);
    expect(preserveRunPhaseTimingRollup(previous, corrected)).toBeFalsy();
  });

  it("excludes unknown Runs, mismatched owners, malformed records and late marks", () => {
    const day = rollup([
      generation("2026-11-14T16:00:01.000Z", true, RUN_B),
      {
        ...generation("2026-11-14T16:00:01.000Z", true),
        org_id: "another_org",
      },
      { ...research("2026-11-14T16:00:01.000Z"), schema_version: 2 },
      generation("2026-11-14T16:00:11.000Z", true),
    ]);
    expect(day.source).toMatchObject({
      unknownRuns: 1,
      identityMismatchMarks: 1,
      invalidRecords: 1,
      globalCoverage: "unknown",
      population: "phase-marked-runs",
    });
    expect(day.counts).toMatchObject({
      markedRuns: 0,
      observedRuns: 1,
      invalidMarks: 1,
    });
    expect(group(day).metrics.total.count).toBe(0);
  });

  it("uses sparse mergeable bins with exact zero and explicit upper-bound quantiles", () => {
    const ids = [RUN_A, RUN_B, RUN_C, RUN_D];
    const offsets = [0, 1, 1000, 1001];
    const day = rollup(
      ids.flatMap((id, index) => {
        const duration = offsets[index];
        if (duration === undefined) {
          throw new Error("Missing duration");
        }
        return [
          research(START, id),
          generation(
            new Date(Date.parse(START) + duration).toISOString(),
            false,
            id,
          ),
        ];
      }),
      ids.map((id) => {
        return run(id);
      }),
    );
    expect(group(day).metrics.research).toMatchObject({
      count: 4,
      p50Ms: 1000,
      p90Ms: 2000,
      sumMs: 2002,
      histogram: { zeroCount: 1, positiveBins: { "1": 2, "2": 1 } },
    });
    expect(day.histogramSpec).toMatchObject({
      widthMs: 1000,
      quantile: "nearest-rank-upper-bound",
    });
  });

  it("preserves stronger snapshots when records disappear or their source ages out", () => {
    const previous = rollup([
      research("2026-11-14T16:00:01.000Z"),
      generation("2026-11-14T16:00:02.000Z"),
    ]);
    const lost = rollup([generation("2026-11-14T16:00:02.000Z")]);
    expect(preserveRunPhaseTimingRollup(previous, lost)).toBeTruthy();
    const aged = {
      ...previous,
      source: { ...previous.source, startTime: "2026-11-14T16:00:01.001Z" },
    };
    expect(preserveRunPhaseTimingRollup(previous, aged)).toBeTruthy();
    expect(preserveRunPhaseTimingRollup(previous, previous)).toBeFalsy();
    expect(preserveRunPhaseTimingRollup(lost, previous)).toBeFalsy();
  });

  it("does not infer earliest phases from duplicates retained after Run start expired", () => {
    const day = rollup(
      [
        research("2026-11-14T16:00:01.000Z"),
        generation("2026-11-14T16:00:02.000Z", true),
      ],
      [{ ...run(), startedAt: "2026-11-12T23:59:59.000Z" }],
    );
    expect(day.counts.retentionLimitedRuns).toBe(1);
    expect(group(day, "unknown").metrics.total.count).toBe(1);
    expect(group(day, "unknown").metrics.prepare).toMatchObject({
      count: 0,
      invalid: 1,
    });
    expect(group(day, "unknown").metrics.research).toMatchObject({
      count: 0,
      invalid: 1,
    });
    expect(group(day, "unknown").metrics.makingDelivery).toMatchObject({
      count: 0,
      invalid: 1,
    });
    expect(day.missingDateMeans).toBe("gap-not-zero");
  });

  it("keeps tied earliest competing generation kinds unknown, but ignores later kind changes", () => {
    const day = rollup(
      [
        generation("2026-11-14T16:00:02.000Z", true, RUN_A, "image"),
        generation("2026-11-14T16:00:02.000Z", true, RUN_A, "report"),
        generation("2026-11-14T16:00:03.000Z", true, RUN_B, "image"),
        generation("2026-11-14T16:00:04.000Z", true, RUN_B, "report"),
      ],
      [run(), run(RUN_B)],
    );
    expect(group(day, "unknown").runs).toBe(1);
    expect(group(day, "image").runs).toBe(1);
    expect(group(day, "report").runs).toBe(0);
    expect(day.counts.conflictingMarks).toBe(2);
  });

  it("looks up only well-formed phase-marked Run identities", () => {
    expect(
      runPhaseTimingMarkedRunIds([
        research("2026-11-14T16:00:01.000Z"),
        generation("2026-11-14T16:00:02.000Z"),
        { ...research(START, RUN_B), _time: "not-a-timestamp" },
      ]),
    ).toStrictEqual([RUN_A]);
  });

  it("rejects provider rows outside the bounded source scan", () => {
    expect(() => {
      return rollup([research("2026-11-12T16:00:01.000Z")]);
    }).toThrow("outside its requested source window");
  });
});
