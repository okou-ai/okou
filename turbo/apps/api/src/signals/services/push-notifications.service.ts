import webpush, { WebPushError } from "web-push";
import { and, eq } from "drizzle-orm";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { pushSubscriptions } from "@okouai/db/schema/push-subscription";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { isUserInForeground } from "../external/realtime";
import { settle } from "../utils";

const log = logger("api:push");

interface PushNotification {
  readonly title?: string;
  readonly body: string;
  readonly url: string;
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
 * Missing VAPID keys are an intentional no-op, matching the legacy web route.
 */
export async function sendUserPushNotifications(
  args: {
    readonly db: Db;
    readonly userId: string;
    readonly orgId: string;
    readonly threadId: string;
    readonly notification: PushNotification;
  },
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const publicKey = optionalEnv("VAPID_PUBLIC_KEY");
  const privateKey = optionalEnv("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) {
    return;
  }

  // Read at delivery time, not Run admission: the user may mute a running chat.
  const [thread] = await args.db
    .select({ muted: chatThreads.muted })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);
  if (!thread || thread.muted) {
    return;
  }

  const subscriptions = await args.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, args.userId));
  if (subscriptions.length === 0) {
    return;
  }

  // Presence is scoped to the notification's org, not the device's active org.
  if (await isUserInForeground(args.userId, args.orgId, signal)) {
    return;
  }

  await Promise.all(
    subscriptions.map(async (subscription) => {
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
      if (result.ok) {
        return;
      }

      const statusCode =
        result.error instanceof WebPushError
          ? result.error.statusCode
          : undefined;
      if (statusCode === 410 || statusCode === 404) {
        await args.db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.id, subscription.id));
        log.debug("Removed stale push subscription", {
          endpoint: subscription.endpoint,
        });
        return;
      }

      log.warn("Failed to send push notification", {
        endpoint: subscription.endpoint,
        error: result.error,
      });
    }),
  );
}
