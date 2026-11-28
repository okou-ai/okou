# integrations-telegram-post

## integrations-telegram-post-001

- Vitest: "POST /api/telegram/webhook/:telegramBotId > binds the canonical private Connect link with normalized username and display name"
- Mode: run
- Given: The official Telegram bot is configured, the app URL is `https://app.okou.ai`, and the clock is 2026-10-15T12:00:00Z. An onboarded member has not linked Telegram. An unlinked Telegram user whose profile has username `  @alice_connect  `, first name `  Alice   &  ` and last name `  王  ` sends `/connect` in a private chat.
- When: Telegram delivers the private message to `POST /api/telegram/webhook/:telegramBotId` for the official bot with the valid secret; the member then calls `GET /api/integrations/telegram`, submits the URL's signed proof unchanged to `POST /api/integrations/telegram/link`, reads `GET /api/integrations/telegram/link?botId=…` and lists the bots again.
- Then: The webhook returns HTTP 200 and the bot sends exactly one message to the user's chat with a `Connect` button to `https://app.okou.ai/settings/telegram` whose query is exactly `bot`, `tgUser`, `ts` (issue time in seconds), a 64-hex `sig`, `tgUserName=alice_connect` and `tgDisplayName=Alice & 王`. Before linking the official bot is listed with `isConnected: false` and `connectedUser: null`; the link returns HTTP 200 with the Telegram user ID and `official_okou_bot`, the status returns `linked: true` with the same values, and the list shows the bot connected with `connectedUser` username `alice_connect`, display name `Alice & 王`, and `official.configured: true` with the linked Telegram user ID.

## integrations-telegram-post-002

- Vitest: "POST /api/telegram/webhook/:telegramBotId > binds the canonical private Connect link with display name without a username"
- Mode: run
- Given: The official Telegram bot is configured, the app URL is `https://app.okou.ai`, and the clock is 2026-10-15T12:00:00Z. An onboarded member has not linked Telegram. An unlinked Telegram user with first name `  Alice   王  ` and no username sends `/start connect` in a private chat.
- When: Telegram delivers the private message to `POST /api/telegram/webhook/:telegramBotId` for the official bot with the valid secret; the member then calls `GET /api/integrations/telegram`, submits the URL's signed proof unchanged to `POST /api/integrations/telegram/link`, reads `GET /api/integrations/telegram/link?botId=…` and lists the bots again.
- Then: The webhook returns HTTP 200 and the bot sends exactly one message with a `Connect` button to `https://app.okou.ai/settings/telegram` whose query is exactly `bot`, `tgUser`, `ts`, a 64-hex `sig` and `tgDisplayName=Alice 王`, with no `tgUserName`. Before linking the bot is not connected; the link returns HTTP 200 with the Telegram user ID and bot username, the status reports `linked: true`, and the list shows the bot connected with `connectedUser` username `null` and display name `Alice 王`.

## integrations-telegram-post-003

- Vitest: "POST /api/telegram/webhook/:telegramBotId > binds the canonical private Connect link with no optional identity names"
- Mode: run
- Given: The official Telegram bot is configured, the app URL is `https://app.okou.ai`, and the clock is 2026-10-15T12:00:00Z. An onboarded member has not linked Telegram. An unlinked Telegram user with no username or names sends `hello` in a private chat.
- When: Telegram delivers the private message to `POST /api/telegram/webhook/:telegramBotId` for the official bot with the valid secret; the member then calls `GET /api/integrations/telegram`, submits the URL's signed proof unchanged to `POST /api/integrations/telegram/link`, reads `GET /api/integrations/telegram/link?botId=…` and lists the bots again.
- Then: The webhook returns HTTP 200 and the bot sends exactly one message with a `Connect` button to `https://app.okou.ai/settings/telegram` whose query is exactly `bot`, `tgUser`, `ts` and a 64-hex `sig`, without name parameters. Before linking the bot is not connected; the link returns HTTP 200, the status reports `linked: true`, and the list shows the bot connected with `connectedUser` username and display name both `null`.

## integrations-telegram-post-004

- Vitest: "POST /api/telegram/webhook/:telegramBotId > keeps group Connect private with bot username official_okou_bot"
- Mode: run
- Given: The official Telegram bot is configured with username `official_okou_bot`. An unlinked Telegram user sends `/connect` (message 197) in supergroup `-40197`.
- When: Telegram delivers the group message to `POST /api/telegram/webhook/:telegramBotId` for the official bot with the valid secret.
- Then: The webhook returns HTTP 200 and the bot sends exactly one message to chat `-40197` replying to message 197, with a single `Connect` button to `https://t.me/official_okou_bot?start=connect`. The message text contains no `https://app.` link.

