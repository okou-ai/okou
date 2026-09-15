import { command } from "ccstate";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";

import { logger } from "../../lib/log";
import { apiStartTime$, authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import { completeAgentRun$ } from "../services/agent-webhook-complete.service";
import { dispatchCompleteSideEffects$ } from "../services/agent-run-lifecycle.service";
import { tapError } from "../utils";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const L = logger("webhook:complete");

const completeBody$ = bodyResultOf(webhookCompleteContract.complete);

const completeAgentRunRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(completeBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const auth = getSandboxAuthForRun(body.runId, get(authorization$));
    if (!auth) {
      return unauthorizedRunMismatch;
    }

    const result = await set(completeAgentRun$, { auth, body }, signal);
    signal.throwIfAborted();

    if (result.status === 200 && result.sideEffects) {
      waitUntil(
        tapError(
          set(
            dispatchCompleteSideEffects$,
            { ...result.sideEffects, apiStartTime: get(apiStartTime$) },
            signal,
          ),
          (error) => {
            L.error("dispatchCompleteSideEffects failed", {
              runId: result.sideEffects?.runId,
              error,
            });
          },
        ),
      );
    }

    return {
      status: result.status,
      body: result.body,
    };
  },
);

export const webhooksAgentCompleteRoutes: readonly RouteEntry[] = [
  {
    route: webhookCompleteContract.complete,
    handler: completeAgentRunRoute$,
  },
];
