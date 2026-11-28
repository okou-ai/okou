# integrations-telegram

## integrations-telegram-001

- Vitest: "GET /api/integrations/telegram > returns the configured official bot for the active organization"
- Mode: run
- Given: The official Telegram bot is configured with username `official_okou_bot`. A member of an organization holds an Okou token and has not linked Telegram.
- When: The member calls `GET /api/integrations/telegram` with the Okou token.
- Then: The response is HTTP 200 with exactly one bot: ID `official`, kind `official`, username `official_okou_bot`, an avatar URL under `/api/integrations/telegram/official/avatar?exp=`, `isOwner: false`, `isConnected: false`, `connectedUser: null`, `tokenStatus: valid` and `official: {configured: true, linkedTelegramUserId: null}`.

## integrations-telegram-002

- Vitest: "GET /api/integrations/telegram/link > returns 401 when no auth token is provided"
- Mode: run
- Given: The official Telegram bot is configured. The caller sends no credentials.
- When: The caller calls `GET /api/integrations/telegram/link` without an authorization header.
- Then: The API responds with HTTP 401 and exactly `{error: {message: "Not authenticated", code: "UNAUTHORIZED"}}`.

## integrations-telegram-003

- Vitest: "GET /api/integrations/telegram/link > returns linked false without installation when no link exists"
- Mode: run
- Given: The official Telegram bot is configured. A member of an organization holds an Okou token and has not linked Telegram.
- When: The member calls `GET /api/integrations/telegram/link` with no query parameters.
- Then: The response is HTTP 200 with exactly `{linked: false}` and no installation.

## integrations-telegram-004

- Vitest: "GET /api/integrations/telegram/link > returns official bot link status with the login bot id"
- Mode: run
- Given: The official Telegram bot is configured with username `official_okou_bot` and bot ID 9876543210, and the app URL is `https://app.example.com`. A member holds an Okou token and has not linked Telegram. Telegram's OAuth domain probe answers with `content-length: 0`.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=https://app.example.com/settings/telegram`.
- Then: The response is HTTP 200 with exactly `linked: false`, installation `{id: official, botUsername: official_okou_bot, loginBotId: "9876543210", domainConfigured: false}` and `readinessError: domain_not_verified`.

## integrations-telegram-005

- Vitest: "POST /api/integrations/telegram/link > returns 401 when not authenticated"
- Mode: run
- Given: The official Telegram bot is configured. The caller sends no credentials.
- When: The caller posts `{telegramBotId: "some-id"}` to `POST /api/integrations/telegram/link` without an authorization header.
- Then: The API responds with HTTP 401 and exactly `{error: {message: "Not authenticated", code: "UNAUTHORIZED"}}`.

## integrations-telegram-006

- Vitest: "POST /api/integrations/telegram/link > links via Telegram Login Widget and attempts a DM welcome (Telegram returns 200)"
- Mode: run
- Given: An onboarded, signed-in member has not linked Telegram. The official bot is configured, and Telegram accepts the bot's direct message with HTTP 200.
- When: The member posts a valid Telegram Login Widget payload (username `official_tg`, first name Test) for the official bot to `POST /api/integrations/telegram/link`.
- Then: The response is HTTP 200 with exactly `botUsername: official_okou_bot` and the Telegram user ID. Exactly one HTML message "✅ Account linked.\nSend me a message to start chatting with Okou." is sent to the user's chat. `GET /api/integrations/telegram` shows the official bot connected with username `official_tg` and display name `Test`.

## integrations-telegram-007

- Vitest: "POST /api/integrations/telegram/link > links via Telegram Login Widget and attempts a DM welcome (Telegram returns 403)"
- Mode: run
- Given: An onboarded, signed-in member has not linked Telegram. The official bot is configured, and Telegram rejects the bot's direct message with HTTP 403 "Bot was blocked".
- When: The member posts a valid Telegram Login Widget payload (username `official_tg`, first name Test) for the official bot to `POST /api/integrations/telegram/link`.
- Then: The response is still HTTP 200 with exactly `botUsername: official_okou_bot` and the Telegram user ID. Exactly one welcome message attempt is made to the user's chat with the linked-account text. `GET /api/integrations/telegram` shows the official bot connected with username `official_tg` and display name `Test`.

