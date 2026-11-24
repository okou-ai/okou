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

**Unverified clauses.** 两个独立浏览器窗口经生产 SharedWorker 接收相同变化。中断、恢复以及失去连续性分别读取，两窗先后关闭，余下窗口收到终态。最终 worker 退出与每窗精确一次 resync、最后一次显式解除订阅仍是不同命题。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-015

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-015)

- **Given** A registered tab subscribes to presentationTemplatesChanged at organization scope.
- **When** An event is published on its organization's channel.
- **Then** The tab receives the event through that organization channel.

**Unverified clauses.** The organ­ization-scoped native subscription and exact revision were observed in the experiment. The recorded Workflows page had no visible change establishing application handling of that revision. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** One page can hold its local token provider. An independent second registered tab able to satisfy the same pending read with a different bearer was not constructed at the public boundary. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-022

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-022)

- **Given** Two registered tabs share an indicator read; one token provider is pending and the other can provide a token.
- **When** The pending provider's tab disconnects before the healthy provider returns its token.
- **Then** The read succeeds using the healthy tab's bearer token.

**Unverified clauses.** The single registered tab can reject its local provider. There is no second simultaneously live tab with an independent pending bearer on the same worker to survive the first disconnect. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-023

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-023)

- **Given** Two registered tabs share an indicator read, and one token provider rejects while the other is pending.
- **When** The second token provider also rejects.
- **Then** The shared read rejects with AggregateError after every tab's token provider fails.

**Unverified clauses.** The first native token-error was observed during startup. The all-providers AggregateError for a shared read needs two real token providers and the requesting caller receipt. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-027

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-027)

- **Given** Two tabs are registered.
- **When** The first tab disconnects and the second performs a cache-only read.
- **Then** The first tab's port closes, while the second tab's read succeeds with an empty result and its port remains open.

**Unverified clauses.** The child runtime experiment exercises cache reopening. Its app/worker domain is independent and its document is shared. Closing one native tab while a second tab continues reading on that same worker is unproved. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-030

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-030)

- **Given** A tab has not registered with the bridge.
- **When** It attempts a cache-only chat-event query.
- **Then** The query rejects because tab registration is required.

**Unverified clauses.** The first real browser messages include register-tab before queries. Issuing a pre-registration read would require sending a private bridge message on behalf of a tab. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-032

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-032)

- **Given** A registered tab has unread indicators for an agent and a thread, with an indicator-change subscription active.
- **When** An indicator-change event arrives after the indicators become empty.
- **Then** A later indicator read returns empty agents, threads, and unread timestamps; the event does not warm chat messages.

**Unverified clauses.** The current indicator schema carries threads and unreadAt. It no longer carries the frozen agent indicators. The page cannot establish the complete two-kind initial and empty final result. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-033

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-033)

- **Given** A registered tab has unread indicators and chat-message notification subscriptions, with one chat row initially available.
- **When** Indicator-change and read-cursor events arrive, then two chat-message notifications arrive two seconds apart as another row becomes available.
- **Then** The indicator and read-cursor events cause three indicator reloads and no catch-up requests. Each chat-message notification triggers one catch-up, and the cached rows advance from one row to two.

**Unverified clauses.** Credential-scope notifications, catch-up and rendered rows were exercised. No public handler receipt separates exactly three indicator reloads from two independent warms two seconds apart. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### message-port-034

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/message-port.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/message-port.bdd.md#message-port-034)

- **Given** A registered tab has an unread thread and chat-message notifications; catch-up initially fails with HTTP 500.
- **When** A message notification triggers warming, then a later notification arrives after catch-up recovers and a second row is available.
- **Then** The unread indicators remain readable during the failure, and the later warming makes both rows available in the cache.

**Unverified clauses.** Background warming and later cache visibility were exercised on the Router. The failed warm, continued readable unread indicators, and recovered two-row offline history were not all observed in one lifetime. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** The local attach gate can fail and release one native subscriber. The two independent ports sharing that pending topic, both rejection receipts, and successful reacquisition remain unproved. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** 签名快照的真实响应能恢复会话，远端增量送达后可读回修改。界面能区分快照与新标题；不能反推出两次底层返回对象均为 snapshot 且 events 为空。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### worker-runtime-008

