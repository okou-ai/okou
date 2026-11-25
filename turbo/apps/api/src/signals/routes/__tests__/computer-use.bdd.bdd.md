# computer-use.bdd

## computer-use.bdd-001

- Vitest: "FILE-03 desktop computer-use runtime > creates a delegated authorization link and keeps its host directory fresh across heartbeat and stop"
- Mode: run
- Given: The app URL is `https://app.okou.ai`. A signed-in workspace member has a chat Run, and its Agent created a Computer Use authorization request via `POST /api/computer-use/authorization-requests`. The member has an online Desktop host "Studio Mac".
- When: The member reads `GET /api/computer-use/authorization-requests/:requestToken`, applies it with `POST .../apply` choosing the host, and reads it again after the Desktop heartbeats with a new name, capabilities and permissions, and after the Desktop stops.
- Then: The request has source `chat` and an authorization URL on `https://app.okou.ai` under `/computer-use/authorize/`. The first read shows the chat thread, no completion or host, and the same hosts as `GET /api/computer-use/hosts`. Apply returns exactly `{ ok: true, source: "chat", computerUseHostId }`, the thread metadata (`GET /api/chat-threads/:id/metadata`) now carries the host, and the request shows a completion time and the host. After the heartbeat the request's hosts match the refreshed directory entry ("Renamed Studio Mac", `apps.list`, accessibility false, `online`) with the completion unchanged; after the stop the directory shows the host `offline` and the request is identical except its host list is empty.

## computer-use.bdd-002

- Vitest: "FILE-03 desktop computer-use runtime > denies authorization tokens to another user in the same org without changing their owner's state"
- Mode: run
- Given: A signed-in member's chat Agent created a Computer Use authorization request and the member has an online Desktop host. Another user in the same workspace (row: same-org peer) is signed in.
- When: The peer reads `GET /api/computer-use/authorization-requests/:requestToken` and applies it with `POST .../apply` for the member's host.
- Then: Both return HTTP 404 with message "Computer Use authorization request not found". The owner's request, thread metadata and thread lifecycle events are unchanged.

## computer-use.bdd-003

- Vitest: "FILE-03 desktop computer-use runtime > denies authorization tokens to the same user in another org without changing their owner's state"
- Mode: run
- Given: A signed-in member's chat Agent created a Computer Use authorization request and the member has an online Desktop host. The same user signed in to a different workspace (row: same user, other org) is the caller.
- When: The caller reads `GET /api/computer-use/authorization-requests/:requestToken` and applies it with `POST .../apply` for the member's host.
- Then: Both return HTTP 404 with message "Computer Use authorization request not found". The owner's request, thread metadata and thread lifecycle events are unchanged.

## computer-use.bdd-004

- Vitest: "FILE-03 desktop computer-use runtime > rejects an online host owned by another user in the same org without completing authorization"
- Mode: run
- Given: A signed-in member's chat Agent created a Computer Use authorization request; another user in the same workspace (row: same-org peer) has an online Desktop host, and the member has none.
- When: The member applies the request with `POST /api/computer-use/authorization-requests/:requestToken/apply` choosing the peer's host.
- Then: Before applying, the request shows no completion, no host and an empty host list. Apply returns HTTP 404 "Computer-use host not found", and the request, thread metadata and thread lifecycle events are unchanged.

## computer-use.bdd-005

- Vitest: "FILE-03 desktop computer-use runtime > rejects an online host owned by the same user in another org without completing authorization"
- Mode: run
- Given: A signed-in member's chat Agent created a Computer Use authorization request; the same user in a different workspace (row: same user, other org) has an online Desktop host, and the member has none in this workspace.
- When: The member applies the request with `POST /api/computer-use/authorization-requests/:requestToken/apply` choosing that host.
- Then: Before applying, the request shows no completion, no host and an empty host list. Apply returns HTTP 404 "Computer-use host not found", and the request, thread metadata and thread lifecycle events are unchanged.

## computer-use.bdd-006

- Vitest: "FILE-03 desktop computer-use runtime > expires a pending authorization at the inclusive one-hour boundary"
- Mode: run
- Given: A signed-in member's chat Agent created a Computer Use authorization request expiring exactly one hour later, and the member's Desktop heartbeats one millisecond before expiry; the request is left pending (row: pending).
- When: The member reads the request at expiry minus 1 ms, then at exactly the expiry time reads `GET /api/computer-use/authorization-requests/:requestToken` and applies it.
- Then: The creation response's `expiresAt` is one hour after creation. At expiry minus 1 ms the request is readable, uncompleted and lists the host. At the expiry instant both read and apply return HTTP 410 with code `GONE`, and the thread metadata and lifecycle events are unchanged.

