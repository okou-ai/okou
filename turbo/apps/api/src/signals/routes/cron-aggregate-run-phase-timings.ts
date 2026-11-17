import { cronAggregateRunPhaseTimingsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import {
  buildRunPhaseTimingRollups,
  preserveRunPhaseTimingRollup,
  runPhaseTimingMarkedRunIds,
  runPhaseTimingSourceWindow,
} from "../../lib/run-phase-timing-rollup";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  readRunPhaseTimingMarks$,
  readRunPhaseTimingMetadata$,
  readRunPhaseTimingRollup$,
  runPhaseTimingRollupObjectKey,
  writeRunPhaseTimingRollup$,
} from "../services/cron-aggregate-run-phase-timings.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const aggregateRunPhaseTimings$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const workSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
    const window = runPhaseTimingSourceWindow(nowDate());
    const source = await set(readRunPhaseTimingMarks$, window, workSignal);
    signal.throwIfAborted();
    workSignal.throwIfAborted();
    const runs = await set(
      readRunPhaseTimingMetadata$,
      runPhaseTimingMarkedRunIds(source.records),
      workSignal,
    );
    signal.throwIfAborted();
    workSignal.throwIfAborted();
    const rollups = buildRunPhaseTimingRollups({
      ...source,
      window,
      runs,
    });
    const days: { date: string; objectKey: string; markedRuns: number }[] = [];
    for (const rollup of rollups) {
      const previous = await set(
        readRunPhaseTimingRollup$,
        rollup.date,
        workSignal,
      );
      signal.throwIfAborted();
      workSignal.throwIfAborted();
      if (previous && preserveRunPhaseTimingRollup(previous.rollup, rollup)) {
        days.push({
          date: rollup.date,
          objectKey: runPhaseTimingRollupObjectKey(rollup.date),
          markedRuns: previous.rollup.counts.markedRuns,
        });
        continue;
      }
      const objectKey = await set(
        writeRunPhaseTimingRollup$,
        { rollup, etag: previous?.etag ?? null },
        workSignal,
      );
      signal.throwIfAborted();
      workSignal.throwIfAborted();
      days.push({
        date: rollup.date,
        objectKey,
        markedRuns: rollup.counts.markedRuns,
      });
    }
    return { status: 200 as const, body: { success: true as const, days } };
  },
);

export const cronAggregateRunPhaseTimingsRoutes: readonly RouteEntry[] = [
  {
    route: cronAggregateRunPhaseTimingsContract.aggregate,
    handler: aggregateRunPhaseTimings$,
  },
];
