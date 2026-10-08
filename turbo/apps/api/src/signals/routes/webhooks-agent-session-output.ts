import { command } from "ccstate";
import { webhookSessionOutputContract } from "@okouai/api-contracts/contracts/webhooks";

import { eventDeliveryUnavailable } from "../../lib/error";
import { now, nowDate } from "../../lib/time";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { publishSessionOutputDelta } from "../external/realtime";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import type { RouteEntry } from "../route-entry";
import { assistantEventIdForRunEvent } from "../services/assistant-event-id";
import { awaitWithSignal, settleIncludingAbort } from "../utils";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const SESSION_OUTPUT_PUBLISH_TIMEOUT_MS = 2000;
const sessionOutputBody$ = bodyResultOf(webhookSessionOutputContract.send);

const publishSandboxSessionOutput$ = command(
  async ({ get }, signal: AbortSignal) => {
    const receivedAt = now();
    const bodyResult = await get(sessionOutputBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const auth = getSandboxAuthForRun(body.runId, get(authorization$));
    if (!auth) {
      return unauthorizedRunMismatch;
    }

    const publishSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(SESSION_OUTPUT_PUBLISH_TIMEOUT_MS),
    ]);
    const result = await settleIncludingAbort(
      awaitWithSignal(
        publishSessionOutputDelta(
          { userId: auth.userId, orgId: auth.orgId },
          {
            ...body,
            eventId: assistantEventIdForRunEvent(body.runId, body.runEventId),
            createdAt: nowDate().toISOString(),
          },
        ),
        publishSignal,
      ),
    );
    signal.throwIfAborted();
    if (body.chunkIndex === 0) {
      // One row per assistant text block; the earliest per run is the run's
      // first chunk. See docs/chat-first-output-latency.md.
      recordSandboxOperation({
        sandboxType: "runner",
        runId: body.runId,
        actionType: "session_output_first_chunk_publish",
        durationMs: now() - receivedAt,
        success: result.ok,
      });
    }
    if (!result.ok) {
      return eventDeliveryUnavailable(
        "Transient session output publication failed",
      );
    }

    return { status: 204 as const, body: undefined };
  },
);

export const webhooksAgentSessionOutputRoutes: readonly RouteEntry[] = [
  {
    route: webhookSessionOutputContract.send,
    handler: publishSandboxSessionOutput$,
  },
];
