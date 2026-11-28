# browser-reuse

## browser-reuse-001

- Vitest: "reuses a healthy run Browser with one provider read and native socket"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, and the native health check for B's window fails. The clock advances one minute.
- When: A's Run reuses its Browser with `POST /api/browsers/use` (entry `run`), and the member reads B's Browser.
- Then: The use returns HTTP 200 with A's original window and an idle expiry of start plus 11 minutes. It reads the provider session once, opens exactly one native connection, and sends exactly one native command, `Browser.getWindowBounds` for A's window. There is one provider session request, and B keeps its window and idle expiry.

## browser-reuse-002

- Vitest: "reuses a healthy chat Browser with one provider read and native socket"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, and the native health check for B's window fails. The clock advances one minute.
- When: The member opens A's Browser with `POST /api/chat-threads/:threadId/browser/open` (entry `chat`), and reads B's Browser.
- Then: The open returns HTTP 200 with A's original window and an idle expiry of start plus 11 minutes. It reads the provider session once, opens exactly one native connection, and sends exactly one native command, `Browser.getWindowBounds` for A's window. There is one provider session request, and B keeps its window and idle expiry.

## browser-reuse-003

- Vitest: "recovers a window lost during the provider await through a fresh binding read"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's native window disappears while the provider is answering the session read.
- When: A's Run calls `POST /api/browsers/use` and the member reads B's Browser.
- Then: A receives the same instance with a new primary window. B keeps its window and idle expiry, there is one provider session request, and no provider session is stopped.

## browser-reuse-004

- Vitest: "opens a new run window without probing an unrelated live sibling"
- Mode: run
- Given: A signed-in member's chat A Run uses the shared Browser, and the native health check for A's window fails. Chat B's Run has not opened a Browser.
- When: B's Run calls `POST /api/browsers/use` (entry `run`), and the member reads A's Browser.
- Then: The use returns HTTP 200 with a new primary window in A's instance, without any `Browser.getWindowBounds` native command. A keeps its window and there is one provider session request.

## browser-reuse-005

- Vitest: "opens a new chat window without probing an unrelated live sibling"
- Mode: run
- Given: A signed-in member's chat A Run uses the shared Browser, and the native health check for A's window fails. Chat B has not opened a Browser.
- When: The member opens B's Browser with `POST /api/chat-threads/:threadId/browser/open` (entry `chat`), and reads A's Browser.
- Then: The open returns HTTP 200 with a new primary window in A's instance, without any `Browser.getWindowBounds` native command. A keeps its window and there is one provider session request.

## browser-reuse-006

- Vitest: "recovers a confirmed stopped provider without reusing its old instance"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser, and the provider then reports its session as stopped with no pages.
- When: The Run calls `POST /api/browsers/use` and the member reads the chat's Browser.
- Then: The use returns a new instance after a second provider session request, and the read reports that new window.

## browser-reuse-007

- Vitest: "returns a provider failure without retrying or reclaiming the live binding"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser, the clock advances one minute, and the provider's session read fails with HTTP 503 (provider failure).
- When: The Run calls `POST /api/browsers/use`; after the provider recovers, the member reads the chat's Browser.
- Then: The use returns HTTP 502 after exactly one provider read, with one session request and no session stopped. The Browser keeps its original window and idle expiry.

## browser-reuse-008

- Vitest: "returns a native failure without retrying or reclaiming the live binding"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser, the clock advances one minute, and the native window-bounds check fails with an error (native failure).
- When: The Run calls `POST /api/browsers/use`; after the native check recovers, the member reads the chat's Browser.
- Then: The use returns HTTP 502 after exactly one provider read, with one session request and no session stopped. The Browser keeps its original window and idle expiry.

## browser-reuse-009

- Vitest: "returns a connection failure without retrying or reclaiming the live binding"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser, the clock advances one minute, and the provider reports the session as `active` but with no CDP URL (connection failure).
- When: The Run calls `POST /api/browsers/use`; after the provider recovers, the member reads the chat's Browser.
- Then: The use returns HTTP 409 after exactly one provider read, with one session request and no session stopped. The Browser keeps its original window and idle expiry.

