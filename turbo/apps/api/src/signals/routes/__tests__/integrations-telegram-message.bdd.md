# integrations-telegram-message

## integrations-telegram-message-001

- Vitest: "POST /api/integrations/telegram/message > returns 401 when no auth token is provided"
- Mode: run
- Given: The caller sends no authorization token.
- When: The caller calls `POST /api/integrations/telegram/message` with bot `tg-bot`, chat `-100` and text "hi".
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## integrations-telegram-message-002

- Vitest: "POST /api/integrations/telegram/message > returns 401 when the token has no active organization membership"
- Mode: run
- Given: A run-scoped agent token was issued to a member who has since been removed from the organization.
- When: The agent calls `POST /api/integrations/telegram/message` with bot `tg-bot`, chat `-100` and text "hi".
- Then: The response is HTTP 401 with exactly the error message "Not authenticated" and code `UNAUTHORIZED`.

## integrations-telegram-message-003

- Vitest: "POST /api/integrations/telegram/message > returns 401 when the authenticated session has no organization"
- Mode: run
- Given: The caller has a valid signed-in session without an active organization.
- When: The caller calls `POST /api/integrations/telegram/message` with bot `tg-bot`, chat `-100` and text "hi".
- Then: The response is HTTP 401 with exactly the error message "Not authenticated" and code `UNAUTHORIZED`.

## integrations-telegram-message-004

- Vitest: "POST /api/integrations/telegram/message > attributes an official message to the agent and sender with a Standard Run"
- Mode: run
- Given: A Pro member with a personal Claude subscription runs a Standard thread on `claude-fable-5-1`; the model list shows it available with member credentials and capture-required account selection and no service tier, and the Runner receives `ANTHROPIC_MODEL` `claude-fable-5-1` and an `OKOU_TOKEN`. The member has linked their Telegram account (first name "Sender") to the official bot, and Telegram accepts messages.
- When: The run calls `POST /api/integrations/telegram/message` with its `OKOU_TOKEN`, the official bot ID, the member's Telegram chat ID and text "Hello from this Run".
- Then: Telegram receives exactly that chat ID, HTML parse mode and the text "Hello from this Run" followed by a blank line and an italic "Triggered by" link to `tg://user?id=<chat ID>` labelled "Sender". The response is HTTP 200 with exactly `ok: true`, message ID 325 and the chat ID.

## integrations-telegram-message-005

- Vitest: "POST /api/integrations/telegram/message > attributes an official message to the agent and sender with a Fast Run"
- Mode: run
- Given: A Pro member connects a Codex subscription and runs a Fast thread on `gpt-6.1-sol`; the model list shows it available with member credentials, capture-required account selection and `priority` service tier, and the Runner receives an `openai-codex` model config with the `fast` tier and an `OKOU_TOKEN`. The member has linked their Telegram account (first name "Sender") to the official bot, and Telegram accepts messages.
- When: The run calls `POST /api/integrations/telegram/message` with its `OKOU_TOKEN`, the official bot ID, the member's Telegram chat ID and text "Hello from this Run".
- Then: Telegram receives exactly that chat ID, HTML parse mode and the text "Hello from this Run" followed by a blank line and an italic "Triggered by" link to `tg://user?id=<chat ID>` labelled "Sender". The response is HTTP 200 with exactly `ok: true`, message ID 325 and the chat ID.

## integrations-telegram-message-006

- Vitest: "POST /api/integrations/telegram/message > appends the dispatched Run's agent label to an official message"
- Mode: run
- Given: An organization admin has a run-scoped agent token from a dispatched Run and has linked their Telegram account (first name "Sender") to the official bot. Telegram accepts messages.
- When: The agent calls `POST /api/integrations/telegram/message` with the official bot ID, the admin's Telegram chat ID and text "Hello from this Run".
- Then: Telegram receives exactly that chat ID, HTML parse mode and the text "Hello from this Run" followed by a blank line and an italic "Triggered by" link to `tg://user?id=<chat ID>` labelled "Sender". The response is HTTP 200 with exactly `ok: true`, message ID 325 and the chat ID.

## integrations-telegram-message-007