Frozen owner: `turbo/apps/platform/src/shared-database/__tests__/worker-runtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/shared-database/__tests__/worker-runtime.bdd.md#worker-runtime-008)

- **Given** A batched catch-up request covers two threads, one with no new events and one with a new event.
- **When** The runtime performs the batched chat catch-up.
- **Then** It reports only the thread with new events, and cache-only reads show an empty list for the unchanged thread and the new row for the updated thread.

**Unverified clauses.** 只给一个线程交付新行，再重开两个会话核对其不同内容。缓存返回的失效 ID 全集及两个列表未通过业务界面公开。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

### realtime-004

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-004)

- **Given** A signed-in user requests an organization-scoped run-queue update while an organization is active.
- **When** Realtime connects and a matching event arrives on the active organization’s channel.
- **Then** The handler runs once on the active organization channel; no subscription is made on the user channel.

**Unverified clauses.** 用相同容量消息分别投递组织及用户频道，组织的队列抽屉只在正确频道从 6/7 更新为 4/7。相同更新重复交付不改变最终数字，单次回调和从未订阅另一频道仍缺证。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### realtime-005

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-005)

- **Given** A signed-in user requests a live update, but the realtime-token service responds with HTTP 500.
- **When** Realtime setup and the pending subscription attempt to connect.
- **Then** Both reject with an Ably connection failure, no live subscription remains, and a later subscription request also rejects with an Ably connection failure.

**Unverified clauses.** A terminal worker failure can be injected through local Ably. The two initial callers and a later independent subscription rejecting the same failure were not publicly observable. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### realtime-006

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-006)

- **Given** Realtime is suspended and a subscriber is waiting for a channel attachment.
- **When** The user cancels that subscriber while attachment is pending.
- **Then** The wait rejects with the subscriber’s cancellation reason, and its channel subscription is removed.

**Unverified clauses.** The route can be closed during attach. The typed cancellation reason returned to its one-shot waiting promise is not observable by the user. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### realtime-008

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-008)

- **Given** A signed-in user’s realtime transport is suspended before a live-update subscription is created.
- **When** The transport reconnects and the matching event arrives.
- **Then** The subscription remains available through the suspended period and its handler runs once after reconnection.

**Unverified clauses.** The open-chat experiment suspended the existing credential connection before opening the viewer. No run-output registration was observed while suspended. Suspending after attachment starts covers a different initial condition. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### realtime-010

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-010)

- **Given** A signed-in user starts a background subscription while the transport is suspended and provides an error callback.
- **When** The channel later reports a terminal “connection failed” error.
- **Then** The callback receives that error, and the channel subscription is removed.

**Unverified clauses.** A terminal loss was delivered to the active local provider. No public component exposes the original subscriber error callback and removal of that exact subscription together. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### realtime-011

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-011)

- **Given** A signed-in user creates a payload subscription with `runOnSubscribe` omitted.
- **When** The subscription receives a payload, then the transport disconnects and reconnects.
- **Then** Initialization runs once on subscription and once after reconnection; the payload is handled, and the continuity gap triggers recovery.

**Unverified clauses.** The native trace includes payload, gap and reconnect. The startup-vs-reconnect initializations with runOnSubscribe omitted and their independent application completion are not observable for the same payload consumer. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### realtime-019

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-019)

- **Given** A signed-in user is subscribed to realtime notifications for a chat thread, including thread detail and automation invalidations.
- **When** A thread-detail notification arrives, followed by an automation notification for that thread.
- **Then** The first notification invalidates thread detail and connector preference resources. The second also invalidates automations.

**Unverified clauses.** The chat registered thread-detail and automation invalidations. The current kind-specific callbacks and visible resources do not establish all the original preference/detail/automation invalidations in the stipulated order. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### realtime-020

Frozen owner: `turbo/apps/platform/src/signals/__tests__/realtime.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/__tests__/realtime.bdd.md#realtime-020)

- **Given** A signed-in user subscribes to chat-thread live updates, but the initial subscription refresh fails.
- **When** Subscription initialization throws an error.
- **Then** The subscription request rejects with the initialization error, but the chat-thread automations live subscription remains active.

**Unverified clauses.** The live automation subscription exists. No public component accepts a failing initialization callback and returns its rejection while keeping that exact subscription active. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** 零采样输入没有进入可停止状态，而有声输入可停止并上传 WAV；因此尚不能观察原 Given 的空录音正常结束以及返回零段。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### voice-draft-audio-013

Frozen owner: `turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.test.ts` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/signals/voice-io/__tests__/voice-draft-audio.bdd.md#voice-draft-audio-013)

- **Given** A voice draft contains 73 seconds of samples after recovery, with a retained checkpoint at 60 seconds.
- **When** The next segment is requested before recording is finished.
- **Then** A non-final segment covers samples 58 through 73 seconds; the retained 60-second checkpoint is not resliced.

