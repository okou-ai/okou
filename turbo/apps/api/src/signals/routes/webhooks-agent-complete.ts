import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";
import { command, computed } from "ccstate";
import { logger } from "../../lib/log";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import { dispatchCompleteSideEffects$ } from "../services/agent-run-lifecycle.service";
import { scheduleReleasedSlotPicks$ } from "../services/agent-run-slot-scheduling.service";
import { completeAgentRun$ } from "../services/agent-webhook-complete.service";
import {
  createRequiredTerminalChatCallback,
  type RequiredTerminalChatCallbackResult,
} from "../services/required-terminal-chat-callback.service";
import { settle, tapError } from "../utils";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const L = logger("webhook:complete");

const completeBody$ = bodyResultOf(webhookCompleteContract.complete);
const completeRequest$ = computed(async (get) => {
  const bodyResult = await get(completeBody$);
  if (!bodyResult.ok) {
    return bodyResult;
  }
  return {
    ...bodyResult,
    requiredChatCallback: createRequiredTerminalChatCallback(
      bodyResult.data.runId,
    ),
  };
});

const completeAgentRunRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(completeRequest$);
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
    if (result.status === 200) {
      set(scheduleReleasedSlotPicks$, result.releasedSlots, signal);
    }
    signal.throwIfAborted();

    if (result.status === 200 && result.sideEffects?.kind === "terminal") {
      const requiredResult = await settle(
        set(
          bodyResult.requiredChatCallback.dispatch$,
          {
            status: result.sideEffects.status,
            error: result.sideEffects.error,
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      const required: RequiredTerminalChatCallbackResult = requiredResult.ok
        ? requiredResult.value
        : {
            success: false,
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
            { ...result.sideEffects, skipChatCallback: true },
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
          set(dispatchCompleteSideEffects$, result.sideEffects, signal),
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
