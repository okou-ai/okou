import { bodyResultOf } from "../context/request";
import { handoffProactiveDispatch$ } from "../services/proactive-handoff.service";
import { nowDate } from "../../lib/time";
import { proactiveDispatchPhase$ } from "../services/proactive-dispatch-ownership.service";
import { dispatchProactiveSchedules$ } from "../services/proactive-dispatch.service";
import { cronProactiveContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";
import type { RouteEntry } from "../route-entry";
import { compareProactiveSchedules$ } from "../services/proactive-schedule-shadow.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

export const cronProactiveRoutes: readonly RouteEntry[] = [
  {
    route: cronProactiveContract.handoff,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      if (!get(hasValidCronSecret$)) {
        return cronUnauthorized();
      }
      const body = await get(bodyResultOf(cronProactiveContract.handoff));
      signal.throwIfAborted();
      if (!body.ok) {
        return body.response;
      }
      return {
        status: 200 as const,
        body: await set(handoffProactiveDispatch$, body.data, signal),
      };
    }),
  },
  {
    route: cronProactiveContract.compare,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      if (!get(hasValidCronSecret$)) {
        return cronUnauthorized();
      }
      const phase = await set(proactiveDispatchPhase$, signal);
      const body =
        phase === "automation"
          ? await set(compareProactiveSchedules$, signal)
          : phase === "draining"
            ? { phase, minute: nowDate().toISOString() }
            : await set(dispatchProactiveSchedules$, signal);
      return { status: 200 as const, body };
    }),
  },
];