**Unverified clauses.** 持续录至 73 秒，实际整段 WAV 与停止尾段分别覆盖 52–67 与 65–73 秒。录制者可区分两种交付，却未在真实页面构造 60 秒检查点恢复得到 58–73 的输出。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** Revalidation conflicts before and after repaint reach terminal 409/protocol diagnostics. Manual reconnect restores input. The single public report does not order two separately delivered errors. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-95.tsv).

### browser-automatic-recovery-008

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#browser-automatic-recovery-008)

- **Given** Three failed image attempts have consumed 65 seconds, and the last attempt begins with one second remaining in the original recovery deadline.
- **When** The endpoint is replaced in the same window, the deadline expires, and the replacement frame fails.
- **Then** Recovery is exhausted and no further automatic attempt starts, even after four seconds. Manual reconnect restores input on the replacement endpoint without adding a report.

**Unverified clauses.** Early and expired frames distinguish recovery at 70 and 180 seconds. Manual reconnect reaches the replacement input after four seconds. The third attempt's start at exactly 179 seconds remains unproven. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-95.tsv).

### browser-automatic-recovery-022

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#browser-automatic-recovery-022)

- **Given** Image recovery is underway while creation of a new tab is pending.
- **When** The user explicitly selects another tab before creation completes.
- **Then** The explicit selection remains active and accepts input; completion of the pending creation does not change it. A later New tab action creates a second blank tab, with no recovery report.

**Unverified clauses.** Selecting Other preserved input, but superseding the pending new-tab command left zero blank targets instead of two independent usable blank pages. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-82.tsv).

### browser-automatic-recovery-075

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-automatic-recovery.bdd.md#browser-automatic-recovery-075)

- **Given** The browser is ready in shared connection mode and an image retry is in progress when control is lost.
- **When** Automatic recovery continues for the shared connection.
- **Then** The same recovery budget continues, the browser becomes ready, and subsequent text reaches the remote browser.

**Unverified clauses.** Holding the replacement version response through the 180s boundary did not produce a confirmed exhausted episode. Previous ready/input evidence cannot discriminate a newly allocated budget. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-82.tsv).

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

**Unverified clauses.** 替换 descriptor 超时后 Reconnecting → 新窗口可输入，迟交/扣住两组均到替换页。仅迟交组实际读到旧回复；等待时禁用的输入没有隐藏祖先，不满足冻结前提。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-007

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-007)

- **Given** Native startup is held while the viewer is paused.
- **When** Startup exceeds 30 seconds, then the viewer resumes and the old native setup is released.
- **Then** The failed startup connection is retired, a new startup becomes usable, and input works on the original page using two total connections.

**Unverified clauses.** 旧握手迟交或持续扣住时，原标签皆可通过替换连接重新输入。旧 socket 关闭并不能证明它处理了迟到消息，两个业务接收端也不能排除同结果的附加连接。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-009

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-009)

- **Given** The initial browser descriptor request is held while the viewer is connecting.
- **When** It exceeds one minute, the binding changes, recovery completes, and the old descriptor response arrives late.
- **Then** The replacement page becomes usable and accepts input in its own session using one connection; the old page tab is absent.

**Unverified clauses.** Both delivered and withheld descriptor controls left the replacement address and typing identical. Service ingress or serialization does not identify consumption by the page. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-011

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-011)

- **Given** The viewer is ready in shared connection mode with one descriptor fetched.
- **When** The user switches to a separate image connection and the successive attachment, hello, and window proof phases take 21, 21, and 19 seconds.
- **Then** The shared startup budget expires and recovery makes the viewer usable; the descriptor is not refreshed before timeout and is fetched once for recovery, with no alert.

**Unverified clauses.** Transport phases and expiry were observable, but the remaining exact-one descriptor fetch was distinguished only by counting requests, which the testing guide excludes. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-018

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-018)

- **Given** A ready viewer disconnects, and the first reconnect descriptor request fails with a server error.
- **When** The binding changes to a replacement window and the browser disconnects again.
- **Then** The replacement page becomes usable with its New tab action enabled, and the earlier browser-action failure message is absent during the later reconnect.

**Unverified clauses.** The replacement address, enabled New tab and absent error matched delivery even when the first descriptor reply was withheld. An independent delivered-500 probe could not observe the original action-error message before switching. Server ingress is insufficient to establish that the earlier failure was processed. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-022

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-022)

- **Given** The ready viewer disconnects and begins recovery while the page is not paused; recovery paint is held.
- **When** The user navigates to the next chat before releasing the old paint, then waits over one minute and releases it.
- **Then** The replacement page becomes usable and accepts input in its own session; the old recovery does not retire it.

