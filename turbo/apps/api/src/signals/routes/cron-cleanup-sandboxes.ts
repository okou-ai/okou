import { cronCleanupSandboxesContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { cleanupRunnerWssTickets$ } from "../services/runner-wss-ticket.service";
import { cleanupSandboxes$ } from "../services/cron-cleanup-sandboxes.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const cleanupSandboxesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    await set(cleanupRunnerWssTickets$, signal);
    const body = await set(cleanupSandboxes$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const cronCleanupSandboxesRoutes: readonly RouteEntry[] = [
  {
    route: cronCleanupSandboxesContract.cleanup,
    handler: cleanupSandboxesRoute$,
  },
];
