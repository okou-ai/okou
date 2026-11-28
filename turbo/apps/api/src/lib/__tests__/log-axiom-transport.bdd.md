# log-axiom-transport

## log-axiom-transport-001

- Vitest: "keeps OAuth callback stages and exception classes without private details"
- Mode: run
- Intent: review
- Given: A signed-in member starts two GitHub OAuth connections. For the first, GitHub's token exchange returns a non-JSON body containing a private detail (stage `exchange_and_profile`); for the second, secret encryption rejects with a `TypeError` whose name, message and cause carry the private detail (stage `persist_connection`).
- When: For each attempt the member completes the GitHub OAuth callback with a private code and the issued state, then replays the same callback.
- Then: Each callback reports status `error` with "OAuth authorization failed. Please try again." Exactly one "OAuth callback failed" error log exists per attempt, containing exactly `context` `connectors:oauth-callback`, `connectorSlug` `github`, `authMethodId` `oauth`, the attempt ID, the `callbackStage`, `failureKind` `unexpected` and `exceptionClass` `SyntaxError` or `TypeError` (plus `causeClass` `Error` for `persist_connection`); the log contains neither the private detail, the state nor the authorization URL. The replay reports "Invalid state - please try again".

## log-axiom-transport-002

- Vitest: "keeps private provider details out of native window failure logs: cdp"
- Mode: run
- Intent: review
- Given: A member's chat run has opened a managed Browser through `POST /api/browsers/use` and the member has a second (sibling) thread. Failure row `cdp`: The provider's native CDP window-bounds command returns error code -32602 with a private message.
- When: The member deletes the sibling thread with `DELETE /api/chat-threads/:id`, which triggers Browser window reconciliation; afterwards the provider failure is cleared and the member reads `GET /api/chat-threads/:threadId/browser`.
- Then: The last "Browser window reconciliation failed" warning contains exactly `instanceId`, `primaryWindowId`, `phase` `check-native-window`, `context` `BrowserReconcile`, `errorKind` `cdp` and `errorCode` -32602. The serialized warning contains neither the private detail, "Private provider", the native CDP URL, the chat thread ID nor the provider session ID. The later Browser read returns the same window and the provider received only one session request.

## log-axiom-transport-003

- Vitest: "keeps private provider details out of native window failure logs: connection"
- Mode: run
- Intent: review
- Given: A member's chat run has opened a managed Browser through `POST /api/browsers/use` and the member has a second (sibling) thread. Failure row `connection`: The provider's native CDP socket connection never completes and the Browser deadline elapses.
- When: The member deletes the sibling thread with `DELETE /api/chat-threads/:id`, which triggers Browser window reconciliation; afterwards the provider failure is cleared and the member reads `GET /api/chat-threads/:threadId/browser`.
- Then: The last "Browser window reconciliation failed" warning contains exactly `instanceId`, `primaryWindowId`, `phase` `check-native-window`, `context` `BrowserReconcile`, `errorKind` `provider`, `mappedHttpStatus` 503, `errorCode` `BROWSER_USE_TIMEOUT` and `nativePhase` `connection`. The serialized warning contains neither the private detail, "Private provider", the native CDP URL, the chat thread ID nor the provider session ID. The later Browser read returns the same window and the provider received only one session request.

## log-axiom-transport-004

- Vitest: "keeps private provider details out of native window failure logs: command"
- Mode: run
- Intent: review
- Given: A member's chat run has opened a managed Browser through `POST /api/browsers/use` and the member has a second (sibling) thread. Failure row `command`: The provider withholds the native window command reply and the Browser deadline elapses.
- When: The member deletes the sibling thread with `DELETE /api/chat-threads/:id`, which triggers Browser window reconciliation; afterwards the provider failure is cleared and the member reads `GET /api/chat-threads/:threadId/browser`.
- Then: The last "Browser window reconciliation failed" warning contains exactly `instanceId`, `primaryWindowId`, `phase` `check-native-window`, `context` `BrowserReconcile`, `errorKind` `provider`, `mappedHttpStatus` 503, `errorCode` `BROWSER_USE_TIMEOUT` and `nativePhase` `command`. The serialized warning contains neither the private detail, "Private provider", the native CDP URL, the chat thread ID nor the provider session ID. The later Browser read returns the same window and the provider received only one session request.

