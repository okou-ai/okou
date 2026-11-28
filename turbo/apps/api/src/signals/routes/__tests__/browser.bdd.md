# browser

## browser-001

- Vitest: "Browser user-action route > creates a native input link from Slack and delivers the callback to the same chat"
- Mode: run
- Given: A workspace member has installed the Slack app with a connected account and enabled cloud Browser by default; a Slack direct message "Sign in to the website" has launched a Run. The Browser provider creates an active browser whose current page shows a login password field.
- When: The Run opens the shared Browser with `POST /api/browsers/use`, creates a native password input request with `POST /api/browser/user-actions` carrying a callback prompt, the signed-in member applies a password with `POST /api/browser/user-actions/:requestToken/apply`, sends the callback prompt to the Browser's thread with `POST /api/chat/events` using the success callback IDs, and reads `GET /api/browser/user-actions/:requestToken`.
- Then: Creation returns HTTP 201 with an action URL on `https://app.okou.test` at `/browser/actions/<requestToken>` whose query carries the Browser's thread ID and the callback prompt. The apply returns HTTP 200 in state `succeeded`, the callback send returns HTTP 201, and the read-back reports the callback as delivered.

## browser-002

- Vitest: "Browser user-action route > keeps all native input operations within the request owner for another user"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a pending native file input request, and the owner has preflighted it to obtain the file-set fingerprint. The foreign caller is another user in the same organization.
- When: The foreign user calls `GET`, `POST .../preflight`, `POST .../apply` (with a file replacement value), `POST .../cancel` and `POST .../files/prepare` on `/api/browser/user-actions/:requestToken`; the owner then reads, preflights and cancels the request.
- Then: Every foreign call returns HTTP 404 with `BROWSER_USER_ACTION_NOT_FOUND`. Afterwards the owner still reads it as `pending`, the owner's preflight returns `pending`, the cancel returns `cancelled`, and a final read shows `cancelled`.

## browser-003

- Vitest: "Browser user-action route > keeps all native input operations within the request owner for another organization"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a pending native file input request, and the owner has preflighted it to obtain the file-set fingerprint. The foreign caller is the same user signed into another organization.
- When: The foreign caller calls `GET`, `POST .../preflight`, `POST .../apply` (with a file replacement value), `POST .../cancel` and `POST .../files/prepare` on `/api/browser/user-actions/:requestToken`; the owner then reads, preflights and cancels the request.
- Then: Every foreign call returns HTTP 404 with `BROWSER_USER_ACTION_NOT_FOUND`. Afterwards the owner still reads it as `pending`, the owner's preflight returns `pending`, the cancel returns `cancelled`, and a final read shows `cancelled`.

## browser-004

- Vitest: "Browser user-action route > rejects overlapping native file applications and preserves the completed action"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a pending native file input request, which the member has preflighted. The Browser provider holds its next browser status read until released.
- When: The member applies a `clear` operation with `POST /api/browser/user-actions/:requestToken/apply`; while that apply waits on the provider, the member reads the request and sends a second identical apply; after release, the member reads it again and replays the apply.
- Then: The read during the held apply shows state `applying` and the overlapping apply returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`. The first apply returns HTTP 200 `succeeded`, a realtime `browserUserActionChanged:<threadId>` publication is sent, the final read shows `succeeded`, and the replay returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`.

## browser-005

- Vitest: "Browser user-action route > recovers stalled input after the deadline and retains uncertainty after a late provider failure"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a pending native file input request, which the member has preflighted. The Browser provider's status read stalls and eventually answers HTTP 503.
- When: The member applies a `clear` operation; while it stalls the member reads the request at 1 minute minus 1 ms, at exactly 1 minute, and at 1 minute plus 1 ms after start, then replays the apply; after the provider fails, the member reads again and replays once more.
- Then: Reads at 59,999 ms and 60,000 ms show `applying` with the callback not delivered; at 60,001 ms the request is `uncertain` with the callback not delivered and the replay returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`. The stalled apply finally returns HTTP 502 `BROWSER_USE_ERROR`, the request stays `uncertain` with no callback delivered, and a further replay returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`.

## browser-006

- Vitest: "Browser user-action route > bounds native file input and cleans staged files when target observation becomes stale"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional multiple file input accepting `.txt`. Temporary uploads are staged through `POST /api/browser/user-actions/:requestToken/files/prepare`, which returns only a signed upload URL.
- When: The Run creates a file input request; the member posts an apply body one byte over the maximum apply size, preflights, stages a file, applies with an upper-case MIME type, applies after the site's accept changes to `.pdf`, preflights a second staged request after the target node disappears, and finally applies a third staged request with `note.txt` once the control is restored.
- Then: The create response shows a `file` control without any file-set fingerprint. The oversized body returns HTTP 400 "Browser input request is too large"; preflight shows `accept` `.txt`, `multiple` true, no files and a 64-hex fingerprint; the bad MIME apply returns HTTP 400; the accept drift apply returns 200 `stale`; the missing-node preflight returns 200 `stale` and deletes its staged object. The final apply returns `succeeded`, after which the first and last staged objects have been deleted; it places exactly `note.txt` (4 bytes, `text/plain`) in the page, does not echo the file name, and uses an isolated world on the page. No files are written by the rejected attempts.

## browser-007

- Vitest: "Browser user-action route > preserves selected files for unavailable controls and reports failed independent readback"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page file input already holds `note.txt`.
- When: The Run creates a file input request while the control is not writable, then while writable; the member applies after the control moves out of the main document, the Run creates another request while it is outside the main document, the member applies after the target node disappears, and finally stages a file and applies a replacement when the page cannot read the file selection back.
- Then: Creation for the unwritable control returns HTTP 409, and creation for the control outside the main document returns HTTP 409 `BROWSER_USER_ACTION_UNSUPPORTED_CONTROL`. Applying after the move returns 200 `stale` and leaves the existing `note.txt` selection untouched; applying after the node disappears returns 200 `stale`. The apply without readback returns 200 `uncertain`.

## browser-008

- Vitest: "Browser user-action route > bounds staged file transfer, supports multiple files and cleans cancelled uploads"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has a multiple file input, and the member stages temporary uploads through `POST /api/browser/user-actions/:requestToken/files/prepare`.
- When: The member applies a `note.txt` replacement after the staged object is deleted, after it is replaced by one byte over the maximum file size, and after it is replaced by different bytes of the same size; then applies a 10 MiB file, applies three staged files `part-0.txt`..`part-2.txt` in one request, and cancels a further request after staging a file.
- Then: The missing-object and oversized-object applies return HTTP 409 and write nothing to the page. The same-size changed-bytes apply returns 200 `succeeded` and writes once. The 10 MiB apply succeeds and the page holds `note.txt` with that size; the three-file apply succeeds, the page holds exactly the three files in order, and all three staged objects are deleted. The cancel returns 200 `cancelled` and deletes its staged object.

