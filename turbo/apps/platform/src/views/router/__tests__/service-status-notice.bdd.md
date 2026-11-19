# Service status notice

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [service-status-notice.test.tsx](service-status-notice.test.tsx).

## service-status-notice-001

Original test `An Okou production user can view and dismiss an active incident`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/router/__tests__/service-status-notice.test.tsx#L49).

- **Given** A user on the Okou production host has an active incident reporting delayed API requests.
- **When** The user views the page and dismisses the service update.
- **Then** The incident appears as Investigating with a link to its status page; dismissing it removes the service update region.

## service-status-notice-002

Original test `A lookalike production hostname does not request service status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/router/__tests__/service-status-notice.test.tsx#L74).

- **Given** A user visits the lookalike host app.okou.ai.evil.example while an incident is active.
- **When** The page loads.
- **Then** The app does not request service status and shows no service update region.

## service-status-notice-003

Original test `A mobile user with bottom navigation sees an active incident above their chats`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/router/__tests__/service-status-notice.test.tsx#L94).

- **Given** A mobile user on the Okou production host has bottom navigation and an active incident reporting delayed API requests.
- **When** The user opens the home page.
- **Then** The main navigation and the incident status are visible.
