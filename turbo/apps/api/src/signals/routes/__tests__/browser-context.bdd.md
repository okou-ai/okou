# browser-context

## browser-context-001

- Vitest: "manages and recovers two no-Run chat windows in one shared Browser"
- Mode: run
- Given: A signed-in workspace member owns two chat threads without a Run, both with cloud Browser use authorized. The Browser provider can create one shared Browser and native windows.
- When: The member opens both with `POST /api/chat-threads/:threadId/browser/open`, reopens A, reads `GET /api/chat-threads/:threadId/browser` (also with `viewer=native`), resizes A to aspect ratio 2 via `POST .../browser/resize`, closes A via `POST .../browser/close`, leases B at minute 9 via `POST .../browser/lease`, reopens A at minute 11, and finally deletes both threads.
- Then: Both chats share one Browser instance with different primary windows (A's is window 0). Reopening and reading A return the same window, and the native viewer returns the provider CDP URL with that window. The resize keeps the window and sizes it 1440x720. B's lease expires at minute 19. Recovering A keeps the instance, gives it a new window restored to A's last page URL, and leaves B's window and lease unchanged. Only one Browser and one provider session are created, the Run list via `GET /api/logs` is empty, and the provider session survives deleting A but is gone after deleting B.

## browser-context-002

- Vitest: "requires cloud-browser authorization for a no-Run chat"
- Mode: run
- Given: A signed-in workspace member owns a chat thread without a Run whose cloud Browser use is not authorized.
- When: The member requests `POST /api/chat-threads/:threadId/browser/open`.
- Then: The API responds with HTTP 403 and error code `BROWSER_AUTHORIZATION_REQUIRED`, and the Browser provider receives no profile creation or session request.

## browser-context-003

- Vitest: "keeps no-Run chat access scoped to both the user and organization"
- Mode: run
- Given: A member of one workspace has opened a Browser for their no-Run chat thread. A different user in that workspace, and the same owner signed into another workspace, each try to use it.
- When: Each actor calls `GET /api/chat-threads/:threadId/browser`, `POST .../browser/open`, `GET .../browser?viewer=native`, `POST .../browser/lease`, `POST .../browser/resize` and `POST .../browser/close` for the owner's thread.
- Then: Every request returns HTTP 404 with error code `BROWSER_NOT_FOUND`, and no Browser session is requested on the second workspace's provider.

## browser-context-004

- Vitest: "rejects publication when a no-Run chat's authorization is revoked during profile preparation"
- Mode: run
- Given: A signed-in workspace member owns a no-Run chat thread with cloud Browser use authorized, and the member revokes that authorization while the Browser profile is being prepared.
- When: The member requests `POST /api/chat-threads/:threadId/browser/open` and then `GET /api/chat-threads/:threadId/browser`.
- Then: The open returns HTTP 409 with error code `BROWSER_RECLAIMING`. No provider session remains and none needed stopping, every created provider profile has been deleted (provider returns 404), and the read returns HTTP 403 with `BROWSER_AUTHORIZATION_REQUIRED`.

## browser-context-005

- Vitest: "rejects publication when a no-Run chat's authorization is revoked during instance preparation"
- Mode: run
- Given: A signed-in workspace member owns a no-Run chat thread with cloud Browser use authorized, and the member revokes that authorization while the provider is creating the Browser instance.
- When: The member requests `POST /api/chat-threads/:threadId/browser/open` and then `GET /api/chat-threads/:threadId/browser`.
- Then: The open returns HTTP 409 with error code `BROWSER_RECLAIMING`. No provider session remains and exactly one started session was stopped, and the read returns HTTP 403 with `BROWSER_AUTHORIZATION_REQUIRED`.

## browser-context-006

- Vitest: "cleans a no-Run chat's candidate window when revoked and preserves its sibling"
- Mode: run
- Given: A signed-in workspace member has an open Browser window for no-Run chat A and a second authorized no-Run chat B. While the native window for B is being created, B's cloud Browser authorization is revoked.
- When: The member requests `POST /api/chat-threads/:threadId/browser/open` for B and then reads `GET /api/chat-threads/:threadId/browser` for A.
- Then: B's open returns HTTP 409 with error code `BROWSER_RECLAIMING`, and only A's window remains among the native targets. A's read returns HTTP 200 with its unchanged window, the provider received one session request, and no session was stopped.

## browser-context-007

- Vitest: "cleans a no-Run chat's candidate window when deleted and preserves its sibling"
- Mode: run
- Given: A signed-in workspace member has an open Browser window for no-Run chat A and a second authorized no-Run chat B. While the native window for B is being created, chat B is deleted.
- When: The member requests `POST /api/chat-threads/:threadId/browser/open` for B and then reads `GET /api/chat-threads/:threadId/browser` for A.
- Then: B's open returns HTTP 409 with error code `BROWSER_RECLAIMING`, and only A's window remains among the native targets. A's read returns HTTP 200 with its unchanged window, the provider received one session request, and no session was stopped.

## browser-context-008

- Vitest: "keeps Run tokens scoped to their live Run while session Browser ownership is independent"
- Mode: run
- Given: A workspace member has a live Run whose Run token has acquired its own Browser via `POST /api/browsers/use`, and the member separately opened a Browser for a manual no-Run chat thread.
- When: The Run token calls the manual chat's `GET /api/chat-threads/:threadId/browser`, `POST .../open`, `.../lease`, `.../resize` and `.../close`; the sandbox reports the Run complete via `POST /api/webhooks/run/complete` (exit code 1); the Run token calls `POST /api/browsers/use` again; and the member opens both chats.
- Then: Every Run-token request on the manual chat returns HTTP 404. After completion, the Run token's use returns HTTP 409 with error code `BROWSER_RUN_ENDED`. The member's open of the Run's thread returns the Run's original Browser window, and the manual chat's open returns its original window.