## browser-009

- Vitest: "Browser user-action route > preserves stale and cancelled native file requests after their target disappears"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a pending native file input request.
- When: The member preflights it, preflights again after the target node disappears, reads it, then preflights and cancels again; separately the member cancels a second request, the target disappears, and the member preflights and reads that cancelled request.
- Then: The first preflight returns `pending`, the post-disappearance preflight and read return `stale`, and the further preflight and cancel each return HTTP 409 `BROWSER_USER_ACTION_CONFLICT` while the request stays `stale`. The second request's cancel returns `cancelled`, its later preflight returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`, and it still reads `cancelled`.

## browser-010

- Vitest: "Browser user-action route > rejects resubmitting succeeded native file actions after upload cleanup"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a native file input request, which the member preflighted and for which a file was staged. Terminal state for this row: `succeeded`.
- When: The member applies the `note.txt` replacement with `POST /api/browser/user-actions/:requestToken/apply`, then submits the same apply again and reads the request.
- Then: The first apply returns HTTP 200 `succeeded`. The retry returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`, and the request still reads `succeeded`.

## browser-011

- Vitest: "Browser user-action route > rejects resubmitting cancelled native file actions after upload cleanup"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a native file input request, which the member preflighted and for which a file was staged. Terminal state for this row: `cancelled`.
- When: The member cancels with `POST /api/browser/user-actions/:requestToken/cancel`, then submits the `note.txt` replacement apply and reads the request.
- Then: The cancel returns HTTP 200 `cancelled`. The apply returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`, and the request still reads `cancelled`.

## browser-012

- Vitest: "Browser user-action route > rejects a late native file preflight after the request is succeeded"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a native file input request, which the member preflighted. The Browser provider holds the next status read. Terminal state for this row: `succeeded`.
- When: The member starts a second preflight; while it waits on the provider, the member applies a `clear` operation; after release, the member reads the request, preflights again and reads again.
- Then: The apply returns HTTP 200 `succeeded`. The held preflight returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`, the request reads `succeeded`, the replayed preflight returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`, and the request still reads `succeeded`.

## browser-013

- Vitest: "Browser user-action route > rejects a late native file preflight after the request is cancelled"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a native file input request, which the member preflighted. The Browser provider holds the next status read. Terminal state for this row: `cancelled`.
- When: The member starts a second preflight; while it waits on the provider, the member cancels the request; after release, the member reads the request, preflights again and reads again.
- Then: The cancel returns HTTP 200 `cancelled`. The held preflight returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`, the request reads `cancelled`, the replayed preflight returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`, and the request still reads `cancelled`.

## browser-014

- Vitest: "Browser user-action route > lets apply finish while the preflight provider read is still pending"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a pending native password input request. The Browser provider holds its next browser status read until released.
- When: The member starts `POST /api/browser/user-actions/:requestToken/preflight`; while it waits, the member applies a password with `POST /api/browser/user-actions/:requestToken/apply`; the provider read is then released.
- Then: The apply returns HTTP 200 `succeeded`. The held preflight returns HTTP 409, and exactly one input write reaches the page.

## browser-015

- Vitest: "Browser user-action route > expires pending native file actions at the idle deadline +0ms"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a native file input request, which the member preflighted; the member leases the thread Browser with `POST /api/chat-threads/:threadId/browser/lease` to learn its idle deadline. Offset for this row: 0 ms past the deadline.
- When: The member reads the request 1 ms before the deadline; at the deadline the member calls `GET`, `POST .../files/prepare`, `POST .../preflight`, `POST .../apply` and `POST .../cancel` on `/api/browser/user-actions/:requestToken`; back at the original time the member reads and cancels it, then reads it at the deadline.
- Then: The read before the deadline shows `pending`. All five calls at the deadline return HTTP 410 `BROWSER_USER_ACTION_EXPIRED`, and a realtime `browserUserActionChanged:<threadId>` publication is sent. Back at the original time the request reads `pending`, the cancel returns `cancelled`, and the read at the deadline shows `cancelled`.

## browser-016

- Vitest: "Browser user-action route > expires pending native file actions at the idle deadline +1ms"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a native file input request, which the member preflighted; the member leases the thread Browser with `POST /api/chat-threads/:threadId/browser/lease` to learn its idle deadline. Offset for this row: 1 ms past the deadline.
- When: The member reads the request 1 ms before the deadline; 1 ms after the deadline the member calls `GET`, `POST .../files/prepare`, `POST .../preflight`, `POST .../apply` and `POST .../cancel` on `/api/browser/user-actions/:requestToken`; back at the original time the member reads and cancels it, then reads it 1 ms after the deadline.
- Then: The read before the deadline shows `pending`. All five calls after the deadline return HTTP 410 `BROWSER_USER_ACTION_EXPIRED`, and a realtime `browserUserActionChanged:<threadId>` publication is sent. Back at the original time the request reads `pending`, the cancel returns `cancelled`, and the later read shows `cancelled`.

## browser-017

- Vitest: "Browser user-action route > keeps native file cancellation idempotent after the browser lease expires"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created two pending native file input requests; the member leased the thread Browser to learn its idle deadline and cancelled the first request.
- When: The clock moves 1 ms past the idle deadline; the member cancels the second (still pending) request, cancels the first request again, preflights the first request, and reads it.
- Then: The first cancel returned `cancelled`. After expiry the second request's cancel returns HTTP 410 `BROWSER_USER_ACTION_EXPIRED`; the repeated cancel of the first returns HTTP 200 with a body identical to the original cancel; its preflight returns HTTP 409 `BROWSER_USER_ACTION_CONFLICT`; and it still reads `cancelled`.

## browser-018

- Vitest: "Browser user-action route > rechecks native input creation at the lease deadline (renewed=false)"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser, and the clock sits 1 minute before the thread Browser's idle deadline. The Browser provider holds the next status read. Row: the lease is not renewed during preparation.
- When: The Run starts creating a native file input request with `POST /api/browser/user-actions`; while it waits, the clock reaches the idle deadline; the Run then retries the same create.
- Then: The held create returns HTTP 404 `BROWSER_USER_ACTION_NOT_FOUND`, and the retry returns HTTP 409 `BROWSER_USER_ACTION_BROWSER_NOT_LIVE`.

## browser-019

- Vitest: "Browser user-action route > rechecks native input creation at the lease deadline (renewed=true)"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser, and the clock sits 1 minute before the thread Browser's idle deadline. The Browser provider holds the next status read. Row: the lease is renewed during preparation.
- When: The Run starts creating a native file input request with `POST /api/browser/user-actions`; while it waits, the member renews the lease with `POST /api/chat-threads/:threadId/browser/lease` and the clock reaches the old deadline; the member then reads the created request.
- Then: The renewed lease's idle deadline is later than the old deadline. The create returns HTTP 201, and the request reads `pending`.

