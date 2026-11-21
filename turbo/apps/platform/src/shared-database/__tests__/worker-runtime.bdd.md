# Worker runtime

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [worker-runtime.test.ts](worker-runtime.test.ts).

## worker-runtime-001

Original test `treat a headerless 426 from chat event rows as an upgrade request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L165).

- **Given** A chat event-rows request receives HTTP 426 with a client-upgrade-required error but no upgrade header.
- **When** The worker queries chat events for catch-up.
- **Then** The query rejects with an HTTP error of status 426, and the worker reports that a client upgrade is required.

## worker-runtime-002

Original test `Keep cached chat data isolated by user and workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L198).

- **Given** Two runtimes use the same user and thread but different workspaces, and each has fetched distinct chat rows.
- **When** Each runtime reads that thread from its local cache.
- **Then** Each runtime returns only the rows fetched for its own workspace.

## worker-runtime-003

Original test `Read locally cached chat data without the network`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L249).

- **Given** The local cache is empty and the network endpoints are available.
- **When** The runtime reads chat rows and thread metadata with cache-only consistency.
- **Then** It returns empty cached results for both, without making any network requests.

## worker-runtime-004

Original test `Load complete chat history across a snapshot boundary`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L295).

- **Given** A chat snapshot contains an event at sequence 2, with a later event at sequence 3.
- **When** The runtime catches up from the beginning, then reads after sequence 2 from cache only.
- **Then** The first read returns both events and requests tails after sequences 2 and 3; the cache-only read returns only the sequence-3 event without further network requests.

## worker-runtime-005

Original test `Load a chat thread snapshot from its presigned object URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L345).

- **Given** The thread snapshot endpoint returns a presigned object URL whose contents include a stored conversation.
- **When** The runtime catches up on thread metadata and then reads it from cache only.
- **Then** Both reads return the stored conversation as the snapshot with no events.

## worker-runtime-006

Original test `Preserve a future run failure reason from snapshot storage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L383).

- **Given** A presigned chat snapshot contains a run-failed event with failure reason "provider_model_retired".
- **When** The runtime loads the snapshot and then reads the data from cache only.
- **Then** Both reads preserve and return the event with its original failure reason and payload.

## worker-runtime-007

Original test `Rebuild chat data after its saved cursor expires`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L432).

- **Given** The runtime has cached chat rows and thread metadata, and both saved event cursors later expire with HTTP 410.
- **When** It catches up using the expired cursors.
- **Then** It fetches fresh snapshots and returns the rebuilt chat row at sequence 10 plus its tail at sequence 11; for thread metadata it returns the refreshed snapshot and the current event at sequence 11.

## worker-runtime-008

Original test `Report only non-empty tails from a batched chat catch-up`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L575).

- **Given** A batched catch-up request covers two threads, one with no new events and one with a new event.
- **When** The runtime performs the batched chat catch-up.
- **Then** It reports only the thread with new events, and cache-only reads show an empty list for the unchanged thread and the new row for the updated thread.

## worker-runtime-009

Original test `Rebuild a cached chat when batched catch-up cannot continue its cursor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L616).

- **Given** A chat thread has a cached row at sequence 1, and batched catch-up reports that the thread was not found.
- **When** The runtime catches up that thread after its saved cursor can no longer continue.
- **Then** It reports the thread for rebuilding and replaces the cache with the snapshot row at sequence 10 and tail row at sequence 11.

## worker-runtime-010

Original test `Serve remote chat data without Sentry reports when IndexedDB write transactions fail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L676).

- **Given** Local IndexedDB write transactions fail, while remote chat rows and thread metadata are available.
- **When** The runtime catches up, then a later chat-row request receives HTTP 500.
- **Then** It returns the remote rows and metadata without reporting the local write failure to Sentry; the remote HTTP 500 rejects and is reported to Sentry as an exception.

## worker-runtime-011

Original test `Continue online when local chat storage becomes unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L755).

- **Given** The worker's chat database version changes while a runtime is active, making local chat storage unavailable.
- **When** The runtime fetches chat rows online and then reads them from cache only.
- **Then** The online read returns the remote row, the cache-only read is empty, and no Sentry reports are recorded.

## worker-runtime-012

Original test `Project metadata recovers an expired cursor, reopens offline and stays owner scoped`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts#L811).

- **Given** A project snapshot initially has the name "Launch" at sequence 1; a later refresh has the name "New name" at sequence 5, and the old event cursor expires.
- **When** The owner refreshes project metadata, reopens a runtime offline, and a different user checks the cache.
- **Then** The owner receives the refreshed name, the reopened owner runtime reads cached metadata at sequence 5, and the other user sees no cached snapshot or events.
