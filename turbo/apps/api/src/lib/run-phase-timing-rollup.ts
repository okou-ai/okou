import { runGenerationKindSchema } from "@okouai/api-contracts/contracts/run-phase-timing";
import type { RunArtifactResult } from "@okouai/api-contracts/contracts/runs";
import {
  array,
  boolean,
  discriminatedUnion,
  enum as zEnum,
  iso,
  literal,
  number,
  object,
  record,
  string,
  uuid,
  type infer as zInfer,
} from "zod";

const DAY_MS = 86_400_000;
const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;
const HISTOGRAM_WIDTH_MS = 1000;
const TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const;
const KINDS = [...runGenerationKindSchema.options, "unknown"] as const;
const METRICS = ["prepare", "research", "makingDelivery", "total"] as const;

type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
type GenerationKind = (typeof KINDS)[number];
type Metric = (typeof METRICS)[number];

const markFields = Object.freeze({
  schema_version: literal(1),
  type: literal("run_phase_mark"),
  _time: iso.datetime(),
  run_id: uuid(),
  user_id: string().min(1),
  org_id: string().min(1),
});
const phaseMarkSchema = discriminatedUnion("phase", [
  object({
    ...markFields,
    phase: literal("research-start"),
    // Tabular Axiom results represent fields absent on this event as null.
    generation_kind: literal(null).optional(),
    research_skipped: literal(null).optional(),
  }),
  object({
    ...markFields,
    phase: literal("generation-start"),
    generation_kind: runGenerationKindSchema,
    research_skipped: boolean(),
  }),
]);
type PhaseMark = zInfer<typeof phaseMarkSchema>;
type GenerationMark = Extract<PhaseMark, { phase: "generation-start" }>;

const countSchema = number().int().nonnegative();
const histogramSchema = object({
  zeroCount: countSchema,
  positiveBins: record(string().regex(/^[1-9][0-9]*$/u), countSchema),
});
const metricSchema = object({
  count: countSchema,
  p50Ms: number().nonnegative().nullable(),
  p90Ms: number().nonnegative().nullable(),
  sumMs: number().nonnegative(),
  minMs: number().nonnegative().nullable(),
  maxMs: number().nonnegative().nullable(),
  missing: countSchema,
  invalid: countSchema,
  histogram: histogramSchema,
});

export const runPhaseTimingRollupSchema = object({
  schemaVersion: literal(2),
  metricCohort: object({
    status: literal("completed"),
    artifactResult: literal("success"),
  }),
  date: string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  timezone: literal("Asia/Shanghai"),
  missingDateMeans: literal("gap-not-zero"),
  window: object({ startTime: iso.datetime(), endTime: iso.datetime() }),
  source: object({
    dataset: string().min(1),
    startTime: iso.datetime(),
    endTime: iso.datetime(),
    population: literal("phase-marked-runs"),
    globalCoverage: literal("unknown"),
    rawRetentionDays: literal(3),
    queryComplete: literal(true),
    earlierRawData: literal("not-covered"),
    records: countSchema,
    invalidRecords: countSchema,
    unknownRuns: countSchema,
    identityMismatchMarks: countSchema,
    nonterminalRuns: countSchema,
    invalidRuns: countSchema,
    outsideCompletedDaysRuns: countSchema,
    firstMarkAt: iso.datetime().nullable(),
  }),
  histogramSpec: object({
    version: literal(1),
    unit: literal("milliseconds"),
    widthMs: literal(1000),
    positiveBin: literal("((key-1)*widthMs,key*widthMs]"),
    quantile: literal("nearest-rank-upper-bound"),
  }),
  counts: object({
    observedRuns: countSchema,
    observedMarks: countSchema,
    markedRuns: countSchema,
    completed: countSchema,
    failed: countSchema,
    cancelled: countSchema,
    timeout: countSchema,
    duplicateMarks: countSchema,
    conflictingMarks: countSchema,
    invalidMarks: countSchema,
    missingResearchRuns: countSchema,
    missingGenerationRuns: countSchema,
    skippedResearchRuns: countSchema,
    retentionLimitedRuns: countSchema,
  }),
  groups: array(
    object({
      generationKind: zEnum(KINDS),
      status: zEnum(TERMINAL_STATUSES),
      runs: countSchema,
      metrics: object({
        prepare: metricSchema,
        research: metricSchema,
        makingDelivery: metricSchema,
        total: metricSchema,
      }),
    }),
  ),
});
export type RunPhaseTimingRollup = zInfer<typeof runPhaseTimingRollupSchema>;

