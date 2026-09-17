import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Persistence-only setup specific to Morning Brief calendar collection tests.
 *
 * The owner, installation, thread-binding and Agent-grant helpers are shared
 * with Gmail collection and live in `morning-brief-gmail-collection.ts`; only
 * the `google-calendar` account selection differs. Nothing here weakens a
 * gate: authorization, account resolution, grants, catalog policy and
 * credentials all run through the production modules under test.
 */

export async function selectThreadCalendarAccountFixture(args: {
  readonly chatThreadId: string;
  readonly connectorId: string;
}): Promise<void> {
  await db()
    .insert(chatThreadConnectorSelections)
    .values({
      chatThreadId: args.chatThreadId,
      connectorId: args.connectorId,
      connectorSlug: "google-calendar",
    })
    .onConflictDoNothing();
}

/**
 * Withdraw the access an explicitly selected account was granted.
 *
 * The selection row still names a real connector, so this is the exact shape
 * that must fail closed rather than silently read the owner's default
 * calendars instead.
 */
export async function markCalendarAccountNeedsReconnectFixture(
  connectorId: string,
): Promise<void> {
  await db()
    .update(connectors)
    .set({ needsReconnect: true })
    .where(eq(connectors.id, connectorId));
}
