# Single connection client

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [single-connection-client.test.ts](single-connection-client.test.ts).

## single-connection-client-001

Original test `Reports production shared worker queries without entity identifiers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/single-connection-client.test.ts#L134).

- **Given** A production app has a configured telemetry token and an authenticated shared-worker bridge.
- **When** The client queries cached chat events after sequence 42 for a private thread.
- **Then** The query succeeds with an empty result and produces one production client-telemetry event identifying a successful cache-only chat-event query. The event includes duration but omits the private thread ID, sequence cursor, and entity-specific resource data.

## single-connection-client-002

Original test `Does not report preview shared worker queries`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/single-connection-client.test.ts#L176).

- **Given** A preview app has a configured telemetry token and an authenticated shared-worker bridge.
- **When** The client performs a cached chat-event query.
- **Then** The query succeeds with an empty result, and no telemetry event is reported.

## single-connection-client-003

Original test `Does not report shared worker queries without a token`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/single-connection-client.test.ts#L189).

- **Given** A production app has no telemetry token and an authenticated shared-worker bridge.
- **When** The client performs a cached chat-event query.
- **Then** The query succeeds with an empty result, and no telemetry event is reported.