## integrations-telegram-post-005

- Vitest: "POST /api/telegram/webhook/:telegramBotId > keeps group Connect private with bot username undefined"
- Mode: run
- Given: The official Telegram bot is configured without a bot username. An unlinked Telegram user sends `/connect` (message 197) in supergroup `-40197`.
- When: Telegram delivers the group message to `POST /api/telegram/webhook/:telegramBotId` for the official bot with the valid secret.
- Then: The webhook returns HTTP 200 and the bot sends exactly one message to chat `-40197` replying to message 197, with no reply markup and text containing "Send me /connect in a private message.". The text contains no `https://app.` link.

## integrations-telegram-post-006

- Vitest: "POST /api/telegram/webhook/:telegramBotId > validates the webhook secret"
- Mode: run
- Given: An onboarded member's workspace uses the official Telegram bot, whose webhook secret is configured.
- When: A caller posts an empty update to `POST /api/telegram/webhook/:telegramBotId` with `x-telegram-bot-api-secret-token: wrong-secret`.
- Then: The webhook responds with HTTP 401 and body `Unauthorized`.

## integrations-telegram-post-007

- Vitest: "POST /api/telegram/webhook/:telegramBotId > keeps concurrent first Telegram DMs on one owner-scoped thread"
- Mode: run
- Given: A Runner group is available. A member has linked their Telegram user to the official bot and has no Telegram DM thread yet; another unrelated member exists.
- When: Telegram concurrently delivers two first private messages (4701 and 4702) from the linked user to `POST /api/telegram/webhook/:telegramBotId`, then redelivers the first update.
- Then: Both deliveries return HTTP 200 and the owner's thread lifecycle gains exactly one new thread, which holds both non-revoked prompts and is the only thread containing each. The redelivery returns HTTP 200 and leaves the lifecycle and the thread's events unchanged. The unrelated member gets HTTP 404 reading the thread's metadata and does not see the thread in their lifecycle.

## integrations-telegram-post-008

- Vitest: "POST /api/telegram/webhook/:telegramBotId > snapshots thread reuse inputs before a CLI session exists"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram. The member's first DM started a Run that failed (exit code 1, "CLI session did not start") before any CLI session existed. A Runner then registers holding a reusable sandbox for reuse key `thread:<threadId>` sourced from that Run.
- When: Telegram delivers a follow-up DM in the same private chat to `POST /api/telegram/webhook/:telegramBotId`.
- Then: The follow-up Run lands in the same chat thread and is dispatched to the registered Runner and heartbeat generation with execution context `reuseKey: thread:<threadId>` and native continuation `sessionId: null`, `generationRunId: null`. The Run's execution input carries the same reuse key.

## integrations-telegram-post-009

- Vitest: "POST /api/telegram/webhook/:telegramBotId > rebuilds queued Telegram launch material from context"
- Mode: run
- Given: A Runner group is available. A member has completed onboarding, linked Telegram and connected the native Fable subscription. A first DM ("hold the Telegram queue") has started a Run that is still active.
- When: Telegram delivers a second DM (message 2202) to `POST /api/telegram/webhook/:telegramBotId`, then the first Run completes through `POST /api/webhooks/run/complete`.
- Then: The second message is recorded in the same thread as a queued prompt without a Run. After the first Run completes a Run is launched for it whose prompt equals the queued text and whose appended system prompt has the Telegram integration block (Bot ID 987654, `@official_okou_bot`, the chat ID, `private`, Message ID 2202, Root message ID `direct-message:main`), followed by the Telegram integration note and thread context that contains the first prompt.

## integrations-telegram-post-010

- Vitest: "POST /api/telegram/webhook/:telegramBotId > official Telegram DM models > routes official Telegram DM models"
- Mode: run
- Given: A member has linked Telegram to the official bot and uses the native Fable model. A main DM (message 3501) has been completed and answered with a reply to message 3501.
- When: Telegram delivers a new top-level DM "continue the main DM" (message 3502) to `POST /api/telegram/webhook/:telegramBotId` and the Run completes.
- Then: The bot's reply answers message 3502. The Run continues the main DM's native CLI session, lands in the main DM's chat thread, and the thread's selected model is `claude-fable-5-1`.

