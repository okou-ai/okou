# App test rebuild, batch 111

The opening register contained 90 unique frozen cases. All 20 selected cases were exercised. Seven original scenarios passed for the first time. There were no restorations, revisions or retirements. The remaining 83 cases include all six product decisions. The separate upstream register contains 68 scenarios.

[Per-case ledger](../../turbo/apps/platform/test-rebuild-batch-111.tsv) · [Receiver observations](observations.json) · [Source comparison](comparison.json) · [Set reconciliation](reconciliation.json) · [Verification](checks.md)

## message-port-018

Opened the signed-in unread history with the real message-port transport. A continuity gap made the worker-backed indicators caller await a refresh. While the service held delivery, the unread row and upgrade dialog were absent. A 200 delivered the named row. A uniquely tagged 426 instead reached the registered Window as an ApiError with status 426 and code REQUEST_FAILED and the upgrade dialog appeared. In two independent native Chromium runs the tagged object had the ApiError constructor and a port-deserialization stack only after delivery.

Covered by the unread-history Router suite and the held/delivered Chromium controls.

[chat-sync.ts](../../turbo/apps/platform/src/signals/chat-sync.ts) · [protocol.ts](../../turbo/apps/platform/src/shared-database/protocol.ts) · [registered-unread-refresh.test.ts](../../turbo/apps/platform/src/views/okou-page/__tests__/registered-unread-refresh.test.ts)

## message-port-023

