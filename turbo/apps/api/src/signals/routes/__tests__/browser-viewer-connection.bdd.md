# browser-viewer-connection

## browser-viewer-connection-001

- Vitest: "retrieves a viewer connection for its signed-in owner"
- Mode: run
- Given: A signed-in member's chat Run has opened a Browser with `POST /api/browsers/use`. The provider's CDP discovery returns a provider WebSocket URL, and the configured Browser extension ID has since changed. Another signed-in user belongs to the same workspace.
- When: The member reads the chat's Browser with `GET /api/chat-threads/:threadId/browser?viewer=native`, and the other user then makes the same request.
- Then: The member receives HTTP 200 with `Cache-Control: no-store` and a viewer containing the chat's `active` Browser with the provider's live URL and a null screenshot URL, the discovered WebSocket URL as the CDP URL, and the originally installed extension. The other user receives HTTP 404 with `BROWSER_NOT_FOUND`.

## browser-viewer-connection-002

- Vitest: "reuses provider WSS without requiring HTTPS discovery"
- Mode: run
- Given: A signed-in member's chat Run has opened a Browser with `POST /api/browsers/use`. The provider now reports the WebSocket URL directly as its CDP URL and no live URL, and its HTTPS discovery endpoint returns an invalid address (provider WSS).
- When: The member reads the chat's Browser with `GET /api/chat-threads/:threadId/browser?viewer=native`, then reads it without the viewer.
- Then: The viewer read returns HTTP 200 with the chat's `active` Browser and a null live URL, and a viewer containing that Browser, the provider WebSocket URL as the CDP URL, and the required extension. The ordinary read returns the identical Browser.

## browser-viewer-connection-003

- Vitest: "reuses live WSS without requiring HTTPS discovery"
- Mode: run
- Given: A signed-in member's chat Run has opened a Browser with `POST /api/browsers/use`. The provider's live URL now embeds the WebSocket URL in its `wss` parameter, and its HTTPS discovery endpoint returns an invalid address (live WSS).
- When: The member reads the chat's Browser with `GET /api/chat-threads/:threadId/browser?viewer=native`.
- Then: The response is HTTP 200 with the chat's `active` Browser and the provider's live URL, and a viewer containing that Browser, the embedded WebSocket URL as the CDP URL, and the required extension.

## browser-viewer-connection-004

- Vitest: "reuses double-encoded live WSS without requiring HTTPS discovery"
- Mode: run
- Given: A signed-in member's chat Run has opened a Browser with `POST /api/browsers/use`. The provider's live URL now embeds a double-encoded WebSocket URL in its `wss` parameter, and its HTTPS discovery endpoint returns an invalid address (double-encoded live WSS).
- When: The member reads the chat's Browser with `GET /api/chat-threads/:threadId/browser?viewer=native`.
- Then: The response is HTTP 200 with the chat's `active` Browser and the provider's live URL, and a viewer containing that Browser, the decoded WebSocket URL as the CDP URL, and the required extension.

## browser-viewer-connection-005

- Vitest: "rejects an untrusted discovery endpoint without returning provider payloads"
- Mode: run
- Given: A signed-in member's chat Run has opened a Browser with `POST /api/browsers/use`. The provider's CDP discovery now returns an untrusted WebSocket address, `wss://untrusted.example/private-token`.
- When: The member reads the chat's Browser with `GET /api/chat-threads/:threadId/browser?viewer=native`.
- Then: The response is HTTP 502 with `BROWSER_USE_DISCOVERY_ERROR` and the message "Managed browser provider could not connect the viewer", and the body does not contain `private-token`.
