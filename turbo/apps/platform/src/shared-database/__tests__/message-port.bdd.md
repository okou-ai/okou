# Message port

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [message-port.test.ts](message-port.test.ts).

## message-port-001

Original test `Report a pending token request before its response and correlate success without leaking credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L304).

- **Given** A registered tab requests a computed value, and token acquisition is pending.
- **When** The token request starts and then succeeds after 25 ms.
- **Then** Telemetry records correlated started and success events with durations of 0 and 25,000,000 ns. Neither event reveals the token, user ID, or organization ID.

## message-port-002

Original test `Correlate token bridge failures without reporting raw error text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L333).

- **Given** A registered tab requests a computed value while token acquisition is pending.
- **When** The token provider rejects with an error containing private text.
- **Then** The read rejects with AggregateError, and telemetry records correlated started and error events without the raw error text.

## message-port-003

Original test `Report token request cancellation when its serving tab disconnects`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L350).

- **Given** A registered tab has a pending token request for a computed read.
- **When** The tab's serving lifecycle ends before the token arrives.
- **Then** The read rejects with AbortError and telemetry records the request as aborted. A later token response does not change that result.

## message-port-004

Original test `Preserve token request success when the telemetry SDK throws Error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L376).

- **Given** A token request is pending and the telemetry SDK throws Error when recording events.
- **When** Token acquisition succeeds.
- **Then** The read still succeeds and telemetry records the request's success outcome.

## message-port-005

Original test `Preserve token request error when the telemetry SDK throws Error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L376).

- **Given** A token request is pending and the telemetry SDK throws Error when recording events.
- **When** The token provider rejects.
- **Then** The read still rejects with AggregateError and telemetry records the request's error outcome.

## message-port-006

Original test `Preserve token request aborted when the telemetry SDK throws Error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L376).

- **Given** A token request is pending and the telemetry SDK throws Error when recording events.
- **When** The serving tab disconnects before the token arrives.
- **Then** The read still rejects with AbortError and telemetry records the request's aborted outcome.

## message-port-007

Original test `Preserve token request success when the telemetry SDK throws AbortError`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L376).

- **Given** A token request is pending and the telemetry SDK throws AbortError when recording events.
- **When** Token acquisition succeeds.
- **Then** The read still succeeds and telemetry records the request's success outcome.

## message-port-008

Original test `Preserve token request error when the telemetry SDK throws AbortError`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L376).

- **Given** A token request is pending and the telemetry SDK throws AbortError when recording events.
- **When** The token provider rejects.
- **Then** The read still rejects with AggregateError and telemetry records the request's error outcome.

## message-port-009

Original test `Preserve token request aborted when the telemetry SDK throws AbortError`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L376).

- **Given** A token request is pending and the telemetry SDK throws AbortError when recording events.
- **When** The serving tab disconnects before the token arrives.
- **Then** The read still rejects with AbortError and telemetry records the request's aborted outcome.

## message-port-010

Original test `Keep foreground presence until the last visible tab hides or disconnects`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L426).

- **Given** Two registered tabs belong to the same user and organization.
- **When** Both become visible, then the first hides, the second hides, the second becomes visible again, and it disconnects.
- **Then** Foreground presence remains while either tab is visible, drops to zero when none is visible, returns when the second becomes visible, and drops again when it disconnects.

## message-port-011

Original test `Forward new user events without registering their names and keep chat reads available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L464).

- **Given** A registered tab subscribes to the unregistered event name newFeature:changed on the user's channel.
- **When** Events arrive on another user's channel, under another event name, and then under the requested name on the correct channel.
- **Then** Only the matching event is forwarded, and a chat-event read still returns its existing row.

## message-port-012

Original test `Forward new org events without registering their names and keep chat reads available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L464).

- **Given** A registered tab subscribes to the unregistered event name newFeature:changed on the organization's channel.
- **When** Events arrive on another organization's channel, under another event name, and then under the requested name on the correct channel.
- **Then** Only the matching event is forwarded, and a chat-event read still returns its existing row.

## message-port-013

Original test `Forward new credential events without registering their names and keep chat reads available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L464).

- **Given** A registered tab subscribes to the unregistered event name newFeature:changed on the user's organization credential channel.
- **When** Events arrive on another credential channel, under another event name, and then under the requested name on the correct channel.
- **Then** Only the matching event is forwarded, and a chat-event read still returns its existing row.

## message-port-014

