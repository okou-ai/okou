import webpush, { WebPushError } from "web-push";
import { eq } from "drizzle-orm";
import { pushSubscriptions } from "@okouai/db/schema/push-subscription";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/brand-presentation";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
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
export async function sendUserPushNotifications(args: {
  readonly db: Db;
  readonly userId: string;
  readonly notification: PushNotification;
}): Promise<void> {
  const publicKey = optionalEnv("VAPID_PUBLIC_KEY");
  const privateKey = optionalEnv("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) {
    return;
  }

  const subscriptions = await args.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, args.userId));
  if (subscriptions.length === 0) {
    return;
  }

  await Promise.all(
    subscriptions.map(async (subscription) => {
      const payload = JSON.stringify({
        ...args.notification,
        title:
          args.notification.title ?? PUBLIC_BRAND_PRESENTATION.assistantName,
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
              subject: `mailto:${PUBLIC_BRAND_PRESENTATION.contactEmail}`,
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
