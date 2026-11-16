import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { feedItems } from "@okouai/db/schema/feed-item";
import { notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishAgentSuggestionsChangedSafely } from "../external/realtime";

/** A receipt hides the event; it never re-enables or otherwise edits its automation. */
export const dismissFeedEvent$ = command(
  async (
    { set },
    owner: { readonly orgId: string; readonly userId: string },
    id: string,
    signal: AbortSignal,
  ) => {
    const [updated] = await set(writeDb$)
      .update(feedItems)
      .set({ state: { status: "dismissed" }, updatedAt: nowDate() })
      .where(
        and(
          eq(feedItems.orgId, owner.orgId),
          eq(feedItems.userId, owner.userId),
          eq(feedItems.id, id),
          eq(feedItems.type, "event"),
        ),
      )
      .returning({ id: feedItems.id });
    signal.throwIfAborted();
    if (!updated) {
      return notFound("Feed event not found");
    }
    await publishAgentSuggestionsChangedSafely(owner);
    signal.throwIfAborted();
    return { status: 204 as const, body: undefined };
  },
);
