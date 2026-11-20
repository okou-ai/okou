# Telegram callback v2

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [telegram-callback-v2.test.tsx](telegram-callback-v2.test.tsx).

## telegram-callback-v2-001

Original test `The v2 tab waits for one real binding, acknowledges duplicates and leaves Works visible`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-callback-v2.test.tsx#L147).

- **Given** A user is on Works with Telegram unconnected and starts a v2 authorization in a new tab.
- **When** The callback bridge becomes ready, sends the identity more than once, and later receives a successful binding response.
- **Then** Only one binding request is made; the connected account appears only after the binding completes. The linked result is sent to the callback origin, duplicate readiness and identity messages are acknowledged or ignored, the result ACK stops further processing, the popup stays open, and the user remains on Works.

## telegram-callback-v2-002

Original test `Native identity can bind first and deliver the owned result when the callback becomes ready later`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-callback-v2.test.tsx#L203).

- **Given** A user starts Telegram authorization and the native identity arrives before the callback bridge is ready.
- **When** The identity is bound successfully, then the callback bridge becomes ready and receives duplicate identity and an ACK.
- **Then** The account becomes connected and the linked result is delivered once the bridge is ready. Only one binding request is made, and the popup remains open.

## telegram-callback-v2-003

Original test `Wrong protocol, operation, product bot, origin and window cannot authorize the active operation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-callback-v2.test.tsx#L231).

- **Given** A user has an active Telegram authorization operation and a callback bridge that is ready.
- **When** Messages arrive with a wrong protocol, operation, bot, origin, window, or malformed identity fields before a valid identity arrives.
- **Then** Only the valid identity authorizes the active operation; one binding request uses its identity and the operation reports linked.

## telegram-callback-v2-004

Original test `Changing the initiating organization stops identity delivery and never binds under the next org`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-callback-v2.test.tsx#L277).

- **Given** A user starts Telegram authorization under one organization and the callback bridge becomes ready.
- **When** The active organization changes before the identity is delivered.
- **Then** The attempt reports interrupted, the Connect control becomes available again, no linked result is reported, and Telegram does not become connected under the next organization.

## telegram-callback-v2-005

Original test `A suspended expired operation rejects late identity and releases its controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-callback-v2.test.tsx#L299).

- **Given** A user starts Telegram authorization and its operation is suspended until more than 120 seconds have elapsed.
- **When** The user sends identity after expiration.
- **Then** The attempt reports interrupted, the Connect control is released, and no linked result is reported.

## telegram-callback-v2-006

Original test `Denial reports cancelled and permits retry without a binding request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-callback-v2.test.tsx#L316).

- **Given** A user starts Telegram authorization and the callback bridge becomes ready.
- **When** Telegram denies authorization and the user acknowledges the result.
- **Then** The attempt reports cancelled, explains that the attempt did not confirm a connection, and makes Connect available for retry without reporting a linked result.

## telegram-callback-v2-007

Original test `An unacknowledged result is repeated on readiness and stops after its correlated result ACK`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-callback-v2.test.tsx#L342).

- **Given** A user starts Telegram authorization and a successful binding produces a linked result that has not yet been acknowledged.
- **When** The user sends an ACK for the wrong operation, signals readiness, then sends the correlated result ACK and signals readiness again.
- **Then** Readiness repeats the unacknowledged result; the wrong-operation ACK does not stop it. After the correlated ACK, readiness and duplicate identity produce no further messages, and the popup remains open.

## telegram-callback-v2-008

Original test `An initiating account change during POST ignores the old server request result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-callback-v2.test.tsx#L373).

- **Given** A user starts Telegram authorization and the identity binding request is in progress under the initiating account.
- **When** The account changes before the server returns success.
- **Then** The old request result is ignored: no linked or cancelled result is reported, and Telegram does not appear connected.

## telegram-callback-v2-009

Original test `An initiating session change during POST ignores the old server request result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-callback-v2.test.tsx#L373).

- **Given** A user starts Telegram authorization and the identity binding request is in progress under the initiating session.
- **When** The session changes before the server returns success, while the account remains the same.
- **Then** The old request result is ignored: no linked or cancelled result is reported, and Telegram does not appear connected.
