# integrations-telegram-upload-complete

## integrations-telegram-upload-complete-001

- Vitest: "POST /api/integrations/telegram/upload-file/complete > delivers private file bytes through Telegram with attribution"
- Mode: run
- Given: A member has onboarded, linked their Telegram user (first name "Test") to the official upload bot, and has a running chat Run with an Okou token. Telegram reports the target supergroup allows documents and the member belongs to it, and `sendDocument` returns message 321 with a Telegram file ID. The member initialized `report.pdf` (`application/pdf`, 1234 bytes) through `POST /api/integrations/telegram/upload-file/init` and uploaded the bytes to the returned URL.
- When: The Run calls `POST /api/integrations/telegram/upload-file/complete` with the Okou token, the upload ID, the official bot, chat `-1001234567890`, caption "Daily report" and message thread 42.
- Then: Telegram receives a document request for chat `-1001234567890` with a private-artifact storage URL, caption `Daily report` followed by an italic HTML attribution linking `tg://user?id=<telegramUserId>` labeled Test, `parse_mode: HTML` and `message_thread_id: 42`. The response is HTTP 200 with message ID 321, the chat ID, the Telegram file ID, `report.pdf`, `application/pdf`, size 1234 and the upload's file URL. The Run's thread artifacts list exactly that one file.

## integrations-telegram-upload-complete-002

- Vitest: "POST /api/integrations/telegram/upload-file/complete > delivers private file bytes through Telegram at the caption limit"
- Mode: run
- Given: A member has onboarded, linked Telegram to the official upload bot, and has a running chat Run with an Okou token. Telegram reports the target supergroup allows documents and the member belongs to it, and `sendDocument` returns message 321. The member initialized and uploaded `report.pdf` (1234 bytes) through `POST /api/integrations/telegram/upload-file/init`.
- When: The Run calls `POST /api/integrations/telegram/upload-file/complete` with the Okou token, the upload ID, chat `-1001234567890`, a 1024-character caption and message thread 42.
- Then: Telegram receives the caption exactly as given, without attribution, with `parse_mode: HTML`, `message_thread_id: 42` and a private-artifact storage URL. The response is HTTP 200 with message ID 321, the Telegram file ID, `report.pdf`, `application/pdf`, size 1234 and the file URL, and the Run's thread artifacts list exactly that one file.

## integrations-telegram-upload-complete-003

- Vitest: "POST /api/integrations/telegram/upload-file/complete > returns 403 when the token has no organization membership"
- Mode: run
- Given: An Okou token was issued for a user and organization, and the user's organization membership has since been removed.
- When: The caller posts to `POST /api/integrations/telegram/upload-file/complete` with that token, a random upload ID, the official bot and chat `-1001234567890`.
- Then: The API responds with HTTP 403 and exactly `{error: {message: "Organization context is required", code: "FORBIDDEN"}}`.

## integrations-telegram-upload-complete-004

- Vitest: "POST /api/integrations/telegram/upload-file/complete > returns 400 when Telegram rejects the sendDocument call"
- Mode: run
- Given: A member has onboarded, linked Telegram to the official upload bot, and has a running chat Run with an Okou token. The member initialized and uploaded `report.pdf` (1234 bytes) through `POST /api/integrations/telegram/upload-file/init`. Telegram's `sendDocument` rejects with HTTP 400 "Bad Request: chat not found".
- When: The Run calls `POST /api/integrations/telegram/upload-file/complete` with the Okou token, the upload ID, the official bot and chat `-1001234567890`.
- Then: The API responds with HTTP 400, error code `TELEGRAM_ERROR` and a message containing "chat not found". The Run's thread artifacts list no uploaded files.
