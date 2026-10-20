import { browserUserActionRequests } from "@okouai/db/schema/browser-session";
import { command } from "ccstate";
import { and, eq, or, sql } from "drizzle-orm";
import { db$ } from "../external/db";
import { publishBrowserUserActionChangedSafely } from "../external/realtime";

/**
 * A Browser user-action reports its callback as delivered once the callback
 * event exists, so creating that event notifies the thread's open cards.
 */
export const notifyBrowserUserActionCallback$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly threadId: string;
      readonly eventId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const [callback] = await get(db$)
      .select({ requestTokenHash: browserUserActionRequests.requestTokenHash })
      .from(browserUserActionRequests)
      .where(
        and(
          eq(browserUserActionRequests.chatThreadId, args.threadId),
          eq(browserUserActionRequests.userId, args.userId),
          or(
            and(
              eq(browserUserActionRequests.status, "succeeded"),
              sql`${browserUserActionRequests.payload}->'callbackIds'->'success'->>'clientEventId' = ${args.eventId}`,
            ),
            and(
              eq(browserUserActionRequests.status, "cancelled"),
              sql`${browserUserActionRequests.payload}->'callbackIds'->'cancellation'->>'clientEventId' = ${args.eventId}`,
            ),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (callback) {
      await publishBrowserUserActionChangedSafely(args.userId, args.threadId);
    }
  },
);
