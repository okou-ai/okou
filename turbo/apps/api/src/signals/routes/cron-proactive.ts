import { bodyResultOf } from "../context/request";
import { handoffProactiveDispatch$ } from "../services/proactive-handoff.service";
import { monotonicNow, nowDate } from "../../lib/time";
import { proactiveDispatchPhase$ } from "../services/proactive-dispatch-ownership.service";
import { dispatchProactiveSchedules$ } from "../services/proactive-dispatch.service";
import { cronProactiveContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";
import type { RouteEntry } from "../route-entry";
import { recordApiOperationTimings } from "../external/sandbox-op-log";
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
      signal.throwIfAborted();
      if (phase !== "standalone") {
        const action = phase === "automation" ? "drain" : "activate";
        const started = monotonicNow();
        const handoff = await set(
          handoffProactiveDispatch$,
          { action, apply: true },
          signal,
        );
        signal.throwIfAborted();
        recordApiOperationTimings([
          {
            actionType: "proactive_schedule_handoff",
            durationMs: monotonicNow() - started,
            success: true,
            dimensions: { action, ...handoff },
          },
        ]);
        if (handoff.phase !== "standalone") {
          return {
            status: 200 as const,
            body: {
              phase: "draining" as const,
              minute: nowDate().toISOString(),
            },
          };
        }
      }
      return {
        status: 200 as const,
        body: await set(dispatchProactiveSchedules$, signal),
      };
    }),
  },
];
