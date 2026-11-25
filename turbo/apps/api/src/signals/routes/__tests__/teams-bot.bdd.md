# teams-bot

## teams-bot-001

- Vitest: "POST /api/webhooks/teams/bot > delivers a historical downloadInfo attachment through its dispatched Run"
- Mode: run
- Given: Row `downloadInfo`. A Teams-connected workspace admin with a Pro entitlement and an installed Teams bot sends a mention in a thread whose earlier reply carries a `historical note.txt` file attachment exposed as a Teams download-info attachment (SharePoint download URL). Microsoft Graph returns the thread root and replies, and the Teams user is a member of the conversation.
- When: The bot receives the mentioned message on `POST /api/webhooks/teams/bot`, the dispatched Run is picked up by a Runner, and the Run's Okou token calls `GET /api/integrations/teams/download-file?file_id=<history ID>`; it then requests an unknown file ID, and requests the real file again after Teams stops reporting the user as a conversation member.
- Then: Exactly one Run matching the prompt is listed, and its Teams thread context lists `[Teams file] historical note.txt (text/plain)` with the Teams attachment ID. The download returns HTTP 302 to the provider URL with `Cache-Control: private, no-store` and `X-File-Mimetype`/`X-File-Name` headers. The unknown ID returns HTTP 404 `NOT_FOUND` "Microsoft Teams file is unavailable to this run", and the real file returns HTTP 404 once membership is gone.

## teams-bot-002

- Vitest: "POST /api/webhooks/teams/bot > delivers a historical graph attachment through its dispatched Run"
- Mode: run
- Given: Row `graph`. A Teams-connected workspace admin with a Pro entitlement and an installed Teams bot sends a mention in a thread whose earlier reply carries a `historical note.txt` reference attachment to a SharePoint URL, resolvable through the Graph shares API. Microsoft Graph returns the thread root and replies.
- When: The bot receives the mentioned message on `POST /api/webhooks/teams/bot`, the dispatched Run is picked up by a Runner, and the Run's Okou token calls `GET /api/integrations/teams/download-file?file_id=<history ID>`.
- Then: Exactly one Run matching the prompt is listed, and its Teams thread context lists `[Teams file] historical note.txt (text/plain)` with the Teams attachment ID. The download returns HTTP 302 to the file URL with `Cache-Control: private, no-store`, `X-File-Mimetype: text/plain` and the encoded file name.

## teams-bot-003

- Vitest: "POST /api/webhooks/teams/bot > delivers a historical bot attachment through its dispatched Run"
- Mode: run
- Given: Row `bot`. A Teams-connected workspace admin with a Pro entitlement and an installed Teams bot sends a mention in a thread whose earlier reply carries a `text/plain` attachment hosted on the Bot Framework attachments URL, which requires the bot access token.
- When: The bot receives the mentioned message on `POST /api/webhooks/teams/bot`, the dispatched Run is picked up by a Runner, and the Run's Okou token calls `GET /api/integrations/teams/download-file?file_id=<history ID>`.
- Then: Exactly one Run matching the prompt is listed, and its Teams thread context lists the file and its Teams attachment ID. The download returns HTTP 200 with the file bytes, `X-File-Mimetype: text/plain` and the encoded file name.

## teams-bot-004

- Vitest: "POST /api/webhooks/teams/bot > rejects missing Teams authorization"
- Mode: run
- Given: A Teams channel message activity for an installed tenant, with no Authorization header.
- When: The activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The API responds with HTTP 401 `UNAUTHORIZED` "Missing Teams bot bearer token".

## teams-bot-005

- Vitest: "POST /api/webhooks/teams/bot > verifies the bot token on the final Microsoft console path"
- Mode: run
- Given: The Bot Framework publishes valid OpenID metadata and signing keys, and the request carries a correctly signed Teams bot token for the configured bot app.
- When: A `typing` activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The API responds with HTTP 200.

## teams-bot-006

