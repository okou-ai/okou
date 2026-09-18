import { cronExecuteMorningBriefsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import type { MorningBriefMemberIdentity } from "../services/morning-brief-enrollment-data.service";
import { executeNativeMorningBriefTick$ } from "../services/morning-brief-native-executor.service";
import {
  executeNativeMorningBriefSlot$,
  productionNativeTickDependencies,
  recoverNativeMorningBriefDelivery$,
} from "../services/morning-brief-native-pipeline.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

/**
 * The native Morning Brief cron.
 *
 * Ordinary application scheduling with the repository's normal cron secret.
 * Invalid authentication returns before any state is read or written and before
 * any provider is contacted.
 */
function createExecuteMorningBriefsRoute(
  scope?: MorningBriefMemberIdentity,
): RouteEntry["handler"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const db = set(writeDb$);
    const result = await set(
      executeNativeMorningBriefTick$,
      productionNativeTickDependencies({
        db,
        scope,
        // The real S5 generation engine and the real S6 delivery engine, bound
        // here rather than inside the tick so a boundary double can replace the
        // provider without replacing the scheduler.
        executor: {
          execute: async (owner, occurrence, executionSignal) => {
            return await set(
              executeNativeMorningBriefSlot$,
              { owner, occurrence },
              executionSignal,
            );
          },
        },
        delivery: {
          resolve: async (owner, occurrence, recoverySignal) => {
            return await set(
              recoverNativeMorningBriefDelivery$,
              { owner, occurrence },
              recoverySignal,
            );
          },
        },
      }),
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body: result };
  });
}

function routesFor(handler: RouteEntry["handler"]): readonly RouteEntry[] {
  return [{ route: cronExecuteMorningBriefsContract.execute, handler }];
}

export const cronExecuteMorningBriefsRoutes = routesFor(
  createExecuteMorningBriefsRoute(),
);

/**
 * Keep cron integration tests owner-scoped while exercising the same route and
 * production composition. This factory is never registered by application
 * bootstrap; the deployed cron always uses the global route above.
 */
export function createScopedMorningBriefCronRoutesForTest(
  owner: MorningBriefMemberIdentity,
): readonly RouteEntry[] {
  return routesFor(createExecuteMorningBriefsRoute(owner));
}
