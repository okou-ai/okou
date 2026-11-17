import { command } from "ccstate";
import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { isAbortError, onRejection } from "../utils";
import { projectChatThreadSearch$ } from "./cron-project-chat-event-search.service";

const L = logger("chat:event-publication");

export interface ChatEventPublicationScope {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
}

/** Finite projection work. The producing entry owns its background lifetime. */
export const projectCommittedChatThreadSearch$ = command(
  async (
    { set },
    scope: ChatEventPublicationScope,
    signal: AbortSignal,
  ): Promise<void> => {
    await onRejection(set(projectChatThreadSearch$, scope, signal), (error) => {
      if (!isAbortError(error)) {
        L.error("Committed chat search publication failed", {
          threadId: scope.threadId,
          errorName: error instanceof Error ? error.name : "UnknownError",
          sqlState: safeSqlStateCode(error),
        });
        // Database errors can contain private message SQL parameters. Preserve
        // the failure for the entry's lifecycle without exposing that payload.
        throw new Error("Committed chat search publication failed");
      }
    });
  },
);

/** Realtime acknowledgement remains independent of search projection. */
export const publishChatThreadMessageCreated$ = command(
  async (
    _,
    args: ChatEventPublicationScope & { readonly syncThroughSeqId?: number },
    signal: AbortSignal,
  ): Promise<void> => {
    await publishChatThreadMessageCreatedSafely(args);
    signal.throwIfAborted();
  },
);