## computer-use.bdd-007

- Vitest: "FILE-03 desktop computer-use runtime > expires a completed authorization at the inclusive one-hour boundary"
- Mode: run
- Given: A signed-in member's chat Agent created a Computer Use authorization request expiring exactly one hour later; one millisecond before expiry the Desktop heartbeats and the member applies the request (row: completed).
- When: At exactly the expiry time the member reads `GET /api/computer-use/authorization-requests/:requestToken` and applies it again.
- Then: The early apply returns `{ ok: true, source: "chat", computerUseHostId }` and the request shows completion at expiry minus 1 ms. At the expiry instant both read and apply return HTTP 410 with code `GONE`, and the thread metadata and lifecycle events are unchanged.

## computer-use.bdd-008

- Vitest: "FILE-03 desktop computer-use runtime > accepts repeat authorization with updated completion and distinct ordered events"
- Mode: run
- Given: A signed-in member's chat Agent created a Computer Use authorization request and the member has an online Desktop host.
- When: The member applies the request for the same host at +1 s and again at +2 s.
- Then: Each apply returns `{ ok: true, source: "chat", computerUseHostId }`; the request keeps its expiry and shows the latest completion time, and thread metadata shows the host with the cloud browser disabled. The thread lifecycle has two distinct `computer_use_host_updated` events for the thread at +1 s and +2 s, with increasing sequence IDs.

## computer-use.bdd-009

- Vitest: "FILE-03 desktop computer-use runtime > orders concurrent desktop authorizations and retains the last event's preference"
- Mode: run
- Given: A signed-in member's chat Agent created a Computer Use authorization request and the member has two online Desktop hosts.
- When: The member applies the request concurrently for both hosts.
- Then: Both applies succeed with their host IDs. The thread lifecycle has exactly two `computer_use_host_updated` events (one per host) after the thread's creation event, each with the exact public shape (null title, pin order, model and service tier, cloud browser disabled) and increasing sequence IDs. Thread metadata and the request's completed host both match the later event's host.

## computer-use.bdd-010

- Vitest: "FILE-03 desktop computer-use runtime > only exposes online hosts for delegated authorization requests"
- Mode: run
- Given: A signed-in member has a chat Run, a Desktop host last seen 120 seconds ago, a stopped host, and an online host; the Agent creates a Computer Use authorization request.
- When: The member reads `GET /api/computer-use/authorization-requests/:requestToken` and applies it for the stale, the stopped, and the online host.
- Then: The request lists only the online host. Applying the stale or stopped host returns HTTP 404 "Computer-use host not found"; applying the online host returns `{ ok: true, source: "chat", computerUseHostId }` and the thread metadata carries that host.

## computer-use.bdd-011

- Vitest: "FILE-03 desktop computer-use runtime > uses chat-thread authorization for a canonical Slack run"
- Mode: run
- Given: A member has installed the Slack app for their Slack workspace and an online Desktop host "Canonical Slack Desktop".
- When: The member mentions the app in a Slack channel with a prompt (signed Slack event), the resulting Run's Agent creates a Computer Use authorization request, and the member applies it for the host.
- Then: Exactly one chat thread is created with one launched input whose message includes a Slack source part; the Run's execution prompt contains the text and its log reports trigger source `slack`. The authorization request has source `chat`, apply returns `{ ok: true, source: "chat", computerUseHostId }`, and the thread metadata carries the host.

## computer-use.bdd-012

- Vitest: "FILE-03 desktop computer-use runtime > uses chat-thread authorization for a canonical Teams run"
- Mode: run
- Given: A member's workspace has installed the Microsoft Teams app and the member has connected their Teams account; Microsoft login, Bot Framework and Graph endpoints accept requests. The member has an online Desktop host "Canonical Teams Desktop".
- When: The member mentions the bot in a Teams message (Bot Framework activity), the resulting Run's Agent creates a Computer Use authorization request, the member applies it, and later the Desktop stops.
- Then: The Teams activity returns HTTP 200; exactly one chat thread is created with one launched input whose message includes a Teams source part, and the Run's log reports trigger source `teams`. The request has source `chat`, apply returns `{ ok: true, source: "chat", computerUseHostId }`, the request shows completion and the host, and thread metadata keeps the host binding even after the Desktop stops.

