import { cronExtractPiMemoryStage1Contract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  executePiMemoryStage1Work$,
  type PiMemoryStage1WorkerResult,
} from "../services/pi-memory-stage1-worker.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";
import { admitsPiMemoryBackgroundWorkerInvocation } from "./pi-memory-background-worker-breaker";

const ZERO_STAGE1_RESULT: PiMemoryStage1WorkerResult = Object.freeze({
  scanned: 0,
  claimed: 0,
  succeeded: 0,
  succeededNoOutput: 0,
  retryableFailure: 0,
  terminalFailure: 0,
  sourceExpired: 0,
  sourceActive: 0,
  staleDiscarded: 0,
});

function extractPiMemoryStage1Routes(): readonly RouteEntry[] {
  const extractPiMemoryStage1Route$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (!get(hasValidCronSecret$)) {
        return cronUnauthorized();
      }
      if (!admitsPiMemoryBackgroundWorkerInvocation("stage1")) {
        return {
          status: 200 as const,
          body: { success: true as const, ...ZERO_STAGE1_RESULT },
        };
      }
      const result = await set(
        executePiMemoryStage1Work$,
        { currentTime: nowDate() },
        signal,
      );
      return {
        status: 200 as const,
        body: { success: true as const, ...result },
      };
    },
  );

  return [
    {
      route: cronExtractPiMemoryStage1Contract.extract,
      handler: extractPiMemoryStage1Route$,
    },
  ];
}

export const cronExtractPiMemoryStage1Routes = extractPiMemoryStage1Routes();
