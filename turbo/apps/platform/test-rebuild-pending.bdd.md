# Pending frozen App scenarios

This is the active register of original frozen cases. Remove an entry after its complete Given/When/Then is accepted or its final upstream disposition is recorded. Tests live in the owning suites. The [68 upstream scenarios](./test-rebuild-upstream-pending.bdd.md) have a separate register.

At migration, the [case snapshot](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/test-rebuild-evidence/101/pending-before-migration.tsv) contained 146 open IDs across 47 frozen owners. Batch 101 had already accepted three of the 149 IDs open at `6d74f80019`. The migration recorded zero acceptances. The six product decisions remain open.

## `src/shared-database/__tests__/message-port.test.ts`

### message-port-011

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-011)

- **Given** A registered tab subscribes to the unregistered event name newFeature:changed on the user's channel.
- **When** Events arrive on another user's channel, under another event name, and then under the requested name on the correct channel.
- **Then** Only the matching event is forwarded, and a chat-event read still returns its existing row.

**Unverified clauses.** 通过实际用户频道的浏览器请求主题和私有聊天观察匹配与不匹配的通知。没有用户入口订阅冻结的任意 newFeature:changed 主题，未能证明按用户及名称过滤后仍读回原事件。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-014

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-014)

- **Given** Two registered tabs subscribe to the same user-channel topic.
- **When** The topic emits an event, the connection suspends and reconnects, then the first tab disconnects and another event arrives.
- **Then** Both tabs receive the first event; a plain resume causes no resync, while reconnect causes one resync per tab. After the first tab disconnects, only the second receives the next event, and the shared subscription ends after the second disconnects.

**Unverified clauses.** Two already-open Chromium template shelves subscribed to the same user topic. Both windows displayed the new card before the resume control began. That resume produced no page catalog read. The continuity gap produced one read in A and one in B. Only B read the second, empty catalog after A closed and B lost the card. The provider did not record the final topic unsubscribe after B closed. Obtain an independent final topic-removal receipt after B disconnects, while retaining this per-window continuity control. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#message-port-014).

### message-port-017

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-017)

- **Given** A registered tab queries a chat snapshot and the API responds with HTTP 426.
- **When** The query result crosses the message port.
- **Then** It rejects as a shared-database HTTP error retaining status 426.

**Unverified clauses.** A held snapshot denial produces the required-update dialog. SharedDatabaseHttpError and its status were visible in an internal port reply only. The Router readiness promise for this Workflows route does not expose the snapshot read. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-018

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-018)

- **Given** A registered tab requests chat-thread indicators and the API responds with HTTP 426 and code REQUEST_FAILED.
- **When** The computed result crosses the message port.
- **Then** It rejects as an API error retaining status 426 and code REQUEST_FAILED.

**Unverified clauses.** The indicator denial reached the update dialog. Only the diagnostic reply exposed ApiError together with REQUEST_FAILED and status 426. The generic update dialog does not distinguish these fields. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-020

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-020)

- **Given** Two registered tabs share an indicator read; the first tab's token is delayed and the second tab can provide a token immediately.
- **When** The second tab requests the indicators while the first token request is still pending.
- **Then** The read completes without waiting for the first tab and uses the second tab's bearer token. Both tabs receive token requests.

**Unverified clauses.** Window A had a pending identity request before B opened its dashboard for the first time. Without another notification, B displayed the cached Side survey label, issued no indicator GET bearing B’s alias, and showed no unread mark while A was held. The distinct B-bearing read after a worker refresh is already documented in batch 105. [Batch 106 review](../../../test-rebuild-evidence/106/README.md#message-port-020).

### message-port-023

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-023)

- **Given** Two registered tabs share an indicator read, and one token provider rejects while the other is pending.
- **When** The second token provider also rejects.
- **Then** The shared read rejects with AggregateError after every tab's token provider fails.

**Unverified clauses.** A rejected at the identity boundary while B was held and B subsequently rejected. After both rejections, restoring the provider allowed a new turn to appear. The Router did not expose the aggregate error type from that particular shared read. Use a supported consumer that distinguishes AggregateError after both providers fail from an individual rejection or a generic unavailable state. [Batch 105](../../../test-rebuild-evidence/105/README.md#message-port-023).

### message-port-027

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-027)

- **Given** Two tabs are registered.
- **When** The first tab disconnects and the second performs a cache-only read.
- **Then** The first tab's port closes, while the second tab's read succeeds with an empty result and its port remains open.

**Unverified clauses.** A visited the empty side conversation and closed. Its Chromium page reported closed before B went offline and opened that conversation for the first time. B showed Side survey and its empty composer. After reconnecting it could read Question number 16 in the nonempty conversation. The literal close of A’s worker port and the empty result returned to B have no separate caller receipt. [Batch 106 review](../../../test-rebuild-evidence/106/README.md#message-port-027).

### message-port-030

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-030)

- **Given** A tab has not registered with the bridge.
- **When** It attempts a cache-only chat-event query.
- **Then** The query rejects because tab registration is required.

**Unverified clauses.** The first real browser messages include register-tab before queries. Issuing a pre-registration read would require sending a private bridge message on behalf of a tab. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-033

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-033)

- **Given** A registered tab has unread indicators and chat-message notification subscriptions, with one chat row initially available.
- **When** Indicator-change and read-cursor events arrive, then two chat-message notifications arrive two seconds apart as another row becomes available.
- **Then** The indicator and read-cursor events cause three indicator reloads and no catch-up requests. Each chat-message notification triggers one catch-up, and the cached rows advance from one row to two.

**Unverified clauses.** Credential-scope notifications, catch-up and rendered rows were exercised. No public handler receipt separates exactly three indicator reloads from two independent warms two seconds apart. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-036

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-036)

- **Given** A user has two subscribers to the same user-scoped topic, another subscriber to that topic in the organization scope, and a subscriber to a different user-scoped topic on one port.
- **When** The first user subscriber is released, then the remaining user subscriber is released and later reacquired.
- **Then** After the first release, notifications reach the second user subscriber, organization subscriber, and different-topic subscriber, but not the released subscriber. Releasing the second removes only that user-topic subscription; the organization and different-topic subscriptions remain. A reacquired subscriber receives a later notification.