- Vitest: "POST /api/webhooks/teams/bot > rejects a Teams token for another bot app"
- Mode: run
- Given: The Bot Framework publishes valid signing keys, and the request carries a validly signed Teams token whose audience is a different bot app ID.
- When: A message activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The API responds with HTTP 401 `UNAUTHORIZED` "Invalid Teams bot token audience".

## teams-bot-007

- Vitest: "POST /api/webhooks/teams/bot > normalizes a valid Teams message activity"
- Mode: run
- Given: An installed Teams tenant whose sender is not yet connected to Okou sends a channel message `<at>Nova</at> deploy the preview` mentioning the bot, with a valid bot token.
- When: The activity is posted to `POST /api/webhooks/teams/bot`; afterwards the member connects the Teams account and an admin reads `GET /api/integrations/teams/connect`.
- Then: The API returns HTTP 200 with `ok: true`, a normalized message activity (tenant, team, channel, thread, sender, recipient `Nova`, raw and stripped text, `mentionsRecipient: true`, idempotency key `<conversation>:message:<activity>`) and a `connectUrl` to `/settings/teams` carrying tenant, user, activity, team, conversation type and bot name parameters. Exactly one Teams reply is sent to the activity with an adaptive card "Please connect your account…" and a `Connect` OpenUrl action and no `text`. After connecting, the status shows installed and connected for the tenant.

## teams-bot-008

- Vitest: "POST /api/webhooks/teams/bot > uses the configured app for connect links and the Teams recipient for bot identity"
- Mode: run
- Given: The app URL is configured as `https://app.okou.ai`, and an unconnected Teams user sends `help` to a bot whose Teams recipient name is `Tenant Helper`.
- When: The activity is posted to `https://api.okou.ai/api/webhooks/teams/bot` (`POST /api/webhooks/teams/bot`) with a valid bot token.
- Then: The `connectUrl` uses the `https://app.okou.ai` origin and `botName=Tenant Helper`. One help reply is sent containing "Tenant Helper Teams Bot Help", "Connect to Okou" and `@Tenant Helper`.

## teams-bot-009

- Vitest: "POST /api/webhooks/teams/bot > reuses and refreshes Teams auth metadata within explicit app lifecycles"
- Mode: run
- Given: A valid Teams bot token and Bot Framework metadata and key endpoints; one app instance receives several activities, the clock then advances just over 24 hours, and a second app instance is started.
- When: Messages are posted to `POST /api/webhooks/teams/bot` twice on the first app, once more on the first app after the clock advance, and once on the new app.
- Then: Every request returns HTTP 200. The first two requests fetch metadata and keys once in total, the post-expiry request fetches them again, and the new app instance fetches them a third time (six fetches in `metadata`, `jwks` pairs).

## teams-bot-010

- Vitest: "POST /api/webhooks/teams/bot > ignores Teams channel messages that do not mention the bot"
- Mode: run
- Given: An installed Teams tenant and a valid bot token; a channel message `hello channel` does not mention the bot.
- When: The activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The API returns HTTP 200 with a normalized message activity whose text is `hello channel` and `mentionsRecipient` is false.

## teams-bot-011

- Vitest: "POST /api/webhooks/teams/bot > sends one team welcome across installation and members-added events"
- Mode: run
- Given: An installed Teams tenant and a valid bot token; Teams sends both an installation-added event and a members-added event for the bot in the same team conversation, initiated by Ada Lovelace.
- When: Both activities are posted to `POST /api/webhooks/teams/bot`.
- Then: Both requests return HTTP 200, and exactly one welcome message is posted to the conversation (not as a reply) in markdown, containing "<at>Ada Lovelace</at> added Nova to this Teams workspace." with a mention entity for the installing user and the tenant in channel data.

## teams-bot-012

- Vitest: "POST /api/webhooks/teams/bot > sends a personal welcome message when Teams adds the bot in personal scope"
- Mode: run
- Given: A valid bot token; Teams adds the bot in personal scope in the conversation `a:personal-<user>`.
- When: The installation activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The request returns HTTP 200, and exactly one new markdown message containing the full Nova welcome text is posted to the personal conversation, with no mention entities and no `replyToId`.