Registered A and B against one native SharedWorker. Both requested chat-thread-indicators. The independent identity receiver recorded A failing, B remaining pending, then B failing after release. The healthy continuity-gap/publication control subsequently updated the unread shelf in B. The window observer did not receive an AggregateError attributable to this pair of indicator requests. The upstream credential change reuses the preferred provider before falling back to other windows. Its provider selection does not expose the result of a particular pending indicator read. [#39765](https://github.com/okou-ai/okou/commit/944979a1412592028ce9e91a5a5ac334660904a2)

Find a consumer that preserves the originating shared indicators read and returns its specific aggregate after both credential providers reject. The detached error from a separate snapshot is insufficient.

[worker-context.ts](../../turbo/apps/platform/src/shared-database/worker-context.ts) · [protocol.ts](../../turbo/apps/platform/src/shared-database/protocol.ts)

## message-port-030

Passive capture at both native window ports observed register-tab before the first chat-thread-event query. The production bridge awaits registerTab before making the client available. Inspecting the server's registration guard and the client's own guard found no supported user action issuing a pre-registration cache-only read. The production Clerk ownership change introduced an awaited registerTab before publication of the bridge. The server still retains its registration guard. [#31037](https://github.com/okou-ai/okou/commit/6ba1dbeb842c60a8b5c8f014bcfc7a624b2a7817)

An independently registered client entry that can issue cache-only before registration, or a final upstream change replacing that requirement, is needed.

[shared-database-bridge-state.ts](../../turbo/apps/platform/src/signals/shared-database-bridge-state.ts) · [message-port-server.ts](../../turbo/apps/platform/src/shared-database/message-port-server.ts)

## indexeddb-client-002

Visited Chat with a deliberate InvalidStateError from the native database-open boundary. The same attempt generated chat.open with error outcome and numeric duration and omitted the sensitive diagnostic, member and organization. The original Router readiness fulfilled and the composer was usable. The attempted comparison of its rejection with the original object failed because it fulfilled.

Find a public consumer that actually returns the open rejection. Compare its reason by object identity while retaining the telemetry privacy assertions.

[indexeddb-client.ts](../../turbo/apps/platform/src/signals/external/indexeddb-client.ts) · [chat-storage-telemetry.test.ts](../../turbo/apps/platform/src/views/okou-page/__tests__/chat-storage-telemetry.test.ts)

## indexeddb-client-003

Inspected production transaction users for event rows, metadata, diagnostics and voice drafts. Writes and cursor saves share write transactions; reads of a previously stored record use separate operations, or precede the write. The generic callback arranging put then get is exercised in the original test. The worker delta replay provides a two-request transaction comparison with public duration/outcome telemetry.

A production entry that writes and reads the same sensitive record in one read-write transaction must also return that value. The transaction request count cannot establish operation order or the returned object.

[#31772](https://github.com/okou-ai/okou/pull/31772) · [#31656](https://github.com/okou-ai/okou/pull/31656)

[idb-event-row-store.ts](../../turbo/apps/platform/src/signals/external/idb-event-row-store.ts) · [idb-metadata-event-store.ts](../../turbo/apps/platform/src/signals/external/idb-metadata-event-store.ts) · [idb-diagnostics-store.ts](../../turbo/apps/platform/src/signals/external/idb-diagnostics-store.ts) · [voice-draft-store.ts](../../turbo/apps/platform/src/signals/external/voice-draft-store.ts)

## realtime-005

With the realtime token receiver returning 500, invoked the provider's actual auth callback. It reported failure. Opened a second Router on the same thread: Question number 16 remained readable and the provider still saw topic activity. Neither page exposes separate setup, waiting subscribe and later subscribe promises.

Capture all three original Ably connection failures and verify that no live subscription remains at the terminal point through a supported consumer.

[realtime.ts](../../turbo/apps/platform/src/signals/realtime.ts)

## realtime-006

Kept the external attach pending, closed the waiting subscriber's actual Window and saw its provider connection close. The independent receiver observed no topic-specific unsubscribe or original subscriber rejection reason in this arm.

Need the live subscriber's own cancellable wait and its reason, with topic release identifiable independently of full connection teardown.

[realtime.ts](../../turbo/apps/platform/src/signals/realtime.ts)

## realtime-010

Held the external attach and delivered terminal channel and connection failure. The independent provider saw an unsubscribe sequence and the Dashboard stayed mounted. There is no returned callback receipt on this production background consumer to identify the terminal reason object.

Use a supported subscriber supplying an observable error callback on the suspended transport. Correlate that exact terminal error with release of its topic.

[realtime.ts](../../turbo/apps/platform/src/signals/realtime.ts)

## realtime-020

On one mounted Chat the initial detail read returned 500. With the automation notification withheld the same panel kept Cedar schedule. Releasing just chatThreadAutomationsChanged changed it to Maple schedule. This independently proves continued automation delivery after the detail failure.

The initiating subscribe caller must expose its initialization rejection. The detail HTTP failure and continued automation update do not expose that rejection.

[#34399](https://github.com/okou-ai/okou/pull/34399) · [#38375](https://github.com/okou-ai/okou/pull/38375)

[realtime.ts](../../turbo/apps/platform/src/signals/realtime.ts)

## clerk-user-003

From signed-out Sign in entered a Clerk session transition and used browser history to open a protected hosted-site grant. The actual Clerk loaded accessor was read and the grant remained pending. After sign-in the receiver obtained the user-a session's token, returned its synthetic denial and the Router reached the denied access page. The wrapper checks the awaited user's presence; token acquisition is separate. The custom-domain change extends recovery destination handling. The authenticated authorization request still sends the origin, state and challenge, and the grant continues to obtain its token separately. [#50462](https://github.com/okou-ai/okou/pull/50462)

Find a supported waiting consumer that uses the resolved user's ID on that same read and distinguishes user-a from another signed-in member.

[auth.ts](../../turbo/apps/platform/src/signals/auth.ts) · [marketing-handoff.ts](../../turbo/apps/platform/src/signals/prompt-page/marketing-handoff.ts) · [identity-startup.test.ts](../../turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts)

## clerk-user-005

Held an onboarding handoff already owned by user-a, then removed active organization while onboarding status was pending so ownership validation compares the actual user-read promise. Re-emitting the same member's profile let that original handoff finish with its unique task. Transitioning away and back to the same member and session replaced the promise: the original readiness rejected with AbortError / Session changed and the task was absent.

Covered by the two onboarding ownership outcomes on the original request.

[auth.ts](../../turbo/apps/platform/src/signals/auth.ts) · [marketing-handoff.ts](../../turbo/apps/platform/src/signals/prompt-page/marketing-handoff.ts) · [identity-startup.test.ts](../../turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts)

## clerk-user-006

Started Workflows with a signed-in member and held the external Clerk runtime. The member label and user-scoped connector subscription were absent. After release the original route became ready and both appeared. Feature-switch startup waits for the SDK, so this identifies the member and eventual subscription but does not identify an early synchronous reader of the owner's promise.

Locate a public reader demonstrably invoked before user-owner initialization finishes and verify that its particular returned promise resolves to user-a.

[#33865](https://github.com/okou-ai/okou/pull/33865)

[auth.ts](../../turbo/apps/platform/src/signals/auth.ts) · [marketing-handoff.ts](../../turbo/apps/platform/src/signals/prompt-page/marketing-handoff.ts) · [identity-startup.test.ts](../../turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts)

## clerk-user-007

Disposed a live Workflows owner after its member menu rendered; the menu disconnected. Installed a successor and emitted during transition, then restored the profile. The successor rendered the restored label and the original menu stayed disconnected. The frozen test cancels the original owner and examines its old store; no mounted consumer supplies the old promise after disposal.

Need an already-issued observation surviving owner replacement that can distinguish the same settled old promise and continued user-a value from a successor re-read.

[auth.ts](../../turbo/apps/platform/src/signals/auth.ts) · [marketing-handoff.ts](../../turbo/apps/platform/src/signals/prompt-page/marketing-handoff.ts) · [identity-startup.test.ts](../../turbo/apps/platform/src/views/auth-v1/__tests__/identity-startup.test.ts)

## command-scheduling-001

One caller used the documented debounceCommand API with delay 20 and invoked old/1 then new/2. Its old promise rejected with AbortError, its latest promise returned newnew and the single delivery came from new. A separate Chromium run used the production timer branch.

Covered through the returned public calls and caller-owned output.

[utils.ts](../../turbo/apps/platform/src/signals/utils.ts) · [command-scheduling.test.ts](../../turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts)

## command-scheduling-002

Let the old source command start, held its work, issued new, then released the old command. At its cooperative signal check the old result rejected with AbortError. The replacing call returned new and reached the delivery boundary.

Covered through the two returned calls and the held source command.

[utils.ts](../../turbo/apps/platform/src/signals/utils.ts) · [command-scheduling.test.ts](../../turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts)

## command-scheduling-003

Cancelled the discarded caller, submitted latest under a live owner, then submitted invalid under the cancelled owner. The first rejection carried the reason in its AbortError, the invalid invocation rejected with the original reason object, and latest alone executed and returned its value.

Covered through the original two rejection reasons and final delivery.

[utils.ts](../../turbo/apps/platform/src/signals/utils.ts) · [command-scheduling.test.ts](../../turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts)

## command-scheduling-004

Held the leading call during the 1,000 ms interval, issued trailing arguments at 200 and 600 ms and released the lead at 1,000. No trailing work had started at the hold point. The original returns were first, latestlatest and latestlatest; only first and latest ran. Chromium repeated the inputs using the production timer branch.

Covered through all three public receipts, the pre-release observation and independent production-clock control.

[utils.ts](../../turbo/apps/platform/src/signals/utils.ts) · [command-scheduling.test.ts](../../turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts)

## command-scheduling-006

Two separate ccstate Stores invoked the same public debounced command with delay 20. The caller saw an empty delivery set immediately. Both returned their own values and both labels reached the sink.

Covered through the shared command and both independent Stores.

[utils.ts](../../turbo/apps/platform/src/signals/utils.ts) · [command-scheduling.test.ts](../../turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts)

## client-001

Kept Browser.getVersion pending on an otherwise open CDP connection with an empty target list. Advanced the monotonic clock beyond 31 seconds, then used New tab while withholding the created-target event. The subsequent Target.getTargets returned empty on the same transport; later delivery of the created target started the stream. The actual frame-window reader consumes optional read-only probe failures. The upstream response-deadline change introduced monotonic deadlines on the connection. The later read-only policy and version-sampling consumer explain where the optional version result is handled. [#44801](https://github.com/okou-ai/okou/commit/47f22ca434f6cbf2069ab919286d6050033f5a42)

The original version-probe rejection must itself be independently observed as a read-only protocol failure. The successful later read only establishes continued availability.

[#44917](https://github.com/okou-ai/okou/pull/44917) · [#47191](https://github.com/okou-ai/okou/pull/47191)

[client.ts](../../turbo/apps/platform/src/signals/browser/cdp/client.ts) · [frame-window.ts](../../turbo/apps/platform/src/signals/browser/viewer/frame-window.ts) · [browser-response-deadlines.test.tsx](../../turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx)

## client-002

Held Browser.getVersion and Target.attachToBrowserTarget on the viewer connection. Left through the Router, observed socket closure, then individually released both late replies at the peer. The viewer input control was gone and the remote target was still present. Leaving also destroys the page's notification issuer.

Need a supported caller retaining both pending promise results and attempting a post-close notification, with the independent remote browser still running.

[client.ts](../../turbo/apps/platform/src/signals/browser/cdp/client.ts) · [frame-window.ts](../../turbo/apps/platform/src/signals/browser/viewer/frame-window.ts) · [browser-response-deadlines.test.tsx](../../turbo/apps/platform/src/views/browser-session/__tests__/browser-response-deadlines.test.tsx)