## browser-020

- Vitest: "Browser user-action route > can create native input after preparation rejects HTTP 503"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser. Row: the Browser provider's status read answers HTTP 503 during the first request preparation, then recovers to an active browser.
- When: The Run creates a native file input request with `POST /api/browser/user-actions` during the failure, then creates another after recovery; the member reads, preflights and applies a `clear` operation to the new request.
- Then: The first create returns HTTP 502 `BROWSER_USE_ERROR`. The second create returns HTTP 201, the request reads `pending` with the callback not delivered, and the apply returns HTTP 200 `succeeded`.

## browser-021

- Vitest: "Browser user-action route > can create native input after preparation rejects inactive provider"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser. Row: the Browser provider reports the browser as stopped during the first request preparation, then reports it active again.
- When: The Run creates a native file input request with `POST /api/browser/user-actions` while the provider reports it stopped, then creates another after recovery; the member reads, preflights and applies a `clear` operation to the new request.
- Then: The first create returns HTTP 409 `BROWSER_USER_ACTION_BROWSER_NOT_LIVE`. The second create returns HTTP 201, the request reads `pending` with the callback not delivered, and the apply returns HTTP 200 `succeeded`.

## browser-022

- Vitest: "Browser user-action route > keeps a preflight pending when its attach reply is withheld until the deadline"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a pending native password input request. The browser emits a target-attached event but withholds the reply to the page attach command.
- When: The member calls `POST /api/browser/user-actions/:requestToken/preflight` and the 15-second browser command deadline elapses; the member then reads the request.
- Then: The preflight returns HTTP 503 `BROWSER_USE_TIMEOUT`, and the request still reads `pending`.

## browser-023

- Vitest: "Browser user-action route > preflights when an attach event and reply arrive back-to-back"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a pending native password input request. The browser sends a target-attached event immediately before the attach reply.
- When: The member calls `POST /api/browser/user-actions/:requestToken/preflight`.
- Then: The preflight returns HTTP 200 with state `pending`.

## browser-024

- Vitest: "Browser user-action route > keeps an input request pending when an interleaved attach reply is a CDP error"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser and created a pending native password input request. The browser sends a target-attached event and then answers the page attach command with an error.
- When: The member calls `POST /api/browser/user-actions/:requestToken/preflight` and then reads the request.
- Then: The preflight returns HTTP 502 `BROWSER_USER_ACTION_PROVIDER_ERROR`, and the request still reads `pending`.

## browser-025

- Vitest: "Browser user-action route > independently verifies select-one/null and reports event microtask resets as uncertain"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose order page has an optional select-one control. Each request is created with `POST /api/browser/user-actions` and preflighted before apply. Row: control `select-one`, scalar kind `null`.
- When: The member applies option index 1 with the observed option fingerprint to a first request; then, with the page resetting the value in an event microtask after the write, applies the same values to a second request, reads it, and applies it again.
- Then: The first apply returns HTTP 200 `succeeded` after one page write. The second apply returns HTTP 200 `uncertain`, the read shows `uncertain` with the callback not delivered, and the repeated apply returns HTTP 409. The page records exactly 2 writes and 2 independent verifications in total.

## browser-026

- Vitest: "Browser user-action route > independently verifies select-multiple/null and reports event microtask resets as uncertain"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose order page has an optional select-multiple control. Each request is created with `POST /api/browser/user-actions` and preflighted before apply. Row: control `select-multiple`, scalar kind `null`.
- When: The member applies option index 1 with the observed option fingerprint to a first request; then, with the page resetting the value in an event microtask after the write, applies the same values to a second request, reads it, and applies it again.
- Then: The first apply returns HTTP 200 `succeeded` after one page write. The second apply returns HTTP 200 `uncertain`, the read shows `uncertain` with the callback not delivered, and the repeated apply returns HTTP 409. The page records exactly 2 writes and 2 independent verifications in total.

## browser-027

- Vitest: "Browser user-action route > independently verifies checkbox/null and reports event microtask resets as uncertain"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose order page has an optional checkbox control. Each request is created with `POST /api/browser/user-actions` and preflighted before apply. Row: control `checkbox`, scalar kind `null`.
- When: The member applies an explicit unchecked value with observed checked true to a first request; then, with the page resetting the value in an event microtask after the write, applies the same values to a second request, reads it, and applies it again.
- Then: The first apply returns HTTP 200 `succeeded` after one page write. The second apply returns HTTP 200 `uncertain`, the read shows `uncertain` with the callback not delivered, and the repeated apply returns HTTP 409. The page records exactly 2 writes and 2 independent verifications in total.

## browser-028

- Vitest: "Browser user-action route > independently verifies select-one/text and reports event microtask resets as uncertain"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose order page has an optional select-one control and a required `text` field. Each request is created with `POST /api/browser/user-actions` and preflighted before apply. Row: control `select-one`, scalar kind `text`.
- When: The member applies option index 1 plus the text value to a first request; then, with the page resetting the value in an event microtask after the write, applies the same values to a second request, reads it, and applies it again.
- Then: The first apply returns HTTP 200 `succeeded` after one page write. The second apply returns HTTP 200 `uncertain`, the read shows `uncertain` with the callback not delivered, and the repeated apply returns HTTP 409. The page records exactly 2 writes and 2 independent verifications in total.

## browser-029

- Vitest: "Browser user-action route > independently verifies checkbox/username and reports event microtask resets as uncertain"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose order page has an optional checkbox control and a required `username` field. Each request is created with `POST /api/browser/user-actions` and preflighted before apply. Row: control `checkbox`, scalar kind `username`.
- When: The member applies an explicit unchecked value plus the username value to a first request; then, with the page resetting the value in an event microtask after the write, applies the same values to a second request, reads it, and applies it again.
- Then: The first apply returns HTTP 200 `succeeded` after one page write. The second apply returns HTTP 200 `uncertain`, the read shows `uncertain` with the callback not delivered, and the repeated apply returns HTTP 409. The page records exactly 2 writes and 2 independent verifications in total.

## browser-030

- Vitest: "Browser user-action route > independently verifies checkbox/password and reports event microtask resets as uncertain"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose order page has an optional checkbox control and a required `password` field. Each request is created with `POST /api/browser/user-actions` and preflighted before apply. Row: control `checkbox`, scalar kind `password`.
- When: The member applies an explicit unchecked value plus the password value to a first request; then, with the page resetting the value in an event microtask after the write, applies the same values to a second request, reads it, and applies it again.
- Then: The first apply returns HTTP 200 `succeeded` after one page write. The second apply returns HTTP 200 `uncertain`, the read shows `uncertain` with the callback not delivered, and the repeated apply returns HTTP 409. The page records exactly 2 writes and 2 independent verifications in total.

## browser-031