**Unverified clauses.** The Router registers production user and organization template topics. It does not expose four separately owned subscriptions and independent release of two callers on the same port. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-037

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-037)

- **Given** A subscriber begins attaching to a realtime topic, but the attach is delayed.
- **When** The subscriber is cancelled and a new subscriber with the same ID starts attaching before the old attach completes; then both attaches complete.
- **Then** The cancelled subscription rejects with an AbortError. Only the new subscriber receives a subsequent notification, and the worker sends one successful subscription reply for the reused ID without an error reply.

**Unverified clauses.** A delayed native attachment and UI replacement were exercised. Each real acquisition generated a new subscriptionId. The frozen reused-ID race requires an ID chosen by the subscriber. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-038

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-038)

- **Given** Two ports subscribe to the same realtime topic while its shared attach is pending.
- **When** The attach fails, then one port reacquires the subscription.
- **Then** Both subscriptions reject with the attach failure, and the failed topic is no longer subscribed. After reacquisition, a notification reaches the new subscriber.

**Unverified clauses.** Two independent already-open shelves shared an outstanding organization attach. The local receiver released it with 503. After closing both windows, a newly registered window reacquired presentationTemplatesChanged on the same organization channel. Publishing on that topic delivered to one handler and put Harbor exhibit on the new shelf. Neither of the two original callers surfaced its rejected attach result. Observe both original subscription rejections and identify removal of the failed topic before reacquiring it. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#message-port-038).

### message-port-039

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-039)

- **Given** Two separate worker Stores each have a subscriber with the same ID and topic.
- **When** The first worker Store is reset and a notification is sent to the topic.
- **Then** The first worker's signal is aborted and its port closes with no remaining listeners, while the second worker remains active and its subscriber receives the notification. The second worker can still complete a cached chat-data query with an empty result.

**Unverified clauses.** Independent child worker domains are available. The Router assigns its own subscription identifiers and does not expose identical IDs or listener counts across worker stores. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** 生产域收到带 duration 的 cache-only 成功遥测并隐藏私有实体信息，预览域作对照。真实页面先查询空会话，但没有证据显示以指定 afterSeqId=42 发出此查询。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/shared-database/__tests__/worker-runtime.test.ts`

### worker-runtime-005

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.bdd.md#worker-runtime-005)

- **Given** The thread snapshot endpoint returns a presigned object URL whose contents include a stored conversation.
- **When** The runtime catches up on thread metadata and then reads it from cache only.
- **Then** Both reads return the stored conversation as the snapshot with no events.

**Unverified clauses.** The metadata endpoint supplied an expiring object URL. Its external object served Stored tide ledger and the metadata events endpoint initially served no events. An independent rename delta was delivered, and B’s offline first selection displayed Revised tide ledger. A separate run displayed the stored title offline without that rename. The two runtime return envelopes are still unobserved. [Batch 106 review](../../../test-rebuild-evidence/106/README.md#worker-runtime-005).

### worker-runtime-008

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.bdd.md#worker-runtime-008)

- **Given** A batched catch-up request covers two threads, one with no new events and one with a new event.
- **When** The runtime performs the batched chat catch-up.
- **Then** It reports only the thread with new events, and cache-only reads show an empty list for the unchanged thread and the new row for the updated thread.

**Unverified clauses.** The first batched HTTP response seeded 48 primary rows and zero side rows. After adding one new row, the next batch requested primary cursor 48 and side cursor 0 and returned one and zero rows respectively. First offline visits displayed the empty side conversation and Observed tidal change in the primary conversation. The runtime’s returned list of changed thread IDs has no independent caller receipt. [Batch 106 review](../../../test-rebuild-evidence/106/README.md#worker-runtime-008).

## `src/signals/__tests__/api-client-bootstrap.test.ts`

### api-client-bootstrap-001

Frozen owner: `turbo/apps/platform/src/signals/__tests__/api-client-bootstrap.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/api-client-bootstrap.bdd.md#api-client-bootstrap-001)

- **Given** A matching one-use bootstrap response and a different network response are available for a feature-switch request.
- **When** The client makes three successive requests, with the third carrying an abort signal.
- **Then** The first request returns the bootstrap response without obtaining a token or using the network; the next two return the network response, and the token provider is called once per network request with the corresponding signal.

**Unverified clauses.** Lab 从嵌入响应读出初始设置并展示服务器后续变化。三次底层请求的逐次 token、signal 归属及首次零网络调用缺可区分结果。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

## `src/signals/__tests__/clerk-user.test.ts`

### clerk-user-003

Frozen owner: `turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/clerk-user.bdd.md#clerk-user-003)

- **Given** The Clerk user value is null, and the session then enters a transition.
- **When** A reader waits for the user while transitioning, then the session signs in as user-a and the transition ends.
- **Then** The read stays pending during the transition and resolves to user-a rather than reporting sign-out.

**Unverified clauses.** 同成员刷新和受保护页面仍有回归；无法从中定位进入过渡前已待决的同一个读取，更无法证明它解析为 user-a。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### clerk-user-005

Frozen owner: `turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/clerk-user.bdd.md#clerk-user-005)

- **Given** Clerk user state has settled for user-a.
- **When** Clerk emits the same user again.
- **Then** The settled user read retains the same promise identity.

**Unverified clauses.** 同一用户再次到达后，账号菜单和工作流均正常；用户可见数据相同并不能证明两次读取返回同一 Promise 对象。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### clerk-user-006

Frozen owner: `turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/clerk-user.bdd.md#clerk-user-006)

- **Given** Clerk is signed in as user-a, and an owner is initializing user state.
- **When** A reader requests the user value synchronously before owner initialization finishes.
- **Then** The read is a promise the owner can resolve and eventually resolves to user-a.

**Unverified clauses.** The page owns startup and installs its reader internally. A synchronous read ahead of owner completion and the identity of the owner-resolved promise are not exposed on this route. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### clerk-user-007

Frozen owner: `turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/clerk-user.bdd.md#clerk-user-007)

