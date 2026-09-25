self.addEventListener("install", (_event) => {
  self.skipWaiting();
});

// --- Web Push Notifications ---

const NOTIFICATION_ICON_URL =
  "https://static.vm0.io/platform/icons/okou-icon-192-81c6e7aaadac.png";

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }

  const options = {
    body: data.body ?? "",
    // Hard-cached (one-year, immutable) CDN copy of /icons/icon-192.png so a
    // burst of notifications does not re-fetch the icon from the app origin.
    icon: NOTIFICATION_ICON_URL,
    badge: NOTIFICATION_ICON_URL,
    data: { url: data.url },
  };

  event.waitUntil(
    self.registration.showNotification(data.title ?? "Okou", options),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Reuse an existing same-origin tab: postMessage lets the SPA
        // router navigate without a full page reload.
        for (const client of windowClients) {
          if ("focus" in client) {
            client.postMessage({ type: "NOTIFICATION_CLICK", url });
            return client.focus();
          }
        }
        return clients.openWindow(url);
      }),
  );
});
