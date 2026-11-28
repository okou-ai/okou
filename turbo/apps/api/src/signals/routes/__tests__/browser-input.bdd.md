# browser-input

## browser-input-001

- Vitest: "shared-window native Browser input > keeps separately created input requests independently pending"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser (A in native window 0, B in window 17), and A's page shows a login URL containing a private code. A's Run creates input requests for a password field on its own page.
- When: A's Run token creates two input requests with `POST /api/browser/user-actions`, and the member reads each with `GET /api/browser/user-actions/:requestToken`.
- Then: Each creation returns HTTP 201 without the private page code or a window in the response. The two request tokens differ, and both reads return HTTP 200 with state `pending`.

## browser-input-002

- Vitest: "shared-window native Browser input > preserves a newer window lease when input requests arrive with older timestamps"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser (A in window 0, B in window 17). At minute 2, A's Run creates a password input request on its own page.
- When: With a request clock of minute 1 (an older timestamp), the member preflights the request with `POST /api/browser/user-actions/:requestToken/preflight`, A's Run creates another input request, and the member reads both chats with `GET /api/chat-threads/:threadId/browser`.
- Then: The preflight returns HTTP 200. After both the preflight and the second request, A's idle expiry stays at minute 12, and B's stays at minute 10.

## browser-input-003

- Vitest: "shared-window native Browser input > captures window zero and applies only the owned page without exposing sealed identities or values"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser (A in window 0, B in window 17), with both pages on the same login URL. A's Run has created a password input request for A's page.
- When: The member preflights with `POST /api/browser/user-actions/:requestToken/preflight`, applies the value `private-input-value` with `POST /api/browser/user-actions/:requestToken/apply`, and reads the request with `GET /api/browser/user-actions/:requestToken`.
- Then: The preflight returns `pending` and the apply returns HTTP 200 with state `succeeded` and no private values in the body. Exactly one write happens, on A's page only (B's page is untouched). The read returns `succeeded`, and B's Browser view still shows primary window 17.

## browser-input-004

- Vitest: "shared-window native Browser input > rejects sibling capture and treats a moved page as stale without writing"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser (A in window 0, B in window 17).
- When: A's Run token tries to create an input request for B's page target with `POST /api/browser/user-actions`; then creates one for its own page, which the provider then moves into window 17, and the member preflights it; then creates another, the page moves again, and the member applies a value with `POST /api/browser/user-actions/:requestToken/apply`.
- Then: The sibling-page creation returns HTTP 409 with error code `BROWSER_USER_ACTION_PAGE_TARGET_NOT_FOUND`. The preflight returns HTTP 200 with state `stale`, and the apply returns HTTP 200 with state `stale`. No value is ever written.

## browser-input-005

- Vitest: "shared-window native Browser input > does not publish a request if the window expires during external validation while its sibling remains live"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser; B's lease was renewed at minute 9. While the input field on A's page is being validated, the clock advances to minute 11 so A's window expires.
- When: A's Run token creates an input request with `POST /api/browser/user-actions`, and the member reads both chats with `GET /api/chat-threads/:threadId/browser`.
- Then: The creation returns HTTP 404. A's Browser is `suspended`, B's idle expiry is minute 19, and no value is written.

## browser-input-006