**Unverified clauses.** The replacement chat receives new input equally when the old recovery delivery is withheld. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-023

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-023)

- **Given** The ready viewer disconnects and begins recovery while the page is not paused; recovery paint is held.
- **When** The page is hidden, then the user navigates to the next chat while paused and makes it visible before releasing the old paint.
- **Then** The replacement page becomes usable and accepts input in its own session after the old paint is released; the old recovery does not retire it.

**Unverified clauses.** Releasing or withholding the old paint after changing chats while hidden leaves the same replacement input outcome. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-024

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-024)

- **Given** A ready viewer in shared-wire mode disconnects, and recovery capture is acknowledged but its image is held.
- **When** The wall clock moves back one hour and more than 30 seconds of monotonic time pass, then the image is released and recovery retries.
- **Then** The viewer shows reconnecting and remains disabled until retry succeeds, then becomes usable.

**Unverified clauses.** The prior image was withheld while wall time moved backwards. The retry capture needed to anchor monotonic expiry did not arrive at the required boundary. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-026

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-026)

- **Given** A ready viewer has two tabs in the same window, and the original tab is usable in shared-wire mode.
- **When** The user selects the replacement tab while its first image is held past 30 seconds, then retries with another held image that also exceeds 30 seconds.
- **Then** Each timeout shows reconnecting without disabling the original tab; after the retry image is released and recovery completes, the replacement tab is usable and accepts input in its own session.

**Unverified clauses.** The documented clock and held image did not establish both expired retries, their visible reconnecting states and restored replacement input in the original order. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-029

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-029)

- **Given** A ready viewer has a replacement tab in the same window, and its capture acknowledgement and first image are held.
- **When** The capture acknowledgement is delayed 20 seconds, then the image remains held for more than 30 seconds.
- **Then** The viewer shows reconnecting without replacing its connection; after the image is released and recovery completes, the replacement page is usable.

**Unverified clauses.** Delaying the start receipt and holding the first picture did not produce the expected reconnecting state at the picture-relative deadline. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-031

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-031)

- **Given** A ready viewer is paused and resumed with the original tab's first image held; capture cleanup is also held after the image deadline expires.
- **When** The user selects the replacement tab before releasing cleanup and the old image.
- **Then** The replacement page remains usable after both old operations are released and accepts input in its own session.

**Unverified clauses.** After resume and image expiry, the pending old stop-screencast acknowledgement required by the scenario did not arrive before the selection. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-034

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-034)

- **Given** A viewer is switching to separate-image mode while native startup is held, then the viewport is paused and shared mode is unavailable.
- **When** The browser binding changes and its descriptor arrives while paused; shared mode becomes available, then the viewport resumes.
- **Then** The replacement page becomes usable and accepts input in its own session after the old native operation is released.

**Unverified clauses.** A replacement descriptor and address appeared while the transport was pending, but fresh text on its own page session was not established after release. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-035

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-035)

- **Given** A ready viewer begins automatic recovery after a temporary native proof failure; the proof is held.
- **When** The user changes connection mode, another native proof failure triggers recovery, and the old proof is released after recovery completes.
- **Then** The viewer becomes usable and accepts input on the original page in its own session.

**Unverified clauses.** Current-transport readiness and fresh input still pass with the prior transport proof withheld. No acknowledgement distinguishes that old response. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-039

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-039)

- **Given** The browser's native hello request receives no reply.
- **When** Its deadline expires, the user reconnects, and the late hello reply arrives.
- **Then** The browser view is unavailable and input is disabled until the user explicitly reconnects. The late reply is not replayed; a subsequent new-tab action creates one tab in the original window.

**Unverified clauses.** The unavailable screen, explicit Reconnect and new tab all work with the old native hello withheld. None proves handling of that hello. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-043

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-043)

- **Given** The browser is ready on a shared connection, and a native window read is pending after a tab attaches.
- **When** The read times out and automatic recovery runs without replacing the browser binding; the late reply then arrives.
- **Then** Input and new-tab controls are disabled during reconnecting. Recovery returns to the original address without changing the connection count, and fresh input works after the late reply.

**Unverified clauses.** The original address and fresh input still pass when the old native scope reply is withheld. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-051

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-051)

- **Given** The browser is ready and a navigation request is sent without receiving its response.
- **When** The request passes its response deadline and recovery completes.
- **Then** The navigation request is sent exactly once; it is not replayed.

**Unverified clauses.** Recovery reaches the accepted URL, but replay of the same destination has the same final URL. The exact-once clause was not verified via a distinct navigation effect. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-response-deadlines-053

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.bdd.md#browser-response-deadlines-053)

