# browser-viewer-acquisition

## browser-viewer-acquisition-001

- Vitest: "get acquires presentation and viewer with one provider observation"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser.
- When: The member reads the chat's Browser with `GET /api/chat-threads/:threadId/browser?viewer=native` (entry `get`), and reads it again without the viewer.
- Then: The response is HTTP 200 with `Cache-Control: no-store`, a viewer that carries the same Browser and the provider's CDP URL, and the original window. The provider session is read once, CDP address discovery runs once, and there is one session request. The later read still reports the original window.

## browser-viewer-acquisition-002

- Vitest: "open acquires presentation and viewer with one provider observation"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser.
- When: The member opens the chat's Browser with `POST /api/chat-threads/:threadId/browser/open?viewer=native` and an `operationId`, and then reads it without the viewer.
- Then: The response is HTTP 200 with `Cache-Control: no-store`, a viewer that carries the same Browser and the provider's CDP URL, and the original window. The provider session is read once, CDP address discovery runs once, and there is one session request. Exactly one `browserSessionChanged` realtime notification is published, carrying the thread ID and the operation ID. The later read still reports the original window.

## browser-viewer-acquisition-003

- Vitest: "read acquisition does not create a missing Browser and preserves stopped presentation"
- Mode: run
- Given: A signed-in member's chat Run has not opened a Browser yet.
- When: The member reads the chat's Browser with `GET /api/chat-threads/:threadId/browser?viewer=native`; the Run then opens the Browser with `POST /api/browsers/use`, the provider reports that session as stopped, and the member reads with the viewer again.
- Then: The first read returns HTTP 404 and no provider session is requested. The second read returns HTTP 200 with a `suspended` Browser whose live URL and idle expiry are null, a null viewer, and still one provider session request.

## browser-viewer-acquisition-004

- Vitest: "ordinary open publishes a lifecycle notification without the native operation ID"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser.
- When: The member opens the chat's Browser with `POST /api/chat-threads/:threadId/browser/open` and an `operationId`, without requesting a viewer.
- Then: The open returns HTTP 200 and exactly one `browserSessionChanged` realtime notification is published, carrying only the thread ID without the operation ID.

## browser-viewer-acquisition-005

- Vitest: "native open correlates its expired-window retirement and final publication"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser, and the clock moves to 11 minutes so its idle lease has expired.
- When: The member opens the chat's Browser with `POST /api/chat-threads/:threadId/browser/open?viewer=native` and an `operationId`.
- Then: The open returns HTTP 200 with a viewer whose window is in a new instance. Exactly two `browserSessionChanged` realtime notifications are published, each carrying the thread ID and the operation ID.

## browser-viewer-acquisition-006

- Vitest: "only signed-in shared callers can opt into viewer credentials"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser.
- When: The Run, using its Run token, reads `GET /api/chat-threads/:threadId/browser?viewer=native`, opens `POST /api/chat-threads/:threadId/browser/open?viewer=native`, and reads the Browser without the viewer; the signed-in member then reads it with the viewer.
- Then: Both viewer requests from the Run return HTTP 403 with `BROWSER_VIEWER_SESSION_REQUIRED`. The Run's ordinary read returns HTTP 200 with an `active` Browser, and the member's viewer read returns HTTP 200 with a viewer for the same window.

## browser-viewer-acquisition-007

- Vitest: "get rechecks authorization after viewer discovery"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser. While the CDP address is being discovered, the member disables the cloud Browser for the chat with `POST /api/chat-threads/:id/computer-use-host`.
- When: The member reads the chat's Browser with `GET /api/chat-threads/:threadId/browser?viewer=native` (entry `get`).
- Then: The response is HTTP 409 with `BROWSER_RECLAIMING`, and there is still one provider session request.

## browser-viewer-acquisition-008

- Vitest: "open rechecks authorization after viewer discovery"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser. While the CDP address is being discovered, the member disables the cloud Browser for the chat with `POST /api/chat-threads/:id/computer-use-host`.
- When: The member opens the chat's Browser with `POST /api/chat-threads/:threadId/browser/open?viewer=native` (entry `open`).
- Then: The response is HTTP 409 with `BROWSER_RECLAIMING`, and there is still one provider session request.

## browser-viewer-acquisition-009

- Vitest: "a binding replaced during address discovery cannot be published"
- Mode: run
- Given: A signed-in member's chats A and B have Runs using separate windows of one shared Browser instance, and the member renews B at nine minutes. During the first CDP address discovery, the clock moves to 11 minutes and A's Run reopens its Browser with `POST /api/browsers/use`, replacing A's window.
- When: The member reads A's Browser with `GET /api/chat-threads/:threadId/browser?viewer=native`, then reads A's and B's Browsers.
- Then: The viewer read returns HTTP 409 with `BROWSER_RECLAIMING`. A's Browser now reports a different primary window, and B keeps its original window.

## browser-viewer-acquisition-010

- Vitest: "provider failure is returned without replaying explicit open"
- Mode: run
- Given: A signed-in member's chat Run uses the shared Browser, and the provider's CDP address discovery fails with HTTP 503.
- When: The member opens the chat's Browser with `POST /api/chat-threads/:threadId/browser/open?viewer=native`, then reads it.
- Then: The open returns HTTP 502 without a new provider session request (still one), and the read still reports the original window.
