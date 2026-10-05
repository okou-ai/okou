import {
  cronConsolidatePiMemoryPhase2Contract,
  type CronConsolidatePiMemoryPhase2Response,
} from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  createPiMemoryPhase2Worker,
  type PiMemoryPhase2WorkerResult,
} from "../services/pi-memory-phase2-worker.service";
import type { PiMemoryPhase2OwnerScope } from "../services/pi-memory-phase2-job.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";
import { admitsPiMemoryBackgroundWorkerInvocation } from "./pi-memory-background-worker-breaker";

const ZERO_PHASE2_RESPONSE: CronConsolidatePiMemoryPhase2Response =
  Object.freeze({
    success: true,
    claimed: 0,
    noWork: 0,
    noDiff: 0,
    published: 0,
    conflicted: 0,
    stale: 0,
    failed: 0,
  });

function responseForPhase2Result(
  result: PiMemoryPhase2WorkerResult,
): CronConsolidatePiMemoryPhase2Response {
  const claimed = result.outcome === "no_work" ? 0 : 1;
  return {
    success: true,
    claimed,
    noWork: result.outcome === "no_work" ? 1 : 0,
    noDiff: 0,
    published: 0,
    conflicted: 0,
    stale: result.outcome === "stale" ? 1 : 0,
    failed: result.outcome === "failed" ? 1 : 0,
  };
}

function consolidatePiMemoryPhase2Routes(
  scope: PiMemoryPhase2OwnerScope | undefined,
): readonly RouteEntry[] {
  const { execute$ } = createPiMemoryPhase2Worker(scope);
  const consolidatePiMemoryPhase2Route$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (!get(hasValidCronSecret$)) {
        return cronUnauthorized();
      }
      if (!admitsPiMemoryBackgroundWorkerInvocation("phase2")) {
        return { status: 200 as const, body: ZERO_PHASE2_RESPONSE };
      }
      signal.throwIfAborted();
      const result = await set(execute$, nowDate(), signal);
      signal.throwIfAborted();
      return { status: 200 as const, body: responseForPhase2Result(result) };
    },
  );

  return [
    {
      route: cronConsolidatePiMemoryPhase2Contract.consolidate,
      handler: consolidatePiMemoryPhase2Route$,
    },
  ];
}

export const cronConsolidatePiMemoryPhase2Routes =
  consolidatePiMemoryPhase2Routes(undefined);