- Vitest: "Browser user-action route > keeps interrupted mixed verification uncertain without replay for error responses"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose order page has an optional select-one control and a required `password` field, and the member created and preflighted a request. Row: `error` — the page's independent verification read returns a browser command error.
- When: The member applies option index 1 and the password value with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and applies it again.
- Then: The apply returns HTTP 200 `uncertain`, the read shows `uncertain` with the callback not delivered, and the repeated apply returns HTTP 409. The page records exactly 1 write and 1 verification.

## browser-032

- Vitest: "Browser user-action route > keeps interrupted mixed verification uncertain without replay for malformed responses"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose order page has an optional select-one control and a required `password` field, and the member created and preflighted a request. Row: `malformed` — the page's independent verification read returns a malformed result.
- When: The member applies option index 1 and the password value with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and applies it again.
- Then: The apply returns HTTP 200 `uncertain`, the read shows `uncertain` with the callback not delivered, and the repeated apply returns HTTP 409. The page records exactly 1 write and 1 verification.

## browser-033

- Vitest: "Browser user-action route > keeps interrupted mixed verification uncertain without replay for timeout responses"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose order page has an optional select-one control and a required `password` field, and the member created and preflighted a request. Row: `timeout` — the page withholds the independent verification reply until the 15-second browser command deadline elapses.
- When: The member applies option index 1 and the password value with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and applies it again.
- Then: The apply returns HTTP 200 `uncertain`, the read shows `uncertain` with the callback not delivered, and the repeated apply returns HTTP 409. The page records exactly 1 write and 1 verification.

## browser-034

- Vitest: "Browser user-action route > applies explicit checkbox booleans, preserves untouched state, and rejects changed or required checkboxes"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose consent page has a checked, writable, optional checkbox.
- When: The Run creates checkbox input requests with `POST /api/browser/user-actions` and the member preflights and applies them with `POST /api/browser/user-actions/:requestToken/apply`: an explicit unchecked choice, an empty value list, an unchecked choice after the page unchecks the box, required requests with no value, unchecked and checked choices, an unchecked choice while the site marks the box required, creations while the control is not writable or is a text input, and a checked choice when the page does not confirm the write.
- Then: Creation returns a checkbox `INPUT` control without exposing its checked state, and preflight shows `checked` true and `siteRequired` false. The explicit unchecked choice succeeds and writes `checked` false; the empty list succeeds and leaves the box untouched; the drifted box returns `stale`. The required request rejects no value and unchecked with HTTP 400 `BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING` and accepts checked as `succeeded`. The site-required unchecked choice returns HTTP 409 `BROWSER_USER_ACTION_INVALID_VALUE`; both unwritable and text-type creations return HTTP 409; the unconfirmed write returns `uncertain`.

## browser-035

- Vitest: "Browser user-action route > discovers exact radio member identities, selects duplicate-valued option by index, and rejects group drift"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has a radio group `delivery` of three members in one form: options 0 and 1 share the same label and value, option 0 is selected, and option 2 is disabled.
- When: The Run creates radio input requests with `POST /api/browser/user-actions` and the member preflights and applies them by member index and observed selected index with the group fingerprint: select index 1, clear with -1, select the disabled option, clear while the site requires the group, select when the page does not confirm the write or the readback differs, and apply after the selection, group name, form owner or member set changes; then applies mixed radio and optional text requests while the radio change makes the text field required immediately or in a microtask.
- Then: Neither creation nor preflight exposes the private member node IDs or option value; preflight lists options 0 and 1 with the same label (0 selected) and option 2 disabled, with a 64-hex group fingerprint. Selecting index 1 and clearing succeed, the write targeting all three members and the form. Selecting the disabled option and clearing a site-required group return HTTP 409 `BROWSER_USER_ACTION_INVALID_VALUE`. An unconfirmed write and a mismatched independent readback return `uncertain`. Any group drift (selection, name, form, members) returns `stale`. Both mixed constraint-drift applies return `uncertain`, the microtask case after a write plus an independent verification.

## browser-036

- Vitest: "Browser user-action route > selects by option index, rejects disabled and drifted options, and supports explicit clear"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has a writable single-select `region` with an empty placeholder (0), a disabled option (1) and two enabled options (2 selected, 3) that share the private value `same`.
- When: The Run creates select input requests with `POST /api/browser/user-actions` and the member preflights and applies option indexes with the option-set fingerprint: the disabled option, option 3 after its label changes, option 3, options 2 and 3 on a multi-select, an empty selection, a required request with no option or the placeholder, option 3 when the page does not confirm the write, mixed select and required text requests, and a preflight after the control becomes non-writable.
- Then: Creation returns a `SELECT` `select-one` control; preflight lists every option's index, label, disabled, selected and empty flags with a 64-hex fingerprint and never exposes node IDs or the `same` value. The disabled option returns HTTP 409 `BROWSER_USER_ACTION_INVALID_VALUE` and the label drift returns `stale`, both without writing. Option 3, the multi-select pair [2, 3] and the explicit clear succeed with the matching index writes. The required request rejects no option with HTTP 400 `BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING` and the placeholder with HTTP 409 `BROWSER_USER_ACTION_INVALID_VALUE`, and the unconfirmed write returns `uncertain`. Mixed requests succeed, writing the select and the note, or only the note when the select is untouched. The non-writable preflight returns `stale` with no write.

## browser-037

- Vitest: "Browser user-action route > supports live number constraints, optional clear, and exact readback"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has a `quantity` number input with live constraints min 10, max 20, step 0.5.
- When: The Run creates number input requests with `POST /api/browser/user-actions` and the member preflights and applies values: `not-a-number`, `12.3`, `12.5` after the site raises min to 15, `12.5` with min back at 10, an empty value list, an empty string, an empty string on a required request, `9007199254740993` after constraints change to min 0, max 1e30, step `any`, and `12.5` when the readback does not match.
- Then: Creation returns an `INPUT` `number` control and preflight reports min 10, max 20, step 0.5 without node IDs. `not-a-number`, `12.3` and the out-of-range `12.5` each return HTTP 409 `BROWSER_USER_ACTION_INVALID_VALUE` with no write. `12.5` within range succeeds with a write carrying the constraints and value. The empty list succeeds with one descriptor recheck carrying a null value, and the empty string clears and succeeds. The required empty value returns HTTP 400 `BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING`. The large integer succeeds and is written exactly. The mismatched readback returns `uncertain`.

## browser-038

