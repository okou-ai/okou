import { isCodexFastModeEnabled } from "@okouai/core/model-feature-switch";
import type { FeatureSwitchContext } from "@okouai/core";

import { badRequestMessage } from "../../lib/error";
import type { Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { appendQueuedRunAssistantMarker } from "./chat-queue-marker.service";
import {
  resolvePersistedChatThreadModel,
  type ResolvedPersistedChatThreadModel,
} from "./chat-thread-model.service";

/**
 * Resolve a chat-derived run against the current canonical model policy.
 * Legacy threads without a stored model use the current canonical default and
 * persist that selection before the run is created.
 */
export async function resolveRunChatThreadModelContext(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
}): Promise<
  | (ResolvedPersistedChatThreadModel & {
      readonly featureSwitchContext: FeatureSwitchContext;
    })
  | ReturnType<typeof badRequestMessage>
> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    params.db,
    params.orgId,
    params.userId,
  );
  const resolved = await resolvePersistedChatThreadModel({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    threadId: params.threadId,
    persistRequestedCodexServiceTier: false,
    codexFastModeEnabled: isCodexFastModeEnabled(featureSwitchContext),
  });
  if (!resolved) {
    return badRequestMessage("Chat thread not found");
  }
  if ("status" in resolved) {
    return resolved;
  }
  return { ...resolved, featureSwitchContext };
}

async function publishRunUserMessageSignals(
  orgId: string,
  userId: string,
  threadId: string,
): Promise<void> {
  await publishChatThreadMessageCreatedSafely({ orgId, userId, threadId });
  await publishThreadListChanged({ orgId, userId });
}

/**
 * Finish the side effects for a user message inserted by a queue-first run
 * claim. The claim and run rows already committed atomically; only a queued
 * marker and realtime notifications remain.
 */
export async function finalizeClaimedRunUserMessage(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
  readonly runStatus: string;
  readonly runGroupId?: string;
  readonly createdAt: Date;
}): Promise<void> {
  if (params.runStatus === "queued") {
    await params.db.transaction(async (tx): Promise<void> => {
      await appendQueuedRunAssistantMarker(tx, {
        chatThreadId: params.threadId,
        runId: params.runId,
        runGroupId: params.runGroupId,
        createdAfter: params.createdAt,
      });
    });
  }
  await publishRunUserMessageSignals(
    params.orgId,
    params.userId,
    params.threadId,
  );
}
