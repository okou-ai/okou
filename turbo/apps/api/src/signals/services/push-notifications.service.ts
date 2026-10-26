import { command } from "ccstate";
import { iosPushRegistrations } from "@okouai/db/schema/ios-push-registration";
import { hasApnsConfiguration, sendApnsNotification } from "../external/apns";
import { isActiveIosPushSession$ } from "./ios-push-registrations.service";
import webpush, { WebPushError } from "web-push";
import { and, eq } from "drizzle-orm";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { pushSubscriptions } from "@okouai/db/schema/push-subscription";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
import { isUserInForeground } from "../external/realtime";
import { settle } from "../utils";
import { unreadIosNotificationThreadCondition } from "./ios-notification-query";

const log = logger("api:push");

interface PushNotification {
  readonly title?: string;
  readonly body: string;
  readonly url: string;
}

interface PushDelivery {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly notification: PushNotification;
}

interface NativePushDelivery {
  readonly orgId?: string;
  readonly runId?: string;
  readonly notificationId: string;
  readonly payload: string;
}

function nativeRunNotification(
  args: PushDelivery,
  unreadCount: number,
): NativePushDelivery {
  const notificationId = `${args.runId}:${args.status}`;
  return {
    orgId: args.orgId,
    runId: args.runId,
    notificationId,
    payload: JSON.stringify({
      aps: {
        alert: {
          title: (
            args.notification.title ?? BRAND_PRESENTATION.assistantName
          ).slice(0, 120),
          body: args.notification.body.slice(0, 512),
        },
        sound: "default",
        badge: unreadCount,
        "content-available": 1,
      },
      okou: {
        version: 1,
        userId: args.userId,
        workspaceId: args.orgId,
        threadId: args.threadId,
        runId: args.runId,
        notificationId,
      },
    }),
  };
}

