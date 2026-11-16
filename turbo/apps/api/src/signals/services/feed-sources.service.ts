import { command, computed } from "ccstate";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { feedPreferences } from "@okouai/db/schema/feed-preference";
import { feedItems } from "@okouai/db/schema/feed-item";
import type { FeedSources } from "@okouai/api-contracts/contracts/feed";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { organizationAuthContext$ } from "../auth/auth-context";
import { createUserFeatureSwitchContext } from "./feature-switches.service";
import { db$, writeDb$ } from "../external/db";
import { publishAgentSuggestionsChangedSafely } from "../external/realtime";
import { liveSuggestion } from "./agent-suggestions-lifecycle";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
function feedOwner(owner: Owner) {
  return and(
    eq(feedItems.orgId, owner.orgId),
    eq(feedItems.userId, owner.userId),
  );
}
function activePlatformEvent() {
  return and(
    eq(feedItems.type, "event"),
    sql`${feedItems.state}->>'status' = 'active'`,
  );
}
const switchContext$ = createUserFeatureSwitchContext(organizationAuthContext$);
export const forYouSourcesEnabled$ = computed(async (get) => {
  return isFeatureEnabled(
    FeatureSwitchKey.ForYouSources,
    await get(switchContext$),
  );
});

export const readFeedSources$ = computed(async (get): Promise<FeedSources> => {
  const owner = get(organizationAuthContext$);
  const [row] = await get(db$)
    .select({
      suggestions: feedPreferences.suggestions,
      whatsNew: feedPreferences.whatsNew,
      offers: feedPreferences.offers,
      systemUpdates: feedPreferences.systemUpdates,
    })
    .from(feedPreferences)
    .where(
      and(
        eq(feedPreferences.orgId, owner.orgId),
        eq(feedPreferences.userId, owner.userId),
      ),
    )
    .limit(1);
  return (
    row ?? {
      suggestions: true,
      whatsNew: true,
      offers: true,
      systemUpdates: true,
    }
  );
});

export const updateFeedSources$ = command(
  async (
    { set },
    owner: Owner,
    patch: Partial<FeedSources>,
    signal: AbortSignal,
  ) => {
    const [row] = await set(writeDb$)
      .insert(feedPreferences)
      .values({ ...owner, ...patch })
      .onConflictDoUpdate({
        target: [feedPreferences.orgId, feedPreferences.userId],
        set: patch,
      })
      .returning({
        suggestions: feedPreferences.suggestions,
        whatsNew: feedPreferences.whatsNew,
        offers: feedPreferences.offers,
        systemUpdates: feedPreferences.systemUpdates,
      });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Source preference write did not return a row");
    }
    await publishAgentSuggestionsChangedSafely(owner);
    signal.throwIfAborted();
    return row;
  },
);

export const readFeedSummary$ = computed(async (get) => {
  const owner = get(organizationAuthContext$);
  const sources = await get(readFeedSources$);
  if (!sources.suggestions && !sources.systemUpdates) {
    return { hasUnread: false };
  }
  // This is independent of the review's ten-card snapshot and counts no
  // expired, consumed, removed or already displayed card.
  const [row] = await get(db$)
    .select({ id: feedItems.id })
    .from(feedItems)
    .where(
      and(
        feedOwner(owner),
        or(
          sources.suggestions ? liveSuggestion(nowDate()) : undefined,
          sources.systemUpdates ? activePlatformEvent() : undefined,
        ),
        isNull(feedItems.readAt),
      ),
    )
    .limit(1);
  return { hasUnread: row !== undefined };
});

export const markFeedItemRead$ = command(
  async ({ set }, owner: Owner, id: string, signal: AbortSignal) => {
    const [row] = await set(writeDb$)
      .update(feedItems)
      // Reading is a receipt, not a content update or a retention extension.
      .set({ readAt: sql`coalesce(${feedItems.readAt}, ${nowDate()})` })
      .where(
        and(
          feedOwner(owner),
          eq(feedItems.id, id),
          or(liveSuggestion(nowDate()), activePlatformEvent()),
        ),
      )
      .returning({ readAt: feedItems.readAt });
    signal.throwIfAborted();
    if (!row?.readAt) {
      return notFound("Card not found");
    }
    await publishAgentSuggestionsChangedSafely(owner);
    signal.throwIfAborted();
    return { status: 200 as const, body: { readAt: row.readAt.toISOString() } };
  },
);