## log-axiom-transport-005

- Vitest: "keeps private provider details out of native window failure logs: admission-close"
- Mode: run
- Intent: review
- Given: A member's chat run has opened a managed Browser through `POST /api/browsers/use` and the member has a second (sibling) thread. Failure row `admission-close`: The provider closes the native CDP socket on connection with close code 1013 and a private reason.
- When: The member deletes the sibling thread with `DELETE /api/chat-threads/:id`, which triggers Browser window reconciliation; afterwards the provider failure is cleared and the member reads `GET /api/chat-threads/:threadId/browser`.
- Then: The last "Browser window reconciliation failed" warning contains exactly `instanceId`, `primaryWindowId`, `phase` `check-native-window`, `context` `BrowserReconcile`, `errorKind` `transport`, `nativePhase` `connection`, `errorClass` `CdpConnectionError`, `socketSource` `native-close`, `socketPhase` `opening` or `open`, `socketReadyState` 3, `closeCode` 1013 and `wasClean` true. The serialized warning contains neither the private detail, "Private provider", the native CDP URL, the chat thread ID nor the provider session ID. The later Browser read returns the same window and the provider received only one session request.

## log-axiom-transport-006

- Vitest: "keeps private provider details out of native window failure logs: command-close"
- Mode: run
- Intent: review
- Given: A member's chat run has opened a managed Browser through `POST /api/browsers/use` and the member has a second (sibling) thread. Failure row `command-close`: The provider closes the open native CDP socket with close code 1013 and a private reason just before the native window reply.
- When: The member deletes the sibling thread with `DELETE /api/chat-threads/:id`, which triggers Browser window reconciliation; afterwards the provider failure is cleared and the member reads `GET /api/chat-threads/:threadId/browser`.
- Then: The last "Browser window reconciliation failed" warning contains exactly `instanceId`, `primaryWindowId`, `phase` `check-native-window`, `context` `BrowserReconcile`, `errorKind` `transport`, `nativePhase` `command`, `errorClass` `CdpConnectionError`, `socketSource` `native-close`, `socketPhase` `open`, `socketReadyState` 3, `closeCode` 1013 and `wasClean` true. The serialized warning contains neither the private detail, "Private provider", the native CDP URL, the chat thread ID nor the provider session ID. The later Browser read returns the same window and the provider received only one session request.

## log-axiom-transport-007

- Vitest: "keeps private provider details out of native window failure logs: normal-close"
- Mode: run
- Intent: review
- Given: A member's chat run has opened a managed Browser through `POST /api/browsers/use` and the member has a second (sibling) thread. Failure row `normal-close`: The provider closes the open native CDP socket with close code 1000 and a private reason just before the native window reply.
- When: The member deletes the sibling thread with `DELETE /api/chat-threads/:id`, which triggers Browser window reconciliation; afterwards the provider failure is cleared and the member reads `GET /api/chat-threads/:threadId/browser`.
- Then: The last "Browser window reconciliation failed" warning contains exactly `instanceId`, `primaryWindowId`, `phase` `check-native-window`, `context` `BrowserReconcile`, `errorKind` `transport`, `nativePhase` `command`, `errorClass` `CdpConnectionError`, `socketSource` `native-close`, `socketPhase` `open`, `socketReadyState` 3, `closeCode` 1000 and `wasClean` true. The serialized warning contains neither the private detail, "Private provider", the native CDP URL, the chat thread ID nor the provider session ID. The later Browser read returns the same window and the provider received only one session request.

