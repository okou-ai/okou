import { cronProactiveContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";
import type { RouteEntry } from "../route-entry";
import { compareProactiveSchedules$ } from "../services/proactive-schedule-shadow.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

export const cronProactiveRoutes: readonly RouteEntry[] = [
  {
    route: cronProactiveContract.compare,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      if (!get(hasValidCronSecret$)) {
        return cronUnauthorized();
      }
      const body = await set(compareProactiveSchedules$, signal);
      return { status: 200 as const, body };
    }),
  },
];