- **Given** The browser is ready on one chat, and a native window read is pending.
- **When** The user navigates to another chat before the read deadline, waits past the deadline, and then the old reply arrives.
- **Then** The next chat shows the replacement address and accepts fresh input on its page. No error is reported.

**Unverified clauses.** Switching chats shows the replacement address and delivers text with the old proof still withheld. The missing acknowledgement remains with this ID. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

### browser-viewer-interaction-006

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-006)

- **Given** The user has submitted the invalid address ///invalid and received a validation alert; the page remains at https://example.com.
- **When** The selected page is detached and reattached through a membership refresh.
- **Then** The invalid draft remains focused and unchanged, and the page remains at https://example.com.

**Unverified clauses.** 三斜线输入在真实表单提交后显示浏览器动作错误，保持原地址。普通 membership refresh 期间输入禁用，放行后保留焦点、草稿和原 CDP 会话；更正有效地址才真正导航。同窗口 detach/attach 通知实验中原会话退出但没有可用的新页面会话。#47099 确认三斜线校验，并未退役原 When。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** The native key-down and key-up reached the original target. With the key-up acknowledgement held, hiding stopped the screencast and resuming showed Updating view. Even after acknowledging capture stop, the replacement screencast did not start while the original key receipt remained outstanding. This probe cannot paint the replacement before the original key release as required. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-viewer-interaction-122

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-122)

- **Given** The viewer uses a separate image connection, and the control session detaches while Other's image attachment is pending.
- **When** The image attachment completes.
- **Then** The input becomes enabled, and the user can enter a URL and navigate to it.

**Unverified clauses.** The split viewer recovers Other and navigates after its control detach. Running the same test without delivering the held image attachment still enables input and navigates. These outcomes do not establish consumption of the obsolete image attachment. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-viewer-interaction-133

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-133)

- **Given** The user selects Other while membership admission is pending, then its target closes while a native proof for the old selection is still unacknowledged.
- **When** The selection is cancelled and the user selects Last before the old proof completes.
- **Then** Tab controls are available, Last remains selected with input enabled after the proof completes, and the user can navigate to a new URL.

**Unverified clauses.** The selected Other target's CDP membership request was observed. Interposing the native getTab or getWindow response did not establish the required simultaneous unacknowledged native proof and selection of Last before its completion. No added selection or keyboard workaround was used. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-viewer-interaction-148

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-148)

- **Given** The selected scoped tab's membership lookup is pending, and another scoped tab and a foreign tab exist.
- **When** The selected target is destroyed before the membership lookup fails.
- **Then** The surviving scoped tab is automatically selected and usable; the destroyed and foreign tabs are excluded. Navigating updates only the survivor to http://survivor.example/ready.

**Unverified clauses.** After destruction of the selected target the surviving scoped tab alone accepts navigation, and the foreign tab is excluded. Keeping the failed membership response entirely outstanding produces the same results as delivery. There is no completion signal for the old failure. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-viewer-interaction-155

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-155)

- **Given** The selected tab's membership lookup failed and a target-loss confirmation is pending; another tab is available.
- **When** The user selects the other tab, then the pending confirmation succeeds; the original target may or may not have been destroyed before the selection.
- **Then** The newer tab remains selected with input enabled and its address unchanged. The original tab is absent after its destruction is reported.

**Unverified clauses.** After original destruction and selection of Other, delivering the successful confirmation and withholding it both leave Other selected, enabled and unchanged. The disappearance is established by the earlier destruction event. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### browser-viewer-interaction-158

