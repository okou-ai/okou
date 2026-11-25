# browser-reclaim

## browser-reclaim-001

- Vitest: "explicit shared Browser restart > retires all bound chats and reopens using the saved profile and URLs"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, and a third chat's Run has Browser access disabled. A's page is at `https://a.example.test/recover` and the member has closed A's Browser. Both native windows then stop responding.
- When: The Run without Browser access calls `POST /api/browsers/restart` for the instance; A's Run then restarts the instance, the member reads A's and B's Browsers, A's Run calls `POST /api/browsers/use`, restarts the original instance again, and calls use once more.
- Then: The restart without Browser access returns HTTP 403 and the provider session stays running. A's restart returns HTTP 200 and stops the provider session, and both chats read as `suspended`. A's use returns a new instance whose window contains only `https://a.example.test/recover`, with one profile created and two session requests in total. Restarting the old instance returns HTTP 409, and the next use returns the replacement window.

## browser-reclaim-002

- Vitest: "explicit shared Browser restart > leaves the instance stopping until the provider confirms shutdown"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser. The provider answers stop requests with HTTP 202 and a session that is still `active`.
- When: The Run calls `POST /api/browsers/restart` for its instance and then `POST /api/browsers/use`; the provider then confirms stops normally and the Run calls use again.
- Then: The restart returns HTTP 502 and the first use returns HTTP 409 with still one provider session request. After the provider confirms the stop, use returns a new instance and the provider has exactly one running session.

## browser-reclaim-003

- Vitest: "shared Browser expiry through public reopen > saves and restores expired A in the same instance while preserving active B"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with A's page at `https://a.example.test/task` and B's at `https://b.example.test/task`. The member renews B's Browser at nine minutes, and the clock then moves to 11 minutes so A's idle lease has expired.
- When: A's Run calls `POST /api/browsers/use` and the member reads B's Browser with `GET /api/chat-threads/:threadId/browser`.
- Then: A receives the same instance with a new primary window that contains only `https://a.example.test/task`. B's page is untouched, B's Browser keeps its original window and the idle expiry from its renewal, and the provider received only one session request.

## browser-reclaim-004

- Vitest: "shared Browser expiry through public reopen > stops after all windows expire and recreates only A using the same profile"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using one shared Browser instance with the original Browser extension; the configured extension ID changes after A's first use, but B's use and B's native viewer still report the original extension. A's page is at `https://a.example.test/recover` and B's at `https://b.example.test/recover`. The clock moves to 11 minutes so both idle leases have expired.
- When: A's Run calls `POST /api/browsers/use`, the member reads B's Browser, B's Run calls use, and the member reads B's native viewer with `GET /api/chat-threads/:threadId/browser?viewer=native`.
- Then: The provider stops the old session only after all its pages are closed. A receives a new instance with the replacement extension, using the same single profile: the two session requests carry the original and then the replacement extension ID. The new instance initially contains only A's recovered URL and B reads as `suspended`. B's use joins A's new instance with a window containing only B's recovered URL, still with two session requests, and B's native viewer reports the replacement extension, B's new window and the provider CDP URL.

## browser-reclaim-005

- Vitest: "shared Browser expiry through public reopen > waits for a confirmed provider stop after a failed stop request"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser with its page at `https://a.example.test/confirmed`. The provider fails stop requests with HTTP 503 (failed). The clock moves to 11 minutes so the chat's idle lease has expired.
- When: The Run calls `POST /api/browsers/use`; the provider then accepts stops normally and the Run calls use again.
- Then: The first use returns HTTP 409 after the instance's pages are closed, the provider session is still running, and there is one session request. The second use returns a new instance, with one profile created, one running session, two session requests in total, and a window containing only `https://a.example.test/confirmed`.

## browser-reclaim-006

- Vitest: "shared Browser expiry through public reopen > waits for a confirmed provider stop after a accepted stop request"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser with its page at `https://a.example.test/confirmed`. The provider answers stop requests with HTTP 202 and a session that is still `active` (accepted). The clock moves to 11 minutes so the chat's idle lease has expired.
- When: The Run calls `POST /api/browsers/use`; the provider then confirms stops normally and the Run calls use again.
- Then: The first use returns HTTP 409 after the instance's pages are closed, the provider session is still running, and there is one session request. The second use returns a new instance, with one profile created, one running session, two session requests in total, and a window containing only `https://a.example.test/confirmed`.