- Vitest: "Browser user-action route > guards native slider position, constraints, required confirmation and post-event readback"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has a writable `level` range slider at 19 with min 10, max 20, step 3.
- When: The Run creates slider input requests with `POST /api/browser/user-actions` and the member applies values with the observed position and constraints: an empty list, a required request with no value, without observed position, and confirming 19; value 17 then 16; 19 after the position changes to 16; 19 after min changes to 11; 16 when the readback differs; 51 on a slider with no explicit bounds at 50; 200 on a single-position slider with min 200; and creation while the slider is not writable.
- Then: Creation shows a `range` control without its position, and preflight reports position 19 with min 10, max 20, step 3. The empty list succeeds with a null-value write and an independent verification. The required request rejects no value with HTTP 400 `BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING` and a value without observations with HTTP 400 `BROWSER_USER_ACTION_INVALID_VALUES`, and accepts confirmed 19 with a write and verification. 17 returns HTTP 409 `BROWSER_USER_ACTION_INVALID_VALUE` and 16 succeeds. Position or constraint drift returns `stale` and the mismatched readback returns `uncertain`. The unbounded slider omits min, max and step and accepts 51; the single-position slider reports min 200 and accepts 200. The unwritable creation returns HTTP 409.

## browser-039

- Vitest: "Browser user-action route > guards native opaque color selection, unchanged values, stale targets and independent readback"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has a writable opaque `swatch` color input set to `#123abc`.
- When: The Run creates color input requests with `POST /api/browser/user-actions` and the member applies colors with the observed color: an empty list; a required request with no value, without an observed color, and confirming `#123abc`; `#00ff00`; `#00ff00` after the control becomes non-writable; `#123abc` after the page color changes to `#00ff00`; `#00ff00` when the readback differs; and creation while the control is not writable.
- Then: Creation shows a `color` control without its value, and preflight reports `#123abc` in `opaque-srgb` mode. The empty list succeeds with a null-value write followed by an independent verification. The required request rejects no value and the unobserved value with HTTP 400 and accepts confirmed `#123abc`. `#00ff00` succeeds. The non-writable control and the color drift each return `stale`, the mismatched readback returns `uncertain`, and the non-writable creation returns HTTP 409.

## browser-040

- Vitest: "Browser user-action route > validates all five native date/time subtypes, empty/required values and independent readback"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an `arrival` date/time input whose subtype and constraints the page can change.
- When: For each subtype (`date` with min 2026-01-01 and max 2026-12-31, `time` with step 60, `datetime-local`, `month`, `week`) the Run creates a `date_time` request with `POST /api/browser/user-actions`, the member preflights it and applies `not-a-date` and then the canonical value; the member then applies an empty list, an empty string, an empty string on a required request, `2026-09` after the control changes from `date` to `month`, and a date when the readback differs.
- Then: Each creation returns an `INPUT` control of that subtype and preflight reports its min, max and step without node IDs. `not-a-date` returns HTTP 409 `BROWSER_USER_ACTION_INVALID_VALUE`, and the canonical values (`2026-09-25`, `09:30`, `2026-09-25T09:30`, `2026-09`, `2026-W39`) succeed with a write followed by an independent verification. The empty list succeeds with two page calls ending in a null-value check, and the empty string succeeds with a verified empty value. The required empty value returns HTTP 400 `BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING`, the subtype drift returns `stale`, and the mismatched readback returns `uncertain`.

## browser-041

- Vitest: "Browser user-action route > rejects type drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `type` drift — the first control's change event changes the later control's type to `text`.
- When: The member applies `synthetic-first` to `first` and `synthetic-later` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its initial value, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-042

- Vitest: "Browser user-action route > rejects disabled drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `disabled` drift — the first control's change event disables the later control.
- When: The member applies `synthetic-first` to `first` and `synthetic-later` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its initial value, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-043

- Vitest: "Browser user-action route > rejects readOnly drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `readOnly` drift — the first control's change event makes the later control read-only.
- When: The member applies `synthetic-first` to `first` and `synthetic-later` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its initial value, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-044

- Vitest: "Browser user-action route > rejects fieldset drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `fieldset` drift — the first control's change event disables the later control's containing fieldset.
- When: The member applies `synthetic-first` to `first` and `synthetic-later` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its initial value, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-045

- Vitest: "Browser user-action route > rejects required drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `required` drift — the first control's change event makes the later control required.
- When: The member applies `synthetic-first` to `first` and `synthetic-later` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its initial value, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-046

- Vitest: "Browser user-action route > rejects minLength drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `minLength` drift — the first control's change event sets the later control's minimum length to 1.
- When: The member applies `synthetic-first` to `first` and `synthetic-later` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its initial value, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-047

- Vitest: "Browser user-action route > rejects maxLength drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `maxLength` drift — the first control's change event sets the later control's maximum length to 50.
- When: The member applies `synthetic-first` to `first` and `synthetic-later` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its initial value, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-048

- Vitest: "Browser user-action route > rejects pattern drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `pattern` drift — the first control's change event sets the later control's pattern to `.*`.
- When: The member applies `synthetic-first` to `first` and `synthetic-later` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its initial value, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-049

- Vitest: "Browser user-action route > rejects multiple drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `email` control, and the Run created an input request for both. Row: `multiple` drift — the first control's change event makes the later control accept multiple values.
- When: The member applies `synthetic-first` to `first` and `synthetic@example.com` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its initial value, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-050

- Vitest: "Browser user-action route > rejects min drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `number` control, and the Run created an input request for both. Row: `min` drift — the first control's change event sets the later control's min to 1.
- When: The member applies `synthetic-first` to `first` and `10` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its original value `10`, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-051

- Vitest: "Browser user-action route > rejects max drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `number` control, and the Run created an input request for both. Row: `max` drift — the first control's change event sets the later control's max to 50.
- When: The member applies `synthetic-first` to `first` and `10` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its original value `10`, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-052

- Vitest: "Browser user-action route > rejects step drift before a later scalar write"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `number` control, and the Run created an input request for both. Row: `step` drift — the first control's change event sets the later control's step to 2.
- When: The member applies `synthetic-first` to `first` and `10` to `later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain`; `first` holds `synthetic-first`, the later control keeps its original value `10`, and only `first` input and change events fire. The read shows `uncertain` with the callback not delivered and contains neither submitted value. The retry returns HTTP 409 and fires no further events.

## browser-053

- Vitest: "Browser user-action route > rejects final scalar type drift in an event immediate even when values match"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `type` drift, `immediate` timing — the page changes the first control's type to `password` synchronously in the later control's change event.
- When: The member applies `synthetic-first` and `synthetic-later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain` even though both controls hold the submitted values, after input and change events for `first` then `later`. The read shows `uncertain` with the callback not delivered, and the retry returns HTTP 409 without firing further events.

## browser-054

- Vitest: "Browser user-action route > rejects final scalar disabled drift in an event immediate even when values match"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `disabled` drift, `immediate` timing — the page disables the first control synchronously in the later control's change event.
- When: The member applies `synthetic-first` and `synthetic-later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain` even though both controls hold the submitted values, after input and change events for `first` then `later`. The read shows `uncertain` with the callback not delivered, and the retry returns HTTP 409 without firing further events.