## teams-bot-013

- Vitest: "POST /api/webhooks/teams/bot > responds to Teams validation help and greeting messages without a mention"
- Mode: run
- Given: An unconnected Teams user and a valid bot token; channel messages `help`, `/help`, a group-chat `help`, and a channel `Hi` are sent without mentioning the bot.
- When: The four activities are posted to `POST /api/webhooks/teams/bot` in order.
- Then: Four replies are sent, one to each activity in order. The `help` and group-chat `help` replies contain "Nova Teams Bot Help", and the `Hi` reply is a connect card whose `Connect` action URL equals the `connectUrl` returned by that request.

## teams-bot-014

- Vitest: "POST /api/webhooks/teams/bot > offers a direct connection link for unconnected Teams greetings with a mention"
- Mode: run
- Given: An unconnected Teams user and a valid bot token; a channel message `<at>Nova</at> Hi` mentions the bot.
- When: The activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The response normalizes the text to `Hi` with `mentionsRecipient: true` and includes a `connectUrl`. Exactly one reply to the activity is sent as an adaptive connect card whose `Connect` action URL equals that `connectUrl`.

## teams-bot-015

- Vitest: "POST /api/webhooks/teams/bot > does not run other Teams commands without a mention in channel scope"
- Mode: run
- Given: An installed Teams tenant and a valid bot token; a channel message `disconnect` does not mention the bot.
- When: The activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The API returns HTTP 200 with the normalized text `disconnect` and `mentionsRecipient: false`, and no Teams message is sent.

## teams-bot-016

- Vitest: "POST /api/webhooks/teams/bot > offers a direct connection link for an unconnected Teams DM: hello from dm"
- Mode: run
- Given: Row `hello from dm`. An unconnected Teams user sends the personal message `hello from dm` in `a:personal-<user>` with a valid bot token and no mention.
- When: The activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The response returns HTTP 200 with a personal message activity whose thread ID is the activity ID, text `hello from dm` and `mentionsRecipient: false`. Exactly one reply is sent as an adaptive connect card linking to `/settings/teams`, with no `text`.

## teams-bot-017

- Vitest: "POST /api/webhooks/teams/bot > offers a direct connection link for an unconnected Teams DM: Hi"
- Mode: run
- Given: Row `Hi`. An unconnected Teams user sends the personal message `Hi` in `a:personal-<user>` with a valid bot token and no mention.
- When: The activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The response returns HTTP 200 with a personal message activity whose thread ID is the activity ID, text `Hi` and `mentionsRecipient: false`. Exactly one reply is sent as an adaptive connect card linking to `/settings/teams`, with no `text`.

## teams-bot-018

- Vitest: "POST /api/webhooks/teams/bot > asks for a message when a personal Teams message is blank"
- Mode: run
- Given: A valid bot token; a Teams user sends a personal message containing only whitespace.
- When: The activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The API returns HTTP 200 with a personal message activity whose text is empty and with no attachments. One reply to the activity says "Please include a message for Nova."

## teams-bot-019

- Vitest: "POST /api/webhooks/teams/bot > downloads Teams channel reference attachments through Graph"
- Mode: run
- Given: A Teams-connected workspace admin with a Pro entitlement and an installed Teams bot. The user posts a channel message `please inspect this` with a `reference` attachment `spec.png` pointing to a SharePoint URL; the Graph shares API redirects to a downloadable PNG.
- When: The activity is posted to `POST /api/webhooks/teams/bot`, a Runner picks up the Run, and the member reads the chat thread events.
- Then: The webhook returns HTTP 200 and one active Run prompt contains the text and `[Web file] spec.png (image/png)`. The execution prompt carries a UUID file ID (not the SharePoint URL) and the system prompt mentions `okou teams download-file -h`. The thread's user message has a `file` part (`spec.png`, `image/png`), the text `@Nova please inspect this`, and a Teams `source` link to the channel message, and the file preview serves the downloaded bytes.

## teams-bot-020

