# Chat composer connector overview

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-connector-overview.test.tsx](chat-composer-connector-overview.test.tsx).

## chat-composer-connector-overview-001

Original test `Load 20 connectors once and reuse the Chat cache on reopening (draft=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L105).

- **Given** The user is in an existing Chat with the connector-account-access feature enabled and 20 connected connectors available.
- **When** They open the Connectors panel, close it, and reopen it.
- **Then** All 20 connectors appear both times. The overview is fetched once, no target refresh is fetched, and the legacy connector and thread endpoints are not read.

## chat-composer-connector-overview-002

Original test `Load 20 connectors once and reuse the Chat cache on reopening (draft=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L105).

- **Given** The user is in a draft Chat with the connector-account-access feature enabled and 20 connected connectors available.
- **When** They open the Connectors panel, close it, and reopen it.
- **Then** All 20 connectors appear both times. The overview is fetched once with no thread ID, no target refresh is fetched, and the legacy connector and thread endpoints are not read.

## chat-composer-connector-overview-003

Original test `Patch only the notified target while closed and fully calibrate after lost continuity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L195).

- **Given** The user has loaded the connector overview in an existing Chat and closed the Connectors panel.
- **When** A connector-change notification updates Probe 1, then removes it; afterward, the subscription loses continuity and reconnects.
- **Then** The first notification refreshes only Probe 1, and its account access is shown off when the panel is reopened. The removal leaves only Probe 2 in the panel. After continuity is lost, a full overview is fetched and Probe 2 remains available.

## chat-composer-connector-overview-004

Original test `Discard an older target response after a Run invalidates the full snapshot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L272).

- **Given** The user has loaded Probe 1 and a target refresh for it is still pending.
- **When** A thread-change event updates the full snapshot to turn off Probe 1 access, then the older target response arrives and another target refresh starts while the panel is closed and reopened.
- **Then** The older response does not overwrite the updated snapshot: Probe 1 access remains off after reopening. The test does not assert the outcome of the second pending response.

## chat-composer-connector-overview-005

Original test `Retry a failed initial overview without keeping an unusable cached request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L334).

- **Given** The initial connector overview request fails with a provider-unavailable error.
- **When** The user selects Try again in the Connectors panel.
- **Then** The connector appears after a second overview request succeeds; the failed request is not reused as a cached result.

## chat-composer-connector-overview-006

Original test `Recover from an initial subscription failure through the overview retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L354).

- **Given** The initial connector-change subscription fails in an existing Chat.
- **When** The user selects Try again in the Connectors panel.
- **Then** No overview request has occurred before the retry. After retry, Probe 1 appears and exactly one overview request has succeeded.

## chat-composer-connector-overview-007

Original test `Expose a failed target refresh and keep notifications working after retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L374).

- **Given** The user has loaded Probe 1 and Probe 2 in the Connectors panel.
- **When** A refresh notification for Probe 1 fails; a notification for Probe 2 arrives; then the user retries Probe 1 successfully and another Probe 1 notification arrives.
- **Then** The panel exposes Try again for the failed Probe 1 refresh while still showing Probe 1, and the Probe 2 notification refreshes Probe 2. Retrying restores Probe 1 and removes the retry control; a later notification updates Probe 1 access to off. The full overview is fetched twice and target refreshes three times.

## chat-composer-connector-overview-008

Original test `Load full readiness only for an opened panel's selected off-page account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L448).

- **Given** The user has a GitHub account selected as current, but that account is on a later page; the first page contains a different account, and the selected account requires reconnection.
- **When** They open the Connectors panel and open GitHub's account list.
- **Then** Opening the panel does not fetch the off-page account's details. Opening the account list fetches that account's details, shows its access switch on, and displays Reconnect required.

## chat-composer-connector-overview-009

Original test `Release the cached subscription on navigation and reload the returning Chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L506).

- **Given** The user has opened the Connectors panel in an existing Chat and loaded Probe 1.
- **When** They navigate to New chat, return to the original Chat using browser back, and reopen the Connectors panel.
- **Then** The connector-change subscription is released while away. Returning to the Chat loads Probe 1 again with a second full overview request and no target refreshes.

## chat-composer-connector-overview-010

Original test `Calibrate custom account changes on focus while keeping ordinary reopenings cached`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx#L544).

- **Given** The user has loaded a custom connector with one account and closed the Connectors panel.
- **When** An account is added externally, the window receives focus, and the user reopens the panel; they then close and reopen it again without another focus event.
- **Then** The first reopening shows two custom accounts and the overview has been fetched twice. The ordinary second reopening still shows two accounts without another overview request.