- **Given** Clerk user state has settled for user-a under an active owner.
- **When** The owner is replaced, then Clerk emits while the session is transitioning.
- **Then** The last published user value remains available as the same settled promise resolving to user-a; the new event is not observed.

**Unverified clauses.** A Clerk session switch cancels the previous real page owner. The fixture has no public read of the prior settled promise under the replacement owner or listener-observation identity. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

## `src/signals/__tests__/command-scheduling.test.ts`

### command-scheduling-001

Frozen owner: `turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/command-scheduling.bdd.md#command-scheduling-001)

- **Given** A debounced command accepts a value and repetition count.
- **When** The user submits “old” once and then “new” twice before the 20 ms delay expires.
- **Then** The first call is rejected with an AbortError. The latest call returns “newnew”, and only “new” executes.

**Unverified clauses.** 受保护搜索在同轮提交五种值，只有末词及对应结果出现。没有真实页面消费冻结命令的 newnew 字符串或前一次调用的 AbortError。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### command-scheduling-002

Frozen owner: `turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/command-scheduling.bdd.md#command-scheduling-002)

- **Given** A debounced command has started processing “old” and is waiting to finish.
- **When** The user submits “new” before the old work is released.
- **Then** The old call is rejected with an AbortError after it cooperatively checks cancellation. The new call returns “new”.

**Unverified clauses.** 草稿保存的旧 HTTP signal 被中止；旧保存继续扣住或返回时 UI 都保留新稿。传输取消与顶层命令抛出的 AbortError、返回 new 不能等同。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### command-scheduling-003

Frozen owner: `turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/command-scheduling.bdd.md#command-scheduling-003)

- **Given** A pending debounced call for “discarded” belongs to a caller that is then cancelled.
- **When** The user submits “latest” with a valid caller, followed by “invalid” with the cancelled caller.
- **Then** The discarded call is rejected with an AbortError carrying the cancellation reason, and the invalid call is rejected with that reason. Only “latest” executes and returns successfully.

**Unverified clauses.** A production edit cannot resubmit with a deliberately cancelled caller signal, nor retrieve the two returned AbortErrors and their original reason. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### command-scheduling-004

Frozen owner: `turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/command-scheduling.bdd.md#command-scheduling-004)

- **Given** A throttled command has a 1,000 ms interval and its first call, “first”, is still running.
- **When** At 200 ms the user submits “discarded”, then at 600 ms submits “latest” with a repetition count of two.
- **Then** No trailing work executes while the first call is running. At 1,000 ms, the first call returns “first” and both trailing callers receive “latestlatest”; only “first” and “latest” execute.

**Unverified clauses.** The worker warm and draft UI produce observable updates. Two trailing throttle callers sharing the returned latestlatest promise at the 1000 ms boundary have no user-facing equivalent. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### command-scheduling-006