- Vitest: "POST /api/webhooks/teams/bot > provides a source link for a Teams personal message"
- Mode: run
- Given: Row `personal`. A Teams-connected member with a Pro entitlement sends a message in the personal conversation `a:personal-<user>`.
- When: The activity is posted to `POST /api/webhooks/teams/bot`, and the member reads chat thread lifecycle events and the new thread's events.
- Then: The webhook returns HTTP 200. A created chat thread exists, and its `input.prompt` user message contains a Teams `source` part linking to `https://teams.microsoft.com/l/chat/0/0?tenantId=<tenant>&users=<bot>`.

## teams-bot-021

- Vitest: "POST /api/webhooks/teams/bot > provides a source link for a Teams groupChat message"
- Mode: run
- Given: Row `groupChat`. A Teams-connected member with a Pro entitlement sends a message in a group chat conversation `19:<user>@thread.v2`.
- When: The activity is posted to `POST /api/webhooks/teams/bot`, and the member reads chat thread lifecycle events and the new thread's events.
- Then: The webhook returns HTTP 200. A created chat thread exists, and its `input.prompt` user message contains a Teams `source` part linking to `https://teams.microsoft.com/l/message/<conversation>/<activity>?tenantId=<tenant>&context={"contextType":"chat"}`.

## teams-bot-022

- Vitest: "POST /api/webhooks/teams/bot > deduplicates Teams files across messages by uniqueId without mixing attachments"
- Mode: run
- Given: Row `uniqueId`. A Teams-connected member sends three personal messages with download-info attachments: the first two carry the same `uniqueId` `first.png` with different download URL tokens, and the third carries `second.png`.
- When: Each activity is posted to `POST /api/webhooks/teams/bot`.
- Then: Every request returns HTTP 200. Three user-message file parts exist; the first has a UUID file ID, the second reuses it, and the third has a different ID. SharePoint is downloaded twice and two files are uploaded.

## teams-bot-023

- Vitest: "POST /api/webhooks/teams/bot > deduplicates Teams files across messages by resource URL without mixing attachments"
- Mode: run
- Given: Row `resource URL`. A Teams-connected member sends three personal messages with download-info attachments without a `uniqueId`: the first two use the same download URL for `first.png`, and the third uses `second.png`.
- When: Each activity is posted to `POST /api/webhooks/teams/bot`.
- Then: Every request returns HTTP 200. Three user-message file parts exist; the first has a UUID file ID, the second reuses it, and the third has a different ID. SharePoint is downloaded twice and two files are uploaded.

## teams-bot-024

- Vitest: "POST /api/webhooks/teams/bot > uses short file ids for Teams personal attachments"
- Mode: run
- Given: A Teams-connected member sends a personal message with a download-info attachment `personal.png` whose SharePoint download URL has a very long `tempauth` query; SharePoint answers that URL with 503 at upload time.
- When: The activity is posted to `POST /api/webhooks/teams/bot`, a Runner picks up the Run, and the Run's Okou token calls `GET /api/integrations/teams/download-file?file_id=<id>`.
- Then: The execution prompt carries a short file ID matching `teams_file_<22 chars>` (under 64 characters), and one user-message file part records `personal.png` with a UUID file ID. The download returns HTTP 302 to the original long download URL with `x-file-name: personal.png`.

## teams-bot-025

- Vitest: "POST /api/webhooks/teams/bot > preserves non-bot Teams mentions in message text"
- Mode: run
- Given: An installed Teams tenant and a valid bot token; a channel message `<at>Nova</at> ask <at>Grace Hopper</at> to review` mentions both the bot and another user.
- When: The activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The API returns HTTP 200 with normalized text `ask @Grace Hopper (<Grace's Teams ID>) to review` and `mentionsRecipient: true`.

## teams-bot-026

- Vitest: "POST /api/webhooks/teams/bot > handles connected Teams bot commands"
- Mode: run
- Given: A Teams-connected workspace admin with a Pro entitlement in a personal conversation with the bot.
- When: The member sends `/help`, `/connect`, then a normal message `run after connection commands`, and finally `/disconnect`, each to `POST /api/webhooks/teams/bot`.
- Then: Every request returns HTTP 200. `/help` replies with "Nova Teams Bot Help" and `/connect` with "You're already connected". The normal message creates a Run whose execution prompt is the message and whose system prompt contains "Your name is Okou.". `/disconnect` replies with a message containing "agent access has been revoked".