Original test `share one Worker realtime subscription until tabs disconnect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L523).

- **Given** Two registered tabs subscribe to the same user-channel topic.
- **When** The topic emits an event, the connection suspends and reconnects, then the first tab disconnects and another event arrives.
- **Then** Both tabs receive the first event; a plain resume causes no resync, while reconnect causes one resync per tab. After the first tab disconnects, only the second receives the next event, and the shared subscription ends after the second disconnects.

## message-port-015

Original test `route workspace realtime subscriptions through the organization channel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L607).

- **Given** A registered tab subscribes to presentationTemplatesChanged at organization scope.
- **When** An event is published on its organization's channel.
- **Then** The tab receives the event through that organization channel.

## message-port-016

Original test `preserve a rejected 401 through the port and allow a later query to succeed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L638).

- **Given** A registered tab queries chat events while the API responds with HTTP 401.
- **When** The query is retried after the API begins responding successfully.
- **Then** The first query rejects as a shared-database HTTP error with status 401, and the later query returns the recovered row.

## message-port-017

Original test `preserve upgrade status on query errors across MessagePort`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L673).

- **Given** A registered tab queries a chat snapshot and the API responds with HTTP 426.
- **When** The query result crosses the message port.
- **Then** It rejects as a shared-database HTTP error retaining status 426.

## message-port-018

Original test `preserve API error classification for computed upgrade errors across MessagePort`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L695).

- **Given** A registered tab requests chat-thread indicators and the API responds with HTTP 426 and code REQUEST_FAILED.
- **When** The computed result crosses the message port.
- **Then** It rejects as an API error retaining status 426 and code REQUEST_FAILED.

## message-port-019

Original test `Keep concurrent shared chat loads independent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L713).

- **Given** A registered tab starts chat-event catch-up reads for two different threads, and each API response is delayed independently.
- **When** The second thread's response arrives before the first thread's response.
- **Then** Each read returns its own thread's row, regardless of completion order.

## message-port-020

Original test `Authenticate a shared read with the first successful tab without waiting for its sibling`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L781).

- **Given** Two registered tabs share an indicator read; the first tab's token is delayed and the second tab can provide a token immediately.
- **When** The second tab requests the indicators while the first token request is still pending.
- **Then** The read completes without waiting for the first tab and uses the second tab's bearer token. Both tabs receive token requests.

## message-port-021

Original test `Authenticate a shared read when another token provider rejects first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L822).

- **Given** Two registered tabs share an indicator read; one token provider is pending and the other can provide a token.
- **When** The pending provider rejects before the healthy provider returns its token.
- **Then** The read succeeds using the healthy tab's bearer token.

## message-port-022

Original test `Authenticate a shared read when another token provider disconnects first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L822).

- **Given** Two registered tabs share an indicator read; one token provider is pending and the other can provide a token.
- **When** The pending provider's tab disconnects before the healthy provider returns its token.
- **Then** The read succeeds using the healthy tab's bearer token.

## message-port-023

Original test `Reject a shared read with AggregateError when every tab's token provider fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L898).

- **Given** Two registered tabs share an indicator read, and one token provider rejects while the other is pending.
- **When** The second token provider also rejects.
- **Then** The shared read rejects with AggregateError after every tab's token provider fails.

## message-port-024

Original test `Cancel a shared read waiting for a token without cancelling worker progress`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L942).

- **Given** A registered tab starts a shared indicator read while its token provider is pending.
- **When** The caller cancels the read, then the token arrives and another caller requests indicators.
- **Then** The cancelled caller receives AbortError, while the later read succeeds using the arrived token; cancelling the caller does not stop worker progress.

## message-port-025

Original test `Keep overlapping token broadcasts independent when the later request completes first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L983).

- **Given** A registered tab starts an indicator request and then a computer-use-hosts request, each awaiting a separate token.
- **When** The later hosts token arrives first, followed by the indicators token.
- **Then** The hosts read uses the hosts token and returns an empty list; the indicators read uses its own token and returns the indicators.

## message-port-026

Original test `Cancel one shared chat load without cancelling worker progress`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1033).

- **Given** A registered tab starts a chat-event catch-up read.
- **When** The caller cancels while the API request is pending, then the API response is released.
- **Then** The caller receives AbortError, but the worker retains the loaded row for a later cache-only read and the bridge remains open.

## message-port-027

Original test `Disconnect one tab without interrupting another tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1086).

- **Given** Two tabs are registered.
- **When** The first tab disconnects and the second performs a cache-only read.
- **Then** The first tab's port closes, while the second tab's read succeeds with an empty result and its port remains open.

## message-port-028

Original test `Send a heartbeat immediately after tab registration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1118).

