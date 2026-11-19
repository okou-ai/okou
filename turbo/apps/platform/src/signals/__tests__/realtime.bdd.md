# Realtime

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [realtime.test.ts](realtime.test.ts).

## realtime-001

Original test `A session output channel detaches after its final subscriber and can be reacquired`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L111).

- **Given** Two subscribers listen for output on the same session channel.
- **When** The user cancels the first subscriber, sends an event, cancels the second subscriber, and then subscribes again and sends another event.
- **Then** The channel remains active after the first cancellation and the remaining subscriber receives the event. After the second cancellation the channel detaches; it can be reacquired, and the new subscriber receives the next event.

## realtime-002

Original test `Route app subscriptions through the SharedWorker without an App Ably client`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L237).

- **Given** A signed-in user has realtime subscriptions routed through the SharedWorker.
- **When** The app subscribes to a user-scoped connector-permission update and the worker receives a matching event.
- **Then** The subscription is registered with the worker, the app handles the event once and completes the wait, and no app-side Ably authentication token is requested. The subscription is removed after completion.

## realtime-003

Original test `A pending live-update listener starts after realtime connects`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L265).

- **Given** A signed-in user requests a connector-permission live update before realtime has connected.
- **When** Realtime setup completes and the matching event arrives.
- **Then** The pending subscription becomes active, the event runs its handler once, and the completed subscription is removed.

## realtime-004

Original test `Workspace live updates stay in the active workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L296).

- **Given** A signed-in user requests an organization-scoped run-queue update while an organization is active.
- **When** Realtime connects and a matching event arrives on the active organization’s channel.
- **Then** The handler runs once on the active organization channel; no subscription is made on the user channel.

## realtime-005

Original test `Realtime authentication failure does not leave stale live updates`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L330).

- **Given** A signed-in user requests a live update, but the realtime-token service responds with HTTP 500.
- **When** Realtime setup and the pending subscription attempt to connect.
- **Then** Both reject with an Ably connection failure, no live subscription remains, and a later subscription request also rejects with an Ably connection failure.

## realtime-006

Original test `Cancelling a subscriber releases its pending channel attach wait`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L367).

- **Given** Realtime is suspended and a subscriber is waiting for a channel attachment.
- **When** The user cancels that subscriber while attachment is pending.
- **Then** The wait rejects with the subscriber’s cancellation reason, and its channel subscription is removed.

## realtime-007

Original test `Live updates remain usable after the transport reconnects`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L387).

- **Given** A signed-in user has an active live-update subscription whose handler continues listening after each event.
- **When** An event arrives, the transport reconnects, and another event arrives.
- **Then** The handler runs once for each event, including the event after reconnection.

## realtime-008

Original test `A subscription created while the connection is suspended still starts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L421).

- **Given** A signed-in user’s realtime transport is suspended before a live-update subscription is created.
- **When** The transport reconnects and the matching event arrives.
- **Then** The subscription remains available through the suspended period and its handler runs once after reconnection.

## realtime-009

Original test `Subscription initialization runs only after the channel attaches`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L457).

- **Given** A signed-in user creates a payload subscription while realtime is suspended, with an initialization command.
- **When** The transport reconnects and the channel attaches.
- **Then** Initialization does not run before attachment and runs once after the channel attaches.

## realtime-010

Original test `A background subscription reports a terminal channel failure after returning`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L497).

- **Given** A signed-in user starts a background subscription while the transport is suspended and provides an error callback.
- **When** The channel later reports a terminal “connection failed” error.
- **Then** The callback receives that error, and the channel subscription is removed.

## realtime-011

Original test `Payload initialization with runOnSubscribe=undefined retains events and gap recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L522).

- **Given** A signed-in user creates a payload subscription with `runOnSubscribe` omitted.
- **When** The subscription receives a payload, then the transport disconnects and reconnects.
- **Then** Initialization runs once on subscription and once after reconnection; the payload is handled, and the continuity gap triggers recovery.

## realtime-012

Original test `Payload initialization with runOnSubscribe=true retains events and gap recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L522).

- **Given** A signed-in user creates a payload subscription with `runOnSubscribe` set to true.
- **When** The subscription receives a payload, then the transport disconnects and reconnects.
- **Then** Initialization runs once on subscription and once after reconnection; the payload is handled, and the continuity gap triggers recovery.

## realtime-013

Original test `Payload initialization with runOnSubscribe=false retains events and gap recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L522).

- **Given** A signed-in user creates a payload subscription with `runOnSubscribe` set to false.
- **When** The subscription receives a payload, then the transport disconnects and reconnects.
- **Then** Initialization does not run on subscription but runs once after reconnection to recover the continuity gap. The payload is handled.

## realtime-014

Original test `A continuity gap pokes a topic loop`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L572).

- **Given** A signed-in user has a live topic loop configured to run once when subscribed.
- **When** The realtime transport disconnects and reconnects, creating a continuity gap.
- **Then** The topic loop runs again to recover from the gap.

## realtime-015

Original test `An update arriving during processing is not lost`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L602).

- **Given** A signed-in user’s first live-update handler is still processing an event.
- **When** A second event arrives before the first handler finishes.
- **Then** The second update is not lost: the first handler completes, the second runs, and the wait resolves after two runs.

## realtime-016

Original test `Payload updates received during subscription initialization are applied`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L642).

- **Given** A signed-in user has a payload subscription whose initialization is still running.
- **When** A payload arrives during initialization and initialization then finishes.
- **Then** The payload is applied after initialization completes.

## realtime-017

Original test `A permanently bad live update does not block later updates`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L682).

- **Given** A signed-in user has a payload handler that permanently fails for poison updates and completes on a valid update.
- **When** Two poison updates arrive, followed by a valid update.
- **Then** Each poison update is attempted once without blocking the later update. The valid update is handled, and the wait completes.

## realtime-018

Original test `A failed live update waits for the next update`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L722).

- **Given** A signed-in user has a live-update handler that fails on its first run and succeeds on its next run.
- **When** An update arrives, then a later update arrives after the failure.
- **Then** The first failure does not complete the wait or trigger an automatic retry. The next update runs the handler successfully and completes the wait.

## realtime-019

Original test `Chat thread notifications invalidate their matching resources`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L758).

- **Given** A signed-in user is subscribed to realtime notifications for a chat thread, including thread detail and automation invalidations.
- **When** A thread-detail notification arrives, followed by an automation notification for that thread.
- **Then** The first notification invalidates thread detail and connector preference resources. The second also invalidates automations.

## realtime-020

Original test `An initial refresh failure does not destroy live subscriptions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/realtime.test.ts#L817).

- **Given** A signed-in user subscribes to chat-thread live updates, but the initial subscription refresh fails.
- **When** Subscription initialization throws an error.
- **Then** The subscription request rejects with the initialization error, but the chat-thread automations live subscription remains active.