## integrations-telegram-post-011

- Vitest: "POST /api/telegram/webhook/:telegramBotId > official Telegram DM reply-anchors > routes official Telegram DM reply-anchors"
- Mode: run
- Given: A member has linked Telegram to the official bot. A main DM (3501) is answered; a branch DM (3503) replying to 3501 produced a long answer delivered in several Telegram messages; a follow-up (3504) replying to the bot's branch answer continued the branch session.
- When: Telegram delivers a DM (message 3505) replying to the member's earlier branch message 3503 to `POST /api/telegram/webhook/:telegramBotId` and the Run completes.
- Then: The bot's reply answers message 3505 and the Run continues the native CLI session of the branch follow-up.

## integrations-telegram-post-012

- Vitest: "POST /api/telegram/webhook/:telegramBotId > official Telegram DM pinned-replies > routes official Telegram DM pinned-replies"
- Mode: run
- Given: A member has linked Telegram to the official bot and started with model `claude-fable-5-1`. A main DM (3501) is answered; a branch DM (3503) replying to 3501 produced a multi-message answer; a follow-up (3504) continued that branch. The member then changes their default model to `gpt-6-astra` through `PUT /api/user-model-preference`.
- When: Telegram delivers a DM (message 3508) replying to the bot's branch answer to `POST /api/telegram/webhook/:telegramBotId` and the Run completes.
- Then: The Run still uses model `claude-fable-5-1`, lands in the branch's chat thread whose selected model stays `claude-fable-5-1`, and continues the branch follow-up's native CLI session. The bot's reply answers message 3508.

## integrations-telegram-post-013

- Vitest: "POST /api/telegram/webhook/:telegramBotId > forwards unrecognized Telegram DM slash inputs to the agent"
- Mode: run
- Given: A member has linked Telegram to the official bot and a main DM has been completed in its chat thread.
- When: Telegram delivers the DM `/unrecognized_command` (message 3511) to `POST /api/telegram/webhook/:telegramBotId` and the resulting Run completes.
- Then: The text launches an agent Run whose reply answers message 3511, and the input lands in the main DM chat thread.

## integrations-telegram-post-014

- Vitest: "POST /api/telegram/webhook/:telegramBotId > preserves Telegram forum delivery and ignores duplicate completion callbacks"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. The member is in forum supergroup `-77201`, topic 9201.
- When: Telegram delivers `@official_okou_bot start canonical chain` (message 2201) with a mention entity to `POST /api/telegram/webhook/:telegramBotId`; the Run completes, and then a late duplicate completion (exit code 1) is posted to `POST /api/webhooks/run/complete`.
- Then: The Run's prompt equals the message text and its appended system prompt contains the exact Telegram integration block (Bot ID 987654, `@official_okou_bot`, Chat ID -77201, `supergroup`, Message ID 2201, Message thread ID 9201). On completion exactly one Telegram message is sent to chat `-77201` in topic 9201 replying to message 2201. The duplicate completion returns HTTP 200 and sends no further message.

## integrations-telegram-post-015

- Vitest: "POST /api/telegram/webhook/:telegramBotId > does not deliver a completed Telegram reply after public unlink"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. A mention in a supergroup topic has started a Run that has been dispatched.
- When: The member unlinks with `DELETE /api/integrations/telegram/link?botId=…`, lists bots with `GET /api/integrations/telegram`, and the Run then completes through `POST /api/webhooks/run/complete`.
- Then: The unlink returns HTTP 204 and the bot is listed with `isConnected: false`. The Run reads back as `completed`, and no Telegram message is sent.

## integrations-telegram-post-016

- Vitest: "POST /api/telegram/webhook/:telegramBotId > keeps Telegram completion terminal after provider HTTP 503"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. Telegram's `sendMessage` responds with HTTP 503 to every attempt.
- When: Telegram delivers a mention in group `-77202` to `POST /api/telegram/webhook/:telegramBotId`; the Run completes, and a late duplicate completion (exit code 1) is then posted to `POST /api/webhooks/run/complete`.
- Then: Exactly one delivery is attempted, to chat `-77202` with text containing "Task completed successfully.", and the Run reads back as `completed`. The duplicate completion returns HTTP 200, triggers no further attempt, and the Run stays `completed`.

## integrations-telegram-post-017