## computer-use.bdd-013

- Vitest: "FILE-03 desktop computer-use runtime > chains host start, command claim, completion, audit, and host stop"
- Mode: run
- Given: A signed-in workspace member with no Desktop hosts, and a peer in the same workspace.
- When: The member lists hosts, registers a Desktop "lancy-macbook-pro.local", creates an `app.open` write command, the Desktop claims and completes it, the member and the peer read it, the member lists its audit events, and the Desktop stops and heartbeats again.
- Then: The initial host list is empty; registration returns connection generation 1 and the host is listed `online` with accessibility and screen recording granted. The command is created `queued`, claimed as `app.open`, and then reads `succeeded` on that host. The peer's read returns HTTP 403 or 404 with code `FORBIDDEN` or `NOT_FOUND`. The audit events include `completed`; after stopping, the host is `offline` and the heartbeat returns HTTP 409.

## computer-use.bdd-014

- Vitest: "FILE-03 desktop computer-use runtime > rewrites the host row only when heartbeats carry news or liveness goes stale"
- Mode: run
- Given: A signed-in member registered a Desktop host "BDD Desktop" at a fixed time.
- When: The Desktop heartbeats unchanged at +10 s and +30 s, then at +35 s with host name "Renamed Desktop"; the member lists hosts after each step.
- Then: The +10 s heartbeat returns exactly `{ ok: true, hostId, hasPendingCommands: false }` and last-seen stays at registration time. At +30 s last-seen becomes +30 s without any realtime publication. At +35 s the host shows display name "Renamed Desktop" with last-seen +35 s, and `computerUseHostsChanged` is published with a null payload.

## computer-use.bdd-015

- Vitest: "FILE-03 desktop computer-use runtime > refreshes host liveness from idle claim polls only when it is stale"
- Mode: run
- Given: A signed-in member registered a Desktop host at a fixed time with no queued commands.
- When: The Desktop polls `POST /api/computer-use/hosts/:hostId/commands/next` at +10 s and at +40 s, and the member lists hosts after each poll.
- Then: Both polls return `idle`. Last-seen stays at registration time after the +10 s poll and becomes +40 s after the +40 s poll.

## computer-use.bdd-016

- Vitest: "FILE-03 desktop computer-use runtime > keeps multiple active hosts and lets stale heartbeats recover"
- Mode: run
- Given: A signed-in member registered Desktop "Office Mac", which heartbeats; 120 seconds later the member registers a second Desktop "Studio Mac".
- When: "Office Mac" heartbeats again after going stale; the member lists hosts; "Studio Mac" stops and a new Desktop "Recovered Desktop" registers.
- Then: Both heartbeats return exactly `{ ok: true, hostId, hasPendingCommands: false }` and the second host has a different ID. The list contains both hosts `online` with their names. Stopping returns exactly `{ ok: true, hostId }`, and the newly registered Desktop gets a different host ID.

## computer-use.bdd-017

- Vitest: "FILE-03 desktop computer-use runtime > keeps installation hosts stable across stop and restart"
- Mode: run
- Given: A signed-in member registered a Desktop "Studio Mac" with a fixed installation ID.
- When: The Desktop stops and then heartbeats; the member lists hosts; the same installation registers again as "Renamed Studio Mac" and the member lists hosts.
- Then: The heartbeat after stop returns HTTP 409 with message "Computer-use host connection is no longer authorized", and the host is listed `offline`. Re-registration returns the same host ID with a higher connection generation, and the host is listed `online` as "Renamed Studio Mac".

## computer-use.bdd-018

- Vitest: "FILE-03 desktop computer-use runtime > scopes host discovery to the bound host for agent run tokens"
- Mode: run
- Given: A signed-in member has two Desktop hosts ("Other Desktop" with `apps.list` and "Apple Notes Desktop" with `app.state`), a chat Run launched with the second host selected, and a chat Run launched with no host.
- When: Each Run's Agent calls `GET /api/computer-use/hosts`.
- Then: The bound Agent sees exactly one host, "Apple Notes Desktop" with `app.state`. The unbound Agent gets HTTP 403 with an API error.

## computer-use.bdd-019

