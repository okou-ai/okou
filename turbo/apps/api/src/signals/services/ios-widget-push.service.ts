import { command } from "ccstate";
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { iosPushRegistrations } from "@okouai/db/schema/ios-push-registration";
import { hasApnsConfiguration, sendApnsNotification } from "../external/apns";
import { db$, writeDb$ } from "../external/db";
import { waitUntil } from "../context/wait-until";
import { logger } from "../../lib/log";
import { nowDateSql } from "../../lib/time";
import { settle } from "../utils";

const log = logger("api:ios-widget-push");

/**
 * The shortest spacing between two widget pushes to one installation. WidgetKit
 * budgets these pushes, and each one makes the device read the chat state when
 * its widgets reload, so a change inside this window is normally already part of
 * the read the earlier push started.
 */
const IOS_WIDGET_PUSH_INTERVAL_MS = 10_000;

type Registration = Pick<
  typeof iosPushRegistrations.$inferSelect,
  "installationId" | "revision" | "environment" | "widgetPushToken"
>;

/**
 * Ask every installed iOS widget of this user to reload. Call it after a change to
 * what the widgets show has committed: a Run became pending, a Run's terminal
 * marker committed, or a read state, mute or deletion changed. The push carries
 * no chat data, so it needs no session check; the widget's API read is
 * authorized on its own.
 */
export const refreshUserWidgets$ = command(
  async ({ get, set }, userId: string, signal: AbortSignal): Promise<void> => {
    if (
      !hasApnsConfiguration("production") &&
      !hasApnsConfiguration("sandbox")
    ) {
      return;
    }
    const registrations = await get(db$)
      .select({
        installationId: iosPushRegistrations.installationId,
        revision: iosPushRegistrations.revision,
        environment: iosPushRegistrations.environment,
        widgetPushToken: iosPushRegistrations.widgetPushToken,
      })
      .from(iosPushRegistrations)
      .where(
        and(
          eq(iosPushRegistrations.userId, userId),
          eq(iosPushRegistrations.enabled, true),
          isNotNull(iosPushRegistrations.widgetPushToken),
        ),
      );
    signal.throwIfAborted();
    await Promise.all(
      registrations.map((registration) => {
        return set(sendWidgetPush$, registration, signal);
      }),
    );
  },
);

/**
 * Queue `refreshUserWidgets$` after the caller's change committed. It outlives
 * the caller's request and never delays or fails it.
 */
export const scheduleUserWidgetRefresh$ = command(
  ({ set }, userId: string): void => {
    waitUntil(set(refreshUserWidgets$, userId, new AbortController().signal));
  },
);

const sendWidgetPush$ = command(
  async (
    { set },
    registration: Registration,
    signal: AbortSignal,
  ): Promise<void> => {
    const token = registration.widgetPushToken;
    if (!token || !hasApnsConfiguration(registration.environment)) {
      return;
    }
    // Claim this installation's next push slot. The binding must still be the
    // current, enabled one with the same widget token.
    const claimed = await set(writeDb$)
      .update(iosPushRegistrations)
      .set({ widgetPushedAt: nowDateSql() })
      .where(
        and(
          eq(iosPushRegistrations.installationId, registration.installationId),
          eq(iosPushRegistrations.revision, registration.revision),
          eq(iosPushRegistrations.enabled, true),
          eq(iosPushRegistrations.widgetPushToken, token),
          or(
            isNull(iosPushRegistrations.widgetPushedAt),
            lte(
              iosPushRegistrations.widgetPushedAt,
              sql`${nowDateSql()} - ${IOS_WIDGET_PUSH_INTERVAL_MS} * interval '1 millisecond'`,
            ),
          ),
        ),
      )
      .returning({ pushedAt: iosPushRegistrations.widgetPushedAt });
    signal.throwIfAborted();
    const pushedAt = claimed[0]?.pushedAt;
    if (!pushedAt) {
      return;
    }
    const notificationId = `widgets:${registration.installationId}:${pushedAt.getTime()}`;
    const result = await settle(
      sendApnsNotification(
        {
          environment: registration.environment,
          deviceToken: token,
          notificationId,
          pushType: "widgets",
          payload: JSON.stringify({ aps: { "content-changed": true } }),
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      log.warn("APNs widget push request failed", { error: result.error });
      return;
    }
    const { status, reason } = result.value;
    if (
      status === 410 ||
      (status === 400 &&
        (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"))
    ) {
      // Only the widget token is gone; the installation's alerts still work.
      log.warn("APNs widget token cleared", { status, reason });
      await set(writeDb$)
        .update(iosPushRegistrations)
        .set({ widgetPushToken: null })
        .where(
          and(
            eq(
              iosPushRegistrations.installationId,
              registration.installationId,
            ),
            eq(iosPushRegistrations.widgetPushToken, token),
          ),
        );
      signal.throwIfAborted();
    } else if (status !== 200) {
      log.warn("APNs rejected widget push", { status, reason });
    }
  },
);