- Vitest: "POST /api/telegram/webhook/:telegramBotId > keeps Telegram completion terminal after provider HTTP 429"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. Telegram's `sendMessage` responds with HTTP 429 to the first attempt and succeeds on the second.
- When: Telegram delivers a mention in group `-77202` to `POST /api/telegram/webhook/:telegramBotId`; the Run completes, and a late duplicate completion (exit code 1) is then posted to `POST /api/webhooks/run/complete`.
- Then: Exactly two identical delivery attempts are made, to chat `-77202` with text containing "Task completed successfully.", and the Run reads back as `completed`. The duplicate completion returns HTTP 200, triggers no further attempt, and the Run stays `completed`.

## integrations-telegram-post-018

- Vitest: "POST /api/telegram/webhook/:telegramBotId > preserves Telegram group reply chains and duplicate updates"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. A mention in forum supergroup `-77201`, topic 9201 (message 2201) has completed and the bot answered as message 700.
- When: Telegram delivers a reply (message 2202) to bot message 700 (bot shown as `provider_renamed_bot`) to `POST /api/telegram/webhook/:telegramBotId`, the Run completes, the same update is redelivered, and the user then replies to bot message 701 and to bot message 700.
- Then: The follow-up Run's prompt is the quoted reply header `[Replying to @provider_renamed_bot]`, the quoted bot text and the new text; its system prompt has Message ID 2202, Root message ID 700 and Message thread ID 9201, with thread context containing the first prompt. It lands in the first thread and continues the first CLI session; two Telegram messages are sent in total. The redelivery launches no new Run and sends no reply. A reply to the latest answer 701 lands in the first thread, while a reply to the retired answer 700 lands in a different thread.

## integrations-telegram-post-019

- Vitest: "POST /api/telegram/webhook/:telegramBotId > starts a fresh Telegram group chain after a completed reply"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. In forum supergroup `-77201`, topic 9201, a mention was answered (bot message 700) and a reply to it was answered (bot message 701) in the same thread.
- When: Telegram delivers a new mention `@official_okou_bot start another chain` (message 2203) to `POST /api/telegram/webhook/:telegramBotId`, then the user replies to bot message 701.
- Then: The new mention's Run lands in a different chat thread than the first chain. The reply to bot message 701 still lands in the first chain's thread.

## integrations-telegram-post-020

- Vitest: "POST /api/telegram/webhook/:telegramBotId > preserves a Telegram topic attachment and ignores duplicate delivery"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram with the native Fable subscription. Telegram resolves the document `topic-note.txt` and serves its text bytes.
- When: Telegram delivers the same supergroup-topic update twice to `POST /api/telegram/webhook/:telegramBotId`: a document with caption `@official_okou_bot inspect the original topic attachment` (message 9001); the Run is then completed.
- Then: Both deliveries return HTTP 200 and only one Run exists. Its prompt contains the caption, `topic-note.txt` and an `[ID]` file reference; the bytes are stored privately as `text/plain`, `GET /api/web/file-url` returns a URL with `publicUrl: null` for the member and the Run's Okou token, and the thread input has that file part. The system prompt contains the chat ID, `supergroup`, Message ID 9001 and the topic ID, and exactly one reply is sent to the chat and topic answering message 9001.

## integrations-telegram-post-021

- Vitest: "POST /api/telegram/webhook/:telegramBotId > keeps Telegram callbacks typed when OKOU_API_BACKEND_URL is set"
- Mode: run
- Given: `OKOU_API_BACKEND_URL` is set to `https://api.okou.ai`. A Runner group is available and a member has linked Telegram to the official bot.
- When: Telegram delivers the DM "hello from telegram" in chat 77001 to `POST /api/telegram/webhook/:telegramBotId` and the Run completes through `POST /api/webhooks/run/complete`.
- Then: The webhook returns HTTP 200 and exactly one Telegram message is sent to chat `77001`.

## integrations-telegram-post-022

- Vitest: "POST /api/telegram/webhook/:telegramBotId > preserves a mention-only Telegram request with the preceding group task"
- Mode: run
- Given: A Runner group is available and a member with a Fable subscription has linked Telegram. In supergroup `-10099002` the user first posted "Check https://example.com/broken-article" (message 100) without mentioning the bot.
- When: Telegram delivers a mention-only message `@official_okou_bot` (message 101, from `@alice`) to `POST /api/telegram/webhook/:telegramBotId`.
- Then: The webhook returns HTTP 200 and a running Run with a start time has prompt `@official_okou_bot`. Its chat input carries source `{type: "source", kind: "telegram", href: "https://t.me/c/99002/101"}`. The appended system prompt contains the preceding URL, the exact integration block with Chat ID -10099002, `supergroup` and Message ID 101, and `Telegram username: @alice`, and has no `Root message ID:` or `Message thread ID:` lines.

