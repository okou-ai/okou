# Pending frozen App scenarios

This is the active register of original frozen cases. Remove an entry after its complete Given/When/Then is accepted or its final upstream disposition is recorded. Tests live in the owning suites. The [68 upstream scenarios](./test-rebuild-upstream-pending.bdd.md) have a separate register.

At migration, the [case snapshot](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/test-rebuild-evidence/101/pending-before-migration.tsv) contained 146 open IDs across 47 frozen owners. Batch 101 had already accepted three of the 149 IDs open at `6d74f80019`. The migration recorded zero acceptances. The six product decisions remain open.

## `src/shared-database/__tests__/message-port.test.ts`

### message-port-011

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-011)

- **Given** A registered tab subscribes to the unregistered event name newFeature:changed on the user's channel.
- **When** Events arrive on another user's channel, under another event name, and then under the requested name on the correct channel.
- **Then** Only the matching event is forwarded, and a chat-event read still returns its existing row.

**Unverified clauses.** Need a supported caller subscribing to newFeature:changed. Wrong user, wrong name, correct delivery and retention of the existing chat row must be tested together. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#message-port-011).

### message-port-030

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-030)

- **Given** A tab has not registered with the bridge.
- **When** It attempts a cache-only chat-event query.
- **Then** The query rejects because tab registration is required.

**Unverified clauses.** An independently registered client entry that can issue cache-only before registration, or a final upstream change replacing that requirement, is needed. [Batch 111 observations](../../../test-rebuild-evidence/111/README.md#message-port-030).

### message-port-036

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-036)

- **Given** A user has two subscribers to the same user-scoped topic, another subscriber to that topic in the organization scope, and a subscriber to a different user-scoped topic on one port.
- **When** The first user subscriber is released, then the remaining user subscriber is released and later reacquired.
- **Then** After the first release, notifications reach the second user subscriber, organization subscriber, and different-topic subscriber, but not the released subscriber. Releasing the second removes only that user-topic subscription; the organization and different-topic subscriptions remain. A reacquired subscriber receives a later notification.

**Unverified clauses.** Need separate production release controls for the two user subscribers on the same port, with the organization and other topic remaining live through release and reacquisition. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#message-port-036).

### message-port-037

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-037)

- **Given** A subscriber begins attaching to a realtime topic, but the attach is delayed.
- **When** The subscriber is cancelled and a new subscriber with the same ID starts attaching before the old attach completes; then both attaches complete.
- **Then** The cancelled subscription rejects with an AbortError. Only the new subscriber receives a subsequent notification, and the worker sends one successful subscription reply for the reused ID without an error reply.

**Unverified clauses.** Need a supported caller that can cancel and reuse its original ID before the attach finishes, with the original rejection and exactly one successful subscription reply observable. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#message-port-037).

### message-port-039

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-039)

- **Given** Two separate worker Stores each have a subscriber with the same ID and topic.
- **When** The first worker Store is reset and a notification is sent to the topic.
- **Then** The first worker's signal is aborted and its port closes with no remaining listeners, while the second worker remains active and its subscriber receives the notification. The second worker can still complete a cached chat-data query with an empty result.

**Unverified clauses.** Need a supported worker reset observable outside the destroyed domain, the same subscriber ID in both domains, proof that the first lost its listeners and the survivor’s own cache-only result. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#message-port-039).

## `src/shared-database/__tests__/platform-direct-bridge.test.ts`

### platform-direct-bridge-002

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/platform-direct-bridge.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/platform-direct-bridge.bdd.md#platform-direct-bridge-002)

- **Given** An authenticated user has one chat event cached locally, and the initial server catch-up request is held pending.
- **When** The user opens the conversation, allows catch-up to return a second event, then a realtime notification exposes a third event.
- **Then** The cached event appears before catch-up completes; afterward the conversation contains events in sequence 1, 2, 3. Catch-up requests use successively increasing cursors without duplicates, and no new request starts after the conversation's lifecycle is reset.

**Pending product decision and unverified clauses.** 离开聊天后的幂等读取可以不改变下一页，飞书回调成功也不能排除额外的目录读取。产品是否要求离页后零读取、回调只读取对应目录项？如需保证，哪项公开诊断能区分两种行为？ 直接连接与 message-port 对照均从同一已保存事件开始，扣住再放行两次增量，三条消息按序可读，离开后新会话可用。重复游标和生命周期结束后的无效读取可以不改变聊天内容。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-94.tsv).

## `src/shared-database/__tests__/single-connection-client.test.ts`

### single-connection-client-001

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/single-connection-client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/single-connection-client.bdd.md#single-connection-client-001)

- **Given** A production app has a configured telemetry token and an authenticated shared-worker bridge.
- **When** The client queries cached chat events after sequence 42 for a private thread.
- **Then** The query succeeds with an empty result and produces one production client-telemetry event identifying a successful cache-only chat-event query. The event includes duration but omits the private thread ID, sequence cursor, and entity-specific resource data.

**Unverified clauses.** Identify a supported caller that sends afterSeqId 42 on its cache-only read and observe the empty result and its own telemetry together. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#single-connection-client-001).

## `src/shared-database/__tests__/worker-runtime.test.ts`

### worker-runtime-005

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.bdd.md#worker-runtime-005)

- **Given** The thread snapshot endpoint returns a presigned object URL whose contents include a stored conversation.
- **When** The runtime catches up on thread metadata and then reads it from cache only.
- **Then** Both reads return the stored conversation as the snapshot with no events.

**Unverified clauses.** Obtain a supported observer of the two result envelopes that can distinguish an empty event list from an event folded into the same title. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#worker-runtime-005).

### worker-runtime-008

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.bdd.md#worker-runtime-008)

- **Given** A batched catch-up request covers two threads, one with no new events and one with a new event.
- **When** The runtime performs the batched chat catch-up.
- **Then** It reports only the thread with new events, and cache-only reads show an empty list for the unchanged thread and the new row for the updated thread.

**Unverified clauses.** The runtime’s changed-thread return list has no identified consumer exposing its membership. Add a caller that distinguishes an unchanged thread incorrectly included in that list. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#worker-runtime-008).

## `src/signals/__tests__/api-client-bootstrap.test.ts`

### api-client-bootstrap-001

