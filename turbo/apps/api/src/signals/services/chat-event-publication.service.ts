import { command } from "ccstate";
import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { waitUntil } from "../context/wait-until";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { isAbortError, onRejection } from "../utils";
import { projectChatThreadSearch$ } from "./cron-project-chat-event-search.service";

const L = logger("chat:event-publication");

/** Preserve realtime delivery while indexing this committed owner's thread. */
export const publishChatThreadMessageCreated$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly threadId: string;
      readonly syncThroughSeqId?: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    // Register before awaiting realtime, so a lost notification cannot suppress
    // indexing. One finite batch belongs to this request's background lifetime;
    // cron recovers failures and catches up older history beyond that batch.
    waitUntil(
      onRejection(set(projectChatThreadSearch$, args, signal), (error) => {
        if (!isAbortError(error)) {
          L.error("Committed chat search publication failed", {
            threadId: args.threadId,
            // A query error can contain the private message document as SQL
            // parameters. Keep diagnostics useful without logging that payload.
            errorName: error instanceof Error ? error.name : "UnknownError",
            sqlState: safeSqlStateCode(error),
          });
          // waitUntil also reports rejected work; propagate a payload-free error
          // so its lifecycle remains failed without exposing query parameters.
          throw new Error("Committed chat search publication failed");
        }
      }),
    );
    await publishChatThreadMessageCreatedSafely(args);
    signal.throwIfAborted();
  },
);