## browser-reuse-010

- Vitest: "retains the native binding when the provider closes before-reply without replaying health"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser. The provider closes the native connection with a private close reason before replying to the window health read (before-reply).
- When: The Run calls `POST /api/browsers/use`; after the connection behaves normally again, the member reads the Browser and the Run calls use again.
- Then: The first use returns HTTP 502 and its body does not contain the private close reason. Exactly one native command, `Browser.getWindowBounds`, is sent, with one provider session request and no session stopped. The read and the later use both return the original window.

## browser-reuse-011

- Vitest: "retains the native binding when the provider closes after-reply without replaying health"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser. The provider closes the native connection with a private close reason right after replying to the window-bounds read (after-reply).
- When: The Run calls `POST /api/browsers/use`; after the connection behaves normally again, the member reads the Browser and the Run calls use again.
- Then: The first use returns HTTP 200 and its body does not contain the private close reason. Exactly one native command, `Browser.getWindowBounds`, is sent, with one provider session request and no session stopped. The read and the later use both return the original window.

## browser-reuse-012

- Vitest: "rejects renewal when the warm binding is revoked during its native check"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser and the clock advances one minute. While the native window check is in progress, the member disables the cloud Browser for the chat with `POST /api/chat-threads/:id/computer-use-host` (revoked).
- When: The Run calls `POST /api/browsers/use`; afterwards the member re-enables the cloud Browser for the chat and reads its Browser.
- Then: The use returns HTTP 409 with `BROWSER_RECLAIMING`, with one provider session request and no session stopped. After re-enabling, the Browser's idle expiry is unchanged from before the use.

## browser-reuse-013

- Vitest: "rejects renewal when the warm binding is expired during its native check"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser and the clock advances one minute. While the native window check is in progress, the clock moves to 11 minutes so the idle lease expires (expired).
- When: The Run calls `POST /api/browsers/use`.
- Then: The use returns HTTP 409 with `BROWSER_RECLAIMING`, with one provider session request and no session stopped.

## browser-reuse-014

- Vitest: "rejects a late healthy result for a replaced native binding"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. The member renews B at nine minutes. The provider holds the first native health reply for A's window.
- When: A's Run calls `POST /api/browsers/use`; while that check is held, native window closing stops working, the clock moves to 11 minutes and A's Run calls use again; the held reply is then released and the member reads both Browsers.
- Then: The held use returns HTTP 409, while the second use returns a new primary window. A reads that replacement window, B keeps its window, and there is one provider session request.

## browser-reuse-015

- Vitest: "rejects an old instance's late health result when the replacement reuses its window number"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser. The clock advances one minute and the provider holds the first native health reply for the chat's window.
- When: The Run calls `POST /api/browsers/use`; while that check is held, the provider session stops with no pages and the Run calls use again; the clock then advances to two minutes, the held reply is released, and the member reads the Browser.
- Then: The second use returns a new instance whose primary window has the same window number as before. The held use returns HTTP 409 with `BROWSER_RECLAIMING`. The read reports the replacement window and idle expiry, with two provider session requests and one profile created.

## browser-reuse-016

- Vitest: "settles warm-open cancellation during the provider check without renewal"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser and the clock advances one minute. The caller cancels the request while the provider session check is in progress (provider phase).
- When: The Run calls `POST /api/browsers/use` and the request is aborted during the provider check; the member then reads the Browser.
- Then: The request ends with the caller's cancellation error. There is one provider session request, no session is stopped, and the Browser's idle expiry is unchanged.

## browser-reuse-017

- Vitest: "settles warm-open cancellation during the native check without renewal"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser and the clock advances one minute. The caller cancels the request while the native window check is in progress (native phase).
- When: The Run calls `POST /api/browsers/use` and the request is aborted during the native check; the member then reads the Browser.
- Then: The request ends with the caller's cancellation error. There is one provider session request, no session is stopped, and the Browser's idle expiry is unchanged.