Frozen owner: `turbo/apps/platform/src/signals/__tests__/api-client-bootstrap.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/api-client-bootstrap.bdd.md#api-client-bootstrap-001)

- **Given** A matching one-use bootstrap response and a different network response are available for a feature-switch request.
- **When** The client makes three successive requests, with the third carrying an abort signal.
- **Then** The first request returns the bootstrap response without obtaining a token or using the network; the next two return the network response, and the token provider is called once per network request with the corresponding signal.

**Unverified clauses.** Find a public token-provider receipt that identifies each feature-switch request and its signal, including the third request. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#api-client-bootstrap-001).

## `src/signals/__tests__/clerk-user.test.ts`

### clerk-user-006

Frozen owner: `turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/clerk-user.bdd.md#clerk-user-006)

- **Given** Clerk is signed in as user-a, and an owner is initializing user state.
- **When** A reader requests the user value synchronously before owner initialization finishes.
- **Then** The read is a promise the owner can resolve and eventually resolves to user-a.

**Unverified clauses.** Need a public reader whose invocation can be observed before the owner completes and whose own pending result resolves to A. A later user-scoped notification alone cannot discriminate that timing. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#clerk-user-006).

### clerk-user-007

Frozen owner: `turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/clerk-user.bdd.md#clerk-user-007)

- **Given** Clerk user state has settled for user-a under an active owner.
- **When** The owner is replaced, then Clerk emits while the session is transitioning.
- **Then** The last published user value remains available as the same settled promise resolving to user-a; the new event is not observed.

**Unverified clauses.** Need an already-issued public observation preserving the old settled promise itself and its A value through replacement and the transition. The aborted onboarding operation cannot witness that identity. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#clerk-user-007).

## `src/signals/__tests__/realtime.test.ts`

### realtime-002

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-002)

- **Given** A signed-in user has realtime subscriptions routed through the SharedWorker.
- **When** The app subscribes to a user-scoped connector-permission update and the worker receives a matching event.
- **Then** The subscription is registered with the worker, the app handles the event once and completes the wait, and no app-side Ably authentication token is requested. The subscription is removed after completion.

**Unverified clauses.** Need a supported one-shot user-scoped connector-permission subscriber. Observe its first matching event, completion, worker-only authentication and release at the independent provider. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#realtime-002).

### realtime-005

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-005)

- **Given** A signed-in user requests a live update, but the realtime-token service responds with HTTP 500.
- **When** Realtime setup and the pending subscription attempt to connect.
- **Then** Both reject with an Ably connection failure, no live subscription remains, and a later subscription request also rejects with an Ably connection failure.

**Unverified clauses.** Capture all three original Ably connection failures and verify that no live subscription remains at the terminal point through a supported consumer. [Batch 111 observations](../../../test-rebuild-evidence/111/README.md#realtime-005).

### realtime-006

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-006)

- **Given** Realtime is suspended and a subscriber is waiting for a channel attachment.
- **When** The user cancels that subscriber while attachment is pending.
- **Then** The wait rejects with the subscriber’s cancellation reason, and its channel subscription is removed.

**Unverified clauses.** Need the live subscriber's own cancellable wait and its reason, with topic release identifiable independently of full connection teardown. [Batch 111 observations](../../../test-rebuild-evidence/111/README.md#realtime-006).

### realtime-010

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-010)

- **Given** A signed-in user starts a background subscription while the transport is suspended and provides an error callback.
- **When** The channel later reports a terminal “connection failed” error.
- **Then** The callback receives that error, and the channel subscription is removed.

**Unverified clauses.** Use a supported subscriber supplying an observable error callback on the suspended transport. Correlate that exact terminal error with release of its topic. [Batch 111 observations](../../../test-rebuild-evidence/111/README.md#realtime-010).

### realtime-020

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-020)

- **Given** A signed-in user subscribes to chat-thread live updates, but the initial subscription refresh fails.
- **When** Subscription initialization throws an error.
- **Then** The subscription request rejects with the initialization error, but the chat-thread automations live subscription remains active.

**Unverified clauses.** The initiating subscribe caller must expose its initialization rejection. The detail HTTP failure and continued automation update do not expose that rejection. [Batch 111 observations](../../../test-rebuild-evidence/111/README.md#realtime-020).

## `src/signals/__tests__/shared-database-browser.test.ts`

### shared-database-browser-006

Frozen owner: `turbo/apps/platform/src/signals/__tests__/shared-database-browser.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/shared-database-browser.bdd.md#shared-database-browser-006)

- **Given** The browser fails to construct the shared database worker.
- **When** Bridge setup is attempted and a consumer checks its connection.
- **Then** Both operations reject with the original worker-construction error.

**Pending product decision and unverified clauses.** 两名等待者是否都必须收到同一个异常实例？本地选择的已读 UTC 是否需要对外可查？这两项当前分别只能看到页面可用性和已读外观，请分别确认要保留的行为。 Chromium shows the PDF chat and composer with a working SharedWorker and loses them when its constructor throws. The browser outcome does not expose the two original rejected operations or their exception identities. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-95.tsv).

## `src/signals/browser/__tests__/client.test.ts`

### client-001

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-001)

- **Given** A CDP connection is open, but its Browser.getVersion probe receives no response before the 31-second deadline.
- **When** The probe deadline expires and the client makes a Target.getTargets request.
- **Then** The version probe rejects as a read-only protocol failure, while Target.getTargets still succeeds with an empty target list.

**Unverified clauses.** The original version-probe rejection must itself be independently observed as a read-only protocol failure. The successful later read only establishes continued availability. [Batch 111 observations](../../../test-rebuild-evidence/111/README.md#client-001).

### client-002

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-002)

- **Given** A viewer has two pending CDP requests on an open connection to a remote browser.
- **When** The viewer closes and then attempts to notify the browser.
- **Then** Both pending requests reject, and no notification is sent after closing; the remote browser is not closed by this action.

**Unverified clauses.** Need a supported caller retaining both pending promise results and attempting a post-close notification, with the independent remote browser still running. [Batch 111 observations](../../../test-rebuild-evidence/111/README.md#client-002).

### client-003

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-003)

- **Given** A native browser attachment is pending on a CDP connection, with its request associated with the original parent session.
- **When** The operation is cancelled, a later Browser.getVersion request is made, and the attachment response arrives late.
- **Then** The attachment request rejects with AbortError, the connection remains usable, and the late attachment is detached using the original parent session.

**Unverified clauses.** Need an independently cancellable native child with its originating parent kept alive, an observable AbortError, a successful version call on that exact connection and the late detach addressed to the same parent. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#client-003).

