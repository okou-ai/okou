# Indexeddb client

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [indexeddb-client.test.ts](indexeddb-client.test.ts).

## indexeddb-client-001

Original test `Reports a physical chat database open without credential identifiers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.test.ts#L95). · **intent review**

- **Given** A chat database is opened for a user and workspace with sensitive identifiers.
- **When** The successful open is reported to client telemetry.
- **Then** A successful window-runtime chat.open event is recorded with a numeric duration, and neither identifier appears in the event.

## indexeddb-client-002

Original test `Reports a failed chat database open without hiding its error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.test.ts#L124). · **intent review**

- **Given** Opening a chat database is configured to fail with an InvalidStateError containing a private message.
- **When** The user opens the database and the failure is reported to telemetry.
- **Then** The open rejects with the original error, and an error chat.open event with a numeric duration is recorded without the error message or user and workspace identifiers.

## indexeddb-client-003

Original test `Reports separate creation and execution events for an IndexedDB transaction`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.test.ts#L157). · **intent review**

- **Given** A user performs a write followed by a read in one read-write IndexedDB transaction, using sensitive record data.
- **When** The transaction is created, executed, and reported to telemetry.
- **Then** The read returns the written value, and separate successful transaction-creation and execution events are recorded for the shared-worker runtime. The execution event reports two requests, and neither event exposes the key or value.

## indexeddb-client-004

Original test `Reports an aborted IndexedDB transaction without hiding its error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.test.ts#L229). · **intent review**

- **Given** A read-write IndexedDB transaction is created successfully for a voice-drafts database.
- **When** Its single write request is aborted during execution.
- **Then** The request rejects with AbortError. Telemetry records successful transaction creation and an aborted execution with one request, without a status code on the execution event.

## indexeddb-client-005

Original test `Reports a synchronous IndexedDB transaction creation failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.test.ts#L280). · **intent review**

- **Given** Creating a read-only IndexedDB transaction synchronously throws an InvalidStateError.
- **When** The transaction operation is attempted and reported to telemetry.
- **Then** The operation rejects with the original error, execution does not start, and an error transaction-creation event is recorded without the private error message.

## indexeddb-client-006

Original test `Reports typed API requests with route templates and no parameters`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.test.ts#L320). · **intent review**

- **Given** An authenticated client has a private token and requests chat event rows for a private thread with a limit of 50 and since-sequence ID 0.
- **When** The successful API request is reported to telemetry.
- **Then** A successful window-runtime GET event uses the route template /api/chat-threads/:threadId/event-rows and reports HTTP 200. The event contains neither the thread ID, token, nor query parameter name sinceSeqId.

## indexeddb-client-007

Original test `Reports API server failures as RED errors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.test.ts#L369). · **intent review**

- **Given** The feature-switches API returns HTTP 500 with an internal server error.
- **When** The authenticated client requests feature switches and the result is reported to telemetry.
- **Then** The request resolves with status 500, and telemetry records an error event for GET /api/feature-switches with HTTP status 500.