## browser-055

- Vitest: "Browser user-action route > rejects final scalar readOnly drift in an event immediate even when values match"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `readOnly` drift, `immediate` timing — the page makes the first control read-only synchronously in the later control's change event.
- When: The member applies `synthetic-first` and `synthetic-later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain` even though both controls hold the submitted values, after input and change events for `first` then `later`. The read shows `uncertain` with the callback not delivered, and the retry returns HTTP 409 without firing further events.

## browser-056

- Vitest: "Browser user-action route > rejects final scalar type drift in an event microtask even when values match"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `type` drift, `microtask` timing — the page changes the first control's type to `password` in a microtask queued by the later control's change event.
- When: The member applies `synthetic-first` and `synthetic-later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain` even though both controls hold the submitted values, after input and change events for `first` then `later`. The read shows `uncertain` with the callback not delivered, and the retry returns HTTP 409 without firing further events.

## browser-057

- Vitest: "Browser user-action route > rejects final scalar disabled drift in an event microtask even when values match"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `disabled` drift, `microtask` timing — the page disables the first control in a microtask queued by the later control's change event.
- When: The member applies `synthetic-first` and `synthetic-later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain` even though both controls hold the submitted values, after input and change events for `first` then `later`. The read shows `uncertain` with the callback not delivered, and the retry returns HTTP 409 without firing further events.

## browser-058

- Vitest: "Browser user-action route > rejects final scalar readOnly drift in an event microtask even when values match"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has an optional `first` text control (requested as `username`) and an optional later `password` control, and the Run created an input request for both. Row: `readOnly` drift, `microtask` timing — the page makes the first control read-only in a microtask queued by the later control's change event.
- When: The member applies `synthetic-first` and `synthetic-later` with `POST /api/browser/user-actions/:requestToken/apply`, reads the request, and retries the same apply.
- Then: The apply returns HTTP 200 `uncertain` even though both controls hold the submitted values, after input and change events for `first` then `later`. The read shows `uncertain` with the callback not delivered, and the retry returns HTTP 409 without firing further events.

## browser-059

- Vitest: "Browser user-action route > preserves stable text scalar native events and omitted-field behavior"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has a stable optional `first` text control (requested as `username`) and a stable optional later `text` control, and the Run creates input requests for both. Row: later control type `text`.
- When: The member applies both controls' current values to one request, only the later value to a second request, and an empty value list to a third request, each with `POST /api/browser/user-actions/:requestToken/apply`, then reads the third request.
- Then: All three applies return HTTP 200 `succeeded`. The first fires input and change for `first` then `later`, the second fires only `later` input and change, and the third fires no events; the third request reads `succeeded`.

## browser-060

- Vitest: "Browser user-action route > preserves stable password scalar native events and omitted-field behavior"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has a stable optional `first` text control (requested as `username`) and a stable optional later `password` control, and the Run creates input requests for both. Row: later control type `password`.
- When: The member applies both controls' current values to one request, only the later value to a second request, and an empty value list to a third request, each with `POST /api/browser/user-actions/:requestToken/apply`, then reads the third request.
- Then: All three applies return HTTP 200 `succeeded`. The first fires input and change for `first` then `later`, the second fires only `later` input and change, and the third fires no events; the third request reads `succeeded`.

## browser-061

- Vitest: "Browser user-action route > preserves stable textarea scalar native events and omitted-field behavior"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has a stable optional `first` text control (requested as `username`) and a stable optional later `textarea` control, and the Run creates input requests for both. Row: later control type `textarea`.
- When: The member applies both controls' current values to one request, only the later value to a second request, and an empty value list to a third request, each with `POST /api/browser/user-actions/:requestToken/apply`, then reads the third request.
- Then: All three applies return HTTP 200 `succeeded`. The first fires input and change for `first` then `later`, the second fires only `later` input and change, and the third fires no events; the third request reads `succeeded`.

## browser-062

- Vitest: "Browser user-action route > preserves stable number scalar native events and omitted-field behavior"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser whose page has a stable optional `first` text control (requested as `username`) and a stable optional later `number` control, and the Run creates input requests for both. Row: later control type `number`.
- When: The member applies both controls' current values to one request, only the later value to a second request, and an empty value list to a third request, each with `POST /api/browser/user-actions/:requestToken/apply`, then reads the third request.
- Then: All three applies return HTTP 200 `succeeded`. The first fires input and change for `first` then `later`, the second fires only `later` input and change, and the third fires no events; the third request reads `succeeded`.

## browser-063

- Vitest: "Browser user-action route > validates and applies CLI-resolved Browser input without exposing target or value data"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser on a login page at `https://example.com` with email, password, one-time-code and textarea controls captured by backend node ID; the Browser provider can fail, stall or report the browser stopped on demand.
- When: The Run calls `POST /api/browser/user-actions` with unwritable, non-main-document, mismatched-kind, missing-node, failing-node, missing-page and invalid-explanation inputs, then creates a valid username and password request; another member and the owner call `GET`, `POST .../preflight` and `POST .../apply` with empty, too-short and valid values; the owner sends chat callbacks with `POST /api/chat/events`, and further requests exercise optional blanks, a multi-line textarea, provider failures, navigation, detached, shadow, unwritable, incompatible and stopped targets, readback mismatch, re-render, a stalled apply, concurrent applies, lease renewal via `POST /api/browsers/lease`, lease expiry and thread deletion.
- Then: Invalid creations return HTTP 409 `BROWSER_USER_ACTION_UNSUPPORTED_CONTROL` (with `--field 1` CLI messages), 409 `BROWSER_USER_ACTION_BACKEND_NODE_NOT_FOUND` (naming `--field 1` or `--field 2`), 502 `BROWSER_USER_ACTION_PROVIDER_ERROR` without the provider detail, 409 `BROWSER_USER_ACTION_PAGE_TARGET_NOT_FOUND` or 400, never exposing the page URL. The valid request returns `pending` with site origin `https://example.com`, no page target or node IDs, after one provider read and one inspection; the other member gets HTTP 404. Preflight returns the email and password controls without writing; an empty required value returns 400 `BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING`, a too-short value 409 `BROWSER_USER_ACTION_INVALID_VALUE`, and valid values succeed with one non-submitting write and one verification. Reads never contain submitted values or touch the provider; only the success callback event marks the callback delivered and publishes `browserUserActionChanged:<threadId>`, after which a replay returns 409 `BROWSER_USER_ACTION_CONFLICT`. Optional blanks and the multi-line textarea succeed; provider failures return 502 or 503 and leave the request `pending` until a retry succeeds. Drifted, detached, shadow, unwritable, incompatible or stopped targets return `stale` without writing; mismatched readback, re-render and stall recovery after 1 minute return `uncertain`, with later replays rejected (409) and the stalled apply ending 502 `BROWSER_USER_ACTION_PROVIDER_ERROR`. Concurrent applies return 200 and 409 with one write. A renewed lease lets an apply at 11 minutes succeed; at 22 minutes apply returns 410 `BROWSER_USER_ACTION_EXPIRED` and creation 409 `BROWSER_USER_ACTION_BROWSER_NOT_LIVE`; after the thread is deleted, the request returns 404 `BROWSER_USER_ACTION_NOT_FOUND`.