### client-004

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-004)

- **Given** Native bridge startup has sent a browser-target attachment request on an open CDP connection.
- **When** Startup is cancelled and the attachment response arrives late.
- **Then** Startup rejects with AbortError, the late native attachment is detached, and the connection remains usable for Browser.getVersion.

**Unverified clauses.** Need a supported bridge-start cancellation independent of connection closure, followed by the original AbortError, late native detach and successful Browser.getVersion on the same peer. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#client-004).

### client-007

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-007)

- **Given** Two Page.navigate requests are pending on one CDP connection, each for a different session and destination.
- **When** The second session's reply arrives before the first session's reply.
- **Then** Each request resolves with its own frame ID: second-frame for the second destination and first-frame for the first.

**Unverified clauses.** Need a supported API that exposes two different sessions on one client and returns each successful frame ID to its original caller, or a Router entry with the same observable results. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#client-007).

### client-008

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-008)

- **Given** A Target.attachToTarget request is pending for the original page on an open CDP connection.
- **When** That request is cancelled, the connection is used for Browser.getVersion, and the late attachment response arrives.
- **Then** The attachment request rejects with AbortError; the late session is detached, and Browser.getVersion succeeds both before and after the late response.

**Unverified clauses.** Need child-only page attach cancellation on a retained original connection, both successful version results around the late response, and independently observed cleanup of that returned session. [Batch 112 observations](../../../test-rebuild-evidence/112/README.md#client-008).

## `src/signals/chat-page/__tests__/unread-through-at.test.ts`

### unread-through-at-001

Frozen owner: `turbo/apps/platform/src/signals/chat-page/__tests__/unread-through-at.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/chat-page/__tests__/unread-through-at.bdd.md#unread-through-at-001)

- **Given** An open thread has a Run terminal marker at 00:07 UTC and another marker at 00:06 UTC.
- **When** The unread-through instant is calculated.
- **Then** The result is the newer Run terminal marker, 2026-03-10T00:07:00Z.

**Pending product decision and unverified clauses.** 两名等待者是否都必须收到同一个异常实例？本地选择的已读 UTC 是否需要对外可查？这两项当前分别只能看到页面可用性和已读外观，请分别确认要保留的行为。 Mark-read takes the thread ID and returns a server timestamp. The page cannot reveal whether the local comparison selected 00:07 over 00:06. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-95.tsv).

## `src/signals/external/__tests__/indexeddb-client.test.ts`

### indexeddb-client-002

Frozen owner: `turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.bdd.md#indexeddb-client-002)

- **Given** Opening a chat database is configured to fail with an InvalidStateError containing a private message.
- **When** The user opens the database and the failure is reported to telemetry.
- **Then** The open rejects with the original error, and an error chat.open event with a numeric duration is recorded without the error message or user and workspace identifiers.

**Unverified clauses.** Find a public consumer that actually returns the open rejection. Compare its reason by object identity while retaining the telemetry privacy assertions. [Batch 111 observations](../../../test-rebuild-evidence/111/README.md#indexeddb-client-002).

### indexeddb-client-003

Frozen owner: `turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.bdd.md#indexeddb-client-003)

- **Given** A user performs a write followed by a read in one read-write IndexedDB transaction, using sensitive record data.
- **When** The transaction is created, executed, and reported to telemetry.
- **Then** The read returns the written value, and separate successful transaction-creation and execution events are recorded for the shared-worker runtime. The execution event reports two requests, and neither event exposes the key or value.

**Unverified clauses.** A production entry that writes and reads the same sensitive record in one read-write transaction must also return that value. The transaction request count cannot establish operation order or the returned object. [Batch 111 observations](../../../test-rebuild-evidence/111/README.md#indexeddb-client-003).

## `src/signals/voice-io/__tests__/voice-draft-audio.test.ts`

### voice-draft-audio-010

Frozen owner: `turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.bdd.md#voice-draft-audio-010)

- **Given** A finished voice draft contains no samples, with no prior samples segmented.
- **When** The next segment is requested.
- **Then** No segment is returned.

**Unverified clauses.** Sent an empty microphone frame through the real recording page. Stop remained absent. A single positive sample enabled Stop. The WAV suite now registers that contrast. No finished zero-sample recording was produced through these controls. Find a supported device termination that completes an empty draft and permits a request for the next segment. [Case review](../../../test-rebuild-evidence/104/README.md#voice-draft-audio-010).

### voice-draft-audio-013

Frozen owner: `turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.bdd.md#voice-draft-audio-013)

- **Given** A voice draft contains 73 seconds of samples after recovery, with a retained checkpoint at 60 seconds.
- **When** The next segment is requested before recording is finished.
- **Then** A non-final segment covers samples 58 through 73 seconds; the retained 60-second checkpoint is not resliced.

**Unverified clauses.** Recorded exactly 60 seconds, navigated away after the fourth live WAV, and reopened the draft. The four live uploads ended at 15, 28, 41 and 54 seconds. Use recording was available without Resume. Its uploads covered 39–54 and 52–60 seconds. The continuous 73-second control has a different non-final 52–67 second window. A supported resume of a retained 60-second checkpoint must emit a non-final 58–73 second WAV. The initial fourth response raced navigation and was requested again on recovery. [Case review](../../../test-rebuild-evidence/104/README.md#voice-draft-audio-013).

## `src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx`

### browser-automatic-recovery-004

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#browser-automatic-recovery-004)

- **Given** The selected tab is recovering after a successful image frame, and revalidation receives a terminal 409 conflict because the assigned window was lost.
- **When** The user reconnects after the unavailable-view state appears.
- **Then** The terminal descriptor error and one final protocol recovery report are preserved in order. Reconnect restores the viewer without adding reports.

**Unverified clauses.** A held recovery image and a terminal assigned-window 409 reached Browser view unavailable. An HTTP response-body observer recorded the conflict before the external reporter received one final protocol recovery report. Manual reconnect restored Ledger input with that report list unchanged. The frozen body requires a separately reported Promise ApiError followed by a Browser report. [Batch 106 review](../../../test-rebuild-evidence/106/README.md#browser-automatic-recovery-004).

## `src/views/browser-session/__tests__/browser-response-deadlines.test.tsx`

### browser-response-deadlines-006

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-006)

- **Given** A replacement browser binding is being fetched while the viewer is concealed.
- **When** The descriptor request exceeds one minute and recovery runs before the held response arrives.
- **Then** Reconnecting is shown, then the replacement page becomes usable and accepts input in its own page session; the late response does not prevent recovery.

**Unverified clauses.** While a replacement descriptor was outstanding, the canvas was outside the viewport and the Router showed Viewing paused. After 60,001 ms both arms still showed Viewing paused without Reconnecting. After revealing the viewer and advancing another four seconds, withholding the old response left input disabled. Delivering the identified stale response and observing its body read allowed the replacement page to receive text. The pending full case requires concealment, timeout recovery and input on that replacement page before the stale reply. [Batch 106 review](../../../test-rebuild-evidence/106/README.md#browser-response-deadlines-006).

### browser-response-deadlines-007

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-007)

- **Given** Native startup is held while the viewer is paused.
- **When** Startup exceeds 30 seconds, then the viewer resumes and the old native setup is released.
- **Then** The failed startup connection is retired, a new startup becomes usable, and input works on the original page using two total connections.

**Unverified clauses.** Startup hello was pending when the document became hidden. The first transport retired after 30,001 ms. After revealing the viewer, the original page session received fresh text on the replacement with exactly two connections. Releasing the old hello did not read its message data on the retired socket. Obtain distinguishable late delivery to the original startup peer, or a final decision about the retired peer. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#browser-response-deadlines-007).

### browser-response-deadlines-022

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-022)

- **Given** The ready viewer disconnects and begins recovery while the page is not paused; recovery paint is held.
- **When** The user navigates to the next chat before releasing the old paint, then waits over one minute and releases it.
- **Then** The replacement page becomes usable and accepts input in its own session; the old recovery does not retire it.

**Unverified clauses.** After visible disconnect, recovery had requested its first image. Navigating to a different chat produced a distinct endpoint and page session. After 61 seconds the old image was released with a unique frame number. The new peer received the text, but no frame acknowledgement identified that old image. Obtain an independent acknowledgement for the identified old frame after visible navigation, or source its final disposal. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#browser-response-deadlines-022).

### browser-response-deadlines-023

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-023)

- **Given** The ready viewer disconnects and begins recovery while the page is not paused; recovery paint is held.
- **When** The page is hidden, then the user navigates to the next chat while paused and makes it visible before releasing the old paint.
- **Then** The replacement page becomes usable and accepts input in its own session after the old paint is released; the old recovery does not retire it.

**Unverified clauses.** Recovery was painting when the document became hidden. The history transition occurred while hidden, then the document became visible before releasing the unique old frame. The replacement peer accepted input. The old capture had no matching frame acknowledgement. Observe late frame handling across the hidden chat transition while independently verifying the selected replacement session. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#browser-response-deadlines-023).

### browser-response-deadlines-039

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-039)

- **Given** The browser's native hello request receives no reply.
- **When** Its deadline expires, the user reconnects, and the late hello reply arrives.
- **Then** The browser view is unavailable and input is disabled until the user explicitly reconnects. The late reply is not replayed; a subsequent new-tab action creates one tab in the original window.

**Unverified clauses.** After 31 seconds without hello the unavailable screen disabled input. Explicit Reconnect restored the original page. After attempting delivery of the old reply, New tab created exactly one blank target in the original window, and it received the typed text. The original socket did not read the late hello. Distinguish actual delivery of the stale hello from sending to a closed socket while reproducing the same single-tab result. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#browser-response-deadlines-039).

### browser-response-deadlines-053

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-053)

- **Given** The browser is ready on one chat, and a native window read is pending.
- **When** The user navigates to another chat before the read deadline, waits past the deadline, and then the old reply arrives.
- **Then** The next chat shows the replacement address and accepts fresh input on its page. No error is reported.

**Unverified clauses.** The user switched chats while the original native window read was outstanding. The replacement address was usable on a different endpoint through the old deadline. Text reached the new page with no recorded report. The original peer did not read the late response body. Observe consumption or final sourced cancellation of that exact outstanding old read after the chat transition. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#browser-response-deadlines-053).

## `src/views/browser-session/__tests__/browser-session-page.test.tsx`

### browser-session-page-025

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-025)

- **Given** A browser connection request is denied because cloud browser authorization is required; a lease request is still pending.
- **When** The user opens the browser page.
- **Then** The authorization message appears within the browser panel. No remote input, “Browser not live,” “Start browser,” or removed-browser placeholder appears.

**Unverified clauses.** #45723 合并初始授权和连接获取，#47114 删除独立 viewer-connection。既有允许/拒绝对照显示，初始拒绝会直接进入授权占位，准入后才有该会话的续租。原 Given 的初始拒绝与已经发出的在途续租仍缺联合证据。 The denied acquisition returns UnauthorizedBrowserSession before the active panel ref is mounted. The heartbeat also checks the mounted session before issuing leaseByThread. A single denied acquisition cannot supply the pending lease in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-session-page-034

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-034)

- **Given** A healthy viewer has an older lease renewal pending when the browser session is reloaded and a new renewal begins.
- **When** The older renewal is denied while the newer renewal is still pending.
- **Then** The current same-window viewer remains enabled, and no authorization-required placeholder appears.

**Unverified clauses.** Batch 71. Same-window reload completed its acquisition and restored usable input while the old renewal was held. At that point the new lease had not arrived. Waiting for it with the older lease unresolved also timed out. Releasing first changes the required order. Reload changes lifetime but the authorizationScope React key survives. The mounted setLoop awaits its old renewal before the next iteration. Batch 71's live old waiter with no new lease agrees with that ordering. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-session-page-035

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-035)

- **Given** A healthy viewer has an older lease pending when chat authorization is revoked and then renewed.
- **When** The renewal attempt is denied while the older lease remains pending.
- **Then** The authorization-required placeholder appears inside the browser panel, and remote input is absent; renewal does not wait for the older lease.

**Unverified clauses.** Batch 71. The new grant reached its lease while the old HTTP handler still waited. The original request signal was already aborted by that transition. A later denial cannot establish independence from a still-live old lease. Revocation replaces the authorizationScope-keyed panel. Unmount aborts the old onRef signal passed to leaseByThread. The other server handler can still run, but the old caller cannot receive its response. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-session-page-036

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-session-page.bdd.md#browser-session-page-036)

- **Given** A healthy shared browser viewer is open, and its initial lease renewal is pending.
- **When** The chat's browser permission is disabled and re-enabled while that renewal is later denied.
- **Then** The viewer is revalidated and remains streaming; its input is temporarily disabled during revalidation, and the stale denial message is not shown.

**Unverified clauses.** Batch 71. The permission change disabled input during the held grant revalidation. The original lease request signal was already aborted before a late denial could be delivered to the viewer. Reauthorization mounts a fresh owner. The old transport is cancelled and throwIfAborted runs before applying the lease. Batch 71 verified the temporary input lock but could not deliver the old denial. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/views/browser-session/__tests__/browser-viewer-binding.test.tsx`

### browser-viewer-binding-002

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-binding.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-binding.bdd.md#browser-viewer-binding-002)

- **Given** The current browser connection is unavailable, and a reconnect will return a fresh viewer binding for a replacement instance.
- **When** The user selects Reconnect while the fresh viewer request is still pending, then the request is released.
- **Then** Before release, the replacement has not connected and remote browser input remains disabled. After release, the replacement page is shown, its sibling window is excluded, and a new tab targets the replacement window. The viewer is requested twice in total.

**Unverified clauses.** The independent Chrome admissions identify transport connections. The provider still supplies the existing viewer binding; the per-acquisition allocation receipt in the original is missing. browserPresent reads the current provider session. confirmBrowserViewer rechecks the existing window binding. Distinct window actions show the destination, but these reads expose no distinct allocation receipt. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-101.tsv).

## `src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx`

### browser-viewer-interaction-088

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-088)

- **Given** A first pause occurs while a capture is in progress and its success reply has not arrived.
- **When** The page becomes hidden and visible again, then the old capture reply arrives and navigation ends.
- **Then** The existing live view and browser session are preserved; the input remains disabled until a replacement capture arrives, then accepts input without reconnecting or stopping the screencast.

**Unverified clauses.** 丢弃旧捕获应答后仍要完成停止确认；新帧到达前输入禁用，之后原远端收到了新输入。保持了原会话，但不能证明冻结所要求的无 stop。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-viewer-interaction-095

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-095)

