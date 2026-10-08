import { trace } from "@opentelemetry/api";
import { cronRetainChatEventsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import type { RouteEntry } from "../route-entry";
import {
  retainChatEvents$,
  type ChatEventRetentionStats,
} from "../services/cron-retain-chat-events.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const COMPLETION_DATASET = "web-logs";
const COMPLETION_CONTEXT = "api:cron:retain-chat-events";

function recordChatEventRetentionCompleted(
  result: ChatEventRetentionStats,
): void {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  ingestToAxiom(getDatasetName(COMPLETION_DATASET), [
    {
      _time: nowDate().toISOString(),
      level: "info",
      message: "Completed chat event retention",
      source: "api",
      type: "chat_event_retention_completed",
      context: COMPLETION_CONTEXT,
      deploymentCommitSha: env("GIT_COMMIT_SHA"),
      ...(traceId === undefined ? {} : { trace_id: traceId }),
      ...result,
    },
  ]);
}

const retainChatEventsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(retainChatEvents$, signal);
    signal.throwIfAborted();
    recordChatEventRetentionCompleted(result);
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronRetainChatEventsRoutes: readonly RouteEntry[] = [
  {
    route: cronRetainChatEventsContract.retain,
    handler: retainChatEventsRoute$,
  },
];