## teams-bot-027

- Vitest: "POST /api/webhooks/teams/bot > preserves the pinned Teams model in an existing DM reply thread > preserves the complete scenario"
- Mode: run
- Given: A Teams-connected workspace admin with native subscription models configured starts a personal reply thread; the first Run executes and is cancelled, and the member then changes the default model to `gpt-6-astra`.
- When: The member posts a follow-up message in the same Teams thread to `POST /api/webhooks/teams/bot` and a Runner picks up the new Run.
- Then: Both executions include "Your name is Okou." in the system prompt. The follow-up uses the same CLI agent type as the first Run, and its model usage provider remains `claude-fable-5-1`.

## teams-bot-028

- Vitest: "POST /api/webhooks/teams/bot > queued runs for a connected Teams bot > replies when a connected Teams message waits for org capacity"
- Mode: run
- Given: A Teams-connected workspace admin with a Pro entitlement, and the concurrent run limit capped at 2. Two personal-thread messages already started two active Runs.
- When: A third personal-thread message is posted to `POST /api/webhooks/teams/bot`, then the first Run is cancelled and its agent reports completion.
- Then: No Run exists yet for the third message. Teams receives three typing indicators and one reply to the third message: "The workspace has reached its concurrent run limit; this will start automatically when a slot frees up." with no attachments and no reactions. After the first Run completes, a Run for the third message is created.

## teams-bot-029

- Vitest: "POST /api/webhooks/teams/bot > clears thinking and preserves attribution for Teams run admission failures"
- Mode: run
- Given: A Teams-connected workspace admin with the Okou debug feature switch, whose Pro subscription is cancelled through a Stripe webhook so billing status is `suspended`.
- When: The member posts `<at>Nova</at> run without entitlement` to `POST /api/webhooks/teams/bot`.
- Then: The webhook returns HTTP 200. Exactly one markdown reply is sent to the activity and its text does not contain "Sent via". A thought-balloon reaction is added to the activity and then removed.

## teams-bot-030

- Vitest: "POST /api/webhooks/teams/bot > deduplicates repeated Teams activities before queueing a second run"
- Mode: run
- Given: A Teams-connected workspace admin with a Pro entitlement in a personal conversation.
- When: The same personal message activity `run this Teams task once` is posted twice to `POST /api/webhooks/teams/bot`.
- Then: Both requests return HTTP 200. Exactly one active Run has that prompt, Teams receives exactly one typing indicator and no reactions.

## teams-bot-031

- Vitest: "POST /api/webhooks/teams/bot > dispatches a connected Teams channel message with its context"
- Mode: run
- Given: Row `channel`. A Teams-connected workspace admin with a Pro entitlement. Microsoft Graph returns recent channel messages: an earlier `api channel planning`, the current `start another topic`, and a later `future channel topic`.
- When: The member posts a top-level channel message that only mentions the bot (`<at>Nova</at>`) to `POST /api/webhooks/teams/bot`, and a Runner picks up the Run.
- Then: No Teams message is sent; a thought-balloon reaction is added to the activity. The Run prompt is `@Nova`, Graph channel messages are read, and the system prompt's "Recent Channel Messages" section contains `api channel planning` but not `start another topic`; there is no "Microsoft Teams Thread Context" section.

## teams-bot-032