## integrations-telegram-008

- Vitest: "POST /api/integrations/telegram/link > connects the official Telegram bot with a signed payload"
- Mode: run
- Given: An onboarded, signed-in member has not linked Telegram. The official bot is configured and Telegram accepts direct messages.
- When: The member posts a current connect signature for Telegram user 99015, signed with the official bot token, to `POST /api/integrations/telegram/link` on `https://api.okou.ai` with origin `https://app.okou.ai`.
- Then: The response is HTTP 200 with exactly `botUsername: official_okou_bot` and `telegramUserId: 99015`. Exactly one HTML welcome message "✅ Account linked.\nSend me a message to start chatting with Okou." is sent to chat 99015.

## integrations-telegram-009

- Vitest: "POST /api/integrations/telegram/link > returns 409 when an official Telegram user is already linked in another org"
- Mode: run
- Given: Two onboarded members belong to different organizations. A Telegram user is already linked to the official bot by the other organization's member.
- When: The first member posts a valid Telegram Login Widget payload for that Telegram user to `POST /api/integrations/telegram/link`.
- Then: The API responds with HTTP 409 and error `{code: CONFLICT, message: "This Telegram account is already connected to another Okou organization through the official Telegram bot @official_okou_bot. Disconnect it before connecting a different account."}`.

## integrations-telegram-010

- Vitest: "POST /api/integrations/telegram/link > returns 400 for invalid telegramAuth hash"
- Mode: run
- Given: An onboarded, signed-in member has not linked Telegram and the official bot is configured.
- When: The member posts a Telegram Login Widget payload with hash `invalid_hash` to `POST /api/integrations/telegram/link`.
- Then: The API responds with HTTP 400 and error message "Invalid Telegram authorization".

## integrations-telegram-011

- Vitest: "POST /api/integrations/telegram/link > returns 400 for invalid connectSignature"
- Mode: run
- Given: An onboarded, signed-in member has not linked Telegram and the official bot is configured.
- When: The member posts a current connect signature for Telegram user 99013 whose signature is 64 `a` characters to `POST /api/integrations/telegram/link`.
- Then: The API responds with HTTP 400 and an error message containing "Invalid or expired connect link".

## integrations-telegram-012

- Vitest: "POST /api/integrations/telegram/link > returns 400 for expired connectSignature"
- Mode: run
- Given: An onboarded, signed-in member has not linked Telegram and the official bot is configured.
- When: The member posts a correctly signed connect signature for Telegram user 99008 whose timestamp is 601 seconds old to `POST /api/integrations/telegram/link`.
- Then: The API responds with HTTP 400 and an error message containing "Invalid or expired connect link".

## integrations-telegram-013

- Vitest: "POST /api/integrations/telegram/link > rejects unauthenticated unlink requests"
- Mode: run
- Given: The official Telegram bot is configured. The caller sends no credentials.
- When: The caller calls `DELETE /api/integrations/telegram/link?botId=official` without an authorization header.
- Then: The API responds with HTTP 401 and exactly `{error: {message: "Not authenticated", code: "UNAUTHORIZED"}}`.

## integrations-telegram-014

- Vitest: "POST /api/integrations/telegram/link > returns 404 when there is no official account to unlink"
- Mode: run
- Given: A signed-in member has no linked Telegram account and the official bot is configured.
- When: The member calls `DELETE /api/integrations/telegram/link?botId=official`.
- Then: The API responds with HTTP 404 and exactly `{error: {message: "No linked Telegram account", code: "NOT_FOUND"}}`.

## integrations-telegram-015

- Vitest: "POST /api/integrations/telegram/link > unlinks the official account only in the active organization"
- Mode: run
- Given: One user belongs to two onboarded organizations and has linked a different Telegram user to the official bot in each.
- When: In the first organization the user calls `DELETE /api/integrations/telegram/link?botId=official`, then reads `GET /api/integrations/telegram/link?botId=official` in each organization.
- Then: The unlink returns HTTP 204. The first organization's link status reports not linked, while the second organization's link status still reports linked.

