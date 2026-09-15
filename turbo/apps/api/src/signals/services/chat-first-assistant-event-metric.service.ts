import { elapsedSinceApiStartMs } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import type { Db } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { now } from "../../lib/time";
import { tapError } from "../utils";
import { writeRunMetadataInTransaction } from "./agent-run-metadata-write.service";

import {
  withRunContentWrite,
  type RunContentOwnership,
} from "./run-content-erasure-admission.service";

const L = logger("api:chat-first-assistant-message-metric");

export function recordFirstAssistantEventEligibility(args: {
  readonly runId: string;
  readonly apiStartedAt: number;
}): void {
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "first_assistant_message_eligible",
    durationMs: 0,
    success: true,
    runId: args.runId,
    timestamp: new Date(args.apiStartedAt).toISOString(),
  });
}

async function recordFirstAssistantEventAcknowledgement(args: {
  readonly db: Db;
  readonly ownership: RunContentOwnership;
  readonly runId: string;
  readonly acknowledgedAt: number;
}): Promise<void> {
  const firstAssistantClaimWhere = and(
    eq(agentRuns.id, args.runId),
    isNotNull(agentRuns.apiStartedAt),
    isNull(agentRuns.firstAssistantEventAcknowledgedAt),
  );
  if (!firstAssistantClaimWhere) {
    throw new Error("First assistant acknowledgement predicate is empty");
  }
  const admitted = await withRunContentWrite(
    args.db,
    { runId: args.runId, ownership: args.ownership },
    async (tx) => {
      return await writeRunMetadataInTransaction(tx, {
        patch: {
          firstAssistantEventAcknowledgedAt: new Date(args.acknowledgedAt),
        },
        where: firstAssistantClaimWhere,
      });
    },
    AbortSignal.timeout(20_000),
  );
  if (admitted.outcome === "closed") {
    return;
  }
  const [claimed] = admitted.value;
  if (!claimed?.apiStartedAt) {
    return;
  }

  recordFirstAssistantEventAcknowledgementMetric({
    runId: args.runId,
    apiStartedAt: claimed.apiStartedAt.getTime(),
    acknowledgedAt: args.acknowledgedAt,
  });
}

export function recordFirstAssistantEventAcknowledgementMetric(args: {
  readonly runId: string;
  readonly apiStartedAt: number;
  readonly acknowledgedAt: number;
}): void {
  const durationMs = elapsedSinceApiStartMs(
    args.apiStartedAt,
    args.acknowledgedAt,
  );
  if (durationMs === undefined) {
    return;
  }

  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "api_to_first_assistant_message",
    durationMs,
    success: true,
    runId: args.runId,
    timestamp: new Date(args.acknowledgedAt).toISOString(),
  });
}

export async function publishFirstAssistantEventCreatedSignalSafely(args: {
  readonly orgId: string;
  readonly threadId: string;
  readonly userId: string;
}): Promise<void> {
  await publishChatThreadMessageCreatedSafely(args);
}

async function publishFirstAssistantEventCreated(args: {
  readonly db: Db;
  readonly ownership: RunContentOwnership;
  readonly orgId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
}): Promise<void> {
  await publishChatThreadMessageCreatedSafely(args);
  const acknowledgedAt = now();
  waitUntil(
    tapError(
      recordFirstAssistantEventAcknowledgement({
        db: args.db,
        ownership: args.ownership,
        runId: args.runId,
        acknowledgedAt,
      }),
      (error) => {
        L.warn("Failed to record first assistant message acknowledgement", {
          runId: args.runId,
          error,
        });
      },
    ),
  );
}

export async function publishFirstAssistantEventCreatedSafely(args: {
  readonly db: Db;
  readonly ownership: RunContentOwnership;
  readonly orgId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
}): Promise<void> {
  await publishFirstAssistantEventCreated(args);
}
