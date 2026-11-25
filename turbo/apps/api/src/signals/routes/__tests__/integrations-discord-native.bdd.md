# integrations-discord-native

## integrations-discord-native-001

- Vitest: "Discord native authorization and reads > reads a post in a type 15 forum or media channel by its thread ID"
- Mode: run
- Given: A workspace admin with a CLI token has installed the bot in a Discord guild linked to their Discord account; the bot has the message-content grant and both principals can view and read history. The parent channel is a type 15 (forum) channel containing a public thread post with "thread message".
- When: The caller requests `GET /api/integrations/discord/messages` with the thread ID, then with the forum channel ID.
- Then: The thread read returns HTTP 200 and its first message content is "thread message". Reading the forum channel itself returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-002

- Vitest: "Discord native authorization and reads > reads a post in a type 16 forum or media channel by its thread ID"
- Mode: run
- Given: A workspace admin with a CLI token has installed the bot in a Discord guild linked to their Discord account; the bot has the message-content grant and both principals can view and read history. The parent channel is a type 16 (media) channel containing a public thread post with "thread message".
- When: The caller requests `GET /api/integrations/discord/messages` with the thread ID, then with the media channel ID.
- Then: The thread read returns HTTP 200 and its first message content is "thread message". Reading the media channel itself returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-003

- Vitest: "Discord native authorization and reads > returns attachment metadata without the signed CDN URL"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild linked to their account. The readable channel's only message has a `report.pdf` attachment (1234 bytes, `application/pdf`) whose Discord URL and proxy URL are signed CDN URLs.
- When: The caller requests `GET /api/integrations/discord/messages` for the channel.
- Then: The response is HTTP 200 and the message's attachments are exactly `[{ id, filename: "report.pdf", size: 1234, contentType: "application/pdf" }]`. The response body does not contain the signature `hm=0123abcd`.

## integrations-discord-native-004

- Vitest: "Discord native authorization and reads > returns exact snowflake pagination and source links"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild. The readable channel contains messages with IDs 18446744073709551614, 18446744073709551613 and 18446744073709551612.
- When: The caller requests `GET /api/integrations/discord/messages` with `limit=2`, then again with `before` set to the returned `nextBefore`.
- Then: The first page is HTTP 200 with IDs 18446744073709551614 and 18446744073709551613, `nextBefore` "18446744073709551613", and the first message URL `https://discord.com/channels/<guild>/<channel>/18446744073709551614`. The second page contains only 18446744073709551612 and `nextBefore` is null.

## integrations-discord-native-005

- Vitest: "Discord native authorization and reads > marks ordinary guild content as limited"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, but Discord reports the application without the message-content intent flag.
- When: The caller requests `GET /api/integrations/discord/messages` for a readable guild channel.
- Then: The response is HTTP 200 with `contextMode` "mentions_only".

## integrations-discord-native-006

- Vitest: "Discord native authorization and reads > rechecks provider grants instead of retaining a prior content capability"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild whose application initially has the message-content intent flag.
- When: The caller reads `GET /api/integrations/discord/messages`, Discord then reports the application with no flags, and the caller reads again.
- Then: The first read is HTTP 200 with `contextMode` "full"; the second read is HTTP 200 with `contextMode` "mentions_only".

## integrations-discord-native-007

- Vitest: "Discord native authorization and reads > fails guild history closed on application discovery failure 401 without blocking sends"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord's application discovery (`/applications/@me`) responds with HTTP 401.
- When: The caller requests `GET /api/integrations/discord/messages`, then sends `POST /api/integrations/discord/message` to the same channel.
- Then: The history read returns HTTP 502 with error code `DISCORD_ERROR`. The send still returns HTTP 200.

## integrations-discord-native-008

- Vitest: "Discord native authorization and reads > fails guild history closed on application discovery failure 500 without blocking sends"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord's application discovery (`/applications/@me`) responds with HTTP 500.
- When: The caller requests `GET /api/integrations/discord/messages`, then sends `POST /api/integrations/discord/message` to the same channel.
- Then: The history read returns HTTP 502 with error code `DISCORD_ERROR`. The send still returns HTTP 200.