- **Given** A capture is underway during navigation, with either a first or later visibility pause and a successful or failed capture reply.
- **When** The viewer is hidden and resumed before or after that reply, then the replacement image arrives and the navigation finishes.
- **Then** The existing preview is retained, input stays disabled until the replacement image arrives, and input then works without reconnecting, reporting an unavailable view, attaching another target, or stopping the screencast. A later pause cancels the obsolete capture failure.

**Unverified clauses.** After a previous pause and recovery, began PNG capture during navigation, delivered its navigation failure and paused and resumed again. The remote observed Page.stopScreencast before replacement paint. After acknowledging that stop, the replacement image enabled input on the original session without another stop. The old registration measured stops only from after recovery; the retained Then also requires preservation without stopping screencast. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-viewer-interaction-102

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-102)

- **Given** The user has pressed Shift in the remote browser, and release of that key is pending when the viewer is hidden.
- **When** The viewer resumes and its replacement image arrives before the original key release completes, then the user enters text after the release completes.
- **Then** Input stays disabled until both the original key release and replacement image finish, then accepts text. The remote browser receives the original Shift key-down followed by its key-up.

**Unverified clauses.** The external CDP peer identified the original Shift key-down and withheld key-up. Hiding and resuming left input disabled. While that original key-up was held the peer received no replacement capture. Releasing it admitted the replacement capture and its frame acknowledgement. In the explicit key-up control the original session recorded rawKeyDown, keyUp, keyUp. [Batch 106 review](../../../test-rebuild-evidence/106/README.md#browser-viewer-interaction-102).

### browser-viewer-interaction-122

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-122)

