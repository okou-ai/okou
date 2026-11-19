# Notification navigation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [notification-navigation.test.tsx](notification-navigation.test.tsx).

## notification-navigation-001

Original test `A relative chat notification opens its conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/notifications/__tests__/notification-navigation.test.tsx#L16).

- **Given** A user is viewing Agents in the app when a chat notification arrives with a relative conversation URL.
- **When** The user clicks the notification.
- **Then** The app navigates to that chat conversation.

## notification-navigation-002

Original test `An untrusted or non-chat notification does not navigate Platform`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/notifications/__tests__/notification-navigation.test.tsx#L33).

- **Given** A user is viewing Agents in the app.
- **When** Notifications point to an external host’s chat, an untrusted Okou host’s chat, or the app’s Agents page.
- **Then** The app does not navigate and continues showing Agents.
