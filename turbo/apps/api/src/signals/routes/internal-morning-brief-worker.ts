import { internalMorningBriefWorkerContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { logger } from "../../lib/log";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import type { RouteEntry } from "../route-entry";
import {
  nativeHttpFanoutEnabled,
  verifyNativeWorkerDispatch,
} from "../services/morning-brief-native-dispatch.service";
import { executeNativeMorningBriefTick$ } from "../services/morning-brief-native-executor.service";
import {
  executeNativeMorningBriefSlot$,
  productionNativeTickDependencies,
  recoverNativeMorningBriefDelivery$,
} from "../services/morning-brief-native-pipeline.service";

const log = logger("MorningBriefNativeWorker");
const body$ = bodyResultOf(internalMorningBriefWorkerContract.execute);

const execute$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  const parsed = await get(body$);
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = parsed.data;
  if (
    !verifyNativeWorkerDispatch(
      body,
      request.header("x-morning-brief-timestamp"),
      request.header("x-morning-brief-signature"),
    )
  ) {
    return {
      status: 401 as const,
      body: {
        error: { code: "UNAUTHORIZED", message: "Invalid worker dispatch" },
      },
    };
  }
  if (!nativeHttpFanoutEnabled()) {
    return {
      status: 503 as const,
      body: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Worker dispatch is disabled",
        },
      },
    };
  }

  const owner = { orgId: body.orgId, userId: body.userId };
  const db = set(writeDb$);
  const deps = productionNativeTickDependencies({
    db,
    scope: owner,
    onlyScheduledFor: new Date(body.scheduledFor),
    workerMode: true,
    executor: {
      execute: async (currentOwner, occurrence, workSignal) => {
        return await set(
          executeNativeMorningBriefSlot$,
          { owner: currentOwner, occurrence },
          workSignal,
        );
      },
    },
    delivery: {
      resolve: async (currentOwner, occurrence, workSignal) => {
        return await set(
          recoverNativeMorningBriefDelivery$,
          { owner: currentOwner, occurrence },
          workSignal,
        );
      },
    },
  });
  // This signal is independent of the short dispatch request. waitUntil keeps
  // this invocation alive, but a Vercel timeout still requires DB recovery.
  const work = set(
    executeNativeMorningBriefTick$,
    deps,
    AbortSignal.timeout(190_000),
  );
  const observe = async () => {
    const result = await settleIncludingAbort(work);
    if (!result.ok) {
      log.error("Morning Brief worker invocation failed", {
        orgId: owner.orgId,
        scheduledFor: body.scheduledFor,
        error: result.error,
      });
      return;
    }
    log.debug("Morning Brief worker invocation completed", {
      orgId: owner.orgId,
      scheduledFor: body.scheduledFor,
      ...result.value,
    });
  };
  waitUntil(observe());
  return { status: 202 as const, body: { accepted: true as const } };
});

export const internalMorningBriefWorkerRoutes: readonly RouteEntry[] = [
  { route: internalMorningBriefWorkerContract.execute, handler: execute$ },
];
