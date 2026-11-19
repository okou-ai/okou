# Chat composer connector loading

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-connector-loading.test.tsx](chat-composer-connector-loading.test.tsx).

## chat-composer-connector-loading-001

Original test `Read connected inventory without fetching the connector directory or old authorization endpoints`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.test.tsx#L30).

- **Given** A chat has an authorized, connected GitHub connector, while the connector directory and custom-connector directory are unavailable.
- **When** The user opens the Connectors menu.
- **Then** GitHub appears as a removable connected connector despite the directory failures.

## chat-composer-connector-loading-002

Original test `Refresh both independent resource domains every time the menu opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.test.tsx#L53).

- **Given** The chat has a connected GitHub connector and an available computer resource. The resource names can change between menu openings.
- **When** The user opens and closes the Connectors menu, then opens it again after both names have changed.
- **Then** The first opening shows the initial GitHub and computer names, closing hides the computer, and the next opening shows the renamed GitHub and computer without the old computer name.

## chat-composer-connector-loading-003

Original test `Render connected connectors while remote resources are unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.test.tsx#L113).

- **Given** The chat has an authorized, connected GitHub connector, but remote resources return a forbidden error.
- **When** The user opens the Connectors menu.
- **Then** GitHub remains visible as a removable connector, and an alert is shown.

## chat-composer-connector-loading-004

Original test `Closing a pending menu releases its snapshot before reopening`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.test.tsx#L129).

- **Given** The first Connectors menu request is pending and would return stale GitHub data.
- **When** The user closes the menu, then reopens it before that request is released.
- **Then** Closing aborts the pending request; the reopened menu shows Fresh GitHub, and releasing the old request does not show Stale GitHub.

## chat-composer-connector-loading-005

Original test `Render remote resources while connected connectors are unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.test.tsx#L179).

- **Given** A computer resource is available, but the connected-connector inventory returns a service-unavailable error.
- **When** The user opens the Connectors menu.
- **Then** The computer resource is visible and an alert says “Couldn't load connectors.”

## chat-composer-connector-loading-006

Original test `Reopening an existing chat refreshes its effective host choices`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.test.tsx#L214).

- **Given** An existing chat has one SSH host whose access is enabled.
- **When** The user opens and closes the Connectors menu, then reopens it after the host's access has been disabled.
- **Then** The first opening shows “1 enabled,” closing hides Remote access, and the next opening shows “0 enabled.”

## chat-composer-connector-loading-007

Original test `Do not show the previous Agent's connectors while the next Agent loads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.test.tsx#L255).

- **Given** The current Agent has GitHub authorized; the next Agent has Slack authorized, but that Agent's authorization response is delayed.
- **When** The user switches to the next Agent and opens Connectors before its authorization response arrives, then waits for the response.
- **Then** While loading, GitHub and the connector list are absent; afterward Slack is removable and GitHub is available to add.

## chat-composer-connector-loading-008

Original test `Show an error when an authorization change cannot be saved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-loading.test.tsx#L296).

- **Given** GitHub is authorized for the Agent, but saving authorization changes returns a server error.
- **When** The user opens Connectors and removes GitHub.
- **Then** The error message “Authorization could not be saved” is shown.