## log-axiom-transport-008

- Vitest: "records upstream HTTP 401 for BROWSER_USE_AUTH_ERROR alongside the mapped status"
- Mode: run
- Intent: review
- Given: A member's chat run has opened a managed Browser through `POST /api/browsers/use` and the member has a second (sibling) thread. The Browser provider answers the next session lookup (`GET /browsers/{sessionId}`) once with HTTP 401 and a JSON body whose `detail` is a private string.
- When: The member deletes the sibling thread with `DELETE /api/chat-threads/:id`, which triggers Browser window reconciliation, then reads `GET /api/chat-threads/:threadId/browser`.
- Then: The last "Browser window reconciliation failed" warning contains exactly `instanceId`, `primaryWindowId`, `phase` `find-provider`, `errorKind` `provider`, `errorCode` `BROWSER_USE_AUTH_ERROR`, `mappedHttpStatus` 503, `upstreamHttpStatus` 401 and `context` `BrowserReconcile`, without the private detail or provider session ID. The Browser read returns the same window and the provider received only one session request.

## log-axiom-transport-009

- Vitest: "records upstream HTTP 403 for BROWSER_USE_AUTH_ERROR alongside the mapped status"
- Mode: run
- Intent: review
- Given: A member's chat run has opened a managed Browser through `POST /api/browsers/use` and the member has a second (sibling) thread. The Browser provider answers the next session lookup (`GET /browsers/{sessionId}`) once with HTTP 403 and a JSON body whose `detail` is a private string.
- When: The member deletes the sibling thread with `DELETE /api/chat-threads/:id`, which triggers Browser window reconciliation, then reads `GET /api/chat-threads/:threadId/browser`.
- Then: The last "Browser window reconciliation failed" warning contains exactly `instanceId`, `primaryWindowId`, `phase` `find-provider`, `errorKind` `provider`, `errorCode` `BROWSER_USE_AUTH_ERROR`, `mappedHttpStatus` 503, `upstreamHttpStatus` 403 and `context` `BrowserReconcile`, without the private detail or provider session ID. The Browser read returns the same window and the provider received only one session request.

## log-axiom-transport-010

- Vitest: "records upstream HTTP 403 for BROWSER_USE_OUTPUT_TOO_LARGE alongside the mapped status"
- Mode: run
- Intent: review
- Given: A member's chat run has opened a managed Browser through `POST /api/browsers/use` and the member has a second (sibling) thread. The Browser provider answers the next session lookup (`GET /browsers/{sessionId}`) once with HTTP 403 and an oversized (about 513 KiB) JSON body whose `detail` starts with a private string.
- When: The member deletes the sibling thread with `DELETE /api/chat-threads/:id`, which triggers Browser window reconciliation, then reads `GET /api/chat-threads/:threadId/browser`.
- Then: The last "Browser window reconciliation failed" warning contains exactly `instanceId`, `primaryWindowId`, `phase` `find-provider`, `errorKind` `provider`, `errorCode` `BROWSER_USE_OUTPUT_TOO_LARGE`, `mappedHttpStatus` 502, `upstreamHttpStatus` 403 and `context` `BrowserReconcile`, without the private detail or provider session ID. The Browser read returns the same window and the provider received only one session request.

## log-axiom-transport-011

- Vitest: "records upstream HTTP 403 for BROWSER_USE_ERROR alongside the mapped status"
- Mode: run
- Intent: review
- Given: A member's chat run has opened a managed Browser through `POST /api/browsers/use` and the member has a second (sibling) thread. The Browser provider answers the next session lookup (`GET /browsers/{sessionId}`) once with HTTP 403 and a body stream that fails with a private error while being read.
- When: The member deletes the sibling thread with `DELETE /api/chat-threads/:id`, which triggers Browser window reconciliation, then reads `GET /api/chat-threads/:threadId/browser`.
- Then: The last "Browser window reconciliation failed" warning contains exactly `instanceId`, `primaryWindowId`, `phase` `find-provider`, `errorKind` `provider`, `errorCode` `BROWSER_USE_ERROR`, `mappedHttpStatus` 502, `upstreamHttpStatus` 403 and `context` `BrowserReconcile`, without the private detail or provider session ID. The Browser read returns the same window and the provider received only one session request.