Frozen owner: `turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/browser-session/__tests__/browser-viewer-interaction.bdd.md#browser-viewer-interaction-158)

- **Given** The selected tab's membership lookup failed and a target-loss confirmation is pending; another tab is available.
- **When** The user selects the other tab, then the pending confirmation fails; the original target is destroyed only afterward.
- **Then** The newer tab remains selected with input enabled and its address unchanged. The original tab disappears when its later destruction is reported.

**Unverified clauses.** While a failed target-loss confirmation was outstanding for the still-existing original page, clicking Other did not commit it as the selected tab before reply delivery. The probe failed at aria-selected, so destruction-before-selection from 155 was not substituted. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

### agent-suggestions-007

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.bdd.md#agent-suggestions-007)

- **Given** For you initially shows one workspace's cards; the user views Agents before changing workspaces.
- **When** The active workspace changes and the user opens For you again.
- **Then** The new workspace's card appears, and the previous workspace's card does not.

**Unverified clauses.** 次级 Agents 入口退役有上游出处；原工作区和新工作区卡片分别归属哪个工作区仍需从保留入口验证。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### agent-suggestions-012

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.bdd.md#agent-suggestions-012)

- **Given** A suggestion action targets a chat with a run already in progress.
- **When** The user chooses the action and then sends it from the chat composer.
- **Then** The existing chat opens with the suggested content in its composer, and sending queues the message in the running chat with the referenced chat included.

**Unverified clauses.** #37169 明确普通 runless 文本的呈现，不能据此证明这条建议的入队及交付结果。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### agent-suggestions-013

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.bdd.md#agent-suggestions-013)

- **Given** The user has loaded a suggestion action for a new chat.
- **When** The server responds to consumption with a later version of that option that points to a different chat and contains different text.
- **Then** The loaded action is sent to a new chat with its originally loaded content, not the later server content, and the user remains on For you.

**Unverified clauses.** 迟到的选项提供不同文本和聊天。最初的发送及 All caught up 在消费结果返回前就出现。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### agent-suggestions-015

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.bdd.md#agent-suggestions-015)

- **Given** At least two cards are available, but no model is available to send a message.
- **When** The user chooses the first card's action.
- **Then** The unavailable-model error appears, and the first card remains in its original place.

**Unverified clauses.** 外部模型列表为空时，内置 Auto 仍然可用，无法建立无可用模型的前提。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### agent-suggestions-021

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.bdd.md#agent-suggestions-021)

- **Given** A suggestion's custom-direction dialog contains a typed follow-up, and sending it initially fails.
- **When** The user retries the send and the server accepts it.
- **Then** The failure leaves the dialog and its text intact; the retry uses the same chat and event identities and includes the suggestion background and follow-up. Acceptance closes the dialog, removes the card, shows the sent confirmation and All caught up, and leaves the user on For you; no ordinary card-consumption request is recorded.

**Unverified clauses.** 原对话框由内联编辑替代；失败后保留编辑器和身份的回归不能证明没有普通 consume。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** 真实录音、转写、持久化和路由重开后，用已保存的 128 段生成 128 个独立 polish 项，完整文本进入编辑器；若重转写会得到不同文案。长程补充验证与短录音主套件分列，常规时限内仍缺此规模的注册。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-capability-voice-recording-005

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-recording.bdd.md#chat-capability-voice-recording-005)

- **Given** A restored recording contains 129 completed transcript segments.
- **When** The user chooses the recording when polishing is available.
- **Then** The composer receives all transcript text, grouped into 65 polish segments with up to two transcripts per item; the audio is not retranscribed.

**Unverified clauses.** 同一真实录音链路构造 129 段，重开后读出 64 个双段及最后一个单段；另有缺转写时重新读取的对照。常规 App 套件仍保留规模缺口。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** 96e318f041 恢复的 Vitest 30 轮注册在几何替身上覆盖顶边、落点、卸载。原生 Chromium 已证 24 个标记、点击第一问、落点、24/30 卸载，但稳定布局中首问锚点距视口顶边 60px。 #49915 撤回分页，#50032 恢复分页；#50327 是 staff scroll-room 开关，未提供修改精确顶边子句的依据。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

## `src/views/okou-page/__tests__/chat-metadata.test.tsx`

### chat-metadata-003

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.bdd.md#chat-metadata-003)

- **Given** The user enters a chat while its metadata request is pending, leaves for Agents, and the abandoned request then completes.
- **When** The user returns to the chat, whose new metadata lookup reports not found.
- **Then** The abandoned title is never shown; Agents remains correctly titled after leaving, and on returning no chat region or abandoned title appears.

**Unverified clauses.** 第 77–79 批迟交与扣留对照已有旧标题和 Workflows 标题的结果。回到 404 会话仍有 chat region；没有支持删除该 Then 的上游。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** 历史答复在关闭 Automations 后保持同一屏幕位置与距底距离。复查业务锚点不依赖写入次数；观察窗内单个实际滚动调整仍无稳定证据。 Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-005

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-005)

- **Given** The reader is in history with a message anchored before opening Automations.
- **When** A new completed reply arrives while the transcript is hidden, and the reader closes Automations.
- **Then** The original message remains at the same screen position after reveal, with one scroll adjustment.

**Unverified clauses.** 隐藏期间新回合完成；回到聊天后的原位置与新答复均可验证。跨隐藏与恢复全过程恰好一次物理调整仍无独立归属。 Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-006

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-006)

- **Given** The reader is in history on the primary conversation at a narrow viewport, and Automations covers the transcript.
- **When** They Alt-click a side conversation in the chat list, opening it alongside the primary conversation and dismissing Automations.
- **Then** The primary conversation remains at its route with the side conversation selected in the sidebar query, and the empty side conversation shows capability discovery. The original reading anchor is restored; subsequent image growth and incoming replies preserve its screen position without returning to the tail.

**Unverified clauses.** The side-chat fixture did not establish the requested independent target and history. Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-007

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-007)

- **Given** The reader reaches the tail, then changes the live scroll offset to 275 before opening Automations at a narrow viewport.
- **When** A new completed reply arrives while the transcript is hidden, and the reader closes Automations.
- **Then** The transcript restores to scroll offset 275 and the same message remains at the same screen position.

**Unverified clauses.** The browser layout fixture observed two scroll adjustments where the original scenario requires one. Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-008

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-008)

- **Given** The reader reaches the tail, changes the live scroll offset to 275, and opens Automations at a narrow viewport.
- **When** A new reply containing a Mermaid diagram begins asynchronous image preparation, and the reader closes Automations before preparation finishes.
- **Then** The oldest message at the captured reading position remains at the same screen position while preparation is pending and after the diagram image is ready; the reader is not forced to the tail.

**Unverified clauses.** Revealing the older diagram moved the measured anchor from 155 to 0. Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-017

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-017)

- **Given** The reader is in history in standalone PWA mode with a multiline draft in the composer.
- **When** They focus the composer through three keyboard-viewport shrink, pan, and restore cycles, then resize the layout viewport.
- **Then** The same message remains at the same reading position throughout, and the focused composer retains both draft lines through the keyboard cycles.

**Unverified clauses.** The history anchor moved. The probe could not obtain the required Scroll to bottom control for the final step. Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-018

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-018)

- **Given** The reader is at the tail of a completed conversation with an empty composer.
- **When** They open Research from the Add menu, then close the capability tray.
- **Then** The transcript remains at the tail while the tray reduces its viewport height by 120 pixels and after it closes; the composer remains empty and the conversation route does not change.

**Unverified clauses.** The Research view opened. Closing the capability tray and the required 120-pixel viewport transition remain unproven. Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-019

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-019)

- **Given** The reader is in history in a stopped conversation with an empty composer.
- **When** They open Research from the Add menu, then close the capability tray.
- **Then** The same message remains at the same reading position while the tray reduces its viewport height by 120 pixels and after it closes; the composer remains empty and the conversation route does not change.

**Unverified clauses.** The Research view opened. Closing the capability tray and the required 120-pixel viewport transition remain unproven. Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-020

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-020)

- **Given** The reader is in history with a visible message anchored in the transcript.
- **When** A late-loaded image above the messages increases content height by 75 pixels.
- **Then** The anchored message remains at the same screen position.

**Unverified clauses.** The image and scrolled-history fixture did not establish the reference position required by the Then. Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-023

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-023)

- **Given** The reader is in history with a visible message anchored in the transcript.
- **When** Two completed replies arrive in succession.
- **Then** Both new replies become visible while the original anchor remains at the same screen position.

**Unverified clauses.** The retained message moved from the measured 180 to -1440 after the append. Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-024

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-024)

- **Given** The reader is near the top of a loaded history window, and the sixth question is not yet displayed.
- **When** Older messages load as the reader scrolls.
- **Then** The sixth question becomes visible and the previously visible anchor stays at the same screen position.

**Unverified clauses.** The sixth question did not render at the target position. Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### chat-scroll-025

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/chat-scroll.bdd.md#chat-scroll-025)

- **Given** The reader is viewing the latest history window, with earlier groups not yet loaded.
- **When** They scroll near the top, away from it, and stop near the top again.
- **Then** The sixth question loads once and the original visible anchor stays at the same screen position; the fourth question remains absent.

**Unverified clauses.** The sixth question did not render at the target position. Scroll capture uses the visible event anchor and hands reflow to native anchoring. #50334 changes voice-chip rendering, not the anchor or tray geometry in this Given. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx`