- Vitest: "shared-window native Browser input > expires A without reviving it through B's provider and accepts only a newly admitted A window"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and A's Run created a password input request. B's lease is renewed at minute 9 and the clock moves to minute 11, expiring A.
- When: The member preflights the old request; A's Run token tries to create a new request; A's Run reacquires a replacement window via `POST /api/browsers/use` (its page set to B's URL); the member applies the old request; A's Run creates a fresh request for the replacement page; and the member applies `fresh-value` to it.
- Then: The old preflight returns HTTP 410, the creation before reacquisition returns HTTP 409, and applying the old request returns HTTP 410. The fresh request returns HTTP 201 and its apply returns `succeeded`, writing `fresh-value` only to the replacement page and nothing to B's page. B's idle expiry stays at minute 19.

## browser-input-007

- Vitest: "shared-window native Browser input > reports a move during a native write as uncertain and never replays it"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and A's Run created a password input request. During the native write, the provider moves A's page into B's window.
- When: The member applies a value with `POST /api/browser/user-actions/:requestToken/apply`, then applies again.
- Then: The first apply returns HTTP 200 with state `uncertain` after exactly one write. The second apply returns HTTP 409 and no further write happens.

## browser-input-008

- Vitest: "shared-window native Browser input > rejects an apply when retirement wins during its provider read"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and A's Run created a password input request. The provider's Browser lookup for the apply is held open.
- When: The member applies a value with `POST /api/browser/user-actions/:requestToken/apply`; while the provider read is held, B's lease is renewed at minute 9 and A's Run reacquires its Browser at minute 11 (retiring the old window); then the provider read completes.
- Then: The apply returns HTTP 200 with state `stale`, and no value is written.

## browser-input-009

- Vitest: "shared-window native Browser input > settles input before propagating application-lifetime cancellation during provider read"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and A's Run created a password input request. The API's application lifetime is cancelled ("The input application lifetime ended") while the apply is reading the Browser from the provider.
- When: The member applies a value with `POST /api/browser/user-actions/:requestToken/apply`, then reads `GET /api/browser/user-actions/:requestToken`.
- Then: The apply fails with exactly that cancellation error. The read returns HTTP 200 with state `pending`, and no value was written.

## browser-input-010

- Vitest: "shared-window native Browser input > settles input before propagating application-lifetime cancellation during native write"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and A's Run created a password input request. The API's application lifetime is cancelled ("The input application lifetime ended") right after the native write to A's page.
- When: The member applies a value with `POST /api/browser/user-actions/:requestToken/apply`, then reads `GET /api/browser/user-actions/:requestToken`.
- Then: The apply fails with exactly that cancellation error. The read returns HTTP 200 with state `uncertain`, and exactly one write happened.

## browser-input-011

- Vitest: "shared-window native Browser input > keeps native lookup failures visible without invalidating or replaying the pending request"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and A's Run created a password input request. The provider's native window lookup for A's page fails with a private provider error message.
- When: The member preflights with `POST /api/browser/user-actions/:requestToken/preflight` and reads `GET /api/browser/user-actions/:requestToken`.
- Then: The preflight returns HTTP 502 without the private error text. The read returns state `pending`, and no value was written.

## browser-input-012

- Vitest: "shared-window native Browser input > does not adopt a replacement instance even when Chrome reuses the native window number"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and A's Run created a password input request. At minute 11 A's Run reacquires its Browser via `POST /api/browsers/use`, getting a new Browser instance whose page reuses native window number 0 and A's old URL.
- When: The member applies a value to the old request with `POST /api/browser/user-actions/:requestToken/apply`, and A's Run creates a new request for the new page with `POST /api/browser/user-actions`.
- Then: The new instance differs from the original and only one Browser profile exists. The old apply returns HTTP 410, the new creation returns HTTP 201, and no value was written.

## browser-input-013

- Vitest: "shared-window native Browser input > binds staged files and native file readback to the same window"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and A's Run created a file input request whose field currently holds one file. Temporary upload storage issues signed upload URLs.
- When: The member prepares a file upload via `POST /api/browser/user-actions/:requestToken/files/prepare`, preflights to read the observed file set, and applies a `clear` operation with that fingerprint via `POST .../apply`; A's Run then creates another file request, the clock moves to minute 11, and the member prepares an upload for it.
- Then: The upload preparation returns HTTP 200 with the signed upload URL. The apply returns `succeeded`, the field's files are cleared and exactly one write happened. Preparing an upload for the second request after A's window expired returns HTTP 410.

## browser-input-014

- Vitest: "shared-window native Browser input > exposes retired shared input as stale without touching the sibling window"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and A's Run created a password input request. B's lease is renewed at minute 9, and at minute 11 A's Run reacquires its Browser, retiring the old window.
- When: The member reads `GET /api/browser/user-actions/:requestToken` and B's `GET /api/chat-threads/:threadId/browser`.
- Then: The input request read returns HTTP 410, B's Browser is still `active`, and no value was written.

## browser-input-015

- Vitest: "shared-window native Browser input > retains closed input for seven days and retries file cleanup before deleting its history"
- Mode: run
- Given: A workspace member has chats A and B whose Runs share one Browser, and A's Run created a file input request. Temporary file storage deletion fails while cleanup is blocked.
- When: The cron calls `GET /api/cron/reconcile-browsers` with the cron secret at minute 11, one millisecond before seven days later, exactly seven days later with storage deletion failing, and again after storage recovers; the member reads `GET /api/browser/user-actions/:requestToken` after each run.
- Then: After the first run the request is `stale` with `completedAt` at minute 11. It stays `stale` with the same completion time just before the seven-day deadline and after the failed cleanup (which did attempt deletion). After the successful cleanup run the read returns HTTP 404.