- **Given** The viewer uses a separate image connection, and the control session detaches while Other's image attachment is pending.
- **When** The image attachment completes.
- **Then** The input becomes enabled, and the user can enter a URL and navigate to it.

**Unverified clauses.** The split viewer recovers Other and navigates after its control detach. Running the same test without delivering the held image attachment still enables input and navigates. These outcomes do not establish consumption of the obsolete image attachment. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-viewer-interaction-160

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-160)

- **Given** The selected tab's membership lookup failed and a target-loss confirmation is pending.
- **When** The browser connection is lost before the confirmation returns.
- **Then** The viewer shows Reconnecting; input and the new-tab button remain disabled after the confirmation returns.

**Unverified clauses.** Disconnecting with a pending target-loss confirmation shows Reconnecting and disables both controls. Attempted delivery on the closed peer and withholding the reply yield identical assertions; actual consumption after disconnect remains unproven. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/views/okou-page/__tests__/agent-suggestions.test.tsx`

### agent-suggestions-004

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.bdd.md#agent-suggestions-004)

- **Given** The user is on the homepage, and the For you sidebar entry shows an unread dot.
- **When** The user opens For you while its details request is held pending.
- **Then** The suggestion card appears before the held request is released.

**Unverified clauses.** Show a genuinely cached card on the routed surface before releasing an in-flight replacement, or identify a later decision requiring the loading state. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#agent-suggestions-004).

## `src/views/okou-page/__tests__/chat-capability-voice-recording.test.tsx`

### chat-capability-voice-recording-004

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.bdd.md#chat-capability-voice-recording-004)

- **Given** A restored recording contains 128 completed transcript segments.
- **When** The user chooses the recording when polishing is available.
- **Then** The composer receives all transcript text, grouped into 128 polish segments with one transcript per item; the audio is not retranscribed.

**Unverified clauses.** Registered an independent 128-segment recovery trial at the ordinary 5000 ms suite limit. It supplied microphone PCM and received four transcriptions before timeout. It did not reach the restored editor or 128 polish groups in that registration. The previous long-run proof and short registered recovery control remain distinct. A representative saved 128-segment draft must be obtainable at a supported boundary within the normal suite run. [Case review](../../../test-rebuild-evidence/104/README.md#chat-capability-voice-recording-004).

### chat-capability-voice-recording-005

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.bdd.md#chat-capability-voice-recording-005)

- **Given** A restored recording contains 129 completed transcript segments.
- **When** The user chooses the recording when polishing is available.
- **Then** The composer receives all transcript text, grouped into 65 polish segments with up to two transcripts per item; the audio is not retranscribed.

**Unverified clauses.** The separate 129-segment trial supplied its own microphone capture. It reached four transcription responses before the ordinary 5000 ms limit, before recovery and the expected 65 polish items. The prior full-size supplemental recovery remains historical evidence. A regular registration must exercise the 129-to-65 boundary and detect any retranscription or lost final singleton. [Case review](../../../test-rebuild-evidence/104/README.md#chat-capability-voice-recording-005).

## `src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx`

### chat-continuity-uploads-003

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.bdd.md#chat-continuity-uploads-003)

- **Given** A chat composer is open, and upload preparation returns an absolute private Artifact URL for private.txt.
- **When** The user uploads private.txt and its storage transfer succeeds.
- **Then** The file appears as a removable attachment, and upload completion is requested once for its upload ID.

**Pending product decision and unverified clauses.** 相同 clientEventId 返回同一已准入 run；同一完成上传产生同一文件。验收是否以只产生一个业务产物为准？若需要证明只有一次传输，需要哪种对用户或业务可核验的回执？ The private upload appears and can be removed. On the real API, completing the same upload ID twice produces identical public receipts and the same single catalog entry. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-95.tsv).

## `src/views/okou-page/__tests__/chat-conversation-locator.test.tsx`

### chat-conversation-locator-002

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.bdd.md#chat-conversation-locator-002)

- **Given** An eight-turn conversation has its first question outside the rendered viewport.
- **When** The user selects the first conversation marker.
- **Then** The first question is brought into the viewport at its top edge, and its message receives landing feedback.

**Unverified clauses.** 96e318f041 恢复的 Vitest 30 轮注册在几何替身上覆盖顶边、落点、卸载。原生 Chromium 已证 24 个标记、点击第一问、落点、24/30 卸载，但稳定布局中首问锚点距视口顶边 60px。 #49915 撤回分页，#50032 恢复分页；#50327 是 staff scroll-room 开关，未提供修改精确顶边子句的依据。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv). 第103批用恰好八轮的对话在原生 Chromium 中点选首个标记。720px 与 960px 两种窗口下，首问均从未挂载变为可见且获得落点反馈。滚动稳定后锚点距滚动视口顶部 60px，问题文本距顶部 74px。点第四个标记产生不同的落点。精确顶边子句保留。 [Batch 103 measurements](../../../test-rebuild-evidence/103/locator.json).

## `src/views/okou-page/__tests__/chat-list-optimistic.test.tsx`

### chat-list-optimistic-002

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.bdd.md#chat-list-optimistic-002)

- **Given** A user is composing a new conversation and attaches a QuickTime video named recording.mov; thread creation remains unconfirmed.
- **When** They send the message with the attachment.
- **Then** A preview for recording.mov appears using the video URL with a start time of 0.001 seconds. The missing-thread artifact response produces no visible error toast, and creation remains unconfirmed.

**Unverified clauses.** A pending inline send starts no catalog read. Opening the preview supplies the missing read, but its error is visible. Revisit if the preview handles a missing pending thread or upstream explicitly narrows the guarantee to inline playback. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#chat-list-optimistic-002).

## `src/views/okou-page/__tests__/chat-navigation-browser.test.tsx`

### chat-navigation-browser-011

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-navigation-browser.bdd.md#chat-navigation-browser-011)

- **Given** The Browser begins narrow with Page 12 selected; showing the chat list starts panel and list motions.
- **When** The user navigates away before visibility paint completes, returns, opens the Browser again, and the surviving motions finish in sequence.
- **Then** The old sidebar is removed during navigation, while the chat-list width owner remains. On return, admission stays at two tabs while either motion remains and widens to all 12 only after both finish, with Page 12 selected.

**Unverified clauses.** The extension's active tab field and native tab-activated event remain different from BrowserUse.activeTargetChanged. No new production change or ordinary re-entry provider delivery of Page 12 was identified. The existing two motion orders and manual re-selection controls stand. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-101.tsv).

## `src/views/okou-page/__tests__/chat-scroll.test.tsx`

### chat-scroll-001

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-001)

- **Given** The reader is in history at a narrow viewport, with a message anchored at the current reading position.
- **When** They open and close Automations, revealing the transcript.
- **Then** After the reveal, the anchored message returns to the same screen position with exactly one scroll adjustment.

**Unverified clauses.** At 760 px the history text returned to 263.25 px and offset 4687. Browser animation frames observed 4687 → 0 while hidden and 0 → 4687 on reveal. The scrollTop, scroll, scrollTo and scrollBy observers registered zero application writes during reveal. Two same-frame control scrolls of +22 and −22 were both recorded. Browser visibility restoration and an explicit physical adjustment are distinguishable here. A receiver for compositor changes inside one frame, or an upstream statement defining the count, could resolve the frozen “exactly one.” [Case review](../../../test-rebuild-evidence/104/README.md#chat-scroll-001).

### chat-scroll-005

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-005)

- **Given** The reader is in history with a message anchored before opening Automations.
- **When** A new completed reply arrives while the transcript is hidden, and the reader closes Automations.
- **Then** The original message remains at the same screen position after reveal, with one scroll adjustment.

**Unverified clauses.** Repeated the narrow reveal after the same worker delivered turn 17 behind Automations. The marker was present before close. Offset 4687 and text position 263.25 px returned. Explicit scroll writes during reveal were zero, with one sampled transition and a two-write positive control. The single physical adjustment remains unproved. Preserve the separate completed-reply observation. [Case review](../../../test-rebuild-evidence/104/README.md#chat-scroll-005).

### chat-scroll-006

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-006)

- **Given** The reader is in history on the primary conversation at a narrow viewport, and Automations covers the transcript.
- **When** They Alt-click a side conversation in the chat list, opening it alongside the primary conversation and dismissing Automations.
- **Then** The primary conversation remains at its route with the side conversation selected in the sidebar query, and the empty side conversation shows capability discovery. The original reading anchor is restored; subsequent image growth and incoming replies preserve its screen position without returning to the tail.

**Unverified clauses.** At 930 px, Alt-click selected Side survey alongside the original route and exposed discovery. The same primary text moved from y=469.25 to y=318.5 on opening the side panel. The pending and decoded Mermaid card above it measured 219 × 164.25 px in both controls. The receiver accepted the new reply, but the side layout did not expose marker 17. Repeat if a production image can change its flow height in this side layout or the side-panel width/anchor restoration changes. [Batch 105](../../../test-rebuild-evidence/105/README.md#chat-scroll-006).

### chat-scroll-008

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-008)

- **Given** The reader reaches the tail, changes the live scroll offset to 275, and opens Automations at a narrow viewport.
- **When** A new reply containing a Mermaid diagram begins asynchronous image preparation, and the reader closes Automations before preparation finishes.
- **Then** The oldest message at the captured reading position remains at the same screen position while preparation is pending and after the diagram image is ready; the reader is not forced to the tail.

**Unverified clauses.** At scrollTop 275, the oldest visible line (Turn 1, observation 2, event ending 000002) was at y=59.25 before and after closing Automations. A second reference, Question number 2, was at y=296. The new reply was received under the panel. Its image receiver saw zero requests while covered and after reveal. The first request arrived after scrolling to the tail, when the original text had left the mounted window; withholding and decoding then produced the same 420 × 315 px card. Use an entry that starts preparation before closing Automations while the same oldest text is still measurable. [Batch 105](../../../test-rebuild-evidence/105/README.md#chat-scroll-008).

### chat-scroll-017

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-017)

- **Given** The reader is in history in standalone PWA mode with a multiline draft in the composer.
- **When** They focus the composer through three keyboard-viewport shrink, pan, and restore cycles, then resize the layout viewport.
- **Then** The same message remains at the same reading position throughout, and the focused composer retains both draft lines through the keyboard cycles.

**Unverified clauses.** Focused a two-line draft and ran three shrink/restore cycles in Chromium. Desktop layout resizing retained the reference. A PWA installation and launch succeeded, but the observed target reported standalone=false and no independent keyboard pan. Separately, a routed standalone VisualViewport fixture with distinct resize and pan inputs moved the text from 65 to −265 px. Use a standalone target that reports its display mode and a real nonzero visualViewport.offsetTop during keyboard use. Keep the existing tail regression separate. [Case review](../../../test-rebuild-evidence/104/README.md#chat-scroll-017).

### chat-scroll-018

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-018)

- **Given** The reader is at the tail of a completed conversation with an empty composer.
- **When** They open Research from the Add menu, then close the capability tray.
- **Then** The transcript remains at the tail while the tray reduces its viewport height by 120 pixels and after it closes; the composer remains empty and the conversation route does not change.

**Unverified clauses.** From a completed conversation at the tail, clicked Add, Research and Remove Research. Transcript heights were 561 → 201 → 561 px. Distance to the bottom stayed zero, the route stayed put, and the composer stayed empty. The measured reduction was 360 px. Revisit an actual 120 px tray layout or an upstream decision superseding that dimension. [Case review](../../../test-rebuild-evidence/104/README.md#chat-scroll-018).

### chat-scroll-019

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-019)

- **Given** The reader is in history in a stopped conversation with an empty composer.
- **When** They open Research from the Add menu, then close the capability tray.
- **Then** The same message remains at the same reading position while the tray reduces its viewport height by 120 pixels and after it closes; the composer remains empty and the conversation route does not change.

**Unverified clauses.** Delivered a terminal run.cancelled row and opened Research from history with an empty composer. The same text stayed at 249.25 px and scrollTop at 4701 through opening and removal. Heights were 561 → 201 → 561 px, with the route unchanged. The measured reduction was 360 px. A stopped conversation with a 120 px reduction, or a documented replacement for that contract, would settle this case. [Case review](../../../test-rebuild-evidence/104/README.md#chat-scroll-019).

### chat-scroll-020

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-020)

- **Given** The reader is in history with a visible message anchored in the transcript.
- **When** A late-loaded image above the messages increases content height by 75 pixels.
- **Then** The anchored message remains at the same screen position.

**Unverified clauses.** Chromium rendered a normal Markdown image and a linked Markdown image above the same visible event. In each trial the decoded natural height went from 0 to 75 px. The message image frame stayed 200 × 180 px at y = −81.25, and the text in event …0038 stayed at y = 427.75. The earlier Mermaid frame measured 420 × 315. Upstream #48209 removed the unsized transcript fallback and #49924 changed post-render alignment. Neither supplies a 75 px increase at these entries. [Batch 106 review](../../../test-rebuild-evidence/106/README.md#chat-scroll-020).

### chat-scroll-023

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-023)

- **Given** The reader is in history with a visible message anchored in the transcript.
- **When** Two completed replies arrive in succession.
- **Then** Both new replies become visible while the original anchor remains at the same screen position.

**Unverified clauses.** Delivered two completed turns through separate catch-up responses. The locator showed 17 then 18 turns. At both arrivals the original text was at 263.25 px. The replies were mounted at 1507.75 and 1789.25 px, below the transcript bottom at 609 px. Both were readable after scrolling to the tail. A layout or presentation change must make both arriving replies visible in the viewport while preserving the history anchor. [Case review](../../../test-rebuild-evidence/104/README.md#chat-scroll-023).

### chat-scroll-024

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-024)

- **Given** The reader is near the top of a loaded history window, and the sixth question is not yet displayed.
- **When** Older messages load as the reader scrolls.
- **Then** The sixth question becomes visible and the previously visible anchor stays at the same screen position.

**Unverified clauses.** Started from sixteen completed turns with question 6 unmounted. On a wheel event at scrollTop 4036, event …0038, “Turn 13, observation 3.” was at 448.75 px. When the older local page mounted and layout settled at 4680, the same text was still at 448.75 px. Question 6 was offscreen until another wheel reached 2336. With shorter earlier turns and a 1600 px browser height, a single wheel made question 6 visible, but question 9 moved from 1031 to 1019 px. A separate 51 px wheel moved the same control text from 84.25 to 135.25 px. The same delivery must show question 6 in the viewport while the pre-delivery event and text retain their screen coordinate. Recheck a change to native anchor compensation or page measurement. [Case review](../../../test-rebuild-evidence/104/README.md#chat-scroll-024).

### chat-scroll-025

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-025)

- **Given** The reader is viewing the latest history window, with earlier groups not yet loaded.
- **When** They scroll near the top, away from it, and stop near the top again.
- **Then** The sixth question loads once and the original visible anchor stays at the same screen position; the fourth question remains absent.

**Unverified clauses.** Drove near, away, then near again with trusted wheels. Question 6 mounted, unmounted, and mounted again. Question 4 stayed absent. The reference retained its position across each local layout. Repeating with the next wheel issued at the observed scroll event also produced two mounts. Look for a change to page retention or a continuous gesture with a single independently observed mount and the same pre-delivery text position. [Case review](../../../test-rebuild-evidence/104/README.md#chat-scroll-025).

## `src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx`

### composer-custom-template-recommendations-009

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.bdd.md#composer-custom-template-recommendations-009)

- **Given** The user has a draft in the Image composer and opens the Image shelf.
- **When** They paste an unsupported PDF, then import a valid WEBP image as a reusable style.
- **Then** The PDF is not attached and does not send a message; the draft remains and an Image removal control is present. The WEBP starts a reusable-template analysis and publish message containing the file, without selecting a generation template, and navigates to a chat.

**Unverified clauses.** The unsupported clipboard PDF must be rejected on paste, or a sourced disposition must explicitly allow it on this path. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#composer-custom-template-recommendations-009).

## `src/views/okou-page/__tests__/connector-directory.test.tsx`

### connector-directory-010

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.bdd.md#connector-directory-010)

- **Given** The connector catalog contains Gmail, which supports provider authorization.
- **When** The user tabs to Connect Gmail and presses Enter.
- **Then** One authorization window opens at the Gmail authorization URL and one OAuth connection request is made. Closing the dialog closes the authorization window.

**Unverified clauses.** Revisit on a browser ownership change that couples directory dismissal to the native handle. Use both callback orderings. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#connector-directory-010).

## `src/views/okou-page/__tests__/connector-provider-pages.test.tsx`

### connector-provider-pages-013

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.bdd.md#connector-provider-pages-013)

- **Given** An unauthenticated user returns from Feishu OAuth with code oauth-code and state oauth-state.
- **When** The callback succeeds with a redirect URL to open the connected bot.
- **Then** The page shows “Connecting Feishu…” with the Feishu icon and navigates to the returned bot URL. The callback includes the code, state, and JSON response mode, and the page reads only the Feishu catalog entry.

**Pending product decision and unverified clauses.** 离开聊天后的幂等读取可以不改变下一页，飞书回调成功也不能排除额外的目录读取。产品是否要求离页后零读取、回调只读取对应目录项？如需保证，哪项公开诊断能区分两种行为？ Feishu branding, icon, callback code, state and JSON mode precede navigation to the bot URL. These outcomes cannot exclude reads for other catalog entries. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-95.tsv).

## `src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx`

### connectors-account-rename-focus-011

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.bdd.md#connectors-account-rename-focus-011)

- **Given** A user saves a GitHub account rename while its response is delayed.
- **When** They close the manager, move focus elsewhere, and the rename response arrives.
- **Then** Focus stays outside the closed manager, which remains closed. Reopening it shows the renamed account and no active rename input.

**Unverified clauses.** A supported manager lifetime that receives the original delayed response after dismissal could distinguish late delivery from an aborted caller. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#connectors-account-rename-focus-011).

### connectors-account-rename-focus-013

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.bdd.md#connectors-account-rename-focus-013)

- **Given** A user saves a rename with a delayed response, closes the manager, reopens it, and starts editing Work 2 as “Work 2 new.”
- **When** The older rename response arrives while the new edit is active.
- **Then** The new input retains focus and its draft; the user can extend and save it as “Work 2 new draft,” after which focus is on that account’s actions.

**Unverified clauses.** The original response must actually reach a caller while the second edit is active, or upstream must specify cancellation as the final disposition. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#connectors-account-rename-focus-013).

## `src/views/okou-page/__tests__/directed-connect-page.test.tsx`

### directed-connect-page-008

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.bdd.md#directed-connect-page-008)

- **Given** The user opens a directed Stripe connection link from a chat, with an agent ID and callback prompt; Stripe requires no authentication.
- **When** The user connects Stripe.
- **Then** Stripe connects once, the originating chat receives the callback prompt, and no visible agent-authorization update is made. No connection dialog remains open.

**Unverified clauses.** A supported no-auth Stripe catalog entry or an explicit Stripe-specific migration of that original precondition is still needed. The authenticated continuation covers the remaining visible steps. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#directed-connect-page-008).

## `src/views/okou-page/__tests__/integrations-discord.test.tsx`

### integrations-discord-037

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.bdd.md#integrations-discord-037)

- **Given** Discord is disconnected, and the user leaves Works for Chat while Discord status refresh is pending.
- **When** The user returns to Works before the refresh completes.
- **Then** The Discord card continues to show its description and an enabled Connect button; after refresh it shows Connected.

**Unverified clauses.** The pre-departure refresh must preserve the disconnected button through the second mount, or upstream must explicitly replace that rule. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#integrations-discord-037).

### integrations-discord-038

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.bdd.md#integrations-discord-038)

- **Given** Discord is connected, and the user leaves Works for Chat while Discord status refresh is pending.
- **When** The user returns to Works before the refresh completes.
- **Then** The Discord card continues to show its description and Connected status; after refresh it still shows Connected.

**Unverified clauses.** Observe Connected throughout the original order, or find a production disposition for discarding the cached status on remount. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#integrations-discord-038).

## `src/views/okou-page/__tests__/paid-media-creation.test.tsx`

### paid-media-creation-002

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/paid-media-creation.bdd.md#paid-media-creation-002)

- **Given** The user explicitly selects image creation while image generation is disabled, and a model is available for running prompts.
- **When** They open settings, enable image generation, close settings, and send an image prompt.
- **Then** The disabled notice clears after the confirmed setting change, and one run prompt is submitted.

**Pending product decision and unverified clauses.** 相同 clientEventId 返回同一已准入 run；同一完成上传产生同一文件。验收是否以只产生一个业务产物为准？若需要证明只有一次传输，需要哪种对用户或业务可核验的回执？ The image tool can be enabled and its prompt reaches the chat. Replaying an identical threadId/clientEventId at the production API preserves the public input and admitted run. The business record cannot distinguish one submission from two. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-95.tsv).

## `src/views/okou-page/__tests__/settings-model-loading.test.tsx`

### settings-model-loading-001

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/settings-model-loading.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/settings-model-loading.bdd.md#settings-model-loading-001)

- **Given** Model settings have loaded and the Connect account control is enabled, while subsequent billing and subscription responses are pending.
- **When** The user switches to Preference and then returns to Models.
- **Then** The Models heading and the no-accounts-connected message appear, and Connect account remains enabled.

**Unverified clauses.** Revisit when the returned Models panel can retain its no-accounts state and enabled Connect while both requests remain outstanding. [Batch 110 observations](../../../test-rebuild-evidence/110/README.md#settings-model-loading-001).