Frozen owner: `turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/command-scheduling.bdd.md#command-scheduling-006)

- **Given** Two separate Stores use the same debounced command with a 20 ms delay.
- **When** One Store submits “first” and the other submits “second”.
- **Then** Neither execution occurs immediately. Both calls complete with their own values, and both commands execute; scheduling in one Store does not replace the other Store’s work.

**Unverified clauses.** Separate runtime domains were exercised on real pages. The generic debounced command invocation, private store identity and its two completion values have no production user operation. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

## `src/signals/__tests__/realtime.test.ts`

### realtime-002

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-002)

- **Given** A signed-in user has realtime subscriptions routed through the SharedWorker.
- **When** The app subscribes to a user-scoped connector-permission update and the worker receives a matching event.
- **Then** The subscription is registered with the worker, the app handles the event once and completes the wait, and no app-side Ably authentication token is requested. The subscription is removed after completion.

**Unverified clauses.** Slack 授权页依次展示两次不同决定，能区别消费通知和忽略通知。它是常驻消费者；一次性等待完成、退订及页面零 token 读取仍缺公开观察。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### realtime-005

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-005)

- **Given** A signed-in user requests a live update, but the realtime-token service responds with HTTP 500.
- **When** Realtime setup and the pending subscription attempt to connect.
- **Then** Both reject with an Ably connection failure, no live subscription remains, and a later subscription request also rejects with an Ably connection failure.

**Unverified clauses.** Two independent Chromium Routers used the local identity service. The provider invoked the production auth callback, the realtime-token HTTP receiver returned 500, and the provider received its failure. Loading another window did not surface distinct setup, pending subscription and later subscription rejections with that failure. Identify each caller at a supported consumer of the failed token exchange, including a later subscription after terminal failure. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#realtime-005).

### realtime-006

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-006)

- **Given** Realtime is suspended and a subscriber is waiting for a channel attachment.
- **When** The user cancels that subscriber while attachment is pending.
- **Then** The wait rejects with the subscriber’s cancellation reason, and its channel subscription is removed.

**Unverified clauses.** With an organization attach held at the HTTP boundary, the presentation shelf opened and the provider received the suspended transition. Chromium confirmed closing the subscriber window before the attach gate was released. The gate then returned 503. Neither the waiting subscriber’s cancellation reason nor its topic removal was acknowledged independently. Keep the provider observer alive beyond the cancellation and identify the subscriber-specific rejection and removal before releasing attach. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#realtime-006).

### realtime-010

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-010)

- **Given** A signed-in user starts a background subscription while the transport is suspended and provides an error callback.
- **When** The channel later reports a terminal “connection failed” error.
- **Then** The callback receives that error, and the channel subscription is removed.

**Unverified clauses.** The external attach was outstanding while the shelf was open. The provider delivered a terminal failed-channel transition with the connection-failed reason, followed by a failed connection and the attach failure. There was no observable acknowledgement from the background subscriber’s error callback or removal of its exact subscription. Use a background subscriber whose failure callback changes a visible value and whose subscription removal can be identified at the same provider. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#realtime-010).

### realtime-011

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-011)

- **Given** A signed-in user creates a payload subscription with `runOnSubscribe` omitted.
- **When** The subscription receives a payload, then the transport disconnects and reconnects.
- **Then** Initialization runs once on subscription and once after reconnection; the payload is handled, and the continuity gap triggers recovery.

**Unverified clauses.** A genuine payload publication was followed by Delivered survey 17 on the open thread. The external provider then recorded both a resumed connection and a discontinuous reconnect. These receipts do not identify two completed initializations of that particular payload subscriber with runOnSubscribe omitted. Use a mounted payload consumer with a unique visible value produced only by its initialization on both sides of the continuity gap. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#realtime-011).

### realtime-020

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-020)

- **Given** A signed-in user subscribes to chat-thread live updates, but the initial subscription refresh fails.
- **When** Subscription initialization throws an error.
- **Then** The subscription request rejects with the initialization error, but the chat-thread automations live subscription remains active.

**Unverified clauses.** The startup thread detail returned HTTP 500. The same open panel still changed Cedar schedule to Maple schedule after the later automation notification. The external HTTP failure has no identified receipt from the original subscription caller. Observe the caller of the subscription initialization receiving its original error while the same open automation panel subsequently changes. [Batch 107 review](../../../test-rebuild-evidence/107/README.md#realtime-020).

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

**Unverified clauses.** 浏览器协议版本答复跨过 31 秒，空窗口仍可创建新页并接收输入。Browser.getVersion 与 Target.getTargets 是两个只读命令；界面不能读出前者异常分类。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### client-002

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-002)

- **Given** A viewer has two pending CDP requests on an open connection to a remote browser.
- **When** The viewer closes and then attempts to notify the browser.
- **Then** Both pending requests reject, and no notification is sent after closing; the remote browser is not closed by this action.

**Unverified clauses.** 旧连接和替换页的定向对照能区别哪个接收端仍可输入。close 时两个不同的待决公开操作各自拒绝且远程浏览器保持存活，仍缺同一场景的证据。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### client-003

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-003)

- **Given** A native browser attachment is pending on a CDP connection, with its request associated with the original parent session.
- **When** The operation is cancelled, a later Browser.getVersion request is made, and the attachment response arrives late.
- **Then** The attachment request rejects with AbortError, the connection remains usable, and the late attachment is detached using the original parent session.

**Unverified clauses.** A genuine attach was delayed and the viewer was closed. Its connection closed; continued Browser.getVersion and late detach on that same live connection were not observed. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### client-004

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-004)

- **Given** Native bridge startup has sent a browser-target attachment request on an open CDP connection.
- **When** Startup is cancelled and the attachment response arrives late.
- **Then** Startup rejects with AbortError, the late native attachment is detached, and the connection remains usable for Browser.getVersion.

**Unverified clauses.** Cancelling the browser page disposed its control connection. The native startup rejection, late detached session and continued control connection were not all observable. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

### client-006

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-006)

- **Given** Two CDP clients are open on different connections and listen for native events.
- **When** Two events arrive on the first connection, including one with a session ID shared by both clients, and another event arrives after the first client closes.
- **Then** Only the first client receives the two events received while it was open; the second client receives none, and the closed client receives no later event.

**Unverified clauses.** The two live viewers had distinct Chrome session IDs. The shared native session ID, isolated event delivery and post-close event in the original remain unproved. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-101.tsv).

### client-007

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-007)

- **Given** Two Page.navigate requests are pending on one CDP connection, each for a different session and destination.
- **When** The second session's reply arrives before the first session's reply.
- **Then** Each request resolves with its own frame ID: second-frame for the second destination and first-frame for the first.

**Unverified clauses.** Two concurrently held native Page.navigate failures reached separate Chromium viewers in reverse order. Each window alone showed the generic failure when its own receipt arrived. On one socket the second submission displayed “A page is still opening” until the first settled. The original still needs two simultaneous requests on one socket, each resolving successfully with its own frame ID. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-101.tsv).

### client-008

Frozen owner: `turbo/apps/platform/src/signals/browser/__tests__/client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/browser/__tests__/client.bdd.md#client-008)

- **Given** A Target.attachToTarget request is pending for the original page on an open CDP connection.
- **When** That request is cancelled, the connection is used for Browser.getVersion, and the late attachment response arrives.
- **Then** The attachment request rejects with AbortError; the late session is detached, and Browser.getVersion succeeds both before and after the late response.

**Unverified clauses.** The public close path cancelled attachment by closing the connection. The late cleanup on the original target/connection and later successful Browser.getVersion remain unproved. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

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

**Unverified clauses.** 由外部 IndexedDB.open 抛错后依然能进入 Workflows。chat.open 的失败遥测带数字时长且屏蔽私有错误及身份；日志与页面不能证明调用方拿到同一异常对象。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### indexeddb-client-003

Frozen owner: `turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/external/__tests__/indexeddb-client.bdd.md#indexeddb-client-003)

- **Given** A user performs a write followed by a read in one read-write IndexedDB transaction, using sensitive record data.
- **When** The transaction is created, executed, and reported to telemetry.
- **Then** The read returns the written value, and separate successful transaction-creation and execution events are recorded for the shared-worker runtime. The execution event reports two requests, and neither event exposes the key or value.

**Unverified clauses.** 迁移后的值与两种事务遥测有各自路由对照。仍未在同一共享 worker 操作里配对特定写后读值、创建与执行两类事件及 request_count=2。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

## `src/views/artifacts-page/__tests__/artifact-sharing.test.tsx`

### artifact-sharing-002

Frozen owner: `turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-sharing.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-sharing.bdd.md#artifact-sharing-002)

- **Given** An owner opens sharing for a private artifact.
- **When** The owner selects Organization, Public access, then Only me, copying the link after each change.
- **Then** Each selected access level becomes checked, and the API receives the changes in that order: organization, public, private. Each copy writes the same canonical app link; there is no text box or copied-link notice before copying, and only one permission-status read occurs.

**Unverified clauses.** 三档访问级别按次序变更，三次复制读到同一规范链接。权限详情决定勾选，重复读取同一版本不改变 UI，未取得唯一读取凭据。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-98.tsv).