- **Given** A tab is not yet registered with the bridge.
- **When** It registers.
- **Then** The first two messages are registration followed immediately by a heartbeat.

## message-port-029

Original test `Keep sending heartbeats while the tab bridge is active`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1130).

- **Given** A tab registers with an active bridge lifecycle.
- **When** The bridge remains active long enough for repeated heartbeats.
- **Then** At least two heartbeats are sent before the lifecycle ends.

## message-port-030

Original test `Reject shared-data access before the tab is registered`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1156).

- **Given** A tab has not registered with the bridge.
- **When** It attempts a cache-only chat-event query.
- **Then** The query rejects because tab registration is required.

## message-port-031

Original test `Stop pending requests when the bridge lifecycle ends`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1174).

- **Given** A registered tab has a pending chat query and computed read.
- **When** The bridge lifecycle ends before either request completes.
- **Then** Both requests reject with the lifecycle's abort reason, the port closes, and a later computed read rejects with the same reason.

## message-port-032

Original test `Refresh unread indicators after an indicator change without warming messages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1316).

- **Given** A registered tab has unread indicators for an agent and a thread, with an indicator-change subscription active.
- **When** An indicator-change event arrives after the indicators become empty.
- **Then** A later indicator read returns empty agents, threads, and unread timestamps; the event does not warm chat messages.

## message-port-033

Original test `Warm unread chats only after chat message notifications`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1358).

- **Given** A registered tab has unread indicators and chat-message notification subscriptions, with one chat row initially available.
- **When** Indicator-change and read-cursor events arrive, then two chat-message notifications arrive two seconds apart as another row becomes available.
- **Then** The indicator and read-cursor events cause three indicator reloads and no catch-up requests. Each chat-message notification triggers one catch-up, and the cached rows advance from one row to two.

## message-port-034

Original test `Keep indicators readable when message-triggered chat warming fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1438).

- **Given** A registered tab has an unread thread and chat-message notifications; catch-up initially fails with HTTP 500.
- **When** A message notification triggers warming, then a later notification arrives after catch-up recovers and a second row is available.
- **Then** The unread indicators remain readable during the failure, and the later warming makes both rows available in the cache.

## message-port-035

Original test `Throttle detached warming without blocking chat message invalidations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1514).

- **Given** A registered tab receives a chat-message notification that starts a delayed detached warm-up.
- **When** Notifications for two other threads arrive while that warm-up is pending, then the delay passes and warming is released.
- **Then** Both later thread invalidations are delivered without starting parallel requests; only one request is active at a time, and one additional warm-up request runs after release.

## message-port-036

Original test `Keep scopes, topics, and subscriber releases independent on one port`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1600).

- **Given** A user has two subscribers to the same user-scoped topic, another subscriber to that topic in the organization scope, and a subscriber to a different user-scoped topic on one port.
- **When** The first user subscriber is released, then the remaining user subscriber is released and later reacquired.
- **Then** After the first release, notifications reach the second user subscriber, organization subscriber, and different-topic subscriber, but not the released subscriber. Releasing the second removes only that user-topic subscription; the organization and different-topic subscriptions remain. A reacquired subscriber receives a later notification.

## message-port-037

Original test `Ignore a stale subscription attach after cancellation and reacquisition`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1670).

- **Given** A subscriber begins attaching to a realtime topic, but the attach is delayed.
- **When** The subscriber is cancelled and a new subscriber with the same ID starts attaching before the old attach completes; then both attaches complete.
- **Then** The cancelled subscription rejects with an AbortError. Only the new subscriber receives a subsequent notification, and the worker sends one successful subscription reply for the reused ID without an error reply.

## message-port-038

Original test `Deliver an attach failure to every subscriber and permit reacquisition`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1733).

- **Given** Two ports subscribe to the same realtime topic while its shared attach is pending.
- **When** The attach fails, then one port reacquires the subscription.
- **Then** Both subscriptions reject with the attach failure, and the failed topic is no longer subscribed. After reacquisition, a notification reaches the new subscriber.

## message-port-039

Original test `Keep identical subscription keys in separate worker Stores independent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts#L1785).

- **Given** Two separate worker Stores each have a subscriber with the same ID and topic.
- **When** The first worker Store is reset and a notification is sent to the topic.
- **Then** The first worker's signal is aborted and its port closes with no remaining listeners, while the second worker remains active and its subscriber receives the notification. The second worker can still complete a cached chat-data query with an empty result.
