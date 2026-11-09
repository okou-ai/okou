import { cleanupUnconnectedEmailMessages$ } from "../services/email-channel-maintenance.service";
import { cronDrainEmailOutboxContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { now } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  cleanupExpiredEmailOutbox$,
  drainEmailOutboxBatch$,
} from "../services/email-common.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const drainEmailOutboxRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const drainContext = { currentTimeMs: now() };
    const drained = await set(drainEmailOutboxBatch$, drainContext, signal);
    signal.throwIfAborted();
    const cleaned = await set(cleanupExpiredEmailOutbox$, drainContext, signal);
    signal.throwIfAborted();

    await set(cleanupUnconnectedEmailMessages$, signal);
    return {
      status: 200 as const,
      body: { success: true as const, drained, cleaned },
    };
  },
);

export const cronDrainEmailOutboxRoutes: readonly RouteEntry[] = [
  {
    route: cronDrainEmailOutboxContract.drain,
    handler: drainEmailOutboxRoute$,
  },
];
