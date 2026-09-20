import { command } from "ccstate";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";

import { logger } from "../../lib/log";
import { apiStartTime$, authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import {
  completeAgentRun$,
  dispatchRequiredTerminalChatCallback$,
  type RequiredTerminalChatCallbackResult,
} from "../services/agent-webhook-complete.service";
import { dispatchCompleteSideEffects$ } from "../services/agent-run-lifecycle.service";
import { settle, tapError } from "../utils";
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

    if (result.status === 200 && result.sideEffects?.kind === "terminal") {
      const requiredResult = await settle(
        set(
          dispatchRequiredTerminalChatCallback$,
          { ...result.sideEffects, apiStartTime: get(apiStartTime$) },
          signal,
        ),
      );
      signal.throwIfAborted();
      const required: RequiredTerminalChatCallbackResult = requiredResult.ok
        ? requiredResult.value
        : {
            success: false,
            chatThreadQueueHandled: false,
            error:
              requiredResult.error instanceof Error
                ? requiredResult.error.message
                : "Canonical terminal chat callback failed",
          };
      if (!requiredResult.ok) {
        L.error("Required terminal chat callback dispatch threw", {
          runId: result.sideEffects.runId,
          error: requiredResult.error,
        });
      }

      const backgroundSignal = new AbortController().signal;
      waitUntil(
        tapError(
          set(
            dispatchCompleteSideEffects$,
            {
              ...result.sideEffects,
              apiStartTime: get(apiStartTime$),
              skipChatCallback: true,
              ...(required.chatThreadQueueHandled
                ? { chatThreadQueueHandled: true as const }
                : {}),
            },
            backgroundSignal,
          ),
          (error) => {
            L.error("dispatchCompleteSideEffects failed", {
              runId: result.sideEffects?.runId,
              error,
            });
          },
        ),
      );

      if (!required.success) {
        return createErrorResponse(
          "INTERNAL_SERVER_ERROR",
          "Failed to finalize terminal chat callback",
        );
      }
    } else if (result.status === 200 && result.sideEffects) {
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