## log-axiom-transport-012

- Vitest: "request lifecycle Axiom transport > exports Worker request and lifecycle RED once through native logs"
- Mode: run
- Intent: review
- Given: The API runs in the Worker runtime with native telemetry enabled and real Axiom telemetry selected.
- When: A caller requests `GET /health` with `X-Client-Request-Id: native-health-red` and background work is drained.
- Then: The response is HTTP 200 with `{ status: "ok" }`. Native logs contain exactly two records in order: a request-log record (`axiom_dataset` `vm0-request-log-dev`, `okou_runtime` `cloudflare-workers`, `GET`, `/health`, status 200, numeric `request_time_ms`, the client request ID) and a `request_lifecycle` record in `vm0-web-logs-dev` with the same request fields, numeric lifecycle and background times, `wait_until_failure_count` 0 and `lifecycle_error` false. The Axiom SDK ingest and log flush are never used.

## log-axiom-transport-013

- Vitest: "request lifecycle Axiom transport > returns health before request-log delivery and records lifecycle after delivery"
- Mode: run
- Intent: review
- Given: The wall clock is 2026-10-21T12:00:00Z with elapsed time 0, and Axiom's first flush (the request-log delivery) stays pending until released.
- When: A caller requests `GET /health`; then the wall clock jumps forward 60 seconds while only 750 ms elapse, and the request-log delivery completes.
- Then: The response is HTTP 200 `{ status: "ok" }` before delivery: one `request-log` event (`GET`, `/health`, 200, `request_time_ms` 0) is ingested, flush is called once and no lifecycle event exists. After delivery exactly one `web-logs` `request_lifecycle` event is ingested with `_time` equal to the start time, `request_time_ms` 0, `lifecycle_time_ms` 750, `background_time_ms` 750, `wait_until_failure_count` 0 and `lifecycle_error` false; there is still one request-log event and flush was called twice.

## log-axiom-transport-014

- Vitest: "request lifecycle Axiom transport > completes another health lifecycle while the first request-log delivery is pending"
- Mode: run
- Intent: review
- Given: The clock starts at 2026-10-21T13:00:00Z with elapsed time 0, and the first two Axiom request-log deliveries stay pending until released individually.
- When: A caller requests `GET /health` with client request ID `health-first`, then at +100 ms `GET /health` with `health-second`; at +300 ms the second delivery completes, and at +900 ms the first delivery completes.
- Then: Both responses are HTTP 200 `{ status: "ok" }` with no lifecycle event yet. After the second delivery exactly one lifecycle event exists, for `health-second`, with `_time` start+100 ms, `request_time_ms` 0, `lifecycle_time_ms` 200 and `background_time_ms` 200. After the first delivery there are two lifecycle events, including `health-first` with `_time` at the start, `lifecycle_time_ms` 900 and `background_time_ms` 900; the request-log events are `health-first` then `health-second`, each with `request_time_ms` 0.

## log-axiom-transport-015

- Vitest: "template usage Axiom transport > records each template once when an immediate queue-first run is created"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected. The clock is fixed at the commit time.
- When: The member sends `POST /api/chat/events` with a client event ID and a message containing a `document-template:simple-invoice` document marker and an `image-style:emboss-deboss` illustration marker, then replays the same send on the created thread (HTTP 201).
- Then: Exactly two `template_used` events are ingested into `vm0-web-logs-dev` for the workspace: index 0 with the commit `_time`, run ID, source event ID, `usageEventId` `template-used:v2:<sourceEventId>:0`, `templateUsageVersion` 2, user ID, thread ID, `dispatchPath` `queued-claim`, category `document`, ID `document-template:simple-invoice`, slug `simple-invoice`, source `builtin`, role `primary`, count 2; and index 1 for the `illustration` `image-style:emboss-deboss` with role `inline` and count 2.