export interface RunPhaseTimingMetadata {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly status: string;
  readonly artifactResult: RunArtifactResult | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface RunPhaseTimingSourceWindow {
  readonly startTime: string;
  readonly endTime: string;
  readonly days: readonly {
    readonly date: string;
    readonly startTime: string;
    readonly endTime: string;
  }[];
}

/** One fixed, half-open raw scan; only the previous two completed Beijing days. */
export function runPhaseTimingSourceWindow(
  at: Date,
): RunPhaseTimingSourceWindow {
  const cutoff = at.getTime();
  if (!Number.isFinite(cutoff)) {
    throw new Error("Invalid rollup cutoff");
  }
  const midnight =
    Math.floor((cutoff + BJT_OFFSET_MS) / DAY_MS) * DAY_MS - BJT_OFFSET_MS;
  return {
    startTime: new Date(cutoff - 3 * DAY_MS).toISOString(),
    endTime: at.toISOString(),
    days: [-2, -1].map((offset) => {
      const start = midnight + offset * DAY_MS;
      return {
        date: new Date(start + BJT_OFFSET_MS).toISOString().slice(0, 10),
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + DAY_MS).toISOString(),
      };
    }),
  };
}

/** Invalid records remain diagnostic counts, never identities for a DB lookup. */
export function runPhaseTimingMarkedRunIds(
  records: readonly unknown[],
): readonly string[] {
  const ids = new Set<string>();
  for (const row of records) {
    const parsed = phaseMarkSchema.safeParse(row);
    if (parsed.success) {
      ids.add(parsed.data.run_id);
    }
  }
  return [...ids].sort();
}

interface MetricAccumulator {
  readonly values: number[];
  missing: number;
  invalid: number;
}
interface GroupAccumulator {
  readonly generationKind: GenerationKind;
  readonly status: TerminalStatus;
  runs: number;
  readonly metrics: Record<Metric, MetricAccumulator>;
}

function metricAccumulator(): MetricAccumulator {
  return { values: [], missing: 0, invalid: 0 };
}
function groupAccumulator(
  generationKind: GenerationKind,
  status: TerminalStatus,
): GroupAccumulator {
  return {
    generationKind,
    status,
    runs: 0,
    metrics: {
      prepare: metricAccumulator(),
      research: metricAccumulator(),
      makingDelivery: metricAccumulator(),
      total: metricAccumulator(),
    },
  };
}

function percentile(
  histogram: zInfer<typeof histogramSchema>,
  count: number,
  fraction: number,
): number | null {
  if (count === 0) {
    return null;
  }
  const rank = Math.ceil(count * fraction);
  let cumulative = histogram.zeroCount;
  if (rank <= cumulative) {
    return 0;
  }
  for (const [key, frequency] of Object.entries(histogram.positiveBins)) {
    cumulative += frequency;
    if (cumulative >= rank) {
      return Number(key) * HISTOGRAM_WIDTH_MS;
    }
  }
  throw new Error("Histogram count does not match its samples");
}

