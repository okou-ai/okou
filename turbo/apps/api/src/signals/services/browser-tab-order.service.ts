import type { BrowserTabOrder } from "@okouai/api-contracts/contracts/browser";
import { browserChatSessions as windows } from "@okouai/db/schema/browser-chat-session";
import { browserOwnerProfiles as profiles } from "@okouai/db/schema/browser-owner";
import {
  browserSessionInstances as instances,
  browserSessions as sessions,
} from "@okouai/db/schema/browser-session";
import { command } from "ccstate";
import { and, eq, exists, gt, sql, type SQLWrapper } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  authorityStillCurrent,
  type BrowserPublicAuthority,
} from "./browser-owner.service";

function appendOrder(column: SQLWrapper, order: BrowserTabOrder) {
  const previous = sql`CASE WHEN ${column}->>'instanceId' = ${order.instanceId}
    AND ${column}->'windowId' = ${JSON.stringify(order.windowId)}::jsonb
    THEN ${column}->'tabs' ELSE '[]'::jsonb END`;
  const additions = [...new Set(order.targetIds)];
  return sql`jsonb_build_object('instanceId', ${order.instanceId}::text,
    'windowId', ${JSON.stringify(order.windowId)}::jsonb,
    'savedTabIds', CASE WHEN ${column}->>'instanceId' = ${order.instanceId} AND ${column}->'windowId' = ${JSON.stringify(order.windowId)}::jsonb THEN ${column}->'savedTabIds' ELSE '[]'::jsonb END,
    'tabs', ${previous} || (SELECT coalesce(jsonb_agg(jsonb_build_object('targetId', requested.id, 'tabId', NULL) ORDER BY requested.ordinal), '[]'::jsonb)
      FROM jsonb_array_elements_text(${JSON.stringify(additions)}::jsonb) WITH ORDINALITY AS requested(id, ordinal)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${previous}) AS known(tab)
        WHERE known.tab->>'targetId' = requested.id)))`;
}

/** A hint only: existing API renewal/close owns authorization and side effects. */
export const recordBrowserTabOrder$ = command(
  async (
    { set },
    owner: BrowserPublicAuthority,
    order: BrowserTabOrder,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    if (order.windowId !== null) {
      const value = appendOrder(windows.tabOrder, order);
      await db
        .update(windows)
        .set({ tabOrder: value })
        .where(
          and(
            sql`${windows.tabOrder} IS DISTINCT FROM ${value}`,
            eq(windows.chatThreadId, owner.chatThreadId),
            eq(windows.orgId, owner.orgId),
            eq(windows.userId, owner.userId),
            eq(windows.instanceId, order.instanceId),
            eq(windows.primaryWindowId, order.windowId),
            eq(windows.state, "active"),
            gt(windows.expiresAt, nowDate()),
            authorityStillCurrent(owner),
            exists(
              new QueryBuilder()
                .select({ id: profiles.id })
                .from(profiles)
                .where(
                  and(
                    eq(profiles.instanceId, order.instanceId),
                    eq(profiles.orgId, owner.orgId),
                    eq(profiles.userId, owner.userId),
                    eq(profiles.status, "active"),
                  ),
                ),
            ),
          ),
        );
    } else {
      const value = appendOrder(instances.tabOrder, order);
      await db
        .update(instances)
        .set({ tabOrder: value })
        .where(
          and(
            sql`${instances.tabOrder} IS DISTINCT FROM ${value}`,
            eq(instances.providerSessionId, order.instanceId),
            eq(instances.chatThreadId, owner.chatThreadId),
            eq(instances.status, "active"),
            authorityStillCurrent(owner),
            exists(
              new QueryBuilder()
                .select({ id: sessions.id })
                .from(sessions)
                .where(
                  and(
                    eq(sessions.chatThreadId, owner.chatThreadId),
                    eq(sessions.orgId, owner.orgId),
                    eq(sessions.userId, owner.userId),
                    eq(sessions.status, "active"),
                  ),
                ),
            ),
          ),
        );
    }
    signal.throwIfAborted();
  },
);
