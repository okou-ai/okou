/**
 * Web Push notification signals for the platform PWA.
 *
 * - registerServiceWorker$ — called once on app startup
 * - ensurePushSubscription$ — fire-and-forget on each send
 */

import { command, state } from "ccstate";
import { pushSubscriptionsContract } from "@okouai/api-contracts/client/push-subscriptions";
import { apiClient$, type ApiClientFactory } from "../signals/api-client.ts";
import { accept } from "./accept.ts";
import { bestEffort } from "../signals/utils.ts";
import { resolvePlatformRuntimeConfig } from "./platform-host.ts";

const swRegistration$ = state<ServiceWorkerRegistration | null>(null);
const subscribing$ = state(false);

/**
 * Register the service worker. Safe to call multiple times.
 * No-ops if push is not supported in this browser.
 */
export const registerServiceWorker$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return;
    }

    signal.throwIfAborted();

    // eslint-disable-next-line ccstate/no-best-effort -- Legacy 20261029: existing bestEffort only; do not add new usages.
    await bestEffort(
      (async () => {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          updateViaCache: "none",
        });

        signal.throwIfAborted();
        set(swRegistration$, registration);
      })(),
    );
  },
);

/**
 * Ensure the user has an active push subscription.
 *
 * If permission is "default", requests it. If granted, subscribes and
 * sends the subscription to the backend. Silently no-ops on denial or
 * when push is unsupported. Callers are responsible for detaching the
 * returned promise (e.g. `detach(ensurePushSubscription(pageSignal),
 * Reason.DomCallback)` from a DOM handler).
 */
export const ensurePushSubscription$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (get(subscribing$)) {
      return;
    }
    const registration = get(swRegistration$);
    if (!registration) {
      return;
    }
    set(subscribing$, true);
    // TODO: The try-catch block here needs to be cleaned up.
    // eslint-disable-next-line no-restricted-syntax
    try {
      const createClient = get(apiClient$);
      await doSubscribe(registration, createClient, signal);
      signal.throwIfAborted();
    } finally {
      set(subscribing$, false);
    }
  },
);

async function doSubscribe(
  registration: ServiceWorkerRegistration,
  createClient: ApiClientFactory,
  signal: AbortSignal,
): Promise<void> {
  const vapidPublicKey = resolvePlatformRuntimeConfig().vapidPublicKey;
  if (!vapidPublicKey) {
    return;
  }

  // Only prompt if user hasn't decided yet
  if (Notification.permission === "default") {
    const result = await Notification.requestPermission();
    signal.throwIfAborted();
    if (result !== "granted") {
      return;
    }
  }

  if (Notification.permission !== "granted") {
    return;
  }

  // Check if already subscribed
  const existingSub = await registration.pushManager.getSubscription();
  signal.throwIfAborted();
  const subscription =
    existingSub ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
        .buffer as ArrayBuffer,
    }));
  signal.throwIfAborted();

  const client = createClient(pushSubscriptionsContract);
  await accept(
    client.register({
      body: {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: arrayBufferToBase64(subscription.getKey("p256dh")),
          auth: arrayBufferToBase64(subscription.getKey("auth")),
        },
      },
      fetchOptions: { signal },
    }),
    [201],
    signal,
    { showErrorToast: false },
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) {
    return "";
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