- Vitest: "official Telegram self delivery > checks both Telegram principals before sending: shared"
- Mode: run
- Given: An onboarded, signed-in member has linked their Telegram account to the official bot. Telegram resolves `@requested_chat` to supergroup `-1001234567890` that allows messages, and reports both the member and the bot as members who can send. Row: `shared`.
- When: The member calls `POST /api/integrations/telegram/message` with the official bot, chat `@requested_chat` and text "authorized group message".
- Then: The response is HTTP 200, and Telegram receives exactly one message for chat `-1001234567890`.

## integrations-telegram-message-008

- Vitest: "official Telegram self delivery > checks both Telegram principals before sending: missing user"
- Mode: run
- Given: An onboarded, signed-in member has linked their Telegram account to the official bot. Telegram resolves `@requested_chat` to a supergroup that allows messages, but reports that the member has left it. Row: `missing user`.
- When: The member calls `POST /api/integrations/telegram/message` with the official bot, chat `@requested_chat` and text "authorized group message".
- Then: The response is HTTP 404, and no message is sent to Telegram.

## integrations-telegram-message-009

- Vitest: "official Telegram self delivery > checks both Telegram principals before sending: missing bot"
- Mode: run
- Given: An onboarded, signed-in member has linked their Telegram account to the official bot. Telegram resolves `@requested_chat` to a supergroup that allows messages, but reports that the bot has left it. Row: `missing bot`.
- When: The member calls `POST /api/integrations/telegram/message` with the official bot, chat `@requested_chat` and text "authorized group message".
- Then: The response is HTTP 404, and no message is sent to Telegram.

## integrations-telegram-message-010

- Vitest: "official Telegram self delivery > checks both Telegram principals before sending: restricted user"
- Mode: run
- Given: An onboarded, signed-in member has linked their Telegram account to the official bot. Telegram resolves `@requested_chat` to a supergroup that allows messages, but reports the member as restricted without permission to send messages. Row: `restricted user`.
- When: The member calls `POST /api/integrations/telegram/message` with the official bot, chat `@requested_chat` and text "authorized group message".
- Then: The response is HTTP 404, and no message is sent to Telegram.

## integrations-telegram-message-011

- Vitest: "official Telegram self delivery > checks both Telegram principals before sending: restricted bot"
- Mode: run
- Given: An onboarded, signed-in member has linked their Telegram account to the official bot. Telegram resolves `@requested_chat` to a supergroup that allows messages, but reports the bot as restricted without permission to send messages. Row: `restricted bot`.
- When: The member calls `POST /api/integrations/telegram/message` with the official bot, chat `@requested_chat` and text "authorized group message".
- Then: The response is HTTP 404, and no message is sent to Telegram.

## integrations-telegram-message-012