## log-axiom-transport-016

- Vitest: "template usage Axiom transport > preserves live categories, optional reporting fields, aliases and repeated marker order"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected.
- When: The member sends `POST /api/chat/events` with six template markers in order: presentation `template:html-ppt-meridian` with color system `color-system:ocean-deep`, website `black-slabs`, illustration `image-style:ink-mascot`, workflow `workflow-template:daily-standup-report`, document `document-mutual-nda`, and the same presentation again.
- Then: Six `template_used` events are ingested in marker order with matching categories, IDs and slugs (`html-ppt-meridian`, `black-slabs`, `ink-mascot`, `daily-standup-report`, `document-mutual-nda`, `html-ppt-meridian`), `colorSystemId` `color-system:ocean-deep` on both presentations, `workflowCategory` `Engineering` on the workflow, source `builtin`, `usageEventId` suffix and `templateIndex` 0–5, role `primary` for the first and `inline` for the rest, and `templateCount` 6.

## log-axiom-transport-017

- Vitest: "template usage Axiom transport > reports a published imported presentation by its authorized kind without private metadata or inheritance"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected. Template row `presentation`: the member uploads a PDF source and a page preview image plus a template package containing private instructions and design details.
- When: The member publishes a private `presentation` template through `POST /api/user-templates`, sends a chat with two `custom` markers for it, then cancels that run with its sandbox token and sends a follow-up on the thread without a template.
- Then: Publishing returns HTTP 200 with kind `presentation` and visibility `private`. Exactly two `template_used` events exist with category `presentation`, `templateId` and `templateSlug` `user-template`, source `user-imported`, roles `primary`/`inline`, indexes 0/1 and count 2, no `colorSystemId`, and none of the template ID, title, file IDs, file names, package contents or `bundles/v1/`. The follow-up adds no template events.

## log-axiom-transport-018

- Vitest: "template usage Axiom transport > reports a published imported document by its authorized kind without private metadata or inheritance"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected. Template row `document`: the member uploads a PDF source and a cover image plus a template package containing private instructions and design details.
- When: The member publishes a private `document` template through `POST /api/user-templates`, sends a chat with two `custom` markers for it, then cancels that run with its sandbox token and sends a follow-up on the thread without a template.
- Then: Publishing returns HTTP 200 with kind `document` and visibility `private`. Exactly two `template_used` events exist with category `document`, `templateId` and `templateSlug` `user-template`, source `user-imported`, roles `primary`/`inline`, indexes 0/1 and count 2, no `colorSystemId`, and none of the template ID, title, file IDs, file names, package contents or `bundles/v1/`. The follow-up adds no template events.

## log-axiom-transport-019

- Vitest: "template usage Axiom transport > reports a published imported illustration by its authorized kind without private metadata or inheritance"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected. Template row `illustration`: the member uploads a PNG source and an example image plus a template package containing private instructions and design details.
- When: The member publishes a private `illustration` template through `POST /api/user-templates`, sends a chat with two `custom` markers for it, then cancels that run with its sandbox token and sends a follow-up on the thread without a template.
- Then: Publishing returns HTTP 200 with kind `illustration` and visibility `private`. Exactly two `template_used` events exist with category `illustration`, `templateId` and `templateSlug` `user-template`, source `user-imported`, roles `primary`/`inline`, indexes 0/1 and count 2, no `colorSystemId`, and none of the template ID, title, file IDs, file names, package contents or `bundles/v1/`. The follow-up adds no template events.

## log-axiom-transport-020