function notificationUrl(pathOrUrl: string) {
  if (/^https?:\/\//u.test(pathOrUrl)) {
    return pathOrUrl;
  }
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${env("APP_URL")}${path}`;
}

/**
 * Send push notifications to all registered devices for a user.
 *
 * Each transport independently requires its own configured credentials.
 */
export const sendUserPushNotifications$ = command(
  async (
    { get, set },
    args: PushDelivery,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const publicKey = optionalEnv("VAPID_PUBLIC_KEY");
    const privateKey = optionalEnv("VAPID_PRIVATE_KEY");
    const nativeConfigured =
      hasApnsConfiguration("production") || hasApnsConfiguration("sandbox");
    if ((!publicKey || !privateKey) && !nativeConfigured) {
      return;
    }

    // Read at delivery time, not Run admission: the user may mute a running chat.
    const [thread] = await get(db$)
      .select({ muted: chatThreads.muted, hidden: chatThreads.hidden })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread || thread.muted || thread.hidden) {
      return;
    }

    const subscriptions = await get(db$)
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, args.userId));
    signal.throwIfAborted();
    const nativeSubscriptions = nativeConfigured
      ? await get(db$)
          .select()
          .from(iosPushRegistrations)
          .where(
            and(
              eq(iosPushRegistrations.userId, args.userId),
              eq(iosPushRegistrations.enabled, true),
            ),
          )
      : [];
    signal.throwIfAborted();
    if (
      (!publicKey || !privateKey || subscriptions.length === 0) &&
      nativeSubscriptions.length === 0
    ) {
      return;
    }

    // Presence is scoped to the notification's org, not the device's active org.
    const foreground = await isUserInForeground(
      args.userId,
      args.orgId,
      signal,
    );

    const unreadCount =
      nativeSubscriptions.length === 0
        ? 0
        : await get(db$).$count(
            chatThreads,
            unreadIosNotificationThreadCondition(args.userId),
          );
    signal.throwIfAborted();
    const native: NativePushDelivery = foreground
      ? {
          orgId: args.orgId,
          notificationId: `badge:${args.userId}`,
          payload: JSON.stringify({ aps: { badge: unreadCount } }),
        }
      : nativeRunNotification(args, unreadCount);

    await Promise.all([
      ...nativeSubscriptions.map((subscription) => {
        return set(sendNativeRegistration$, native, subscription, signal);
      }),
      ...(!foreground && publicKey && privateKey
        ? subscriptions.map((subscription) => {
            return set(
              sendWebSubscription$,
              {
                subscription,
                notification: args.notification,
                publicKey,
                privateKey,
              },
              signal,
            );
          })
        : []),
    ]);
  },
);

/** Badge-only pushes keep installed clients current after reads on any device. */
export const synchronizeUserPushBadge$ = command(
  async ({ get, set }, userId: string, signal: AbortSignal): Promise<void> => {
    if (!hasApnsConfiguration("production") && !hasApnsConfiguration("sandbox"))
      return;
    const subscriptions = await get(db$)
      .select()
      .from(iosPushRegistrations)
      .where(
        and(
          eq(iosPushRegistrations.userId, userId),
          eq(iosPushRegistrations.enabled, true),
        ),
      );
    signal.throwIfAborted();
    if (subscriptions.length === 0) return;
    const unreadCount = await get(db$).$count(
      chatThreads,
      unreadIosNotificationThreadCondition(userId),
    );
    signal.throwIfAborted();
    const badge: NativePushDelivery = {
      notificationId: `badge:${userId}`,
      payload: JSON.stringify({ aps: { badge: unreadCount } }),
    };
    await Promise.all(
      subscriptions.map((subscription) =>
        set(sendNativeRegistration$, badge, subscription, signal),
      ),
    );
  },
);

const sendNativeRegistration$ = command(
  async (
    { get, set },
    args: NativePushDelivery,
    subscription: typeof iosPushRegistrations.$inferSelect,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!hasApnsConfiguration(subscription.environment)) {
      return;
    }
    if (
      !(await set(
        isActiveIosPushSession$,
        { ...subscription, orgId: args.orgId },
        signal,
      ))
    ) {
      return;
    }
    // Re-read the generation after the external session check. Never send a replaced binding.
    const [current] = await get(db$)
      .select({ revision: iosPushRegistrations.revision })
      .from(iosPushRegistrations)
      .where(
        and(
          eq(iosPushRegistrations.installationId, subscription.installationId),
          eq(iosPushRegistrations.revision, subscription.revision),
          eq(iosPushRegistrations.enabled, true),
        ),
      );
    signal.throwIfAborted();
    if (!current) {
      return;
    }
    const started = performance.now();
    const result = await settle(
      sendApnsNotification(
        {
          environment: subscription.environment,
          deviceToken: subscription.deviceToken,
          notificationId: args.notificationId,
          payload: args.payload,
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      log.warn("APNs provider request failed", {
        runId: args.runId,
        error: result.error,
        durationMs: performance.now() - started,
      });
      return;
    }
    const { status, reason } = result.value;
    if (
      status === 410 ||
      (status === 400 &&
        (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"))
    ) {
      await set(writeDb$)
        .update(iosPushRegistrations)
        .set({ enabled: false })
        .where(
          and(
            eq(
              iosPushRegistrations.installationId,
              subscription.installationId,
            ),
            eq(iosPushRegistrations.revision, subscription.revision),
          ),
        );
      signal.throwIfAborted();
    } else if (status !== 200) {
      log.warn("APNs rejected notification", {
        runId: args.runId,
        status,
        reason,
        durationMs: performance.now() - started,
      });
    } else {
      log.debug("APNs accepted notification", {
        runId: args.runId,
        durationMs: performance.now() - started,
      });
    }
  },
);

const sendWebSubscription$ = command(
  async (
    { set },
    args: {
      readonly subscription: typeof pushSubscriptions.$inferSelect;
      readonly notification: PushNotification;
      readonly publicKey: string;
      readonly privateKey: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { subscription, publicKey, privateKey } = args;
    const payload = JSON.stringify({
      ...args.notification,
      title: args.notification.title ?? BRAND_PRESENTATION.assistantName,
      url: notificationUrl(args.notification.url),
    });
    const result = await settle(
      webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
        payload,
        {
          vapidDetails: {
            subject: `mailto:${BRAND_PRESENTATION.contactEmail}`,
            publicKey,
            privateKey,
          },
        },
      ),
    );
    signal.throwIfAborted();
    if (result.ok) {
      return;
    }

    const statusCode =
      result.error instanceof WebPushError
        ? result.error.statusCode
        : undefined;
    if (statusCode === 410 || statusCode === 404) {
      await set(writeDb$)
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.id, subscription.id));
      signal.throwIfAborted();
      log.debug("Removed stale push subscription", {
        endpoint: subscription.endpoint,
      });
      return;
    }

    log.warn("Failed to send push notification", {
      endpoint: subscription.endpoint,
      error: result.error,
    });
    signal.throwIfAborted();
  },
);