## `src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx`

### browser-automatic-recovery-004

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#browser-automatic-recovery-004)

- **Given** The selected tab is recovering after a successful image frame, and revalidation receives a terminal 409 conflict because the assigned window was lost.
- **When** The user reconnects after the unavailable-view state appears.
- **Then** The terminal descriptor error and one final protocol recovery report are preserved in order. Reconnect restores the viewer without adding reports.

**Unverified clauses.** A held recovery image and a terminal assigned-window 409 reached Browser view unavailable. An HTTP response-body observer recorded the conflict before the external reporter received one final protocol recovery report. Manual reconnect restored Ledger input with that report list unchanged. The frozen body requires a separately reported Promise ApiError followed by a Browser report. [Batch 106 review](../../../test-rebuild-evidence/106/README.md#browser-automatic-recovery-004).

## `src/views/browser-session/__tests__/browser-frame-rate.test.tsx`

### browser-frame-rate-001

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-frame-rate.bdd.md#browser-frame-rate-001)

- **Given** A remote browser viewer is open with FPS hidden.
- **When** The user opens Browser settings and chooses FPS > On from the left-opening radio submenu, then chooses Off and reopens the submenu.
- **Then** Off is initially selected, and On displays a 128-by-48 FPS overlay without sending browser requests. On and Off selections are reflected when the submenu is reopened; Off removes the overlay, and Escape returns focus to Browser settings.

**Unverified clauses.** 原生浏览器输入仍未获远端确认时，FPS 本地设置可切换并重新打开。128×48、radio 选中、移除与 Escape 归焦均由页面验证，精确零远端请求没有业务回执。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** 首页近身预加载旧卡后，实际读到旧响应和行内 Unread，再触发持有的新一轮详情并打开 For you。此时新旧卡均未出现，放行后只见替换卡。冷重开对照同样须先交付详情。保留响应前显示卡片的缺口。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### agent-suggestions-015

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.bdd.md#agent-suggestions-015)

- **Given** At least two cards are available, but no model is available to send a message.
- **When** The user chooses the first card's action.
- **Then** The unavailable-model error appears, and the first card remains in its original place.

**Unverified clauses.** After the member disconnected the last personal provider, the run-model API returned available built-in Auto and the first card sent successfully. A separately supplied empty model response produced the expected error and preserved both card positions. The real no-model precondition remains open. [Batch 103 evidence](https://github.com/okou-ai/okou/blob/test/app-gwt-inventory/test-rebuild-evidence/103/README.md#agent-suggestions-015).

### agent-suggestions-021

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.bdd.md#agent-suggestions-021)

- **Given** A suggestion's custom-direction dialog contains a typed follow-up, and sending it initially fails.
- **When** The user retries the send and the server accepts it.
- **Then** The failure leaves the dialog and its text intact; the retry uses the same chat and event identities and includes the suggestion background and follow-up. Acceptance closes the dialog, removes the card, shows the sent confirmation and All caught up, and leaves the user on For you; no ordinary card-consumption request is recorded.

**Unverified clauses.** The inline editor retained the card, background and note after a real conflict. The successful retry reused the chat ID and event ID. The authenticated event and custom feedback show acceptance. A rejected ordinary consume replay leaves the same feed receipt. Its absence remains unproved. [Batch 103 evidence](https://github.com/okou-ai/okou/blob/test/app-gwt-inventory/test-rebuild-evidence/103/README.md#agent-suggestions-021).

## `src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx`

### chat-attachment-annotation-018

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-annotation.bdd.md#chat-attachment-annotation-018)

- **Given** A restored draft contains one annotation mark but no annotated copy.
- **When** The chat loads and rebuilds the marked-up copy from the original image.
- **Then** The composer shows one mark and sending becomes enabled; the original image is read once.

**Unverified clauses.** 持久化单标记重新打开；未取得原图时禁止发送，读取完成后仍一标记且可发送。多次取得相同图像无法由显示结果区分。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-98.tsv).

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

## `src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx`

### chat-composer-connector-overview-001

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.bdd.md#chat-composer-connector-overview-001)

- **Given** The user is in an existing Chat with the connector-account-access feature enabled and 20 connected connectors available.
- **When** They open the Connectors panel, close it, and reopen it.
- **Then** All 20 connectors appear both times. The overview is fetched once, no target refresh is fetched, and the legacy connector and thread endpoints are not read.

**Unverified clauses.** 完整库存被扣住或不可用，关闭后重开仍呈现相同 20 项。可用列表证明缓存回退，不能据此区分重复全表读取、定向刷新和不可见旧路径读取。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-composer-connector-overview-007

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.bdd.md#chat-composer-connector-overview-007)

- **Given** The user has loaded Probe 1 and Probe 2 in the Connectors panel.
- **When** A refresh notification for Probe 1 fails; a notification for Probe 2 arrives; then the user retries Probe 1 successfully and another Probe 1 notification arrives.
- **Then** The panel exposes Try again for the failed Probe 1 refresh while still showing Probe 1, and the Probe 2 notification refreshes Probe 2. Retrying restores Probe 1 and removes the retry control; a later notification updates Probe 1 access to off. The full overview is fetched twice and target refreshes three times.

**Unverified clauses.** 外部变更使 Probe 1 刷新失败、可重试；Probe 2 能独立更新。重试成功和后续关闭均可见；这些独立业务结果不能推出全表两次、定向三次。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-composer-connector-overview-009

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-overview.bdd.md#chat-composer-connector-overview-009)

- **Given** The user has opened the Connectors panel in an existing Chat and loaded Probe 1.
- **When** They navigate to New chat, return to the original Chat using browser back, and reopen the Connectors panel.
- **Then** The connector-change subscription is released while away. Returning to the Chat loads Probe 1 again with a second full overview request and no target refreshes.

**Unverified clauses.** The New chat link reached / and history returned to the original thread with the connector visible. Releasing the subscription while away and the exact request mix on return were not established. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx`

### chat-composer-connector-status-001

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.bdd.md#chat-composer-connector-status-001)

- **Given** The connector directory contains a saved GitHub account and a saved Acme Search account, and both default accounts require reconnection.
- **When** The user opens the connector directory, searches for GitHub, then switches to Custom connectors.
- **Then** GitHub details and Acme Search remain available. No account values are requested, authorization is not updated, and no manual connection is started.

**Unverified clauses.** GitHub 详情和 Acme Search 在两个目录可达，进入配置才见密钥输入。#49268 已删除冻结 helper 监测的 Agent 授权 PUT；另两项账户值读取和手工连接仍无充分的公开反证。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-98.tsv).

## `src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx`

### chat-continuity-uploads-003

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.bdd.md#chat-continuity-uploads-003)

- **Given** A chat composer is open, and upload preparation returns an absolute private Artifact URL for private.txt.
- **When** The user uploads private.txt and its storage transfer succeeds.
- **Then** The file appears as a removable attachment, and upload completion is requested once for its upload ID.

**Pending product decision and unverified clauses.** 相同 clientEventId 返回同一已准入 run；同一完成上传产生同一文件。验收是否以只产生一个业务产物为准？若需要证明只有一次传输，需要哪种对用户或业务可核验的回执？ The private upload appears and can be removed. On the real API, completing the same upload ID twice produces identical public receipts and the same single catalog entry. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-95.tsv).

### chat-continuity-uploads-011

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-continuity-uploads.bdd.md#chat-continuity-uploads-011)

- **Given** A multipart recording upload's storage transfer succeeds, but the completion request returns a 404 with the message Multipart upload not found.
- **When** The user uploads the recording.
- **Then** That finalization message is shown once; completion is requested once, and no generic upload-failure message appears.

**Unverified clauses.** The multipart finalization message appears once without the generic error. Its frequency cannot establish the frequency of failed completion attempts. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-95.tsv).

## `src/views/okou-page/__tests__/chat-conversation-locator.test.tsx`

### chat-conversation-locator-002

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-conversation-locator.bdd.md#chat-conversation-locator-002)

- **Given** An eight-turn conversation has its first question outside the rendered viewport.
- **When** The user selects the first conversation marker.
- **Then** The first question is brought into the viewport at its top edge, and its message receives landing feedback.

**Unverified clauses.** 96e318f041 恢复的 Vitest 30 轮注册在几何替身上覆盖顶边、落点、卸载。原生 Chromium 已证 24 个标记、点击第一问、落点、24/30 卸载，但稳定布局中首问锚点距视口顶边 60px。 #49915 撤回分页，#50032 恢复分页；#50327 是 staff scroll-room 开关，未提供修改精确顶边子句的依据。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv). 第103批用恰好八轮的对话在原生 Chromium 中点选首个标记。720px 与 960px 两种窗口下，首问均从未挂载变为可见且获得落点反馈。滚动稳定后锚点距滚动视口顶部 60px，问题文本距顶部 74px。点第四个标记产生不同的落点。精确顶边子句保留。 [Batch 103 measurements](../../../test-rebuild-evidence/103/locator.json).

## `src/views/okou-page/__tests__/chat-list-cache.test.tsx`

### chat-list-cache-004

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-list-cache.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-cache.bdd.md#chat-list-cache-004)

- **Given** A signed-out user opens the sign-in page.
- **When** The page loads.
- **Then** The sign-in page remains at /sign-in, and no private conversation snapshot, events, indicators, or agent-list requests are made.

**Unverified clauses.** 两种登录状态过渡均保持 /sign-in 且私聊内容不可见。Agent-list 读曾退役，当前证据不能确定另外三类私有读取均未发生。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/views/okou-page/__tests__/chat-list-optimistic.test.tsx`

### chat-list-optimistic-001

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.bdd.md#chat-list-optimistic-001)

- **Given** A user is composing a new conversation and the server has not confirmed its creation.
- **When** They send “Start the local conversation.”
- **Then** A single “New chat” appears in the sidebar with the requested thread ID before confirmation. No draft is requested.

**Unverified clauses.** 提交冻结草稿后、创建确认前，唯一的 New chat 链接含客户端线程 ID。已确认对照能读出服务端草稿；未确认时无该文案并不能排除读取后丢弃。 #50334 changes the voice attachment upload and composer document. The optimistic QuickTime path still renders its resolved video URL independently of thread-artifacts. The 404 read and pending draft lookup retain their previous evidence. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-list-optimistic-002

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.bdd.md#chat-list-optimistic-002)

- **Given** A user is composing a new conversation and attaches a QuickTime video named recording.mov; thread creation remains unconfirmed.
- **When** They send the message with the attachment.
- **Then** A preview for recording.mov appears using the video URL with a start time of 0.001 seconds. The missing-thread artifact response produces no visible error toast, and creation remains unconfirmed.

**Unverified clauses.** 未确认会话已显示 recording.mov 的真实文件 URL 与 #t=0.001，且无错误 toast。用独有错误文案监听该 404 的 Response.json，在创建保持待决的真实发送过程中，定向探针到期仍未取得对应读取回执。保留缺口和失败探针。 #50334 changes the voice attachment upload and composer document. The optimistic QuickTime path still renders its resolved video URL independently of thread-artifacts. The 404 read and pending draft lookup retain their previous evidence. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-list-optimistic-005

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-list-optimistic.bdd.md#chat-list-optimistic-005)

- **Given** A user is composing a new conversation with GPT 5.6 Luna selected, and server creation is pending.
- **When** They change the model to Claude Sonnet 5 and send their first message.
- **Then** The creation request uses Claude Sonnet 5, the composer still shows Claude Sonnet 5, no draft is requested, and creation remains unconfirmed.

**Unverified clauses.** 未确认的创建可显示所选 Claude Sonnet 5，冻结要求的零次草稿请求缺少独立可见证据。 #50334 changes the voice attachment upload and composer document. The optimistic QuickTime path still renders its resolved video URL independently of thread-artifacts. The 404 read and pending draft lookup retain their previous evidence. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** Pasting a PDF attached it to the Image composer, retained the draft and Remove Image control, and sent no message. Importing a valid WEBP through the style picker sent both identified files in the analysis/publish chat and no generation template. In the paired picker-only control the PDF was filtered and only the WEBP was sent. #39648 and #50365 cover the contextual file chooser, not a changed clipboard rule. Revisit when the production clipboard contract for unsupported style files changes or when a real paste is rejected before attaching. [Batch 105](../../../test-rebuild-evidence/105/README.md#composer-custom-template-recommendations-009).

## `src/views/okou-page/__tests__/connector-directory.test.tsx`

### connector-directory-010

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.bdd.md#connector-directory-010)

- **Given** The connector catalog contains Gmail, which supports provider authorization.
- **When** The user tabs to Connect Gmail and presses Enter.
- **Then** One authorization window opens at the Gmail authorization URL and one OAuth connection request is made. Closing the dialog closes the authorization window.

**Unverified clauses.** Tab and Enter started one real OAuth attempt and opened one provider window per ordering. State digests joined the consent and local API denial callback to that same admission. Closing the directory first left the popup able to deliver the callback. Delivering the callback first also left the popup open after directory dismissal. A product change specifying popup ownership after cross-origin navigation, or a later callback lifecycle that actually closes the original window, would change the conclusion. [Batch 105](../../../test-rebuild-evidence/105/README.md#connector-directory-010).

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

**Unverified clauses.** 新控制在服务器先持久化 Work 1、暂扣回执，关闭管理器，在外部搜索取得焦点后结束旧处理，再打开读回 Research archive 且没有编辑框。#37939 引入原注册并限定 save 生命周期；它没有撤销实际旧应答交付这一冻结前提。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### connectors-account-rename-focus-013

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.bdd.md#connectors-account-rename-focus-013)

- **Given** A user saves a rename with a delayed response, closes the manager, reopens it, and starts editing Work 2 as “Work 2 new.”
- **When** The older rename response arrives while the new edit is active.
- **Then** The new input retains focus and its draft; the user can extend and save it as “Work 2 new draft,” after which focus is on that account’s actions.

**Unverified clauses.** 同一持久 Work 1 变更与 Work 2 分开。重开后 Work 2 new 在原处理完成后仍有焦点，追加文字保存，焦点回到 Work 2 new draft 的 Actions，Work 1 同时可查。旧 HTTP 信号已被关闭取消。#37939 引入原注册和生命周期规则，未明文废除旧响应到达条件。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/views/okou-page/__tests__/debug-morning-brief.test.tsx`

### debug-morning-brief-005

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/debug-morning-brief.bdd.md#debug-morning-brief-005)

- **Given** The user opens Debug and the Morning Brief action is enabled.
- **When** The user focuses the action and presses Enter.
- **Then** The brief completes, and exactly one request is submitted.

**Unverified clauses.** 只用 Enter 启动简报，忙碌时没有完成文案，回执放行后可打开对应会话。生产 API 用请求 ID 查找已有的 durable receipt，返回同一会话结果不能证明恰好一次提交。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-99.tsv).

## `src/views/okou-page/__tests__/directed-connect-page.test.tsx`

### directed-connect-page-008

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/directed-connect-page.bdd.md#directed-connect-page-008)

- **Given** The user opens a directed Stripe connection link from a chat, with an agent ID and callback prompt; Stripe requires no authentication.
- **When** The user connects Stripe.
- **Then** Stripe connects once, the originating chat receives the callback prompt, and no visible agent-authorization update is made. No connection dialog remains open.

**Unverified clauses.** Stripe 带聊天返回参数进入现有授权页面。无凭证 Stripe 的前提、该分支成功回调及准确一次连接在当前公开目录均未取得证明。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-98.tsv).

## `src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx`

### discord-oauth-compatibility-007

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/discord-oauth-compatibility.bdd.md#discord-oauth-compatibility-007)

- **Given** The Discord approval callback has a valid proof and an open opener.
- **When** The callback page starts approval and the opener closes immediately afterward.
- **Then** It reports that authorization was interrupted or refreshed, does not show an Open Discord link, submits exactly one approval request, and removes the proof from the URL.

**Unverified clause.** Exactly one approval submission. Closing the opener after the API admitted the page’s approval produced the interrupted message, no Open Discord link and a proof-free URL. Replaying the identical payload at the relay produced an additional 400 under the same state digest with the same page outcome. [Batch 102 receipts](../../../test-rebuild-evidence/102/discord.json).

## `src/views/okou-page/__tests__/get-started-entry.test.tsx`

### get-started-entry-042

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-042)