## browser-064

- Vitest: "okou browser route > keeps Browser reads, leases and resizing within the owner for another user"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser for a thread; the member reads it with `GET /api/chat-threads/:threadId/browser` (active, window with primary window ID 7) and leases it to learn the idle deadline. Row: the foreign caller is another user in the same organization.
- When: One minute later the foreign caller calls `GET /api/chat-threads/:threadId/browser`, `POST /api/chat-threads/:threadId/browser/lease` and `POST /api/chat-threads/:threadId/browser/resize` with aspect ratio 2; the owner then reads the Browser and, two minutes after start, leases, resizes and reads it again.
- Then: All three foreign calls return HTTP 404 `BROWSER_NOT_FOUND`. The owner's next read shows the Browser still active with the original idle deadline and window. The owner's renewed lease sets the idle deadline to 12 minutes after start, the resize returns the Browser active with the same window, and the final read shows that deadline and window.

## browser-065

- Vitest: "okou browser route > keeps Browser reads, leases and resizing within the owner for another organization"
- Mode: run
- Given: A signed-in member's chat Run has opened the shared Browser for a thread; the member reads it with `GET /api/chat-threads/:threadId/browser` (active, window with primary window ID 7) and leases it to learn the idle deadline. Row: the foreign caller is the same user signed into another organization.
- When: One minute later the foreign caller calls `GET /api/chat-threads/:threadId/browser`, `POST /api/chat-threads/:threadId/browser/lease` and `POST /api/chat-threads/:threadId/browser/resize` with aspect ratio 2; the owner then reads the Browser and, two minutes after start, leases, resizes and reads it again.
- Then: All three foreign calls return HTTP 404 `BROWSER_NOT_FOUND`. The owner's next read shows the Browser still active with the original idle deadline and window. The owner's renewed lease sets the idle deadline to 12 minutes after start, the resize returns the Browser active with the same window, and the final read shows that deadline and window.

## browser-066

- Vitest: "okou browser route > applies the saved cloud browser preference (true) to a new chat and its run permissions"
- Mode: run
- Given: A signed-in member with a Pro workspace has saved the cloud Browser default preference as `true` through `POST /api/user-preferences`. Row: `true`.
- When: The member sends a new chat prompt without a Browser selection through `POST /api/chat/events`, reads the thread metadata with `GET /api/chat-threads/:id/metadata`, and the launched Run calls `GET /api/chat-threads/:threadId/browser` with its OKOU token.
- Then: The thread metadata reports `cloudBrowserEnabled` `true`, and the Run's Browser read returns HTTP 404 `BROWSER_NOT_FOUND`.

## browser-067

- Vitest: "okou browser route > applies the saved cloud browser preference (false) to a new chat and its run permissions"
- Mode: run
- Given: A signed-in member with a Pro workspace has saved the cloud Browser default preference as `false` through `POST /api/user-preferences`. Row: `false`.
- When: The member sends a new chat prompt without a Browser selection through `POST /api/chat/events`, reads the thread metadata with `GET /api/chat-threads/:id/metadata`, and the launched Run calls `GET /api/chat-threads/:threadId/browser` with its OKOU token.
- Then: The thread metadata reports `cloudBrowserEnabled` `false`, and the Run's Browser read returns HTTP 403 `FORBIDDEN`.

## browser-068

- Vitest: "okou browser route > honors an explicit cloud browser selection over saved Chat preferences"
- Mode: run
- Given: A signed-in member has saved the cloud Browser default preference as `false` through `POST /api/user-preferences`. Row: explicit `cloud browser` selection.
- When: The member sends a chat prompt with `cloudBrowserEnabled: true` through `POST /api/chat/events`, reads the thread metadata with `GET /api/chat-threads/:id/metadata`, and cancels the Run with `POST /api/runs/:id/cancel`.
- Then: The thread metadata reports `cloudBrowserEnabled` true and no computer use host, and the cancel returns HTTP 200.

## browser-069

- Vitest: "okou browser route > honors an explicit disabled selection over saved Chat preferences"
- Mode: run
- Given: A signed-in member has saved the cloud Browser default preference as `true` through `POST /api/user-preferences`. Row: explicit `disabled` selection.
- When: The member sends a chat prompt with `cloudBrowserEnabled: false` through `POST /api/chat/events`, reads the thread metadata with `GET /api/chat-threads/:id/metadata`, and cancels the Run with `POST /api/runs/:id/cancel`.
- Then: The thread metadata reports `cloudBrowserEnabled` false and no computer use host, and the cancel returns HTTP 200.

## browser-070

- Vitest: "okou browser route > honors an explicit no computer selection over saved Chat preferences"
- Mode: run
- Given: A signed-in member has saved the cloud Browser default preference as `true` through `POST /api/user-preferences`. Row: explicit `no computer` selection.
- When: The member sends a chat prompt with `computerUseHostId: null` through `POST /api/chat/events`, reads the thread metadata with `GET /api/chat-threads/:id/metadata`, and cancels the Run with `POST /api/runs/:id/cancel`.
- Then: The thread metadata reports `cloudBrowserEnabled` false and no computer use host, and the cancel returns HTTP 200.

## browser-071

- Vitest: "okou browser route > honors an explicit computer use selection over saved Chat preferences"
- Mode: run
- Given: A signed-in member has saved the cloud Browser default preference as `true` through `POST /api/user-preferences` and has a running Computer Use host. Row: explicit `computer use` selection.
- When: The member sends a chat prompt with that host's `computerUseHostId` through `POST /api/chat/events`, reads the thread metadata with `GET /api/chat-threads/:id/metadata`, and cancels the Run with `POST /api/runs/:id/cancel`.
- Then: The thread metadata reports `cloudBrowserEnabled` false and the selected host ID, and the cancel returns HTTP 200.

## browser-072

- Vitest: "okou browser route > keeps managed browser access off when the user explicitly disables it"
- Mode: run
- Given: A signed-in member with a Pro workspace and a configured Runner group.
- When: The member sends a chat prompt with `cloudBrowserEnabled: false` through `POST /api/chat/events`, and the launched Run calls `POST /api/browsers/use` with its OKOU token.
- Then: The Run's appended system prompt says "Okou Browser is currently off for this chat thread" and contains no Browser user input priority, `okou browser input-request`, tab continuity or shared profile guidance. The Browser use request returns HTTP 403 `FORBIDDEN`.

## browser-073