### composer-custom-template-recommendations-009

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/composer-custom-template-recommendations.bdd.md#composer-custom-template-recommendations-009)

- **Given** The user has a draft in the Image composer and opens the Image shelf.
- **When** They paste an unsupported PDF, then import a valid WEBP image as a reusable style.
- **Then** The PDF is not attached and does not send a message; the draft remains and an Image removal control is present. The WEBP starts a reusable-template analysis and publish message containing the file, without selecting a generation template, and navigates to a chat.

**Unverified clauses.** 实际粘贴 PDF 会加入编辑器，选择器过滤同一 PDF；两臂都能继续把 WEBP 导入模板。#50326 只改从 Create 卡进入，未更改粘贴契约。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

## `src/views/okou-page/__tests__/connector-directory.test.tsx`

### connector-directory-010

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/connector-directory.bdd.md#connector-directory-010)

- **Given** The connector catalog contains Gmail, which supports provider authorization.
- **When** The user tabs to Connect Gmail and presses Enter.
- **Then** One authorization window opens at the Gmail authorization URL and one OAuth connection request is made. Closing the dialog closes the authorization window.

**Unverified clauses.** Tab and Enter issued one real API attempt. The digest of its state matched the single cross-origin Gmail popup. With OAuth completion still pending (404), Escape removed the directory but the provider page remained open at the six-second check. Closing before releasing the start response did close the popup. Closure after the provider destination loads remains unproved. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-101.tsv).

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

