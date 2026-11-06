import { command, computed } from "ccstate";
import { and, count, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  userNotificationsContract,
  userNotificationSchema,
  userNotificationSummarySchema,
} from "@okouai/api-contracts/contracts/user-notifications";
import { userNotifications } from "@okouai/db/schema/user-notification";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  badRequestMessage,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { createUserFeatureSwitchContext } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const switchContext$ = createUserFeatureSwitchContext(organizationAuthContext$);
const enabled$ = computed(async (get) => {
  return isFeatureEnabled(
    FeatureSwitchKey.UserNotifications,
    await get(switchContext$),
  );
});
const listQuery$ = queryOf(userNotificationsContract.list);
const detailParams$ = pathParamsOf(userNotificationsContract.get);
const readParams$ = pathParamsOf(userNotificationsContract.markRead);
const PAGE_SIZE = 20;

const unreadCount$ = computed(async (get) => {
  const { userId } = get(organizationAuthContext$);
  const [result] = await get(db$)
    .select({ value: count() })
    .from(userNotifications)
    .where(
      and(
        eq(userNotifications.userId, userId),
        isNull(userNotifications.readAt),
      ),
    );
  if (!result) {
    throw new Error("Notification aggregate did not return a row");
  }
  return result.value;
});

const listRows$ = computed(async (get) => {
  const { userId } = get(organizationAuthContext$);
  const query = get(listQuery$);
  return get(db$)
    .select({
      id: userNotifications.id,
      type: sql`${userNotifications.payload}->>'type'`.mapWith(pgTextDecoder),
      title: userNotifications.title,
      summary: userNotifications.summary,
      createdAt: userNotifications.createdAt,
      readAt: userNotifications.readAt,
    })
    .from(userNotifications)
    .where(
      and(
        eq(userNotifications.userId, userId),
        query?.beforeAt && query.beforeId
          ? or(
              lt(userNotifications.createdAt, new Date(query.beforeAt)),
              and(
                eq(userNotifications.createdAt, new Date(query.beforeAt)),
                lt(userNotifications.id, query.beforeId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(userNotifications.createdAt), desc(userNotifications.id))
    .limit(PAGE_SIZE + 1);
});

const detailRow$ = computed(async (get) => {
  const { userId } = get(organizationAuthContext$);
  const { id } = get(detailParams$);
  const [row] = await get(db$)
    .select()
    .from(userNotifications)
    .where(
      and(eq(userNotifications.userId, userId), eq(userNotifications.id, id)),
    );
  return row;
});

const summary$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  if (!(await get(enabled$)))
    return resourceUnavailable("Notifications are not available");
  signal.throwIfAborted();
  const unreadCount = await get(unreadCount$);
  signal.throwIfAborted();
  return { status: 200 as const, body: { unreadCount } };
});

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  if (!(await get(enabled$)))
    return resourceUnavailable("Notifications are not available");
  signal.throwIfAborted();
  const query = get(listQuery$);
  if (Boolean(query?.beforeAt) !== Boolean(query?.beforeId)) {
    return badRequestMessage("Both notification cursor fields are required");
  }
  const rows = await get(listRows$);
  signal.throwIfAborted();
  const items = rows.slice(0, PAGE_SIZE).map((row) => {
    return userNotificationSummarySchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    });
  });
  const last = items.at(-1);
  return {
    status: 200 as const,
    body: {
      items,
      nextCursor:
        rows.length > PAGE_SIZE && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    },
  };
});

const detail$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  if (!(await get(enabled$)))
    return resourceUnavailable("Notifications are not available");
  signal.throwIfAborted();
  const row = await get(detailRow$);
  signal.throwIfAborted();
  if (!row) return notFound("Notification not found");
  return {
    status: 200 as const,
    body: userNotificationSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    }),
  };
});

const markRead$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  if (!(await get(enabled$)))
    return resourceUnavailable("Notifications are not available");
  signal.throwIfAborted();
  const { userId } = get(organizationAuthContext$);
  const { id } = get(readParams$);
  const at = nowDate();
  const [row] = await set(writeDb$)
    .update(userNotifications)
    .set({
      readAt: sql`coalesce(${userNotifications.readAt}, ${sql.param(at, userNotifications.readAt)})`,
    })
    .where(
      and(eq(userNotifications.userId, userId), eq(userNotifications.id, id)),
    )
    .returning({ readAt: userNotifications.readAt });
  signal.throwIfAborted();
  if (!row) return notFound("Notification not found");
  if (!row.readAt) {
    throw new Error("Notification read receipt was not persisted");
  }
  return { status: 200 as const, body: { readAt: row.readAt.toISOString() } };
});

const markAllRead$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  // Capture the request boundary before any awaited work. Later deliveries
  // remain unread, including those outside the currently loaded list page.
  const at = nowDate();
  if (!(await get(enabled$)))
    return resourceUnavailable("Notifications are not available");
  signal.throwIfAborted();
  const { userId } = get(organizationAuthContext$);
  await set(writeDb$)
    .update(userNotifications)
    .set({ readAt: at })
    .where(
      and(
        eq(userNotifications.userId, userId),
        isNull(userNotifications.readAt),
        lte(userNotifications.createdAt, at),
      ),
    );
  signal.throwIfAborted();
  return { status: 200 as const, body: { readThrough: at.toISOString() } };
});

const auth = { requireOrganization: true, accept: ["session"] } as const;
export const userNotificationRoutes: readonly RouteEntry[] = [
  {
    route: userNotificationsContract.summary,
    handler: authRoute(auth, summary$),
  },
  { route: userNotificationsContract.list, handler: authRoute(auth, list$) },
  { route: userNotificationsContract.get, handler: authRoute(auth, detail$) },
  {
    route: userNotificationsContract.markRead,
    handler: authRoute(auth, markRead$),
  },
  {
    route: userNotificationsContract.markAllRead,
    handler: authRoute(auth, markAllRead$),
  },
];