## browser-reclaim-007

- Vitest: "shared Browser expiry through public reopen > waits for a confirmed provider stop after a lost-response stop request"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser with its page at `https://a.example.test/confirmed`. The provider stops the session on a stop request but the response is lost with a network error, and afterwards reports that session as missing with HTTP 404 (lost-response). The clock moves to 11 minutes so the chat's idle lease has expired.
- When: The Run calls `POST /api/browsers/use`; the provider then handles stops normally and the Run calls use again.
- Then: The first use returns HTTP 409 after the instance's pages are closed, no provider session is running, and there is one session request. The second use returns a new instance, with one profile created, one running session, two session requests in total, and a window containing only `https://a.example.test/confirmed`.

## browser-reclaim-008

- Vitest: "shared Browser expiry through public reopen > retains the complete snapshot after partial native closure and sidebar capture"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's window has pages at `https://a.example.test/first` and `https://a.example.test/second`. The member renews B at nine minutes and the clock moves to 11 minutes so A's idle lease has expired. Closing A's window closes only its first page.
- When: A's Run calls `POST /api/browsers/use`, and the member closes A's Browser with `POST /api/chat-threads/:threadId/browser/close`.
- Then: After the use, A's first page is gone and its second page remains as it was. The close returns HTTP 200. A's new window is in the same instance and contains `https://a.example.test/first` and `https://a.example.test/second`, B's window still has one page, and there is one provider session request.

## browser-reclaim-009

- Vitest: "shared Browser expiry through public reopen > keeps the winning complete snapshot when an overlapping reclaim observes a partial close"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's window has pages at `https://a.example.test/first` and `https://a.example.test/second`. The member renews B at nine minutes and the clock moves to 11 minutes so A's idle lease has expired. The provider holds its first session read, and closing A's window closes only its first page.
- When: A's Run calls `POST /api/browsers/use`; while that call is held at the provider, A's Run calls use again; the held read is then released and, after window closing works normally again, A's Run calls use once more.
- Then: The overlapping use returns HTTP 200; at that point A's first page is gone and its second page remains. The held use also returns HTTP 200. The final use returns a window containing `https://a.example.test/first` and `https://a.example.test/second`, and there is one provider session request.

## browser-reclaim-010

- Vitest: "shared Browser expiry through public reopen > cancels an unacknowledged stop at its provider deadline and retains it for reconciliation"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser. The provider never answers stop requests for the running session, and the Browser operation deadline expires while a stop is pending. The clock moves to 11 minutes so the chat's idle lease has expired.
- When: The Run calls `POST /api/browsers/use`; the provider then handles stops normally and the Run calls use again.
- Then: The pending stop request is cancelled and the first use returns HTTP 409 with one provider session request. The second use returns a new instance, with one profile created and two session requests in total.

## browser-reclaim-011

- Vitest: "shared Browser expiry through public reopen > reuses a renewed window instead of reclaiming it at its earlier deadline"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser with its page at `https://a.example.test/working`. The member renews the Browser with `POST /api/chat-threads/:threadId/browser/lease` at nine minutes, and the clock then moves to 11 minutes.
- When: The Run calls `POST /api/browsers/use`.
- Then: The use returns HTTP 200 with the original window, the page is unchanged, and there is one provider session request.

## browser-reclaim-012

- Vitest: "shared Browser expiry through public reopen > leaves an intentionally moved page in its current sibling window"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance. A's page at `https://a.example.test/moved` has been moved into B's window. The member renews B at nine minutes and the clock moves to 11 minutes so A's idle lease has expired.
- When: A's Run calls `POST /api/browsers/use`.
- Then: A receives a window in the same instance. The moved page stays in B's window, which now has two pages, and there is one provider session request.

## browser-reclaim-013

- Vitest: "shared Browser teardown through chat deletion > preserves active siblings and stops after the last deletion"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, with B's page at `https://b.example.test/active`.
- When: The member deletes chat A with `DELETE /api/chat-threads/:id`, and then deletes chat B.
- Then: After the first deletion A's window has no pages, B's page is unchanged, and the provider session is still running. After the second deletion the provider has no pages and no running session, and only one profile was ever created.