**Unverified clauses.** 原生 opener 丢失后，Discord 的 proof 从 URL 移除，显示中断提示且无打开 Discord 链接。相同审批重复抵达能否产生不同业务回执仍缺证。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-98.tsv).

## `src/views/okou-page/__tests__/get-started-entry.test.tsx`

### get-started-entry-042

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.bdd.md#get-started-entry-042)

- **Given** An admin opens the connector step for a connector with two browser authentication methods.
- **When** They select that connector from the picker.
- **Then** A connect dialog named “Choice connector” offers “Workspace OAuth,” and the connector's full catalog entry is read once upon selection.

**Unverified clauses.** 从奖励步骤选中 Choice connector，扣住目录详情和放行后出现的两种 OAuth 选项可区分。重复详情读取可能显示完全相同的 Workspace OAuth，缺少单次读取回执。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-98.tsv).

## `src/views/okou-page/__tests__/integrations-discord.test.tsx`

### integrations-discord-016

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.bdd.md#integrations-discord-016)

- **Given** A user opens a Discord callback URL marked connected, but the account status says there is no verified connection.
- **When** The callback page loads.
- **Then** The user is taken to /settings/discord with status=connected and sees the Connect to Discord heading. No Connect action, Open Discord link, provider error detail, or completion request appears.

**Unverified clauses.** 传入 connected 与私有错误、state、completionToken，成员状态返回未连接。实际清理到 /settings/discord?status=connected，没有 Open Discord 或提供方错误，但页面确有可用 Connect。已移除对内部完成次数的断言。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### integrations-discord-037

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.bdd.md#integrations-discord-037)

- **Given** Discord is disconnected, and the user leaves Works for Chat while Discord status refresh is pending.
- **When** The user returns to Works before the refresh completes.
- **Then** The Discord card continues to show its description and an enabled Connect button; after refresh it shows Connected.

**Unverified clauses.** 离开并返回 Works 时扣住 Discord 状态，说明可读、Connect 消失。相同操作分别释放 connected / disconnected，前者显示 Connected 和可用 More options，后者重新显示可用 Connect。原等待中可点击 Connect 仍缺。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### integrations-discord-038

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.bdd.md#integrations-discord-038)

- **Given** Discord is connected, and the user leaves Works for Chat while Discord status refresh is pending.
- **When** The user returns to Works before the refresh completes.
- **Then** The Discord card continues to show its description and Connected status; after refresh it still shows Connected.

**Unverified clauses.** With the initial card connected, the return route reached the description but not the cached Connected status during the retained refresh. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

### integrations-discord-040

Frozen owner: `turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.test.tsx` · [Original frozen entry](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/src/views/okou-page/__tests__/integrations-discord.bdd.md#integrations-discord-040)

- **Given** Discord initially shows Connected, then a status refresh is denied with a 403 error.
- **When** The user returns to Works after leaving for Chat, once status access is available again.
- **Then** During the error, the card shows “Discord access denied” and its description, with no buttons or stale Connected status. On returning, it shows Connected again.

**Unverified clauses.** Connected was visible. After the 403 refresh, the requested Discord access denied text did not appear. Recovery after the denied card remains unproved. [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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

**Unverified clauses.** 只扣住账单刷新，空账户与 Connect account 均可用。另一路先加载空账户，再从账户菜单发起订阅读取并扣住账单与订阅，重开 Models 时标题 Use more models 仍在，内容显示 Loading accounts…，未显示空账户文案或连接控件。放行订阅后出现 member4@example.test。#37519 解释标题替换，不能证明两项读取均待决时控件可用。 [Case review](https://github.com/okou-ai/okou/blob/557f30ebbb771a9006ca3e9389e5129ab274e560/turbo/apps/platform/test-rebuild-batch-100.tsv).

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