## integrations-telegram-016

- Vitest: "GET /api/integrations/telegram/:botId/avatar > streams the signed official Telegram bot avatar from the configured token"
- Mode: run
- Given: The official Telegram bot is configured with bot ID 9876543210. Telegram reports a profile photo for the bot (a small and a large size) and serves the large photo's JPEG bytes.
- When: The caller requests the signed avatar URL for the official bot, `GET /api/integrations/telegram/official/avatar?exp=…`, without other credentials.
- Then: The response is HTTP 200 with `content-type: image/jpeg`, `cache-control: private, max-age=300` and exactly the avatar bytes. The bot's profile photos are requested with the configured bot token, user ID 9876543210 and limit 1.

## integrations-telegram-017

- Vitest: "GET /api/integrations/telegram/:botId/avatar > returns the avatar placeholder when the official bot has no avatar"
- Mode: run
- Given: The official Telegram bot is configured and has no profile photos. A member holds an Okou token.
- When: The member calls `GET /api/integrations/telegram/official/avatar` with the Okou token.
- Then: The response is HTTP 200 with an `image/svg+xml` content type, `cache-control: private, max-age=300` and a body containing "Telegram bot avatar fallback".

## integrations-telegram-018

- Vitest: "GET /api/integrations/telegram/download-file > returns 401 when no auth token is provided"
- Mode: run
- Given: The official Telegram bot is configured. The caller sends no credentials.
- When: The caller calls `GET /api/integrations/telegram/download-file?file_id=tg-file-1&bot_id=tg-bot` without an authorization header.
- Then: The API responds with HTTP 401, a JSON content type and exactly `{error: {message: "Not authenticated", code: "UNAUTHORIZED"}}`.

## integrations-telegram-019

- Vitest: "GET /api/integrations/telegram/download-file > returns 401 when the token has no active organization membership"
- Mode: run
- Given: An Okou token was issued for a user and organization, and the user's membership has since been removed.
- When: The caller calls `GET /api/integrations/telegram/download-file?file_id=tg-file-1&bot_id=tg-bot` with that token.
- Then: The API responds with HTTP 401, a JSON content type and exactly `{error: {message: "Not authenticated", code: "UNAUTHORIZED"}}`.

## integrations-telegram-020

- Vitest: "GET /api/integrations/telegram/download-file > returns 401 when the authenticated session has no organization"
- Mode: run
- Given: A signed-in user session has no active organization.
- When: The user calls `GET /api/integrations/telegram/download-file?file_id=tg-file-1&bot_id=tg-bot` with the session token.
- Then: The API responds with HTTP 401, a JSON content type and exactly `{error: {message: "Not authenticated", code: "UNAUTHORIZED"}}`.

## integrations-telegram-021

- Vitest: "GET /api/integrations/telegram/download-file > streams files for the official Telegram bot"
- Mode: run
- Given: An onboarded member linked Telegram user "Reader" to the official bot, and the official bot webhook recorded the user's document `tg-official` in a supergroup the user still belongs to. Telegram resolves the file to `photos/official.jpg` and serves its JPEG bytes. The member holds an Okou token.
- When: The member calls `GET /api/integrations/telegram/download-file?file_id=tg-official&bot_id=official` with the Okou token.
- Then: The response is HTTP 200 with `content-type: image/jpeg`, `x-file-name: official.jpg` and exactly the file bytes. Telegram file metadata is requested with the official bot token and `tg-official`.

## integrations-telegram-022

- Vitest: "GET /api/integrations/telegram/download-file > does not read an old account's recorded private files through the new account's binding"
- Mode: run
- Given: An onboarded member linked a first Telegram account, which sent the private document `previous-private-attachment` to the official bot. The member then unlinked and linked a different Telegram account. The member holds an Okou token.
- When: The member calls `GET /api/integrations/telegram/download-file?file_id=previous-private-attachment&bot_id=official` with the Okou token.
- Then: The API responds with HTTP 404. Telegram is asked about the recorded source chat exactly once, and file metadata is never requested.

## integrations-telegram-023