- Vitest: "template usage Axiom transport > redacts a published private presentation selection and its preview metadata"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected. The member uploads a private deck PDF, page image and template package.
- When: The member publishes a private presentation through `POST /api/presentation-templates`, then sends a chat whose presentation template selects `user-template:<id>` with color system `color-system:prism` and a private preview URL.
- Then: Exactly one `template_used` event exists with the run ID, category `presentation`, `templateId` and `templateSlug` `user-template` and source `user-imported`, without `colorSystemId`. It contains none of the template ID, title, preview URL, `color-system:prism`, file IDs, file names, package contents or `bundles/v1/`.

## log-axiom-transport-021

- Vitest: "template usage Axiom transport > waits until a queued template input creates its run"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected. The thread is busy with an active anchor run.
- When: The member sends a queued `POST /api/chat/events` (HTTP 201) whose message has a `document-template:simple-invoice` marker; then the Runner completes the anchor run with no output and the queued message is consumed into a new run.
- Then: No `template_used` event exists while the message is queued. After consumption exactly one event exists with the source event ID, the new run's ID, `dispatchPath` `queued-claim`, category `document` and count 1.

## log-axiom-transport-022

- Vitest: "template usage Axiom transport > records only the winning active-input declaration, not lookups or replay"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected. A run started without a template is active on the thread.
- When: The member sends a steering message (HTTP 201) with a `document-template:simple-invoice` marker; the Runner reads `GET /api/runners/runs/:runId/steerable-inputs/next` twice, then declares `POST /api/runners/runs/:runId/steerable-inputs/:eventId/steered` twice concurrently and once more.
- Then: Both lookups return the same input with the event ID and a prompt containing "Selected document template:", and no template event exists after them. After the declarations exactly one event exists with the run ID, source event ID, `usageEventId` suffix `:0`, `dispatchPath` `active-input`, category `document`, source `builtin` and count 1.

## log-axiom-transport-023

- Vitest: "template usage Axiom transport > does not report a steered batch whose private template cannot be mounted"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected. A run started without a template is active on the thread.
- When: The member sends a steering message (HTTP 201) with a built-in invoice marker and a `custom` marker for a nonexistent private user template; the Runner reads the next steerable input and declares it steered.
- Then: The next steerable input is the event, but its prompt does not contain "Selected document template:". No `template_used` event is reported.

## log-axiom-transport-024

- Vitest: "template usage Axiom transport > exports a template usage record once through Worker native logs, not the SDK"
- Mode: run
- Intent: review
- Given: The code runs in the Worker runtime with native telemetry enabled and no database access.
- When: The template usage recorder records one built-in `document-template:simple-invoice` usage with `dispatchPath` `queued-claim` directly (no HTTP request), and background work is drained.
- Then: Native logs contain exactly one `template_used` record with `axiom_dataset` `vm0-web-logs-dev`, `okou_runtime` `cloudflare-workers`, the run and source event IDs, `usageEventId` `template-used:v2:<sourceEventId>:0`, category `document`, count 1 and `templateUsageVersion` 2. The Axiom SDK ingest is not used.

## log-axiom-transport-025

- Vitest: "template usage Axiom transport > keeps committed template usage when the Runner refuses complete input"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected. The Runner rejects run dispatch with disposition `rejected`.
- When: The member sends a chat with a client event ID and a `document-template:simple-invoice` template, then reads the run.
- Then: The run status is `failed`, and exactly one `template_used` event exists with the run ID, source event ID, `dispatchPath` `queued-claim` and category `document`.

## log-axiom-transport-026

- Vitest: "template usage Axiom transport > preserves a created template run when Axiom ingestion fails"
- Mode: run
- Intent: review
- Given: A signed-in member of an entitled workspace uses public chat with a Runner, and real Axiom telemetry is selected. Axiom ingestion fails for `template_used` events in `vm0-web-logs-dev`.
- When: The member sends a chat with a `document-template:simple-invoice` template, then reads the run and its execution input.
- Then: The run status is `running`, and the execution's appended system prompt contains "Selected document template:".