## integrations-telegram-post-023

- Vitest: "POST /api/telegram/webhook/:telegramBotId > creates an agent run for a linked official-bot private message"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot.
- When: Telegram delivers a DM "run through official bot" (chat 88002, message 51, from `@bob` named Bob with language `en`) to `POST /api/telegram/webhook/official` on `https://api.okou.ai`.
- Then: The webhook returns HTTP 200 and a Run has exactly that prompt. Its chat input source is `https://t.me/official_okou_bot`; the system prompt contains the exact integration block (Bot ID 987654, `@official_okou_bot`, Chat ID 88002, `private`, Message ID 51, Root message ID `direct-message:main`) and the sender's display name Bob, username `@bob`, Telegram user ID and language `en`. The run log reports `triggerSource: "telegram"`.

## integrations-telegram-post-024

- Vitest: "POST /api/telegram/webhook/:telegramBotId > routes an official-bot group mention with the member subscription"
- Mode: run
- Given: A Runner group is available and a member with a subscription model has linked Telegram to the official bot.
- When: Telegram delivers `@official_okou_bot help from a group` with a mention entity in group `-10099003` to `POST /api/telegram/webhook/official`.
- Then: The webhook returns HTTP 200 and a Run has exactly that prompt. Its appended system prompt contains `Bot username: @official_okou_bot`.

## integrations-telegram-post-025

- Vitest: "POST /api/telegram/webhook/:telegramBotId > publishes fresh Telegram group threads with ordered owner-scoped creation events"
- Mode: run
- Given: A member has linked Telegram and set model preference `claude-fable-5-1` with effort `high` through `PUT /api/user-model-preference`; an unrelated member exists. The clock is 2026-10-10T02:00:00.123Z.
- When: Telegram concurrently delivers two mentions (messages 4601 and 4602) in supergroup `-10099460` to `POST /api/telegram/webhook/:telegramBotId`; the member reads the thread lifecycle in full and since the first new sequence, and the first update is redelivered.
- Then: Both deliveries return HTTP 200 and the lifecycle gains two creation events for distinct threads in ascending sequence order, each with `title: null`, `selectedModel: claude-fable-5-1`, the preference's model settings, `serviceTier: null`, `computerUseHostId: null`, `cloudBrowserEnabled: true` and the clock's `createdAt`. Thread metadata matches each event, the read marker equals `createdAt`, and each message sits in exactly one thread. Reading since the first sequence returns the later events and replays to the same state; the redelivery leaves the lifecycle unchanged; the unrelated member does not see the threads and gets HTTP 404 on their metadata.

## integrations-telegram-post-026

- Vitest: "POST /api/telegram/webhook/:telegramBotId > imports Telegram photo into canonical storage before dispatch"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. Telegram resolves a photo file and serves its JPEG bytes.
- When: Telegram delivers a private photo with caption "inspect imported telegram file" (message 5511) to `POST /api/telegram/webhook/:telegramBotId`, redelivers it, then delivers a follow-up photo (message 5512) with a rotated `file_id` but the same `file_unique_id`.
- Then: The Run's prompt contains `[Web file]`, the caption and an `[ID]` file reference; the bytes are stored privately as `image/jpeg` and `GET /api/web/file-url` returns a non-public URL for the member and the Run's Okou token. The redelivery causes no additional upload. The follow-up reaches the active Run as steerable input with its caption, `[Web file]` and the same file ID; only one upload occurs and Telegram file metadata is fetched once.

## integrations-telegram-post-027

- Vitest: "POST /api/telegram/webhook/:telegramBotId > imports Telegram document into canonical storage before dispatch"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. Telegram resolves a PDF document `report.pdf` and serves its bytes.
- When: Telegram delivers a private document with caption "inspect imported telegram file" (message 5511) to `POST /api/telegram/webhook/:telegramBotId`, redelivers it, then delivers a follow-up document (message 5512) with a rotated `file_id` but the same `file_unique_id`.
- Then: The Run's prompt contains `[Web file]`, the caption and an `[ID]` file reference; the bytes are stored privately as `application/pdf` and `GET /api/web/file-url` returns a non-public URL for the member and the Run's Okou token. The redelivery causes no additional upload. The follow-up reaches the active Run as steerable input with its caption, `[Web file]` and the same file ID; only one upload occurs and Telegram file metadata is fetched once.