- Vitest: "okou browser route > describes shared Browser tabs, login state and native input"
- Mode: run
- Given: A signed-in member with a Pro workspace and a configured Runner group.
- When: The member sends a chat prompt with `cloudBrowserEnabled: true` through `POST /api/chat/events`, and the Runner receives the launched Run's execution input.
- Then: The appended system prompt describes "this chat's managed Browser", that each chat has its own window and tabs, that website login state is shared across chats, and the Browser tab continuity rules (keep a tab only with non-sensitive evidence, origin or selection alone is not proof, never invoke raw `agent-browser tab list` or `agent-browser tab <id>`). It also includes the Browser user input priority preferring `okou browser input-request` over direct takeover and a Browser input completion section.

## browser-074

- Vitest: "okou browser route > prioritizes native input when Browser access is enabled"
- Mode: run
- Given: A signed-in member with a Pro workspace and a configured Runner group.
- When: The member sends a "Sign in to a website" chat prompt with `cloudBrowserEnabled: true` through `POST /api/chat/events`, and the Runner receives the launched Run's execution input.
- Then: The appended system prompt prefers `okou browser input-request` over direct Browser takeover, especially for login username, password or one-time code; requires `--title` and `--reason` in the user's language; says to return the exact action URL and stop Browser commands after success; uses `okou browser tab select <id>` and forbids raw `agent-browser` tab commands; says to stop if the page remains unclear; describes the successful-callback tab-continuity check, submitting at most once, recapturing stale targets without blindly replaying uncertain writes, takeover as a last resort, and sharing the live view on explicit request.

## browser-075

- Vitest: "okou browser route > disables cloud browser when a computer host is selected"
- Mode: run
- Given: A signed-in member sent a chat prompt with `cloudBrowserEnabled: true`, the launched Run has its OKOU token, and the member has a running Computer Use host.
- When: The member selects the host for the thread with `POST /api/chat-threads/:id/computer-use-host`, and the Run then calls `POST /api/browsers/use` with its OKOU token.
- Then: The host selection returns HTTP 204, and the Browser use request returns HTTP 403 `BROWSER_AUTHORIZATION_REQUIRED` with the message "Cloud browser is not enabled for this chat thread".

## browser-076

- Vitest: "okou browser route > uses the configured app URL for browser authorization from run tokens"
- Mode: run
- Given: The app URL is configured as `https://app.okou.ai`, and a signed-in member sent a chat prompt with `cloudBrowserEnabled: false` whose Run holds a Sandbox token and an OKOU token.
- When: The Run creates browser authorization requests with `POST /api/browser/authorization-requests` using the Sandbox token and, on the `https://api.okou.ai` host, the OKOU token; the member reads the request with `GET /api/browser/authorization-requests/:requestToken`, applies it with `POST .../apply`, reads it again, and lists `GET /api/chat-threads/events`.
- Then: Both creations return HTTP 200 with authorization URLs on `https://app.okou.ai`, the token starting with `vm0_browser_authorization_request_`. The first read shows the thread, `completedAt` null and `cloudBrowserEnabled` false. The apply returns exactly `{ ok: true, cloudBrowserEnabled: true }`, the read shows the same ID, thread and expiry with `completedAt` at the current time and `cloudBrowserEnabled` true, and the event list contains a `computer_use_host_updated` event for the thread with no host and Browser enabled.

## browser-077

- Vitest: "okou browser route > does not disclose or apply browser authorization for another user"
- Mode: run
- Given: A signed-in member sent a chat prompt with `cloudBrowserEnabled: false`, and its Run created a browser authorization request with `POST /api/browser/authorization-requests` using its Sandbox token. Row: the foreign caller is another user in the same organization.
- When: The foreign caller reads `GET /api/browser/authorization-requests/:requestToken` and applies `POST /api/browser/authorization-requests/:requestToken/apply`; the owner then reads the request, the thread metadata and `GET /api/chat-threads/events`.
- Then: Both foreign calls return HTTP 404 `NOT_FOUND`. The owner's read shows the request with its thread, original expiry, `completedAt` null and `cloudBrowserEnabled` false; the thread metadata still reports `cloudBrowserEnabled` false, and there are no `computer_use_host_updated` events for the thread.

## browser-078

- Vitest: "okou browser route > does not disclose or apply browser authorization for another organization"
- Mode: run
- Given: A signed-in member sent a chat prompt with `cloudBrowserEnabled: false`, and its Run created a browser authorization request with `POST /api/browser/authorization-requests` using its Sandbox token. Row: the foreign caller is the same user signed into another organization.
- When: The foreign caller reads `GET /api/browser/authorization-requests/:requestToken` and applies `POST /api/browser/authorization-requests/:requestToken/apply`; the owner then reads the request, the thread metadata and `GET /api/chat-threads/events`.
- Then: Both foreign calls return HTTP 404 `NOT_FOUND`. The owner's read shows the request with its thread, original expiry, `completedAt` null and `cloudBrowserEnabled` false; the thread metadata still reports `cloudBrowserEnabled` false, and there are no `computer_use_host_updated` events for the thread.

## browser-079

- Vitest: "okou browser route > expires pending browser authorization at the inclusive one-hour boundary"
- Mode: run
- Given: A signed-in member sent a chat prompt with `cloudBrowserEnabled: false`, and its Run created a browser authorization request with `POST /api/browser/authorization-requests` using its Sandbox token.
- When: The member reads the request 1 ms before one hour after creation, then at exactly one hour reads it and applies it with `POST /api/browser/authorization-requests/:requestToken/apply`, and reads the thread metadata and `GET /api/chat-threads/events`.
- Then: The creation's expiry is exactly one hour after creation. The read 1 ms before shows it pending with `completedAt` null and `cloudBrowserEnabled` false. At one hour both the read and the apply return HTTP 410 `GONE`; the thread metadata still reports `cloudBrowserEnabled` false and there are no `computer_use_host_updated` events for the thread.

## browser-080

- Vitest: "okou browser route > preserves completion and ordered events when browser authorization is applied again"
- Mode: run
- Given: A signed-in member sent a chat prompt with `cloudBrowserEnabled: false`, and its Run created a browser authorization request with `POST /api/browser/authorization-requests` using its Sandbox token.
- When: At 1 and 2 minutes after start the member applies the request with `POST /api/browser/authorization-requests/:requestToken/apply` and reads it; then reads the thread metadata and `GET /api/chat-threads/events`; at one hour the member reads and applies it again and lists events.
- Then: Each apply returns exactly `{ ok: true, cloudBrowserEnabled: true }` and each read shows `completedAt` at that minute with `cloudBrowserEnabled` true. The metadata reports no host and Browser enabled. There are exactly two `computer_use_host_updated` events for the thread, in increasing sequence order, created at 1 and 2 minutes, both with no host and Browser enabled. At one hour the read and apply return HTTP 410 `GONE`, and the thread's events are unchanged.
