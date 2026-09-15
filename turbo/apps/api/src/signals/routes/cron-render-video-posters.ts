import { cronRenderVideoPostersContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { renderMissingVideoPosters$ } from "../services/artifact-preview.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const renderVideoPostersRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const result = await set(renderMissingVideoPosters$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronRenderVideoPostersRoutes: readonly RouteEntry[] = [
  {
    route: cronRenderVideoPostersContract.render,
    handler: renderVideoPostersRoute$,
  },
];