- Vitest: "POST /api/webhooks/teams/bot > dispatches a connected Teams thread message with its context"
- Mode: run
- Given: Row `thread`. A Teams-connected workspace admin with a Pro entitlement. Graph returns a thread root `remember the deployment target`, a reply mentioning Grace Hopper with `deployment-plan.pdf`, a file-only reply with `release-checklist.txt`, and recent channel messages including `api channel planning`.
- When: The member posts a thread reply `<at>Nova</at> ship the Teams dispatch` with attachment `current-task.txt` to `POST /api/webhooks/teams/bot`, and a Runner picks up the Run.
- Then: No Teams message is sent and a thought-balloon reaction is added. The prompt contains the text and `[Teams file] current-task.txt (text/plain)` but not the older files. The system prompt states it runs inside Microsoft Teams, lists the `okou teams` help commands, tenant, team, conversation and thread IDs, puts Teams user ID, principal name and display name under current user info, and recent channel messages include `api channel planning` but not the root. The thread context includes the root, the reply with `@Grace Hopper (<id>)`, both earlier files with their attachment IDs and sender details, and excludes the current message; Graph thread root, replies and user lookups occur.

## teams-bot-033

- Vitest: "POST /api/webhooks/teams/bot > includes recent Teams personal messages in the run context"
- Mode: run
- Given: A Teams-connected workspace admin with a Pro entitlement. Graph finds the bot's personal app installation and returns personal chat messages: the current `continue this private task`, `the target is staging`, `unrelated private task` and `remember the private deployment target`.
- When: The member posts the personal message `continue this private task` to `POST /api/webhooks/teams/bot` and a Runner picks up the Run.
- Then: The request returns HTTP 200 and an active Run has that prompt. The execution prompt is exactly the message, and the Teams thread context contains the three earlier messages but not the current one. Graph receives personal installed-app, personal app chat and chat messages requests.

## teams-bot-034

- Vitest: "POST /api/webhooks/teams/bot > includes Teams thread computer use host bindings in queued agent tokens"
- Mode: run
- Given: A Teams-connected workspace admin with a running Computer Use host. A first personal-thread message `authorize the browser` starts a Run, whose Okou token creates a Computer Use authorization request that the member approves for the host; the Run is then cancelled.
- When: The member posts `use the browser` in the same Teams thread to `POST /api/webhooks/teams/bot` and a Runner picks up the new Run.
- Then: The second Run's Okou token is bound to the authorized host ID and includes the `computer-use:write` capability.

## teams-bot-035

- Vitest: "POST /api/webhooks/teams/bot > checks the connected member’s credits when no Agent profile exists"
- Mode: run
- Given: A Teams tenant is installed and the sender is connected, but the connected member has no Agent profile or credits set up.
- When: The member posts `<at>Nova</at> hello` to `POST /api/webhooks/teams/bot`.
- Then: The request returns HTTP 200 and the last Teams reply to that activity contains "Insufficient credits".

## teams-bot-036

- Vitest: "POST /api/webhooks/teams/bot > normalizes a Teams bot removal activity"
- Mode: run
- Given: A valid bot token; Teams reports a conversation update in which the bot is removed from the channel.
- When: The removal activity is posted to `POST /api/webhooks/teams/bot`.
- Then: The API returns HTTP 200 with `ok: true` and a `bot_removed` activity with reason `members_removed`, tenant, conversation and channel IDs, the removed bot member, and idempotency key `<conversation>:conversationUpdate:<activity>`.

## teams-bot-037

- Vitest: "POST /api/webhooks/teams/bot > removes the bot installation while preserving the connected Teams identity"
- Mode: run
- Given: A Teams tenant installed through a bot message, with the admin's Teams account connected.
- When: Teams posts a bot-removal activity to `POST /api/webhooks/teams/bot`, then the admin reads `GET /api/integrations/teams/connect`.
- Then: The webhook returns HTTP 200. The status shows `isInstalled: false`, `isConnected: true`, the linked account's AAD object ID, no pending installation, `isAdmin: true`, an install URL and `connectUrl: null`.

## teams-bot-038

- Vitest: "POST /api/webhooks/teams/bot > publishes Teams status changes when an install activity refreshes a bound installation"
- Mode: run
- Given: A Teams tenant is installed and the admin's Teams account is connected; the org has been read once with an Okou token.
- When: Teams posts a members-added install activity for the bot to `POST /api/webhooks/teams/bot`.
- Then: The request returns HTTP 200 and a realtime `teams:changed` event is published with a null payload.