## integrations-discord-native-009

- Vitest: "Discord native authorization and reads > fails guild history closed on application discovery failure invalid without blocking sends"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord's application discovery returns an invalid body containing the bot ID but no `flags`.
- When: The caller requests `GET /api/integrations/discord/messages`, then sends `POST /api/integrations/discord/message` to the same channel.
- Then: The history read returns HTTP 502 with error code `DISCORD_ERROR`. The send still returns HTTP 200.

## integrations-discord-native-010

- Vitest: "Discord native authorization and reads > fails guild history closed on application discovery failure mismatch without blocking sends"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord's application discovery returns a different application ID (with the message-content flag) than the configured bot.
- When: The caller requests `GET /api/integrations/discord/messages`, then sends `POST /api/integrations/discord/message` to the same channel.
- Then: The history read returns HTTP 502 with error code `DISCORD_ERROR`. The send still returns HTTP 200.

## integrations-discord-native-011

- Vitest: "Discord native authorization and reads > preserves application-discovery rate limits for history callers"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord's application discovery responds with HTTP 429 and `retry_after: 2`.
- When: The caller requests `GET /api/integrations/discord/messages`.
- Then: The response is HTTP 429 with error code `DISCORD_RATE_LIMITED` and `retryAfterSeconds` 2.

## integrations-discord-native-012

- Vitest: "Discord native authorization and reads > denies bot DM content to every organization's run token while keeping DM sends"
- Mode: run
- Given: A user's Discord account is linked through guild installs in two organizations, and each organization has a run token. The bot has a single DM channel with that user, and the other organization's run has already replied "Other organization: 42 open deals" into it.
- When: Each organization's run token requests `GET /api/integrations/discord/messages` and `GET /api/integrations/discord/replies` for the DM, then the first organization sends `POST /api/integrations/discord/message` to the DM.
- Then: The other organization's send returns HTTP 200. Every history and replies read with either token returns HTTP 403 with error code `DISCORD_DM_READ_DENIED`, and none of those bodies contain "42 open deals". The first organization's DM send returns HTTP 200, and the DM then contains the other organization's reply followed by "this organization can still reply".

## integrations-discord-native-013

