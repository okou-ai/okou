# discord-gateway-auth

## discord-gateway-auth-001

- Vitest: "Discord Gateway authentication and ignored transport events > accepts the exact shared HMAC vector bytes: 1790240400"
- Mode: run
- Given: The deployment and Gateway share the fixture signing configuration, but the API is configured for a different Discord application. The authenticated body is the compact JSON message-create vector.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: Authentication succeeds far enough to reach the application check, which returns HTTP 403 with `FORBIDDEN` and `Invalid application`.

## discord-gateway-auth-002

- Vitest: "Discord Gateway authentication and ignored transport events > accepts the exact shared HMAC vector bytes: 1790240400"
- Mode: run
- Given: The deployment and Gateway share the fixture signing configuration, but the API is configured for a different Discord application. The authenticated body is the formatted Unicode guild-delete vector with a trailing newline.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: Authentication succeeds far enough to reach the application check, which returns HTTP 403 with `FORBIDDEN` and `Invalid application`.

## discord-gateway-auth-003

- Vitest: "Discord Gateway authentication and ignored transport events > rejects signed bodies whose bytes changed"
- Mode: run
- Given: A currently signed, syntactically valid guild-unavailable event is altered after signing by appending a newline.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: The API returns HTTP 401.

## discord-gateway-auth-004

- Vitest: "Discord Gateway authentication and ignored transport events > accepts a signed timestamp at the past/future window boundary (-300)"
- Mode: run
- Given: A correctly signed guild-unavailable event is timestamped 300 seconds before API time.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: HTTP 200 returns `ok: true`, `outcome: ignored`, and `reason: guild-unavailable`.

## discord-gateway-auth-005

- Vitest: "Discord Gateway authentication and ignored transport events > accepts a signed timestamp at the past/future window boundary (300)"
- Mode: run
- Given: A correctly signed guild-unavailable event is timestamped 300 seconds after API time.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: HTTP 200 returns `ok: true`, `outcome: ignored`, and `reason: guild-unavailable`.

## discord-gateway-auth-006

- Vitest: "Discord Gateway authentication and ignored transport events > rejects a signed timestamp outside the past/future window (-301)"
- Mode: run
- Given: A correctly signed guild-unavailable event is timestamped 301 seconds before API time.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: The API returns HTTP 401.

## discord-gateway-auth-007

- Vitest: "Discord Gateway authentication and ignored transport events > rejects a signed timestamp outside the past/future window (301)"
- Mode: run
- Given: A correctly signed guild-unavailable event is timestamped 301 seconds after API time.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: The API returns HTTP 401.

## discord-gateway-auth-008

- Vitest: "Discord Gateway authentication and ignored transport events > rejects partially numeric timestamps and malformed signatures"
- Mode: run
- Given: The configured Gateway has one request whose timestamp has a nonnumeric suffix, and a second request with a current timestamp and a malformed signature.
- When: The Gateway sends both requests to the internal Gateway endpoint.
- Then: Both requests return HTTP 401.

## discord-gateway-auth-009

- Vitest: "Discord Gateway authentication and ignored transport events > rejects a transport-supplied Okou owner"
- Mode: run
- Given: The authenticated Gateway envelope carries an extra transport-supplied Okou user ID.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: The API rejects the unsupported owner field with HTTP 400.

## discord-gateway-auth-010

- Vitest: "Discord Gateway authentication and ignored transport events > acknowledges a guild removal without account mutations"
- Mode: run
- Given: A configured Gateway reports a guild that has no installation in the fixture.
- When: The Gateway delivers an unavailable guild event and then a removal event with the same event ID.
- Then: Each response is HTTP 200 with `ok: true` and `outcome: ignored`. The reasons are `guild-unavailable` and `guild-removed`, respectively.

## discord-gateway-auth-011

- Vitest: "Discord Gateway authentication and ignored transport events > intentionally ignores unsupported message producers or updates: {\"author\":{\"id\":\"333333333333333333\",\"username\":\"bot\",\"bot\":true}}"
- Mode: run
- Given: A correctly authenticated message-create event comes from a bot author.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: HTTP 200 returns `ok: true`, `outcome: ignored`, and `reason: unsupported-message`.

## discord-gateway-auth-012

- Vitest: "Discord Gateway authentication and ignored transport events > intentionally ignores unsupported message producers or updates: {\"webhook_id\":\"444444444444444444\"}"
- Mode: run
- Given: A correctly authenticated message-create event identifies a webhook producer.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: HTTP 200 returns `ok: true`, `outcome: ignored`, and `reason: unsupported-message`.

## discord-gateway-auth-013

- Vitest: "Discord Gateway authentication and ignored transport events > intentionally ignores unsupported message producers or updates: {\"edited_timestamp\":\"2026-09-24T00:00:00Z\"}"
- Mode: run
- Given: A correctly authenticated message-create event contains an edit timestamp.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: HTTP 200 returns `ok: true`, `outcome: ignored`, and `reason: unsupported-message`.

## discord-gateway-auth-014

- Vitest: "Discord Gateway authentication and ignored transport events > intentionally ignores unsupported message producers or updates: {\"type\":6}"
- Mode: run
- Given: A correctly authenticated message-create event has Discord message type 6.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: HTTP 200 returns `ok: true`, `outcome: ignored`, and `reason: unsupported-message`.

## discord-gateway-auth-015

- Vitest: "Discord Gateway authentication and ignored transport events > rejects an oversized authenticated message body"
- Mode: run
- Given: The configured Gateway submits an authenticated message envelope with a one-mebibyte content field and additional envelope bytes.
- When: The Gateway submits the signed event to `POST /api/internal/discord/gateway`.
- Then: The API rejects the oversized body with HTTP 413.

## discord-gateway-auth-016

- Vitest: "Discord Gateway authentication and ignored transport events > does not accept traffic when app configuration is absent"
- Mode: run
- Given: The Discord app has no configured Gateway signing secret.
- When: The Gateway delivers a current signed event to the normal internal endpoint.
- Then: The API returns HTTP 503.
