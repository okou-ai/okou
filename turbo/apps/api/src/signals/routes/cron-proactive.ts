import { dispatchProactiveSchedules$ } from "../services/proactive-dispatch.service";
import { cronProactiveContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";
import type { RouteEntry } from "../route-entry";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

export const cronProactiveRoutes: readonly RouteEntry[] = [
  {
    route: cronProactiveContract.dispatch,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      if (!get(hasValidCronSecret$)) {
        return cronUnauthorized();
      }
      return {
        status: 200 as const,
        body: await set(dispatchProactiveSchedules$, signal),
      };
    }),
  },
];