function summarizeMetric(
  accumulator: MetricAccumulator,
): zInfer<typeof metricSchema> {
  const bins = new Map<number, number>();
  let zeroCount = 0;
  let sumMs = 0;
  let minMs: number | null = null;
  let maxMs: number | null = null;
  for (const value of accumulator.values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Invalid phase duration");
    }
    sumMs += value;
    if (!Number.isSafeInteger(sumMs)) {
      throw new Error("Phase duration sum exceeds integer precision");
    }
    minMs = minMs === null ? value : Math.min(minMs, value);
    maxMs = maxMs === null ? value : Math.max(maxMs, value);
    if (value === 0) {
      zeroCount++;
    } else {
      const bin = Math.ceil(value / HISTOGRAM_WIDTH_MS);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
  }
  const histogram = {
    zeroCount,
    positiveBins: Object.fromEntries(
      [...bins].sort(([a], [b]) => {
        return a - b;
      }),
    ),
  };
  const count = accumulator.values.length;
  return {
    count,
    p50Ms: percentile(histogram, count, 0.5),
    p90Ms: percentile(histogram, count, 0.9),
    sumMs,
    minMs,
    maxMs,
    missing: accumulator.missing,
    invalid: accumulator.invalid,
    histogram,
  };
}

function compareMarks(a: PhaseMark, b: PhaseMark): number {
  const timeOrder = Date.parse(a._time) - Date.parse(b._time);
  if (timeOrder !== 0) {
    return timeOrder;
  }
  const aKey =
    a.phase === "generation-start"
      ? `${a.generation_kind}:${Number(a.research_skipped)}`
      : a.phase;
  const bKey =
    b.phase === "generation-start"
      ? `${b.generation_kind}:${Number(b.research_skipped)}`
      : b.phase;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function terminalStatus(value: string): TerminalStatus | null {
  return (
    TERMINAL_STATUSES.find((status) => {
      return status === value;
    }) ?? null
  );
}
function timestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

type SourceCounts = Pick<
  RunPhaseTimingRollup["source"],
  | "records"
  | "invalidRecords"
  | "unknownRuns"
  | "identityMismatchMarks"
  | "nonterminalRuns"
  | "invalidRuns"
  | "outsideCompletedDaysRuns"
>;

interface DayAccumulator {
  readonly day: RunPhaseTimingSourceWindow["days"][number];
  firstMarkAt: string | null;
  readonly counts: RunPhaseTimingRollup["counts"];
  readonly groups: readonly GroupAccumulator[];
}

interface AttributedRun {
  readonly day: DayAccumulator;
  readonly owned: readonly PhaseMark[];
  readonly status: TerminalStatus;
  readonly artifactResult: RunArtifactResult | null;
  readonly start: number;
  readonly end: number;
}

interface RunPhases {
  readonly firstMarkAt: string;
  readonly generationAt: number | null;
  readonly researchAt: number | null;
  readonly generationKind: GenerationKind;
  readonly skipped: boolean;
  readonly retentionLimited: boolean;
  readonly segmentationInvalid: boolean;
  readonly invalidMarks: number;
  readonly duplicateMarks: number;
  readonly conflictingMarks: number;
}

function parsePhaseTimingSource(
  records: readonly unknown[],
  window: RunPhaseTimingSourceWindow,
) {
  const marksByRun = new Map<string, PhaseMark[]>();
  const sourceCounts: SourceCounts = {
    records: records.length,
    invalidRecords: 0,
    unknownRuns: 0,
    identityMismatchMarks: 0,
    nonterminalRuns: 0,
    invalidRuns: 0,
    outsideCompletedDaysRuns: 0,
  };
  for (const row of records) {
    const parsed = phaseMarkSchema.safeParse(row);
    if (!parsed.success) {
      sourceCounts.invalidRecords++;
      continue;
    }
    const eventTime = Date.parse(parsed.data._time);
    if (
      eventTime < Date.parse(window.startTime) ||
      eventTime >= Date.parse(window.endTime)
    ) {
      throw new Error(
        "Axiom phase result is outside its requested source window",
      );
    }
    const existing = marksByRun.get(parsed.data.run_id);
    if (existing) {
      existing.push(parsed.data);
    } else {
      marksByRun.set(parsed.data.run_id, [parsed.data]);
    }
  }
  return { marksByRun, sourceCounts };
}

function dayAccumulator(
  day: RunPhaseTimingSourceWindow["days"][number],
): DayAccumulator {
  return {
    day,
    firstMarkAt: null,
    counts: {
      observedRuns: 0,
      observedMarks: 0,
      markedRuns: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timeout: 0,
      duplicateMarks: 0,
      conflictingMarks: 0,
      invalidMarks: 0,
      missingResearchRuns: 0,
      missingGenerationRuns: 0,
      skippedResearchRuns: 0,
      retentionLimitedRuns: 0,
    },
    groups: KINDS.flatMap((kind) => {
      return TERMINAL_STATUSES.map((status) => {
        return groupAccumulator(kind, status);
      });
    }),
  };
}

function attributeRunObservations(
  run: RunPhaseTimingMetadata | undefined,
  observations: readonly PhaseMark[],
  days: readonly DayAccumulator[],
  sourceCounts: SourceCounts,
): AttributedRun | null {
  if (!run) {
    sourceCounts.unknownRuns++;
    return null;
  }
  const owned = observations.filter((mark) => {
    return mark.user_id === run.userId && mark.org_id === run.orgId;
  });
  sourceCounts.identityMismatchMarks += observations.length - owned.length;
  if (owned.length === 0) {
    return null;
  }
  const status = terminalStatus(run.status);
  if (status === null) {
    sourceCounts.nonterminalRuns++;
    return null;
  }
  const start = timestamp(run.startedAt);
  const end = timestamp(run.completedAt);
  if (start === null || end === null || start > end) {
    sourceCounts.invalidRuns++;
    return null;
  }
  const day = days.find(({ day }) => {
    return end >= Date.parse(day.startTime) && end < Date.parse(day.endTime);
  });
  if (!day) {
    sourceCounts.outsideCompletedDaysRuns++;
    return null;
  }
  return { day, owned, status, artifactResult: run.artifactResult, start, end };
}

function summarizeGenerationConflicts(
  generations: readonly GenerationMark[],
  generation: GenerationMark | undefined,
  research: PhaseMark | undefined,
) {
  const declarationConflict = Boolean(generation?.research_skipped && research);
  const tiedGenerations = generations.filter((mark) => {
    return (
      generation && Date.parse(mark._time) === Date.parse(generation._time)
    );
  });
  const tiedKindConflict = tiedGenerations.some((mark) => {
    return mark.generation_kind !== generation?.generation_kind;
  });
  const tiedSkipConflict = tiedGenerations.some((mark) => {
    return mark.research_skipped !== generation?.research_skipped;
  });
  const conflictingMarks =
    generations.filter((mark) => {
      return (
        generation &&
        (mark.generation_kind !== generation.generation_kind ||
          mark.research_skipped !== generation.research_skipped)
      );
    }).length + Number(declarationConflict);
  return {
    declarationConflict,
    tiedKindConflict,
    tiedSkipConflict,
    conflictingMarks,
  };
}

function segmentRunPhases(
  bounded: readonly PhaseMark[],
  retentionLimited: boolean,
): RunPhases {
  const first = bounded[0];
  if (!first) {
    throw new Error("Phase observations lost their first record");
  }
  const generation = bounded.find((mark): mark is GenerationMark => {
    return mark.phase === "generation-start";
  });
  const generationAt = generation ? Date.parse(generation._time) : null;
  const researchMarks = bounded.filter((mark) => {
    return mark.phase === "research-start";
  });
  const research = researchMarks.find((mark) => {
    return generationAt === null || Date.parse(mark._time) <= generationAt;
  });
  const researchAt = research ? Date.parse(research._time) : null;
  const generations = bounded.filter((mark): mark is GenerationMark => {
    return mark.phase === "generation-start";
  });
  const conflicts = summarizeGenerationConflicts(
    generations,
    generation,
    research,
  );
  const skipped = Boolean(
    generation?.research_skipped &&
    !conflicts.declarationConflict &&
    !conflicts.tiedSkipConflict &&
    !retentionLimited,
  );
  return {
    firstMarkAt: first._time,
    generationAt,
    researchAt,
    generationKind:
      conflicts.tiedKindConflict || retentionLimited
        ? "unknown"
        : (generation?.generation_kind ?? "unknown"),
    skipped,
    retentionLimited,
    segmentationInvalid:
      conflicts.declarationConflict || conflicts.tiedSkipConflict,
    invalidMarks: researchMarks.filter((mark) => {
      return generationAt !== null && Date.parse(mark._time) > generationAt;
    }).length,
    duplicateMarks:
      Math.max(0, researchMarks.length - 1) +
      Math.max(0, generations.length - 1),
    conflictingMarks: conflicts.conflictingMarks,
  };
}

function applyRunPhaseMetrics(
  metrics: GroupAccumulator["metrics"],
  phases: RunPhases,
  start: number,
  end: number,
): void {
  const { generationAt, researchAt, skipped } = phases;
  metrics.total.values.push(end - start);
  // Retained duplicates cannot prove the earliest boundary of an older Run.
  if (phases.retentionLimited) {
    metrics.prepare.invalid++;
    metrics.research.invalid++;
    metrics.makingDelivery.invalid++;
    return;
  }
  if (generationAt === null) {
    metrics.makingDelivery.missing++;
  } else {
    metrics.makingDelivery.values.push(end - generationAt);
  }
  if (phases.segmentationInvalid) {
    metrics.prepare.invalid++;
    metrics.research.invalid++;
  } else {
    const prepareEnd = skipped ? generationAt : researchAt;
    if (prepareEnd === null) {
      metrics.prepare.missing++;
    } else {
      metrics.prepare.values.push(prepareEnd - start);
    }
    if (skipped) {
      metrics.research.values.push(0);
    } else if (researchAt === null || generationAt === null) {
      metrics.research.missing++;
    } else {
      metrics.research.values.push(generationAt - researchAt);
    }
  }
}

function accumulateRunPhaseTiming(
  attributed: AttributedRun,
  sourceStartTime: string,
): void {
  const { day, owned, status, artifactResult, start, end } = attributed;
  day.counts.observedRuns++;
  day.counts.observedMarks += owned.length;
  const bounded = owned
    .filter((mark) => {
      return Date.parse(mark._time) >= start && Date.parse(mark._time) <= end;
    })
    .sort(compareMarks);
  day.counts.invalidMarks += owned.length - bounded.length;
  if (bounded.length === 0) {
    return;
  }
  const phases = segmentRunPhases(bounded, start < Date.parse(sourceStartTime));
  if (
    day.firstMarkAt === null ||
    Date.parse(phases.firstMarkAt) < Date.parse(day.firstMarkAt)
  ) {
    day.firstMarkAt = phases.firstMarkAt;
  }
  day.counts.invalidMarks += phases.invalidMarks;
  day.counts.duplicateMarks += phases.duplicateMarks;
  day.counts.conflictingMarks += phases.conflictingMarks;
  day.counts.markedRuns++;
  day.counts[status]++;
  if (phases.researchAt === null && !phases.skipped) {
    day.counts.missingResearchRuns++;
  }
  if (phases.generationAt === null) {
    day.counts.missingGenerationRuns++;
  }
  if (phases.skipped) {
    day.counts.skippedResearchRuns++;
  }
  if (phases.retentionLimited) {
    day.counts.retentionLimitedRuns++;
  }
  // Raw counts remain diagnostic; completed metrics require explicit output success.
  if (status === "completed" && artifactResult !== "success") {
    return;
  }
  const group = day.groups.find((entry) => {
    return (
      entry.generationKind === phases.generationKind && entry.status === status
    );
  });
  if (!group) {
    throw new Error("Missing phase rollup cohort");
  }
  group.runs++;
  applyRunPhaseMetrics(group.metrics, phases, start, end);
}

function serializeDayRollup(
  day: DayAccumulator,
  dataset: string,
  window: RunPhaseTimingSourceWindow,
  sourceCounts: SourceCounts,
): RunPhaseTimingRollup {
  return {
    schemaVersion: 2,
    metricCohort: { status: "completed", artifactResult: "success" },
    date: day.day.date,
    timezone: "Asia/Shanghai",
    missingDateMeans: "gap-not-zero",
    window: { startTime: day.day.startTime, endTime: day.day.endTime },
    source: {
      dataset,
      startTime: window.startTime,
      endTime: window.endTime,
      population: "phase-marked-runs",
      globalCoverage: "unknown",
      rawRetentionDays: 3,
      queryComplete: true,
      earlierRawData: "not-covered",
      ...sourceCounts,
      firstMarkAt: day.firstMarkAt,
    },
    histogramSpec: {
      version: 1,
      unit: "milliseconds",
      widthMs: HISTOGRAM_WIDTH_MS,
      positiveBin: "((key-1)*widthMs,key*widthMs]",
      quantile: "nearest-rank-upper-bound",
    },
    counts: day.counts,
    groups: day.groups.map((group) => {
      return {
        generationKind: group.generationKind,
        status: group.status,
        runs: group.runs,
        metrics: {
          prepare: summarizeMetric(group.metrics.prepare),
          research: summarizeMetric(group.metrics.research),
          makingDelivery: summarizeMetric(group.metrics.makingDelivery),
          total: summarizeMetric(group.metrics.total),
        },
      };
    }),
  };
}

export function buildRunPhaseTimingRollups(input: {
  readonly dataset: string;
  readonly window: RunPhaseTimingSourceWindow;
  readonly records: readonly unknown[];
  readonly runs: readonly RunPhaseTimingMetadata[];
}): readonly RunPhaseTimingRollup[] {
  const runs = new Map(
    input.runs.map((run) => {
      return [run.id, run];
    }),
  );
  if (runs.size !== input.runs.length) {
    throw new Error("Duplicate Run metadata");
  }
  const { marksByRun, sourceCounts } = parsePhaseTimingSource(
    input.records,
    input.window,
  );
  const days = input.window.days.map(dayAccumulator);
  for (const [runId, observations] of [...marksByRun].sort(([a], [b]) => {
    return a.localeCompare(b);
  })) {
    const attributed = attributeRunObservations(
      runs.get(runId),
      observations,
      days,
      sourceCounts,
    );
    if (attributed) {
      accumulateRunPhaseTiming(attributed, input.window.startTime);
    }
  }
  return days.map((day) => {
    return serializeDayRollup(day, input.dataset, input.window, sourceCounts);
  });
}

/** Expired evidence or a delayed builder must not erase a stronger partition. */
export function preserveRunPhaseTimingRollup(
  previous: RunPhaseTimingRollup,
  next: RunPhaseTimingRollup,
): boolean {
  if (
    previous.date !== next.date ||
    previous.source.dataset !== next.source.dataset
  ) {
    throw new Error("Cannot compare different phase rollup partitions");
  }
  if (Date.parse(previous.source.endTime) > Date.parse(next.source.endTime)) {
    return true;
  }
  if (
    previous.source.firstMarkAt !== null &&
    Date.parse(next.source.startTime) > Date.parse(previous.source.firstMarkAt)
  ) {
    return true;
  }
  // More complete evidence may retract samples newly proven conflicting.
  return (
    previous.counts.observedMarks > next.counts.observedMarks ||
    previous.counts.markedRuns > next.counts.markedRuns
  );
}