- Vitest: "Discord native authorization and reads > opens an outbound DM for me without enabling private reads"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord opens a DM channel with the caller's own Discord user.
- When: The caller sends `POST /api/integrations/discord/message` with `userId: "me"` and text, then requests `GET /api/integrations/discord/messages` for the opened DM channel.
- Then: Discord's open-DM request body is exactly `{ recipient_id: <caller's Discord user ID> }`. The send returns HTTP 200 with the first receipt's `channelId` set to the DM channel. The DM history read returns HTTP 403.

## integrations-discord-native-014

- Vitest: "Discord native authorization and reads > opens an outbound DM for other without enabling private reads"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord opens a DM channel with another Discord user.
- When: The caller sends `POST /api/integrations/discord/message` with that user's ID as `userId` and text, then requests `GET /api/integrations/discord/messages` for the opened DM channel.
- Then: Discord's open-DM request body is exactly `{ recipient_id: <other user ID> }`. The send returns HTTP 200 with the first receipt's `channelId` set to the DM channel. The DM history read returns HTTP 404.

## integrations-discord-native-015

- Vitest: "Discord native authorization and reads > does not send when opening a DM returns forbidden"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord rejects opening a DM with HTTP 403 (code 50007).
- When: The caller sends `POST /api/integrations/discord/message` with a Discord `userId` and text "must not send".
- Then: The response is HTTP 404 and no message is posted to Discord.

## integrations-discord-native-016

- Vitest: "Discord native authorization and reads > does not send when opening a DM returns wrong-recipient"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and opening a DM returns a DM channel whose recipient is a different user than requested.
- When: The caller sends `POST /api/integrations/discord/message` with a Discord `userId` and text "must not send".
- Then: The response is HTTP 404 and no message is posted to Discord.

## integrations-discord-native-017

- Vitest: "Discord native authorization and reads > denies unknown-guild without exposing message contents"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, but the target channel belongs to a guild that is unknown to Discord (guild, roles and member lookups all return 404).
- When: The caller requests `GET /api/integrations/discord/messages` for the channel and then sends `POST /api/integrations/discord/message` to it.
- Then: The read returns HTTP 404 with error code `NOT_FOUND` and no `messages` property. The send returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-018

- Vitest: "Discord native authorization and reads > denies other-user-dm without exposing message contents"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and the target channel is a DM between the bot and a different Discord user.
- When: The caller requests `GET /api/integrations/discord/messages` for the channel and then sends `POST /api/integrations/discord/message` to it.
- Then: The read returns HTTP 404 with error code `NOT_FOUND` and no `messages` property. The send returns HTTP 200.

## integrations-discord-native-019

- Vitest: "Discord native authorization and reads > denies group-dm without exposing message contents"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and the target channel is a group DM (type 3) that includes the caller's Discord user.
- When: The caller requests `GET /api/integrations/discord/messages` for the channel and then sends `POST /api/integrations/discord/message` to it.
- Then: The read returns HTTP 404 with error code `NOT_FOUND` and no `messages` property. The send returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-020

- Vitest: "Discord native authorization and reads > denies missing-user without exposing message contents"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, but Discord reports the caller's linked Discord user is no longer a guild member.
- When: The caller requests `GET /api/integrations/discord/messages` for the channel and then sends `POST /api/integrations/discord/message` to it.
- Then: The read returns HTTP 404 with error code `NOT_FOUND` and no `messages` property. The send returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-021

- Vitest: "Discord native authorization and reads > denies missing-bot without exposing message contents"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, but Discord reports the bot is no longer a guild member.
- When: The caller requests `GET /api/integrations/discord/messages` for the channel and then sends `POST /api/integrations/discord/message` to it.
- Then: The read returns HTTP 404 with error code `NOT_FOUND` and no `messages` property. The send returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-022

- Vitest: "Discord native authorization and reads > denies an explicit different guild selector and another organization token"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a readable channel. A second, unrelated organization has its own installed guild and CLI token.
- When: The caller requests `GET /api/integrations/discord/messages` for the channel with a different `guildId`; then the other organization's token requests the channel with the correct `guildId`.
- Then: Both reads return HTTP 404, and the other organization's response has error code `NOT_FOUND`.

## integrations-discord-native-023

- Vitest: "Discord native authorization and reads > applies everyone, aggregated role, and member overwrite precedence"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild. The channel denies VIEW_CHANNEL to @everyone and to the caller's first role, but allows it to the caller's second role and to the bot's role.
- When: The caller reads `GET /api/integrations/discord/messages`; a member overwrite denying VIEW_CHANNEL to the caller is added and the caller reads again; the member overwrite is changed to allow VIEW_CHANNEL and the caller reads a third time.
- Then: The first read returns HTTP 200 with one message, the second returns HTTP 404, and the third returns HTTP 200 with one message.

## integrations-discord-native-024

- Vitest: "Discord native authorization and reads > lists only mutually visible readable channels and requires history permission to read"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a readable text channel, a text channel hidden from the bot by a member overwrite, an announcement channel (type 5), a forum (type 15) and a media channel (type 16).
- When: The caller requests `GET /api/integrations/discord/channels`, reads history for the announcement, forum and media channels, and then reads the text channel after a member overwrite denies READ_MESSAGE_HISTORY to the caller.
- Then: The listing returns HTTP 200 with exactly the text channel and the announcement channel, in that order. The announcement read returns HTTP 200; the forum and media reads return HTTP 404 with `NOT_FOUND`. The text-channel read without history permission returns HTTP 404.

## integrations-discord-native-025

- Vitest: "Discord native authorization and reads > requires private thread membership for the user"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a private thread of which the caller's Discord user is not a member (the bot is).
- When: The caller requests `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: Both requests return HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-026