## log-axiom-transport-027

- Vitest: "completed chat callback failure diagnostics > retains the failed operation without private child errors for a live thread"
- Mode: run
- Intent: review
- Given: A signed-in member has a chat run, a registered push subscription and push delivery enabled. The presence provider rejects lookups with a `TypeError` carrying a private detail, and follow-up suggestion generation is held. Thread row `live`: The thread stays live.
- When: The Runner completes the run with the assistant output "The main answer survives"; then follow-up generation returns suggestions and background work is drained.
- Then: The run reads `completed` and the thread events contain the answer. The thread events later include an `output.followups` event. The single "Failed to process terminal chat callback side effects" warning carries the run ID, status `completed`, and an `AggregateError` "Completed chat callback side effects failed" whose cause lists only `{ operation: "push", reason: "type_error" }`; it does not contain the private detail.

## log-axiom-transport-028

- Vitest: "completed chat callback failure diagnostics > retains the failed operation without private child errors for a deleted thread"
- Mode: run
- Intent: review
- Given: A signed-in member has a chat run, a registered push subscription and push delivery enabled. The presence provider rejects lookups with a `TypeError` carrying a private detail, and follow-up suggestion generation is held. Thread row `deleted`: The member deletes the thread with `DELETE /api/chat-threads/:id` before follow-up suggestions are returned.
- When: The Runner completes the run with the assistant output "The main answer survives"; then follow-up generation returns suggestions and background work is drained.
- Then: The run reads `completed` and the thread events contain the answer. Reading the thread returns HTTP 404. The single "Failed to process terminal chat callback side effects" warning carries the run ID, status `completed`, and an `AggregateError` "Completed chat callback side effects failed" whose cause lists only `{ operation: "push", reason: "type_error" }`; it does not contain the private detail.

## log-axiom-transport-029

- Vitest: "Axiom ingest HTTP error diagnostics > logs bounded json upstream details and permits a later successful upload"
- Mode: run
- Intent: review
- Given: A Sandbox holds a run token, and an Axiom telemetry token is configured. Format row `json`: Axiom ingest for `sandbox-telemetry-metrics` returns HTTP 503 with `x-request-id` and `retry-after: 2` headers and a JSON error body that echoes the payload and includes the token, bearer tokens, a password, signed URLs, an email address and long context.
- When: The Sandbox uploads one metric to `POST /api/webhooks/run/telemetry`; after Axiom recovers it uploads again.
- Then: The first upload returns HTTP 500 `{ error: "Internal server error" }` and a `POST` lifecycle event with status 500 and `lifecycle_error` true is ingested. The error "Unhandled request error: Axiom ingest failed with status 503" carries `reason` `http_status`, status 503, the dataset, `retryAfterMs` 2000, `eventCount` 1, the request byte count, elapsed time, the upstream request ID, content type `application/json`, and a body summary of at most 512 characters that contains "no healthy upstream", "[redacted authorization]" and "[redacted telemetry payload]", omits the run ID and ends with "..."; no error log contains any of the secrets. The second upload returns HTTP 200 `{ success: true, id: <runId> }`.

## log-axiom-transport-030

- Vitest: "Axiom ingest HTTP error diagnostics > logs bounded html upstream details and permits a later successful upload"
- Mode: run
- Intent: review
- Given: A Sandbox holds a run token, and an Axiom telemetry token is configured. Format row `html`: Axiom ingest for `sandbox-telemetry-metrics` returns HTTP 503 with `x-request-id` and `retry-after: 2` headers and an HTML error body that echoes the payload and includes the token, bearer tokens, a password, signed URLs, an email address and long context.
- When: The Sandbox uploads one metric to `POST /api/webhooks/run/telemetry`; after Axiom recovers it uploads again.
- Then: The first upload returns HTTP 500 `{ error: "Internal server error" }` and a `POST` lifecycle event with status 500 and `lifecycle_error` true is ingested. The error "Unhandled request error: Axiom ingest failed with status 503" carries `reason` `http_status`, status 503, the dataset, `retryAfterMs` 2000, `eventCount` 1, the request byte count, elapsed time, the upstream request ID, content type `text/html`, and a body summary of at most 512 characters that contains "no healthy upstream", "[redacted authorization]" and "[redacted telemetry payload]", omits the run ID and ends with "..."; no error log contains any of the secrets. The second upload returns HTTP 200 `{ success: true, id: <runId> }`.

