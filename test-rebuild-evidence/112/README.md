# App test rebuild, batch 112

The starting register contained 83 cases. All 20 assigned IDs were open and were processed. 9 original GWTs passed for the first time, leaving 74 open. Historical restorations, revisions and retirements each total zero. The six product decisions remain with their original owners. The independent upstream register retains all 68 scenarios.

[Case ledger](../../turbo/apps/platform/test-rebuild-batch-112.tsv) · [Set difference](reconciliation.json) · [Source comparison](comparison.json) · [Checks and replay](checks.md)

## message-port-023

Two signed-in Windows registered on the same physical SharedWorker. A single chatIndicatorsChanged publication reached both. On each original port the active get-computed for chat-thread-indicators had no reply while A had failed and B was still held. Releasing B delivered a second credential failure, followed by error on each original request ID. The upstream worker uses Promise.any. The error on the wire contained only message and name. Both Windows saw a deserialized Error named AggregateError, with no AggregateError prototype or errors list. On the next control publication A still failed and B supplied the credential for a successful unread refresh. The frozen assertion matches reason.name. Snapshot errors were excluded.

Covered at the frozen named-rejection boundary. Preserving AggregateError instances or member reasons would require changing the serialization contract.

[worker-context.ts](../../turbo/apps/platform/src/shared-database/worker-context.ts) · [protocol.ts](../../turbo/apps/platform/src/shared-database/protocol.ts) · [registered-ports.native.test.mjs](../../test-rebuild-evidence/112/registered-ports.native.test.mjs) · [Upstream change](https://github.com/okou-ai/okou/commit/c514dae7e111b29e03b14af579f73c9096b4475f) · [Upstream change](https://github.com/okou-ai/okou/commit/944979a1412592028ce9e91a5a5ac334660904a2)

## message-port-020

Both tabs first registered on one native worker. Chromium temporarily froze the already-registered B window. One real indicators publication requested A’s credential, which remained held. Resuming B let it issue its own indicators read and respond immediately. The API receiver identified B, and the matching result on B contained the side thread’s unread timestamp before A supplied any credential. Both windows received token requests. Provider attribution uses aliases only.

Covered by the B-owned request, its exact result and the credential receiver while A was pending.

[worker-context.ts](../../turbo/apps/platform/src/shared-database/worker-context.ts) · [worker-signals.ts](../../turbo/apps/platform/src/shared-database/worker-signals.ts) · [registered-ports.native.test.mjs](../../test-rebuild-evidence/112/registered-ports.native.test.mjs) · [Upstream change](https://github.com/okou-ai/okou/commit/c514dae7e111b29e03b14af579f73c9096b4475f)

## message-port-027

A and B registered against one worker. A selected a different signed-in account and the Clerk boundary held that selection. An independent worker observer saw disconnect followed by close on the first port. With the service offline B opened a different thread. Its own chat-event cache-only request returned an empty array with the same request ID and its port remained usable. Merely closing a browser tab had not produced the worker-side close receipt in the control.

Covered by real account release, independent worker-side port close and B’s cache-only result.

[message-port-server.ts](../../turbo/apps/platform/src/shared-database/message-port-server.ts) · [shared-database-bridge-state.ts](../../turbo/apps/platform/src/signals/shared-database-bridge-state.ts) · [registered-ports.native.test.mjs](../../test-rebuild-evidence/112/registered-ports.native.test.mjs) · [Upstream change](https://github.com/okou-ai/okou/commit/c514dae7e111b29e03b14af579f73c9096b4475f)

## message-port-011

Searched Router subscribers and the worker topic registry for newFeature:changed. The worker has accepted arbitrary registered topic strings since #34736. The only matching application-tree call emits a negative control in startup-data-readiness.test.tsx. The registered production consumer never asks for this literal. The two-window, correctly addressed automation control in this batch delivered a first event to each original subscriber.

Need a supported caller subscribing to newFeature:changed. Wrong user, wrong name, correct delivery and retention of the existing chat row must be tested together.

[worker-realtime-subscriptions.ts](../../turbo/apps/platform/src/shared-database/worker-realtime-subscriptions.ts) · [realtime.ts](../../turbo/apps/platform/src/signals/realtime.ts) · [startup-data-readiness.test.tsx](../../turbo/apps/platform/src/views/okou-page/__tests__/startup-data-readiness.test.tsx) · [Upstream change](https://github.com/okou-ai/okou/commit/39c8d353ab496edaa471543970c5474bd9147213)

## message-port-014

Two real tabs opened the same thread’s automation panel. Each subscribed once to the same user topic with its own ID. The first changed schedule reached both. Resuming a preserved channel yielded zero resyncs. A suspended connection followed by a continuity gap yielded one resync on each original ID. After A switched account, the next notification reached B alone. After B switched, the independent provider recorded unsubscribe for this exact topic on the original client. The separate presentation-shelf arm has multiple callbacks and was excluded from these counts.

Covered by independent provider receipts, both original subscription IDs, both visible schedules and final topic-specific release.

[worker-realtime-subscriptions.ts](../../turbo/apps/platform/src/shared-database/worker-realtime-subscriptions.ts) · [realtime.ts](../../turbo/apps/platform/src/signals/realtime.ts) · [registered-ports.native.test.mjs](../../test-rebuild-evidence/112/registered-ports.native.test.mjs) · [Upstream change](https://github.com/okou-ai/okou/commit/39c8d353ab496edaa471543970c5474bd9147213)

## message-port-033

A registered Chat tab started with one cached message. The independent window port received two indicator reloads for chatIndicatorsChanged and one for chatThreadReadCursorUpdated. Neither publication generated catch-up. Two real chat-message publications two seconds apart each generated one catch-up, returning zero then one new row from cursor 1. Reopening the original thread offline rendered both original and new messages. The registered page test independently verifies the unread badge, cursor update and transcript.

Covered by the Router history test and exact native invalidation, catch-up and offline controls.

[worker-signals.ts](../../turbo/apps/platform/src/shared-database/worker-signals.ts) · [updating-chat-indicators-at-home.test.ts](../../turbo/apps/platform/src/views/okou-page/__tests__/updating-chat-indicators-at-home.test.ts) · [registered-ports.native.test.mjs](../../test-rebuild-evidence/112/registered-ports.native.test.mjs) · [Upstream change](https://github.com/okou-ai/okou/commit/c514dae7e111b29e03b14af579f73c9096b4475f)

## message-port-036

Inspected both real producers of presentationTemplatesChanged. On a single registered port the two libraries allocated separate user subscriber IDs, separate organization IDs and subscriptions to other topics. Both libraries bind to the same authenticated root lifetime. Leaving the shelf does not cancel either root subscriber. The new account-switch control releases the whole registered connection and the other topics along with it.

Need separate production release controls for the two user subscribers on the same port, with the organization and other topic remaining live through release and reacquisition.

[presentation-template-library.ts](../../turbo/apps/platform/src/signals/okou-page/presentation-template-library.ts) · [custom-template-library.ts](../../turbo/apps/platform/src/signals/okou-page/custom-template-library.ts) · [authenticated-daemons.ts](../../turbo/apps/platform/src/signals/authenticated-daemons.ts) · [worker-realtime-subscriptions.ts](../../turbo/apps/platform/src/shared-database/worker-realtime-subscriptions.ts) · [Upstream change](https://github.com/okou-ai/okou/commit/ce8f7fc59e52c4da702aced0d641d41f57a63139)

## message-port-037

Held a real provider attach, closed its waiting Window, opened a second Window before release and then published to the surviving subscriber. The independent observer received different generated IDs. Checked realtime.ts, which allocates crypto.randomUUID per subscription, and the old-subscriber release path. Neither page navigation nor a transport resume selects a previously used ID. No original AbortError receipt was observed.

Need a supported caller that can cancel and reuse its original ID before the attach finishes, with the original rejection and exactly one successful subscription reply observable.

[realtime.ts](../../turbo/apps/platform/src/signals/realtime.ts) · [worker-realtime-subscriptions.ts](../../turbo/apps/platform/src/shared-database/worker-realtime-subscriptions.ts) · [message-port-client.ts](../../turbo/apps/platform/src/shared-database/message-port-client.ts) · [Upstream change](https://github.com/okou-ai/okou/commit/81e93c76a220f826e3b340b5465fe1db06efde10)

## message-port-038

While the user channel was attaching, A and B opened the same thread and issued a subscription for its exact automation topic. A terminal attach failure returned realtime-subscription-error on both original IDs. Publishing to that topic reached zero registered provider callbacks. B navigated to the side thread and back in the same Window on the same port, obtained a fresh subscribed ID and received the next publication. Its panel changed from Cedar to Maple.

Covered by both original error receipts, provider delivery-0 and the new B subscriber’s normal notification.

[worker-realtime-subscriptions.ts](../../turbo/apps/platform/src/shared-database/worker-realtime-subscriptions.ts) · [message-port-client.ts](../../turbo/apps/platform/src/shared-database/message-port-client.ts) · [registered-ports.native.test.mjs](../../test-rebuild-evidence/112/registered-ports.native.test.mjs) · [Upstream change](https://github.com/okou-ai/okou/commit/39c8d353ab496edaa471543970c5474bd9147213)

## message-port-039

Read the production SharedWorker entry, which gives the worker AbortSignal.any([]) for its global lifetime. Account switching exercised closure of a particular peer and a successful empty read on the survivor. The new separate-context presentation probe timed out before both shelves were ready. Prior isolated-worker delivery remains a control. Neither action demonstrates a resettable worker signal or a reused subscriber ID in two domains.

Need a supported worker reset observable outside the destroyed domain, the same subscriber ID in both domains, proof that the first lost its listeners and the survivor’s own cache-only result.

[shared-database-worker.ts](../../turbo/apps/platform/src/shared-database-worker.ts) · [realtime.ts](../../turbo/apps/platform/src/signals/realtime.ts) · [message-port-server.ts](../../turbo/apps/platform/src/shared-database/message-port-server.ts) · [Upstream change](https://github.com/okou-ai/okou/commit/39c8d353ab496edaa471543970c5474bd9147213)

## realtime-002

Enumerated the production waitAbly*Until callers. Link waits for wallet:changed and connector setup waits for connector:changed. The permission review and host authorization consumers subscribe to connectorPermissionUpdated, but their subscriptions persist across notifications. A successful last-topic release was independently observed for Chat automations in 014. It cannot establish completion of the original permission waiter.

Need a supported one-shot user-scoped connector-permission subscriber. Observe its first matching event, completion, worker-only authentication and release at the independent provider.

[realtime.ts](../../turbo/apps/platform/src/signals/realtime.ts) · [permission-allow-signals.ts](../../turbo/apps/platform/src/signals/permission-allow/permission-allow-signals.ts) · [host-authorization-block.ts](../../turbo/apps/platform/src/signals/chat-page/host-authorization-block.ts) · [connectors.ts](../../turbo/apps/platform/src/signals/okou-page/settings/connectors.ts) · [Upstream change](https://github.com/okou-ai/okou/commit/c83928ad6fc787a648fa6f2a71fbf5d98b3001cc)

## realtime-011

Link settings uses the production wallet:changed payload subscriber with runOnSubscribe omitted. Held its external user-channel subscription until the initial Connect page had rendered. Attaching refreshed to Update permissions. A member payload refreshed it to Connected. After suspension a missed server change appeared as Reconnect required when the transport reconnected. The separate service-receiver diagnostic observed one status read in each of these three bounded phases.

Covered by the registered Link settings journey and independently counted receiver phases.

[wallet.ts](../../turbo/apps/platform/src/signals/okou-page/settings/wallet.ts) · [realtime.ts](../../turbo/apps/platform/src/signals/realtime.ts) · [settings-wallet.test.tsx](../../turbo/apps/platform/src/views/okou-page/__tests__/settings-wallet.test.tsx) · [Upstream change](https://github.com/okou-ai/okou/commit/ce8f7fc59e52c4da702aced0d641d41f57a63139)

## client-007

Checked Platform policy, package exports and every production createCdpClient and Page.navigate caller. Only the viewer controller constructs this internal CDP client. The exported OkouBrowserClient extension API does not expose Page.navigate. The address dispatcher accepts navigation failure information and the tab creation path checks errorText. Neither returns a successful frame ID to its initiating caller. The two reverse wire replies and Router refusal from batch 108 were not repeated.

Need a supported API that exposes two different sessions on one client and returns each successful frame ID to its original caller, or a Router entry with the same observable results.

[testing.md](../../docs/testing.md) · [app-testing.md](../../docs/app/app-testing.md) · [controller.ts](../../turbo/apps/platform/src/signals/browser/viewer/controller.ts) · [effects.ts](../../turbo/apps/platform/src/signals/browser/input/effects.ts) · [tabs.ts](../../turbo/apps/platform/src/signals/browser/cdp/tabs.ts) · [index.ts](../../turbo/packages/browser-extension-client/src/index.ts) · [Upstream change](https://github.com/okou-ai/okou/commit/41c58f56993d3f45503ca3e0e4bdb2558b3e6970)

## client-003

Traced native attachment and its late-response callback through the real viewer. native.ts captures the parent session for Target.detachFromTarget. The earlier tab-move arm produced a detach without the original parent, while leaving the actual viewer closes its connection. The version latency sampler can run on a separate frames connection, which cannot establish that the cancelled parent connection was usable.

Need an independently cancellable native child with its originating parent kept alive, an observable AbortError, a successful version call on that exact connection and the late detach addressed to the same parent.

[native.ts](../../turbo/apps/platform/src/signals/browser/cdp/native.ts) · [client.ts](../../turbo/apps/platform/src/signals/browser/cdp/client.ts) · [frame-window.ts](../../turbo/apps/platform/src/signals/browser/viewer/frame-window.ts) · [controller.ts](../../turbo/apps/platform/src/signals/browser/viewer/controller.ts) · [Upstream change](https://github.com/okou-ai/okou/commit/e50e38e284b2e310198bf8f96cc0c44cd3752001)

## client-004

Followed the real native bridge startup owner, its pending browser-target attach and cancellation path. The viewer close simplification retains control-connection teardown when the viewer leaves. The actual deferred-response control previously lost its socket on exit. Startup’s own cancellation receipt and a later version request on that same live connection remain unavailable.

Need a supported bridge-start cancellation independent of connection closure, followed by the original AbortError, late native detach and successful Browser.getVersion on the same peer.

[native.ts](../../turbo/apps/platform/src/signals/browser/cdp/native.ts) · [client.ts](../../turbo/apps/platform/src/signals/browser/cdp/client.ts) · [controller.ts](../../turbo/apps/platform/src/signals/browser/viewer/controller.ts) · [Upstream change](https://github.com/okou-ai/okou/commit/85c641e01017caf8b3b6d830521cc62c242b57da)

## client-006

Two real Router viewers used different WebSocket connections and different physical Chromium windows. The loopback CDP provider assigned an equal page-session ID within each connection’s namespace. It forwarded native Chromium events unchanged apart from this reversible ID mapping. Two navigations on the first source updated only its viewer. After its socket closed, the independent original-page listener recorded a third navigation and the surviving viewer retained its old address. Its own later event used the same session ID on the other socket and updated only that viewer.

Covered by the originating native event, two separate socket IDs, shared public session ID and post-close receiver controls. Raw Chromium identities remain independently allocated.

[client.ts](../../turbo/apps/platform/src/signals/browser/cdp/client.ts) · [data.ts](../../turbo/apps/platform/src/signals/browser/navigation/data.ts) · [registered-ports.native.test.mjs](../../test-rebuild-evidence/112/registered-ports.native.test.mjs) · [Upstream change](https://github.com/okou-ai/okou/commit/8af86d99a0c521c2c43df969c901737b60a59ca2)

## client-008

Inspected page attachment cancellation, late-response disposal and the production Browser.getVersion latency reader. The real page lifecycle drops the original connection when that pending viewer is dismissed. The frame sampler or a successor viewer can return a version on a different connection. Neither supplies a before-and-after version on the original peer.

Need child-only page attach cancellation on a retained original connection, both successful version results around the late response, and independently observed cleanup of that returned session.

[client.ts](../../turbo/apps/platform/src/signals/browser/cdp/client.ts) · [controller.ts](../../turbo/apps/platform/src/signals/browser/viewer/controller.ts) · [frame-window.ts](../../turbo/apps/platform/src/signals/browser/viewer/frame-window.ts) · [Upstream change](https://github.com/okou-ai/okou/commit/8af86d99a0c521c2c43df969c901737b60a59ca2)

## clerk-user-003

The signed-in invitation page was held at feature startup, set to signed out and then transitioned before releasing bootstrap. The invitation remained pending. Clerk published user-a and then user-b in the same turn. Only A’s member resource belonged to the invited Field team. The original invitation completion displayed Invitation accepted for Field team after B became current. invitation-redirect.ts reads the membership from the awaited original user.

Covered by the pending UI and distinct member resources. The original consumer identifies A even after the current identity becomes B.

[invitation-redirect.ts](../../turbo/apps/platform/src/signals/invitation-redirect.ts) · [auth.ts](../../turbo/apps/platform/src/signals/auth.ts) · [workspace-invitations.test.tsx](../../turbo/apps/platform/src/views/okou-page/__tests__/workspace-invitations.test.tsx) · [Upstream change](https://github.com/okou-ai/okou/commit/4670cc5bb6acdaa2cefad6b46c1da7e4bdfae7a4)

## clerk-user-006

Traced the synchronous bootstrap prologue through setupClerkUser$, shared database initialization and authenticated realtime. The owner claims the deferred before awaiting Clerk. The bridge awaits Clerk/session identity, and authenticated realtime starts only after locale and feature switches. Even the HTML bootstrap response is consumed after featureSwitches$ has awaited clerk$, so an embedded response cannot advance this consumer past the held SDK. The reachable downstream subscriber can identify the resolved member, but it does not return the exact read requested synchronously before owner initialization finished.

Need a public reader whose invocation can be observed before the owner completes and whose own pending result resolves to A. A later user-scoped notification alone cannot discriminate that timing.

[auth.ts](../../turbo/apps/platform/src/signals/auth.ts) · [bootstrap.ts](../../turbo/apps/platform/src/signals/bootstrap.ts) · [authenticated-daemons.ts](../../turbo/apps/platform/src/signals/authenticated-daemons.ts) · [shared-database-browser.ts](../../turbo/apps/platform/src/signals/shared-database-browser.ts) · [feature-switch.ts](../../turbo/apps/platform/src/signals/external/feature-switch.ts) · [api-client-base.ts](../../turbo/apps/platform/src/signals/api-client-base.ts) · [Upstream change](https://github.com/okou-ai/okou/commit/2ca25eeaef8a322e40ce371c2e55090393f7255a) · [Upstream change](https://github.com/okou-ai/okou/commit/913086ee5a33ca0d0c35fe63e85ac5571b40cad9)

## clerk-user-007

Extended the same-member handoff control from 005. Held the original onboarding handoff after its service request, disposed its owner, installed a new Workflows owner for the same member and session, then emitted a Clerk transition. Released the held original and awaited its original Router readiness. It rejected with AbortError and the original prompt was absent. The successor’s member control was visible. The exposed promise belongs to the disposed operation and does not expose the old settled user promise.

Need an already-issued public observation preserving the old settled promise itself and its A value through replacement and the transition. The aborted onboarding operation cannot witness that identity.

[auth.ts](../../turbo/apps/platform/src/signals/auth.ts) · [marketing-handoff.ts](../../turbo/apps/platform/src/signals/prompt-page/marketing-handoff.ts) · [identity-startup.test.ts](../../turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts) · [Upstream change](https://github.com/okou-ai/okou/commit/56e28d455427e09e5511cf59868bfbc5a07626a6)