- **Given** An admin opens the connector step for a connector with two browser authentication methods.
- **When** They select that connector from the picker.
- **Then** A connect dialog named “Choice connector” offers “Workspace OAuth,” and the connector's full catalog entry is read once upon selection.

**Unverified clauses.** 从奖励步骤选中 Choice connector，扣住目录详情和放行后出现的两种 OAuth 选项可区分。重复详情读取可能显示完全相同的 Workspace OAuth，缺少单次读取回执。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-98.tsv).

## `src/views/okou-page/__tests__/integrations-discord.test.tsx`

### integrations-discord-037

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.bdd.md#integrations-discord-037)

- **Given** Discord is disconnected, and the user leaves Works for Chat while Discord status refresh is pending.
- **When** The user returns to Works before the refresh completes.
- **Then** The Discord card continues to show its description and an enabled Connect button; after refresh it shows Connected.

**Unverified clauses.** Started disconnected, held the change-triggered status request, left for Chat and returned before release. The description remained with no buttons. Delivery exposed Connected and enabled More options. In a separate control where refresh started only on return, the card retained enabled Connect until delivery. Both chronologies have a regular registration. The upstream cache promise covers refresh starting on return. A change or a product ruling on refresh already pending before departure could close the original. [Case review](../../../test-rebuild-evidence/104/README.md#integrations-discord-037).

### integrations-discord-038

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.bdd.md#integrations-discord-038)

- **Given** Discord is connected, and the user leaves Works for Chat while Discord status refresh is pending.
- **When** The user returns to Works before the refresh completes.
- **Then** The Discord card continues to show its description and Connected status; after refresh it still shows Connected.

**Unverified clauses.** Started connected, held refresh before leaving Works and returned while pending. The card showed its description without Connected or actions. The response restored Connected and enabled More options. Starting refresh only on return preserved the cached Connected state. Both initial states and both chronologies were exercised. Look for a decision or implementation that preserves a connected card across departure with a status request already pending. [Case review](../../../test-rebuild-evidence/104/README.md#integrations-discord-038).

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

**Unverified clauses.** Preference → Models with both reads held displayed Use more models and Loading accounts…, with neither the empty-account message nor Connect account. Releasing billing first did not restore those controls; releasing the subscription displayed the returned member, including when billing was still pending. #37519 documents the new heading and requests reuse of resolved data on refresh. A supported re-entry retaining confirmed account data through both outstanding reads, or a later product decision explicitly changing that behavior, is needed. [Batch 105](../../../test-rebuild-evidence/105/README.md#settings-model-loading-001).

## `src/views/okou-page/__tests__/settings-wallet-cards.test.tsx`

### settings-wallet-cards-005

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet-cards.bdd.md#settings-wallet-cards-005)

- **Given** A connected member sees an Everyday card and a recent purchase in Link activity.
- **When** They return to the tab and focus it, then the workspace wallet changes to a Business card and updated purchase.
- **Then** Returning to the tab preserves the existing card and transaction without extra requests. During refresh the old data remains visible; after refresh, Business is marked default and replaces Everyday, and the updated purchase replaces the recent purchase.

**Unverified clauses.** 回到 Tab 后检查原卡与原购买；两条对照分别先放行卡和交易。已交付的一栏更新，另一栏保留此前业务数据，全部放行后只有 Business 标为默认且交易已替换。相同回复的冗余读取仍无法由两栏页面区分。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/views/okou-page/__tests__/vnc-settings.test.tsx`

### vnc-settings-054

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.bdd.md#vnc-settings-054)

- **Given** I have reviewed a host-creation draft containing password old-pass, and token acquisition is pending when I save.
- **When** The signed-in owner changes before the old owner's token resolves.
- **Then** The draft closes, the secret is cleared, and no host creation request is sent.

**Unverified clauses.** 旧身份令牌待决时切换成员，随后放行或继续扣住旧凭据。旧草稿关闭，新成员看不到密码。主机列表没有创建回执，不能排除被拒绝的旧身份写入。 The create command at vnc.ts:1712 validates the current editor and awaits the connection or credential API. A new owner can observe accepted writes; their host list cannot expose an old rejected attempt. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx`

### onboarding-sources-first-flow-012

Frozen owner: `turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.bdd.md#onboarding-sources-first-flow-012)

- **Given** An owner opens the ready step with Gmail connected and a chat service available.
- **When** They start their first task.
- **Then** Onboarding completes exactly once from the ready step before the first request runs.

**Unverified clauses.** Owner 在 ready 启动任务，扣住完成回执时编辑器保留，放行后同一提示词进入新会话。真实测试 API 与隔离 PostgreSQL 对相同 owner 连续提交两次，第一次与第二次公开回执、状态读取相同。无法据此断言只提交一次。 The complete route returns the service result and deletes the saved draft. Batch 98 compared two actual API completions; the identical result and readback cannot distinguish duplicate delivery. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### onboarding-sources-first-flow-015

Frozen owner: `turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.bdd.md#onboarding-sources-first-flow-015)

- **Given** An invited member needs their own onboarding, cannot add Slack, and has no connected Gmail source.
- **When** They choose Marketing & content, skip sources, choose to start with Okou, pass Slack with Not now, edit the ready-step request to “Draft my meeting agenda,” and start the task.
- **Then** The ready step initially shows the asserted competitor-research preset. The first request runs with the edited text, completion is sent once from the ready step, and the member leaves onboarding for chat.

**Unverified clauses.** 成员逐步跳过来源、Slack，改写竞品预设为 Draft my meeting agenda 后进入实际聊天。真实 API 对 org:member 的两次相同完成提交产生同一回执及状态。发送顺序和编辑内容有证，精确提交次数没有可区分回执。 The complete route returns the service result and deletes the saved draft. Batch 98 compared two actual API completions; the identical result and readback cannot distinguish duplicate delivery. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### onboarding-sources-first-flow-021

Frozen owner: `turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-flow.bdd.md#onboarding-sources-first-flow-021)

- **Given** A new user who needs onboarding opens with the prompt “Draft the launch plan.”
- **When** They edit it to “Draft the launch plan for the EU market” and choose Next.
- **Then** Onboarding completes once from the onboarding page before the first chat request runs, and the request uses the edited text with the document and artifact-link instructions appended.

**Unverified clauses.** The edited EU launch prompt stayed at onboarding until the completion response was released, then reached chat with the document instructions. The frozen single-completion clause cannot be credited under the request-count rule. The complete route returns the service result and deletes the saved draft. Batch 98 compared two actual API completions; the identical result and readback cannot distinguish duplicate delivery. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/views/onboarding/__tests__/onboarding-start.test.tsx`

### onboarding-start-001

Frozen owner: `turbo/apps/platform/src/views/onboarding/__tests__/onboarding-start.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/onboarding/__tests__/onboarding-start.bdd.md#onboarding-start-001)

- **Given** A signed-in user needs onboarding.
- **When** The user opens the onboarding page while Marketing records the event request but delays its response.
- **Then** The industry question appears without waiting for the response. One authenticated POST is sent to https://www.okou.ai/api/events with the onboarding-start tag and a UUID event ID; one started telemetry record for the user and organization exists before the POST, with no status code, and the request remains un-aborted.

**Unverified clauses.** 行业问题在营销响应待决时可选；外部边界收到 onboarding-start、已认证 POST 及 UUID，入站已有相应 started 遥测且没有状态码。相同身份的重复营销调用能否区分仍缺来源，不以调用计数做断言。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).
