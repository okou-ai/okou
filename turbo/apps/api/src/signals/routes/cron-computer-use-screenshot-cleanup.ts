import { cronComputerUseScreenshotCleanupContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { cleanupComputerUseCommands$ } from "../services/cron-computer-use-screenshot-cleanup.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const computerUseScreenshotCleanup$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const cleaned = await set(cleanupComputerUseCommands$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { cleaned },
    };
  },
);

export const cronComputerUseScreenshotCleanupRoutes: readonly RouteEntry[] = [
  {
    route: cronComputerUseScreenshotCleanupContract.cleanup,
    handler: computerUseScreenshotCleanup$,
  },
];
