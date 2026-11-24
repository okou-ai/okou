# App test rebuild, batch 110

The opening register contained 92 unique frozen cases. All 20 selected cases were exercised. One original scenario passed for the first time and one received a sourced revision. The remaining 90 cases include all six product decisions. The separate upstream register contains 68 scenarios.

[Per-case ledger](../../turbo/apps/platform/test-rebuild-batch-110.tsv) · [Receiver observations](observations.json) · [Source comparison](comparison.json) · [Set reconciliation](reconciliation.json) · [Verification](checks.md)

## chat-list-optimistic-002

The unconfirmed thread showed recording.mov with the original URL and #t=0.001. Sending mounted the inline recording. Opening its preview on the same page, before releasing thread creation, started the catalog GET for that same thread. The receiver returned a real 404 to the live request; Chat thread not found appeared. The 200 control opened the artifact pane. No response was injected into an idle page.

A pending inline send starts no catalog read. Opening the preview supplies the missing read, but its error is visible. Revisit if the preview handles a missing pending thread or upstream explicitly narrows the guarantee to inline playback.

[#36141](https://github.com/okou-ai/okou/pull/36141)

## agent-suggestions-004

The home sidebar displayed the unread marker after the first feed response. An external change started a second, held response. Entering For you with that request still pending displayed neither the old card nor its replacement. Releasing it displayed the replacement. The original preload change shares data across these entries.

Show a genuinely cached card on the routed surface before releasing an in-flight replacement, or identify a later decision requiring the loading state.

[#47977](https://github.com/okou-ai/okou/pull/47977)

## agent-suggestions-015

With an empty model response the unavailable-model error appeared and both cards retained their positions. With only the built-in Auto entry the first card sent its own prompt, the page showed Sent to a new chat, and the second card became active. The isolated run-models API returned built-in Auto for a member without a subscription and restored Auto after disconnection. Upstream retired organization model configuration and specified a fixed managed Auto identity.

Regress the empty-response error separately from the supported member with only Auto.

[#37746](https://github.com/okou-ai/okou/pull/37746)

## integrations-discord-037

Started disconnected, held the new status before leaving Works, then returned before release. The description appeared without an enabled Connect button. The connected response then rendered Connected. Starting the refresh only upon return retained the enabled button. A disconnected final response gave an independent control.

The pre-departure refresh must preserve the disconnected button through the second mount, or upstream must explicitly replace that rule.

[#39564](https://github.com/okou-ai/okou/pull/39564) · [#39693](https://github.com/okou-ai/okou/pull/39693) · [#39982](https://github.com/okou-ai/okou/pull/39982)

## integrations-discord-038

Started connected and withheld the refresh before leaving Works. On returning, the description appeared without Connected. Releasing the same request restored Connected. Holding the refresh only after the return retained Connected during the wait.

Observe Connected throughout the original order, or find a production disposition for discarding the cached status on remount.

[#39564](https://github.com/okou-ai/okou/pull/39564) · [#39693](https://github.com/okou-ai/okou/pull/39693) · [#39982](https://github.com/okou-ai/okou/pull/39982)

## settings-model-loading-001

After the loaded Models page was left and reopened, billing and subscription reads were held separately. With both pending the page showed Use more models and Loading accounts. Connect and the empty-account message were absent. Billing first left it loading. With subscriptions first the returned account became visible before billing. The cached billing-only control still showed account setup.

Revisit when the returned Models panel can retain its no-accounts state and enabled Connect while both requests remain outstanding.

[#37519](https://github.com/okou-ai/okou/pull/37519) · [#39604](https://github.com/okou-ai/okou/pull/39604)

## composer-custom-template-recommendations-009

Clipboard PDF attached to the Image draft without sending. The typed draft remained. A file-picker PDF was rejected. A valid WEBP through the style importer sent the file with the analysis and publish request, navigated to Chat, and did not select a generation template. The production style tile and picker validation cover the picker path.

The unsupported clipboard PDF must be rejected on paste, or a sourced disposition must explicitly allow it on this path.

[#39648](https://github.com/okou-ai/okou/pull/39648) · [#50365](https://github.com/okou-ai/okou/pull/50365)

## connector-directory-010

In native Chromium the keyboard Gmail entry opened an independent provider window. One OAuth start was admitted in each arm. The real denial callback reached the isolated API and returned HTTP 200 with an error result. Closing the directory before the callback and closing it afterwards both left the provider window open. A simulated window in the regular suite did close.

Revisit on a browser ownership change that couples directory dismissal to the native handle. Use both callback orderings.

## directed-connect-page-008

The real Stripe directed link required credentials. The local API-token grant for Stripe arrived before the originating thread received its exact callback prompt. The route sent nothing while the grant was held. After acknowledgement the dialog closed. The frozen fixture supplied public no-auth Stripe. Upstream introduced marketplace OAuth while retaining the API key and CLI; the generic no-auth connector path still exists.

A supported no-auth Stripe catalog entry or an explicit Stripe-specific migration of that original precondition is still needed. The authenticated continuation covers the remaining visible steps.

[#30568](https://github.com/okou-ai/okou/pull/30568)

## connectors-account-rename-focus-011

After the GitHub rename was sent, closing the manager preserved outside focus. The independent listener accepted the PATCH, then its response adapter recorded AbortError after dismissal. It recorded no 200 delivery to that caller. Reopening showed the saved name without an active editor. A separate live request delivered successfully.

A supported manager lifetime that receives the original delayed response after dismissal could distinguish late delivery from an aborted caller.

[#37939](https://github.com/okou-ai/okou/pull/37939)

## connectors-account-rename-focus-013

A second manager opened and its Work 2 new draft retained focus while the previous receiver was released. The older PATCH reached the listener, but releasing it recorded AbortError. The closed caller received no 200. The new edit saved as Work 2 new draft and focus returned to that account’s actions. The new save had a live 200.

The original response must actually reach a caller while the second edit is active, or upstream must specify cancellation as the final disposition.

[#37939](https://github.com/okou-ai/okou/pull/37939)

## message-port-017

A registered Router used the production MessagePort transport to request the thread snapshot. Holding the external snapshot kept the original readiness promise outstanding. On HTTP 426 that same promise rejected with an instance of SharedDatabaseHttpError and status 426. The update dialog appeared.

Regress with the independently scoped indicators 426 when port error serialization changes.

## message-port-018

The indicators receiver delivered HTTP 426 with REQUEST_FAILED. The update dialog appeared. The signed-in home, Chat and Workflows readiness observations fulfilled, so none provided the indicators caller’s rejected ApiError with its status and code. The snapshot arm supplies a positive error-classification control.

Find a documented indicators caller that exposes the computed rejection, including its class, status and code.

## message-port-020

With A’s token service held, B entered the dashboard without a new publication. Its link was visible with no unread badge and the indicator endpoint saw no read using B. After A closed, a separate publication reached B’s bearer and showed the unread badge in the first trial. With the same release order in a later fresh profile, the receiver recorded the publication and additional pending A token requests. It saw no B indicator GET or badge in the observation window.

Observe a fresh B-owned indicator request and its result before releasing A while both tabs remain registered. A later publication after closure is a separate control.

## message-port-027

After Chromium closed A, B navigated for the first time to the empty side conversation with the data service unavailable. B emitted a successful chat-event.cache-only receipt, showed zero message rows and a ready composer, then independently opened the nonempty cached conversation. A separate fully offline run confirmed the empty result.

B’s successful empty read and continued use are established. A browser tab close does not expose an acknowledgement that the worker peer’s individual port closed; look for a documented per-port close receipt.

## single-connection-client-001

A real production-mode SharedWorker connection emitted successful, timed cache-only chat-event telemetry, without the private identity or entity data. Separate actual catch-up traffic carried cursor 42 and exercised a later row. The routed cache-only empty read supplied no such cursor; current production callers request the full cached list.

Identify a supported caller that sends afterSeqId 42 on its cache-only read and observe the empty result and its own telemetry together.

## worker-runtime-005

An expiring, locally signed URL served the stored title. Catch-up completed in A with zero metadata tail rows. A fresh B first rendered the same title with the metadata endpoint unavailable, emitted its own successful metadata cache-only receipt, and sent no metadata request in that interval. A separate signed-object rejection returned 403. The telemetry and UI expose neither read’s snapshot/events envelope.

Obtain a supported observer of the two result envelopes that can distinguish an empty event list from an event folded into the same title.

## worker-runtime-008

The two-thread HTTP catch-up first returned the primary baseline through 42 and zero for the side thread. In the second batch primary returned only row 43 and side returned nothing. After disconnecting, B’s first side-thread read was empty and first primary selection showed the new row.

The runtime’s changed-thread return list has no identified consumer exposing its membership. Add a caller that distinguishes an unchanged thread incorrectly included in that list.

## api-client-bootstrap-001

Lab initially rendered Banking from a matching one-use bootstrap. Updating and resetting it produced two network GETs with distinct local identity aliases and visible changed values. The bootstrapping branch consumes the match before getToken. The browser identity SDK receives session options and concurrent startup calls, without the individual request AbortSignal.

Find a public token-provider receipt that identifies each feature-switch request and its signal, including the third request.

## indexeddb-client-003

The real worker emitted separate successful IndexedDB transaction-creation and execution telemetry without the synthetic private values. A two-request execution described row and cursor writes. The row was visible on a later offline read from another operation. Distinct read transactions produced their own telemetry.

Find a production journey that writes and immediately reads that same value in one read-write transaction, with a separately attributable two-request execution receipt.