- Vitest: "Discord native authorization and reads > requires private thread membership for the bot"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a private thread of which the bot is not a member (the caller's Discord user is).
- When: The caller requests `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: Both requests return HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-027

- Vitest: "Discord native authorization and reads > conceals archived thread state until both principals have access"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with an archived public thread.
- When: The caller sends `POST /api/integrations/discord/message` to an unknown channel ID; then sends to the thread while the parent denies VIEW_CHANNEL to the caller and then to the bot; then, with the thread made private and archived, sends while each principal in turn is removed from the thread members.
- Then: The unknown-channel send returns HTTP 404, and every thread send returns HTTP 404 with a body identical to the unknown-channel response.

## integrations-discord-native-028

- Vitest: "Discord native authorization and reads > conceals locked thread state until both principals have access"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a locked public thread.
- When: The caller sends `POST /api/integrations/discord/message` to an unknown channel ID; then sends to the thread while the parent denies VIEW_CHANNEL to the caller and then to the bot; then, with the thread made private and locked, sends while each principal in turn is removed from the thread members.
- Then: The unknown-channel send returns HTTP 404, and every thread send returns HTTP 404 with a body identical to the unknown-channel response.

## integrations-discord-native-029

- Vitest: "Discord native authorization and reads > reads a private thread with both memberships and inherits parent overwrites"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a private thread whose members include both the caller's Discord user and the bot.
- When: The caller requests `GET /api/integrations/discord/messages` for the thread, then again after the parent channel adds a member overwrite denying VIEW_CHANNEL to the caller.
- Then: The first read returns HTTP 200 with first message "thread message". The second read returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-030

- Vitest: "Discord native authorization and reads > reads native thread replies and refuses to treat an ordinary reply as a thread"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild. A parent channel message has a native public thread containing "thread message".
- When: The caller requests `GET /api/integrations/discord/replies` for the parent message; the parent is then replaced by an ordinary message that only references another message, and the caller requests replies again.
- Then: The first response is HTTP 200 with `threadId` equal to the thread and first message "thread message". The second request returns HTTP 404.

## integrations-discord-native-031

- Vitest: "Discord native authorization and reads > requires native read and write capabilities for sandbox requests"
- Mode: run
- Given: A run's sandbox token (without Discord native capabilities) is used for an installed Discord guild.
- When: The caller requests `GET /api/integrations/discord/messages` and `POST /api/integrations/discord/message`.
- Then: The read returns HTTP 403 with an error message mentioning `discord:read`, and the send returns HTTP 403 with an error message mentioning `discord:write`.

## integrations-discord-native-032

- Vitest: "Discord native authorization and reads > revokes native access after disconnect without reusing a previously verified binding"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild and can read a channel.
- When: The caller reads `GET /api/integrations/discord/messages`, the admin disconnects with `DELETE /api/integrations/discord` using a signed-in session, and the CLI token then reads and sends again.
- Then: The first read returns HTTP 200 and the disconnect returns HTTP 200. Afterwards the read returns HTTP 404 and the send returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-033

- Vitest: "Discord native sends and transport failures > normalizes 1988 closing-fence spaces while preserving code within every message limit"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a writable channel.
- When: The caller sends `POST /api/integrations/discord/message` with a `typescript` fenced code block of 1990 "x" characters whose closing fence is followed by 1988 spaces and a newline, then reads the channel history.
- Then: The send returns HTTP 200 with more than one message receipt. Every delivered chunk is at most 2000 characters and not blank, and the chunks joined with fences and newlines removed equal the original 1990 "x" characters.

## integrations-discord-native-034

- Vitest: "Discord native sends and transport failures > normalizes 2005 closing-fence spaces while preserving code within every message limit"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a writable channel.
- When: The caller sends `POST /api/integrations/discord/message` with a `typescript` fenced code block of 1990 "x" characters whose closing fence is followed by 2005 spaces and a newline, then reads the channel history.
- Then: The send returns HTTP 200 with more than one message receipt. Every delivered chunk is at most 2000 characters and not blank, and the chunks joined with fences and newlines removed equal the original 1990 "x" characters.

## integrations-discord-native-035

- Vitest: "Discord native sends and transport failures > preserves a long fenced answer and suppresses all mention notifications"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a writable channel.
- When: The caller sends `POST /api/integrations/discord/message` with a 400-line `ts` fenced block followed by "@everyone" and a user mention, then reads the channel history.
- Then: The send returns HTTP 200 with more than one receipt. Every chunk is at most 2000 characters, the chunks without fence markers reproduce the source text, every Discord post has `allowed_mentions` with an empty `parse` list and `replied_user: false`, and every receipt URL ends with its message ID.

## integrations-discord-native-036

- Vitest: "Discord native sends and transport failures > sends into an archived unlocked thread, which Discord reopens (private: false)"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with an archived, unlocked public thread.
- When: The caller reads `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: The read and the send return HTTP 200, and exactly one message is posted to Discord.

## integrations-discord-native-037

- Vitest: "Discord native sends and transport failures > sends into an archived unlocked thread, which Discord reopens (private: true)"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with an archived, unlocked private thread whose members include both principals.
- When: The caller reads `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: The read and the send return HTTP 200, and exactly one message is posted to Discord.

## integrations-discord-native-038

- Vitest: "Discord native sends and transport failures > reads a locked thread and sends only when MANAGE_THREADS is held by neither principal"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a locked, archived public thread; neither the caller nor the bot holds MANAGE_THREADS.
- When: The caller reads `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: The read returns HTTP 200. The send returns HTTP 403 with error code `DISCORD_THREAD_CLOSED`, and no message is posted to Discord.

## integrations-discord-native-039

- Vitest: "Discord native sends and transport failures > reads a locked thread and sends only when MANAGE_THREADS is held by only the bot"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a locked, archived public thread; only the bot's role holds MANAGE_THREADS.
- When: The caller reads `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: The read returns HTTP 200. The send returns HTTP 403 with error code `DISCORD_THREAD_CLOSED`, and no message is posted to Discord.

## integrations-discord-native-040

- Vitest: "Discord native sends and transport failures > reads a locked thread and sends only when MANAGE_THREADS is held by only the sender"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a locked, archived public thread; only the caller's role holds MANAGE_THREADS.
- When: The caller reads `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: The read returns HTTP 200. The send returns HTTP 403 with error code `DISCORD_THREAD_CLOSED`, and no message is posted to Discord.

## integrations-discord-native-041

- Vitest: "Discord native sends and transport failures > reads a locked thread and sends only when MANAGE_THREADS is held by a sender whose member overwrite denies …"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a locked, archived public thread; both roles hold MANAGE_THREADS but a member overwrite on the parent denies it to the caller.
- When: The caller reads `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: The read returns HTTP 200. The send returns HTTP 403 with error code `DISCORD_THREAD_CLOSED`, and no message is posted to Discord.

## integrations-discord-native-042

- Vitest: "Discord native sends and transport failures > reads a locked thread and sends only when MANAGE_THREADS is held by both principals"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a locked, archived public thread; both the caller's role and the bot's role hold MANAGE_THREADS.
- When: The caller reads `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: The read and the send return HTTP 200, and exactly one message is posted to Discord.

## integrations-discord-native-043

- Vitest: "Discord native sends and transport failures > reads a locked thread and sends only when MANAGE_THREADS is held by only the bot in a private thread"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a locked, archived private thread; only the bot's role holds MANAGE_THREADS.
- When: The caller reads `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: The read returns HTTP 200. The send returns HTTP 403 with error code `DISCORD_THREAD_CLOSED`, and no message is posted to Discord.

## integrations-discord-native-044

- Vitest: "Discord native sends and transport failures > reads a locked thread and sends only when MANAGE_THREADS is held by both principals in a private thread"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a locked, archived private thread; both the caller's role and the bot's role hold MANAGE_THREADS.
- When: The caller reads `GET /api/integrations/discord/messages` for the thread and sends `POST /api/integrations/discord/message` to it.
- Then: The read and the send return HTTP 200, and exactly one message is posted to Discord.

## integrations-discord-native-045

- Vitest: "Discord native sends and transport failures > denies writes for a timed-out user while retaining readable history"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord reports the caller's linked Discord member as timed out until 2099.
- When: The caller reads `GET /api/integrations/discord/messages` and sends `POST /api/integrations/discord/message` to the channel.
- Then: The read returns HTTP 200 and the send returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-046

- Vitest: "Discord native sends and transport failures > denies writes for a timed-out bot while retaining readable history"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord reports the bot member as timed out until 2099.
- When: The caller reads `GET /api/integrations/discord/messages` and sends `POST /api/integrations/discord/message` to the channel.
- Then: The read returns HTTP 200 and the send returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-047

- Vitest: "Discord native sends and transport failures > keeps native history and existing-thread sends available without public-thread creation permission"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a public thread, and the parent channel denies CREATE_PUBLIC_THREADS to @everyone.
- When: The caller reads history for the parent and the thread via `GET /api/integrations/discord/messages`, then sends `POST /api/integrations/discord/message` to the parent and to the thread.
- Then: Both reads return HTTP 200. Both sends return HTTP 200, with receipts in the parent channel and the thread respectively.

## integrations-discord-native-048

- Vitest: "Discord native sends and transport failures > requires SEND_MESSAGES_IN_THREADS rather than parent SEND_MESSAGES"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild with a public thread.
- When: The caller sends `POST /api/integrations/discord/message` to the thread while the parent denies SEND_MESSAGES to the caller, then again while it denies SEND_MESSAGES_IN_THREADS instead.
- Then: The first send returns HTTP 200; the second returns HTTP 404 with error code `NOT_FOUND`.

## integrations-discord-native-049

- Vitest: "Discord native sends and transport failures > retries only an explicit short 429 and returns a complete message receipt"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord answers the first channel post with HTTP 429 `retry_after: 0` (global).
- When: The caller sends `POST /api/integrations/discord/message`, then reads the channel history.
- Then: The send returns HTTP 200 with exactly one message receipt, and the history contains exactly one bot-authored message.

## integrations-discord-native-050

- Vitest: "Discord native sends and transport failures > rechecks binding access after a rate limit before resending"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild. On the first channel post, the admin disconnects the Discord integration and Discord responds with HTTP 429 `retry_after: 0`.
- When: The caller sends `POST /api/integrations/discord/message`.
- Then: The response is HTTP 403 or 404 with `deliveredMessages` equal to an empty list, and no message is posted to Discord.

## integrations-discord-native-051

- Vitest: "Discord native sends and transport failures > rechecks channel access after a rate limit before resending"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild. On the first channel post, a member overwrite denying SEND_MESSAGES to the caller is added and Discord responds with HTTP 429 `retry_after: 0`.
- When: The caller sends `POST /api/integrations/discord/message`.
- Then: The response is HTTP 403 or 404 with `deliveredMessages` equal to an empty list, and no message is posted to Discord.

## integrations-discord-native-052

- Vitest: "Discord native sends and transport failures > surfaces read rate limits without replaying an authorized content request"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord answers the first channel-history fetch with HTTP 429 `retry_after: 0`.
- When: The caller requests `GET /api/integrations/discord/messages` twice.
- Then: The first read returns HTTP 429 with `retryAfterSeconds` 0; the second returns HTTP 200.

## integrations-discord-native-053

- Vitest: "Discord native sends and transport failures > reports a provider rate-limit delay and preserves already-delivered chunks"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild. Discord accepts the first channel post and responds to later posts with HTTP 429 `retry_after: 60`.
- When: The caller sends `POST /api/integrations/discord/message` with 4001 characters of text.
- Then: The response is HTTP 429 with `retryAfterSeconds` 60, an error message containing "60 seconds", and `deliveredMessages` containing exactly the first delivered message ID.

## integrations-discord-native-054

- Vitest: "Discord native sends and transport failures > surfaces a provider server failure without resending an uncertain write"
- Mode: run
- Given: A workspace admin with a CLI token uses an installed Discord guild, and Discord answers the first channel post with HTTP 500.
- When: The caller sends `POST /api/integrations/discord/message`, then reads the channel history.
- Then: The send returns HTTP 502, and the history contains no bot-authored messages.