- Vitest: "FILE-03 desktop computer-use runtime > publishes computer-use host list changes"
- Mode: run
- Given: A signed-in workspace member runs a Desktop app.
- When: The Desktop registers, heartbeats unchanged, heartbeats again after 120 seconds, and stops.
- Then: Registration publishes `computerUseHostsChanged` (null payload) exactly once; the unchanged heartbeat publishes nothing; the heartbeat that revives the stale host publishes it exactly once; and the stop publishes it exactly once.

## computer-use.bdd-020

- Vitest: "FILE-03 desktop computer-use runtime > rejects host operations without a session or with an unknown connection"
- Mode: run
- Given: A caller has no session, and separately a signed-in member uses an unknown host ID with connection generation 1.
- When: Each calls heartbeat, stop, next-command and command-complete under `POST /api/computer-use/hosts/:hostId/...`.
- Then: Without a session all four return HTTP 401 with code `UNAUTHORIZED`; with the unknown connection all four return HTTP 409 with code `HOST_CONNECTION_INVALID`.

## computer-use.bdd-021

- Vitest: "FILE-03 desktop computer-use runtime > routes commands across offline, unsupported, ambiguous, and granted hosts"
- Mode: run
- Given: A signed-in workspace member starts with no Desktop hosts; then host A registers and goes stale after 91 s, host B registers with `apps.list` and `element.click`, and host A polls again so both are online. The member has a chat Run without a host, a Run bound to host B, and later a Run bound to host A.
- When: The member and Agents create commands via `POST /api/computer-use/commands` and `POST /api/computer-use/write-commands` across these states; host B claims and completes an `apps.list` read and an `element.click` write; the member lists audit events for the B-bound Run and host; at +182 s host B polls and the A-bound Agent creates a read.
- Then: With no host the create returns HTTP 404 "No linked computer-use host found"; with only a stale host HTTP 409 "No online computer-use host found"; an unsupported `app.state` HTTP 409 "No online computer-use host supports this command"; with two online hosts HTTP 409 "Multiple active computer-use hosts are online"; and the unbound Agent HTTP 403 "Computer Use is not authorized for this run. Authorize a computer once in the conversation, then retry.". The B-bound Agent's read and click are queued, host A stays idle, and host B claims both as `running` with the exact click payload. The audit has one `completed` `element.click` event with the redacted result (`appStateLength: 43`, metrics) and no raw `<app_state>` text. Finally, with host A offline, the A-bound Agent gets HTTP 409 "No online computer-use host found".

## computer-use.bdd-022

- Vitest: "FILE-03 desktop computer-use runtime > withdraws native create and claim admission when host capabilities narrow"
- Mode: run
- Given: A signed-in member has a Desktop host supporting `apps.list` and `app.state`, and has queued an `apps.list` command.
- When: The Desktop polls for the next command advertising only `app.state`, heartbeats with only `app.state`, the member tries another `apps.list` command, creates an `app.state` Safari command, and the Desktop polls again.
- Then: The narrowed poll returns `idle`; the new `apps.list` create returns HTTP 409 with an API error; and the `app.state` command is claimed with kind `app.state` and the default 60000 ms timeout.

## computer-use.bdd-023

- Vitest: "FILE-03 desktop computer-use runtime > normalizes NUL characters in completion results and errors"
- Mode: run
- Given: A signed-in member's Desktop host has claimed a write command, and later a second write command.
- When: The Desktop completes the first command successfully twice with a result containing NUL characters in a nested key and string value (plus a key that collides with an existing U+FFFD key) and Unicode text, and fails the second with an `app_not_found` message containing a NUL; the member reads both commands and their audit events.
- Then: The succeeded command's result replaces each NUL with U+FFFD in keys and values, keeps the Unicode text, and keeps only the pre-existing value for the colliding key; its single audit event is `completed` with the same normalized redacted result and `error: null`. The failed command's error message becomes "Finder�is unavailable 中文🙂", and its single audit event has `redactedResult: null` and that normalized error.

## computer-use.bdd-024

- Vitest: "FILE-03 desktop computer-use runtime > times out stale running commands and reports completion failures"
- Mode: run
- Given: A signed-in member's Desktop host has claimed an `app.state` Safari command with a 1000 ms timeout, and the member then queues an `apps.list` command.
- When: The Desktop polls while the first runs, completes the queued second command, polls again at +1.5 s, fails the second command with `app_not_found`, completes it again, and completes an unknown command ID.
- Then: The poll while running returns `idle`; completing the still-queued command returns HTTP 404 "Computer-use command not found". At +1.5 s the poll claims the second command and the first reads `failed` with `timeout` ("Computer-use command timed out after 1000ms") completed at +1.5 s. The second reads `failed` with "Finder is not available"; the duplicate completion returns exactly `{ ok: true }` without changing it; the unknown command returns HTTP 404 "Computer-use command not found".

