# Notification navigation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [notification-navigation.test.tsx](notification-navigation.test.tsx).

## notification-navigation-001

Original test `A relative chat notification opens its conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/notifications/__tests__/notification-navigation.test.tsx#L16).

- **Given** A user is viewing Agents in the app when a chat notification arrives with a relative conversation URL.
- **When** The user clicks the notification.
- **Then** The app navigates to that chat conversation.

**Batch 33 disposition.** The frozen Agents-list prerequisite was retired by #49556. A Router control opened `/agents`, observed the replacement home URL with `settings=my-okou`, and verified that the Agents heading was absent. A service-worker notification click carrying a relative conversation URL then opened that exact conversation and rendered its seeded message. Main now starts this scenario on Workflows. The original ID stays unaccepted; the control is excluded from the suite and from the count.

## notification-navigation-002

Original test `An untrusted or non-chat notification does not navigate Platform`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/notifications/__tests__/notification-navigation.test.tsx#L33).

- **Given** A user is viewing Agents in the app.
- **When** Notifications point to an external host’s chat, an untrusted Okou host’s chat, or the app’s Agents page.
- **Then** The app does not navigate and continues showing Agents.
