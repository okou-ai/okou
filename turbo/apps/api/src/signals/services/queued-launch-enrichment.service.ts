import type { Db } from "../external/db";
import { settle } from "../utils";
import { isSplitChatEventWriteEnabled } from "./chat-event-write-mode.service";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { logger } from "../../lib/log";
import type { projectUserMessage } from "./chat-user-message.service";

const L = logger("QueuedLaunchEnrichment");

export interface QueuedLaunchContextArgs {
  readonly eventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly userMessageProjection: ReturnType<typeof projectUserMessage>;
}

export function warnMissingQueuedLaunchEnrichment(
  channel: string,
  args: Pick<QueuedLaunchContextArgs, "eventId" | "chatThreadId">,
): void {
  L.warn("Optional queued launch enrichment is unavailable", {
    channel,
    chatEventId: args.eventId,
    chatThreadId: args.chatThreadId,
  });
}

/** Optional history/name lookups cannot block an accepted input after activation. */
export async function loadOptionalChatEnrichment<T>(
  db: Db,
  channel: string,
  load: () => Promise<T>,
  fallback: () => T,
  signal: AbortSignal,
): Promise<T> {
  const result = await settle(load(), signal);
  if (result.ok) {
    return result.value;
  }
  const splitWrites = await isSplitChatEventWriteEnabled(db);
  signal.throwIfAborted();
  if (!splitWrites) {
    throw result.error;
  }
  L.warn("Optional chat input enrichment could not be loaded", {
    channel,
    errorName:
      result.error instanceof Error ? result.error.name : "UnknownError",
  });
  return fallback();
}