## computer-use.bdd-025

- Vitest: "FILE-03 desktop computer-use runtime > offloads screenshots and resolves download URLs with owner isolation"
- Mode: run
- Given: A signed-in member in one workspace has a Desktop host that claimed an `app.state` Safari command; screenshot storage accepts uploads. A user in a different workspace is also signed in.
- When: The Desktop completes the command with snapshot ID, a base64 PNG screenshot and 1363×1200 dimensions; the member reads the command and resolves `GET /api/computer-use/commands/:commandId/screenshot/url`; the other-workspace user requests the same screenshot URL.
- Then: Exactly one PNG upload is stored in the user-storages bucket under `computer-use/<orgId>/<userId>/<commandId>/screenshot.png` with the original bytes. The command result shows `{ type: "s3", mimeType: "image/png", sizeBytes, width: 1363, height: 1200 }` and no base64 data. The download response has a URL containing the encoded key, content type `image/png` and the byte size; the other user gets HTTP 404 `NOT_FOUND`.

## computer-use.bdd-026

- Vitest: "AUTH-05 computer-use auth boundary Clerk classification > maps a deleted Clerk identity to 401 and drops the stale membership cache row"
- Mode: run
- Given: A user's personal access token was used once with a fresh workspace membership (the request reached the handler and returned 404 for an unknown command), and 61 seconds later the cached role has expired. The identity provider now reports the identity as deleted (404).
- When: The token calls `GET /api/computer-use/commands/:commandId`, and then a probe request is made 30 seconds after the original warm-up while the provider still reports the identity gone.
- Then: The request returns HTTP 401 `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }` after exactly one membership lookup, with no retry delay and no error report. The probe also returns HTTP 401, showing the cached membership was removed.

## computer-use.bdd-027

- Vitest: "AUTH-05 computer-use auth boundary Clerk classification > maps an exhausted Clerk provider read to a non-cacheable 503"
- Mode: run
- Given: A user's personal access token has a warmed membership cache that has since expired, and the identity provider's membership lookup fails with status 521.
- When: The token calls `GET /api/computer-use/commands/:commandId`, then a cache probe request is made within the original cache window while the provider reports the identity gone.
- Then: The request returns HTTP 503 `{ error: { message: "Authentication provider is temporarily unavailable", code: "PROVIDER_UNAVAILABLE" } }` with `Cache-Control: no-store`, after three lookups with two retry delays and no error report. The probe returns HTTP 404, so the cached role survived.

## computer-use.bdd-028

- Vitest: "AUTH-05 computer-use auth boundary Clerk classification > leaves a Clerk rate-limited membership read on its existing path"
- Mode: run
- Given: A user's personal access token has a warmed membership cache that has since expired, and the identity provider rate-limits the membership lookup (429).
- When: The token calls `GET /api/computer-use/commands/:commandId`, then a cache probe request is made within the original cache window.
- Then: The request returns HTTP 500 after one lookup with no retry delay, and the 429 error is reported to error tracking. The probe returns HTTP 404, so the cached role survived.

## computer-use.bdd-029

- Vitest: "AUTH-05 computer-use auth boundary Clerk classification > propagates every other Clerk and database membership failure unchanged"
- Mode: run
- Given: A user's personal access token has a warmed membership cache that has since expired. The identity provider's membership lookup first fails with 403, then with a non-provider error "membership read failed".
- When: The token calls `GET /api/computer-use/commands/:commandId` under each failure, then a cache probe request is made within the original cache window.
- Then: Both requests return HTTP 500 and both errors are reported to error tracking (the 403 after a single lookup). The probe returns HTTP 404, so neither failure cleared the cached role.

## computer-use.bdd-030

- Vitest: "AUTH-05 computer-use auth boundary Clerk classification > keeps a non-member identity on the degraded user-only context"
- Mode: run
- Given: A user's personal access token has a warmed membership cache that has since expired. The identity provider then returns an empty membership list, and later reports the identity as deleted (404).
- When: The token calls `GET /api/auth/me` in each state.
- Then: With no memberships the request returns HTTP 200 with the user's ID and `orgId: null`. Once the identity is deleted, the request returns HTTP 401 with code `UNAUTHORIZED`.