- Vitest: "GET /api/integrations/telegram/download-file > denies unrecorded bot-global files and files from a chat the caller left"
- Mode: run
- Given: An onboarded member linked Telegram, and the official bot recorded the user's document `owned-attachment` in a supergroup. The member holds an Okou token.
- When: The member requests `GET /api/integrations/telegram/download-file` for the unrecorded file `another-users-attachment`, then, after Telegram reports the user's group membership status as `left`, for `owned-attachment`.
- Then: Both requests return HTTP 404 and Telegram file metadata is never requested.

## integrations-telegram-024

- Vitest: "GET /api/integrations/telegram/download-file > returns 404 when Telegram file metadata has no downloadable path"
- Mode: run
- Given: An onboarded member linked Telegram and the official bot recorded the user's group document `tg-no-path`. Telegram's file metadata for it has no `file_path`.
- When: The member calls `GET /api/integrations/telegram/download-file?file_id=tg-no-path&bot_id=official` with an Okou token.
- Then: The API responds with HTTP 404, a JSON content type and exactly `{error: {message: "Telegram file does not have a downloadable path", code: "NOT_FOUND"}}`.

## integrations-telegram-025

- Vitest: "GET /api/integrations/telegram/download-file > returns 413 when Telegram reports a file over the proxy limit"
- Mode: run
- Given: An onboarded member linked Telegram and the official bot recorded the user's group document `tg-file-big`. Telegram reports its size as 200 MiB.
- When: The member calls `GET /api/integrations/telegram/download-file?file_id=tg-file-big&bot_id=official` with an Okou token.
- Then: The API responds with HTTP 413, a JSON content type and exactly `{error: {message: "File exceeds maximum size of 104857600 bytes", code: "PAYLOAD_TOO_LARGE"}}`.

## integrations-telegram-026

- Vitest: "GET /api/integrations/telegram/download-file > returns 413 when download content-length exceeds the proxy limit"
- Mode: run
- Given: An onboarded member linked Telegram and the official bot recorded the user's group document `tg-huge-response`. Telegram's metadata omits the size, and the download responds with `content-length` of 200 MiB.
- When: The member calls `GET /api/integrations/telegram/download-file?file_id=tg-huge-response&bot_id=official` with an Okou token.
- Then: The API responds with HTTP 413, a JSON content type and exactly `{error: {message: "File exceeds maximum size of 104857600 bytes", code: "PAYLOAD_TOO_LARGE"}}`.

## integrations-telegram-027

- Vitest: "GET /api/integrations/telegram/download-file > returns 502 when Telegram returns HTML for a file download"
- Mode: run
- Given: An onboarded member linked Telegram and the official bot recorded the user's group document `tg-html`. Telegram's file download returns an HTML page with HTTP 200.
- When: The member calls `GET /api/integrations/telegram/download-file?file_id=tg-html&bot_id=official` with an Okou token.
- Then: The API responds with HTTP 502, a JSON content type and exactly `{error: {message: "Telegram returned an unexpected response", code: "BAD_GATEWAY"}}`.

## integrations-telegram-028

- Vitest: "GET /api/integrations/telegram/download-file > returns 502 when Telegram file download returns a non-OK response"
- Mode: run
- Given: An onboarded member linked Telegram and the official bot recorded the user's group document `tg-download-fail`. Telegram's file download responds with HTTP 503.
- When: The member calls `GET /api/integrations/telegram/download-file?file_id=tg-download-fail&bot_id=official` with an Okou token.
- Then: The API responds with HTTP 502, a JSON content type and exactly `{error: {message: "Failed to download file from Telegram: 503", code: "BAD_GATEWAY"}}`.

## integrations-telegram-029

- Vitest: "GET /api/integrations/telegram/download-file > returns a generic 502 body when Telegram file lookup throws"
- Mode: run
- Given: An onboarded member linked Telegram and the official bot recorded the user's group document `tg-throws`. Telegram's file lookup fails with an error "upstream detail".
- When: The member calls `GET /api/integrations/telegram/download-file?file_id=tg-throws&bot_id=official` with an Okou token.
- Then: The API responds with HTTP 502, a JSON content type and exactly `{error: {message: "Failed to download file from Telegram", code: "BAD_GATEWAY"}}`, without the upstream detail.