## log-axiom-transport-031

- Vitest: "Axiom ingest HTTP error diagnostics > preserves the known HTTP failure when the error body is oversized"
- Mode: run
- Intent: review
- Given: A Sandbox holds a run token. Mode row `oversized`: Axiom ingest for `sandbox-telemetry-metrics` returns HTTP 503 with a JSON body with a 5000-character message.
- When: The Sandbox uploads one metric to `POST /api/webhooks/run/telemetry`.
- Then: The upload returns HTTP 500 `{ error: "Internal server error" }`. The error "Unhandled request error: Axiom ingest failed with status 503" carries `reason` `http_status`, status 503 and no `responseBodySummary`, and `responseBodyTruncated` true.

## log-axiom-transport-032

- Vitest: "Axiom ingest HTTP error diagnostics > preserves the known HTTP failure when the error body is interrupted"
- Mode: run
- Intent: review
- Given: A Sandbox holds a run token. Mode row `interrupted`: Axiom ingest for `sandbox-telemetry-metrics` returns HTTP 503 with a body stream that errors with a private read failure while being read.
- When: The Sandbox uploads one metric to `POST /api/webhooks/run/telemetry`.
- Then: The upload returns HTTP 500 `{ error: "Internal server error" }`. The error "Unhandled request error: Axiom ingest failed with status 503" carries `reason` `http_status`, status 503 and no `responseBodySummary`.

## log-axiom-transport-033

- Vitest: "Axiom logging transport > retains failed request details and resumes logging after a transport failure"
- Mode: run
- Intent: review
- Given: The real Axiom logging SDK transport is active with a telemetry token, dataset suffix `dev` and a commit SHA. Axiom's `vm0-web-logs-dev` ingest endpoint fails at the network level.
- When: Application code logs an info message containing a private payload and flushes logs; then the endpoint recovers and code logs "logging resumed" and flushes again.
- Then: The first flush resolves. A console error "Axiom application log delivery failed" reports `client` `telemetry`, the dataset, `failureKind` `transport_error`, the commit SHA, and a `TypeError` "Failed to fetch" with its cause and request details (origin `https://api.axiom.co`, the ingest endpoint, `POST`, elapsed and attempt times, attempt number, request bytes, `aborted` false). The diagnostics contain neither the token nor the payload; there were exactly 2 failed delivery attempts and the reported elapsed time covers both. After recovery, the "logging resumed" info event is delivered.

## log-axiom-transport-034

- Vitest: "Axiom logging transport > sends Fal info/warn diagnostics with the default SDK transport and restores mocks"
- Mode: run
- Intent: review
- Given: The real Axiom logging SDK transport is active with a telemetry token, dataset suffix `dev` and debug logging disabled; Axiom's `vm0-web-logs-dev` ingest accepts events.
- When: The `BuiltInGenerationWebhooks` logger emits debug, info and warn entries for the Fal failed-generation message (the warn with fallback `unknown` classification and no provider HTTP status), and logs are flushed; afterwards the real transport scope ends and another logger emits an info entry.
- Then: Axiom receives gzip NDJSON (`application/x-ndjson`) with exactly two events: an `info` and a `warn`, both with `source` `api`, the message, and the given fields plus `context`, the warn omitting `providerHttpStatus`; the debug entry is not sent. The later info entry goes to the default test logging sink with its context, and no further events reach Axiom.