## integrations-telegram-post-028

- Vitest: "POST /api/telegram/webhook/:telegramBotId > applies Slack retry policy to Telegram file metadata error 403"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. Telegram's `getFile` returns error code 403 the first time and succeeds afterwards, and the file download serves PDF bytes.
- When: Telegram delivers two private messages (5801 and 5802) carrying the same `retry.pdf` document to `POST /api/telegram/webhook/:telegramBotId`.
- Then: The first message records one file part and its Run's prompt has no `[Web file]`. The second message records a second file part with the same file ID. File metadata is requested only once, nothing is uploaded, and the steerable input delivered to the Run contains no `[Web file]`.

## integrations-telegram-post-029

- Vitest: "POST /api/telegram/webhook/:telegramBotId > applies Slack retry policy to Telegram file metadata error 429"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. Telegram's `getFile` returns error code 429 the first time and succeeds afterwards, and the file download serves PDF bytes.
- When: Telegram delivers two private messages (5801 and 5802) carrying the same `retry.pdf` document to `POST /api/telegram/webhook/:telegramBotId`.
- Then: The first message records one file part and its Run's prompt has no `[Web file]`. The second message records a second file part with the same file ID. File metadata is requested twice and one upload occurs; the steerable input delivered to the Run contains `[ID] <fileId>` and the file is previewable as `application/pdf` through `GET /api/web/file-url`.

## integrations-telegram-post-030

- Vitest: "POST /api/telegram/webhook/:telegramBotId > retains Telegram file references after an import fails on declared size"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. The document `large.pdf` declares `file_size` of 20 MiB + 1 byte.
- When: Telegram delivers a private message with the document and caption "inspect this large report" to `POST /api/telegram/webhook/:telegramBotId`.
- Then: The webhook returns HTTP 200 and the Run's prompt contains `[Telegram file]` and `[FILE_ID] oversized-file` but no `[Web file]`. Nothing is uploaded, the thread records one file part with a UUID file ID and filename `large.pdf`, and Telegram file metadata is never requested.

## integrations-telegram-post-031

- Vitest: "POST /api/telegram/webhook/:telegramBotId > retains Telegram file references after an import fails on streamed size"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. The document `large.pdf` declares no size, but the Telegram download streams 20 MiB + 1 byte.
- When: Telegram delivers a private message with the document and caption "inspect this large report" to `POST /api/telegram/webhook/:telegramBotId`.
- Then: The webhook returns HTTP 200 and the Run's prompt contains `[Telegram file]` and `[FILE_ID] oversized-file` but no `[Web file]`. Nothing is uploaded and the thread records one file part with a UUID file ID and filename `large.pdf`.

## integrations-telegram-post-032

- Vitest: "POST /api/telegram/webhook/:telegramBotId > retains Telegram file references after an import fails on upstream error"
- Mode: run
- Given: A Runner group is available and a member has linked Telegram to the official bot. The Telegram file download for `large.pdf` responds with HTTP 403.
- When: Telegram delivers a private message with the document and caption "inspect this large report" to `POST /api/telegram/webhook/:telegramBotId`.
- Then: The webhook returns HTTP 200 and the Run's prompt contains `[Telegram file]` and `[FILE_ID] oversized-file` but no `[Web file]`. Nothing is uploaded and the thread records one file part with a UUID file ID and filename `large.pdf`.

## integrations-telegram-post-033

- Vitest: "POST /api/telegram/webhook/:telegramBotId > does not prompt unlinked official group replies to another bot but prompts replies to the official bot"
- Mode: run
- Given: The official Telegram bot is configured. An unlinked Telegram user is in group `-10099121`.
- When: Telegram delivers the user's reply to a message from another bot to `POST /api/telegram/webhook/:telegramBotId`, then (with app URL `https://app.okou.ai`) a reply (message 1212) to a message from the official bot (ID 987654, shown as `provider_renamed_bot`).
- Then: Both deliveries return HTTP 200. The reply to the other bot sends no message. The reply to the official bot sends one message containing "connect your account" and "Okou", replying to message 1212, with a button to `https://t.me/official_okou_bot?start=connect`.