- Vitest: "official Telegram self delivery > checks both Telegram principals before sending: other private chat"
- Mode: run
- Given: An onboarded, signed-in member has linked their Telegram account to the official bot. Telegram resolves `@requested_chat` to a private chat with another Telegram user (the member's Telegram ID plus one). Row: `other private chat`.
- When: The member calls `POST /api/integrations/telegram/message` with the official bot, chat `@requested_chat` and text "authorized group message".
- Then: The response is HTTP 200, and Telegram receives exactly one message for that other user's private chat ID.

## integrations-telegram-message-013

- Vitest: "official Telegram self delivery > rejects an unlinked public actor without sending through another actor's link"
- Mode: run
- Given: Two onboarded members, A and B, use the official Telegram bot. A has linked their Telegram account (which sent one message to A's Telegram chat); B has not linked an account.
- When: B, signed in, calls `GET /api/integrations/telegram/link?botId=<official>` and then `POST /api/integrations/telegram/message` with the official bot, chat `me` and text "Hello B".
- Then: The link status returns HTTP 200 with `linked` false. The message request returns HTTP 404 with exactly the message "No Telegram account linked to the current user. Link Telegram first." and code `NOT_FOUND`, and nothing is sent to Telegram, including to A's chat.

## integrations-telegram-message-014

- Vitest: "official Telegram self delivery > resolves serial public self messages for distinct actors in A-B-A order"
- Mode: run
- Given: Two onboarded members, A and B, have each linked a distinct Telegram account to the official bot (each link sent one message to that member's chat). Telegram numbers subsequent messages 101, 102 and 103.
- When: A, then B, then A again, each signed in, call `POST /api/integrations/telegram/message` with the official bot, chat `me` and text "Hello self".
- Then: Each request returns HTTP 200 with exactly `ok: true`, the next integer message ID (101, 102, 103) and the caller's own Telegram ID as chat ID. Telegram receives messages for A's, B's and A's chat IDs in that order.

## integrations-telegram-message-015

- Vitest: "official Telegram self delivery > resolves chatId 'me' through the caller's official link in the current org"
- Mode: run
- Given: An onboarded, signed-in member has linked their Telegram account to the official bot in the current organization. Telegram accepts messages and returns message ID 324.
- When: The member calls `POST /api/integrations/telegram/message` with the official bot, chat `me` and text "Hello self".
- Then: The response is HTTP 200 with exactly `ok: true`, message ID 324 and the member's Telegram ID as chat ID, and Telegram receives the message for that chat ID.

## integrations-telegram-message-016

- Vitest: "official Telegram self delivery > does not use an official link belonging to another org"
- Mode: run
- Given: A user belongs to two organizations and linked their Telegram account to the official bot only in the other organization. The user is signed in to the first organization.
- When: The user calls `POST /api/integrations/telegram/message` with the official bot, chat `me` and text "Hello self".
- Then: The response is HTTP 404 with exactly the message "No Telegram account linked to the current user. Link Telegram first." and code `NOT_FOUND`.

## integrations-telegram-message-017

- Vitest: "official Telegram self delivery > authorizes Telegram file delivery to own DM"
- Mode: run
- Given: An onboarded, signed-in member has linked their Telegram account to the official bot and has uploaded a 1234-byte `report.pdf` via `POST /api/integrations/telegram/upload-file/init` and the returned upload URL. Telegram accepts documents and returns message ID 322.
- When: The member calls `POST /api/integrations/telegram/upload-file/complete` with the upload ID, the official bot, chat `me` and content type `application/pdf`.
- Then: The response is HTTP 200 with message ID 322 and the member's own Telegram ID as chat ID, and Telegram receives the document for that chat ID.

## integrations-telegram-message-018

- Vitest: "official Telegram self delivery > authorizes Telegram file delivery to other DM"
- Mode: run
- Given: An onboarded, signed-in member has linked their Telegram account to the official bot and has uploaded a 1234-byte `report.pdf` via `POST /api/integrations/telegram/upload-file/init` and the returned upload URL. Telegram resolves the target as a private chat with another Telegram user (the member's ID plus one) and accepts documents.
- When: The member calls `POST /api/integrations/telegram/upload-file/complete` with the upload ID, the official bot, that other user's chat ID and content type `application/pdf`.
- Then: The response is HTTP 200 with message ID 322 and the other user's chat ID, and Telegram receives the document for that chat ID.

## integrations-telegram-message-019

- Vitest: "official Telegram self delivery > authorizes Telegram file delivery to revoked group"
- Mode: run
- Given: An onboarded, signed-in member has linked their Telegram account to the official bot and has uploaded a 1234-byte `report.pdf` via `POST /api/integrations/telegram/upload-file/init` and the returned upload URL. Telegram reports group `-100123` as a supergroup that allows documents; the member is a member on the first chat check but has left by the second.
- When: The member calls `POST /api/integrations/telegram/upload-file/complete` with the upload ID, the official bot, chat `-100123` and content type `application/pdf`.
- Then: Telegram's chat is checked twice, the response is HTTP 404, and no document is sent.

## integrations-telegram-message-020

- Vitest: "official Telegram self delivery > rejects self uploads without an official Telegram link"
- Mode: run
- Given: A signed-in user has not linked any Telegram account to the official bot.
- When: The user calls `POST /api/integrations/telegram/upload-file/complete` with a random upload ID, the official bot and chat `me`.
- Then: The response is HTTP 404 with exactly the message "No Telegram account linked to the current user. Link Telegram first." and code `NOT_FOUND`.
