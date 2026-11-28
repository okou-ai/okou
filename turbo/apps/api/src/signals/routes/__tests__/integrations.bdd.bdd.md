# integrations.bdd

## integrations.bdd-001

- Vitest: "INT-01: Slack integration and Slack app routes > keeps signed Slack Events API URL verification boundaries visible through APIs"
- Mode: run
- Given: The Slack signing secret is first unset, then configured; Slack Events API bodies include a URL verification challenge, an `app_mention` retry for team `TBDD_EVENT`, App Home `home` and `messages` tab opens, `app_uninstalled`, `tokens_revoked`, and an unrelated `team_join` payload.
- When: Each body is posted to `POST /api/webhooks/slack/events` with no signature headers, an invalid `v0=invalid` signature, a timestamp 301 seconds old, or valid signature headers (the retry also sends `x-slack-retry-num: 1`).
- Then: Without a signing secret the route returns HTTP 503 `Slack integration is not configured`. Missing signature headers return HTTP 401 `Missing Slack signature headers`, and both the invalid and the stale signature return HTTP 401 `Invalid signature`. A valid URL verification returns HTTP 200 echoing `{ challenge: "slack-bdd-challenge" }`, and every other validly signed event (retry, App Home tabs, uninstall, token revocation, ignored type) returns HTTP 200 with body `OK`.

## integrations.bdd-002

- Vitest: "INT-01: Slack integration and Slack app routes > keeps signed Slack command and interactive payload boundaries visible through APIs"
- Mode: run
- Given: The Slack signing secret is configured and the Slack team `TBDD` user `UBDD` has no Okou connection.
- When: Validly signed slash commands `help`, `connect`, `disconnect` and `unknown` are posted to `POST /api/webhooks/slack/commands`, and a signed `block_actions` payload with action `home_disconnect` is posted to `POST /api/webhooks/slack/interactive`.
- Then: Each command returns HTTP 200 with an ephemeral Slack response containing at least one block. The interactive `home_disconnect` action returns HTTP 200 with an empty body.

## integrations.bdd-003

- Vitest: "INT-01: Slack integration and Slack app routes > keeps Slack org and user connect status boundaries visible through APIs"
- Mode: run
- Given: A signed-in organization admin has no Slack installation or Slack user connection; a second caller is unauthenticated.
- When: Both callers read `GET /api/integrations/slack` and `GET /api/integrations/slack/connect`.
- Then: Unauthenticated reads return HTTP 401 with `UNAUTHORIZED` (the connect status message is `Not authenticated`). The admin's org status returns HTTP 200 with `isConnected: false`, `isInstalled: false`, `isAdmin: true`, `connectUrl: null`, and the connect status returns exactly `{ isConnected: false, isAdmin: true }`.

## integrations.bdd-004

- Vitest: "INT-01: Slack integration and Slack app routes > keeps unauthenticated, not-installed, non-admin, and provider-config errors visible through APIs"
- Mode: run
- Given: An organization admin and a member of the same organization exist with no Slack installation or connection; some requests are unauthenticated; the Slack OAuth provider is initially unconfigured and later configured with client ID `slack-bdd-client-id`.
- When: Callers request `GET /api/slack/channels`, `POST /api/integrations/slack/message`, `POST /api/integrations/slack/upload-file/init`, `POST /api/integrations/slack/upload-file/complete`, `GET /api/integrations/slack/download-file?file_id=F123`, `DELETE /api/integrations/slack` (member `delete` and `uninstall`, admin `uninstall`, unauthenticated), `GET /api/slack/oauth/install` before and after provider configuration, and `GET /api/integrations/slack/oauth/callback?error=access_denied`.
- Then: Unauthenticated channel, message, download and disconnect requests return HTTP 401 `UNAUTHORIZED`. The admin gets HTTP 404 `No Slack account connected for this user` for channels, HTTP 404 `NOT_FOUND` for message, upload init and upload complete, and HTTP 404 `No Slack installation found for this org` for download. The member's delete returns HTTP 404, the member's uninstall returns HTTP 403 `Admin access required`, and the admin's uninstall returns HTTP 404 `No Slack installation found`. OAuth install returns HTTP 503 `Slack integration is not configured` without provider config and then a 307 redirect to slack.com with the configured `client_id` and a scope containing `chat:write`; the callback error redirects (307) to `/settings/slack?error=access_denied`.

## integrations.bdd-005

- Vitest: "INT-01: Slack integration and Slack app routes > installs, connects, disconnects, and uninstalls a Slack workspace through OAuth APIs"
- Mode: run
- Given: Slack is configured; an organization admin and a member of the same organization exist and no Slack workspace is installed yet.
- When: The admin installs a new Slack workspace through the Slack OAuth install flow, the member connects their Slack user, the member disconnects with `DELETE /api/integrations/slack`, and the admin uninstalls with `DELETE /api/integrations/slack?action=uninstall`, reading `GET /api/integrations/slack` and `GET /api/integrations/slack/connect` between steps.
- Then: Before install the admin sees not connected and not installed. After install the admin sees `isConnected: true`, `isInstalled: true`, the workspace name, `scopeMismatch: false` and `reinstallUrl: null`; the member sees installed but not connected with a `connectUrl` containing `connectorState=`, and connect status `{ isConnected: false, isAdmin: false }`. After connecting, the member's connect status is connected with workspace name `BDD Slack App <teamId>`; disconnect returns `{ ok: true }` and the member is disconnected again. Uninstall returns `{ ok: true }`, publishes exactly one Slack App Home view to the installer with an `Open Okou Settings` button linking to `<APP_URL>/settings/slack`, and the admin's status then shows `isConnected: true`, `isInstalled: false`.

## integrations.bdd-006

- Vitest: "INT-01: Slack app deep webhook flows > routes identical Slack user IDs by the verified sender workspace"
- Mode: run
- Given: Two Okou users in different organizations each installed a different Slack workspace with the same installer Slack user ID; the first user has a Pro entitlement and a subscription model, and Slack reports the sender as a non-deleted member of the first user's workspace.
- When: A signed `app_mention` from that Slack user ID arrives at `POST /api/webhooks/slack/events` for the first user's workspace.
- Then: The first user's run logs (`triggerSource=slack`) contain one Slack-triggered run with the mention text as prompt, and the other user's Slack run logs are empty.

## integrations.bdd-007

- Vitest: "INT-01: Slack app deep webhook flows > reads Org A with its organization bot and sends into the external input channel with Org B's bot"
- Mode: run
- Given: A member's home workspace (Org A) has the Okou Slack bot installed and their Slack identity connected; a different organization (Org B) installed another Slack workspace. The member's Slack mention in Org B's external channel `CEXTERNAL` started a running Slack-triggered Run. Slack reports the sender and Org B's bot in `CEXTERNAL`, and Org A's bot in `CORGAMESSAGES`, whose history holds "Org A meeting notes".
- When: Using the Run's token, the caller reads `GET /api/integrations/slack/history?channel=CORGAMESSAGES` and `?channel=CEXTERNAL`, then sends the read text with `POST /api/integrations/slack/message` to `CEXTERNAL`.
- Then: The Org A history read returns HTTP 200 with "Org A meeting notes" and is made with Org A's bot token; reading `CEXTERNAL` history returns HTTP 404. The send returns HTTP 200 for channel `CEXTERNAL`, is made with Org B's bot token, and posts "Org A meeting notes" to that channel. The Run remains `running`.

## integrations.bdd-008

- Vitest: "INT-01: Slack app deep webhook flows > limits a Run without its organization bot to the exact external input channel"
- Mode: run
- Given: A member's Slack mention in another organization's external channel `CEXTERNAL` started a running Run, and the member's home organization no longer has its Slack bot installed. Slack reports the sender and the external bot as channel members.
- When: With the Run token the caller posts `POST /api/integrations/slack/message` to `CEXTERNAL` in the input thread, then to channel `COTHERENTRY`, user `U_OTHER_MEMBER`, and user `me`; the member's own session also posts to `CEXTERNAL`, and the Run token reads `GET /api/integrations/slack/history?channel=CORGAMESSAGES`.
- Then: The in-thread reply to `CEXTERNAL` returns HTTP 200. Every other target, the session-authenticated send and the history read return HTTP 404, and Slack receives no further `chat.postMessage` or `conversations.open` calls.

## integrations.bdd-009

- Vitest: "INT-01: Slack app deep webhook flows > does not inherit a historical or pending Slack input in a Web-triggered Run"
- Mode: run
- Given: A member's external Slack mention in `CEXTERNAL` started a Run that has completed, and the member's home Slack bot is not installed. The member continues the same chat thread from Web, which launches a new Web-triggered Run.
- When: Using the Web Run's token, the caller posts `POST /api/integrations/slack/message` to `CEXTERNAL`; then a new Slack mention arrives in the same Slack thread and the caller sends to `CEXTERNAL` again.
- Then: Both sends return HTTP 404: neither the historical Slack input nor the pending Slack message grants the Web Run access to the external channel.

## integrations.bdd-010

- Vitest: "INT-01: Slack app deep webhook flows > revokes external input-channel writes when left channel"
- Mode: run
- Given: A member's external Slack mention in `CEXTERNAL` started a running Run with the home bot installed, but Slack now lists only the external bot (not the sender) as a member of `CEXTERNAL` (parameter: left channel).
- When: The Run token posts `POST /api/integrations/slack/message` to `CEXTERNAL`.
- Then: The API returns HTTP 404 and Slack `chat.postMessage` is not called.

## integrations.bdd-011

- Vitest: "INT-01: Slack app deep webhook flows > revokes external input-channel writes when posting restricted"
- Mode: run
- Given: A member's external Slack mention in `CEXTERNAL` started a running Run with the home bot installed, but Slack now reports `CEXTERNAL` as read-only (parameter: posting restricted).
- When: The Run token posts `POST /api/integrations/slack/message` to `CEXTERNAL`.
- Then: The API returns HTTP 404 and Slack `chat.postMessage` is not called.

## integrations.bdd-012

- Vitest: "INT-01: Slack app deep webhook flows > revokes external input-channel writes when deleted identity"
- Mode: run
- Given: A member's external Slack mention in `CEXTERNAL` started a running Run with the home bot installed, but Slack now reports the sender's Slack identity as deleted (parameter: deleted identity).
- When: The Run token posts `POST /api/integrations/slack/message` to `CEXTERNAL`.
- Then: The API returns HTTP 404 and Slack `chat.postMessage` is not called.

## integrations.bdd-013

- Vitest: "INT-01: Slack app deep webhook flows > keeps canonical external uploads bound to their Run, entry bot and persisted channel"
- Mode: run
- Given: A member's external Slack mention in Org B's channel `CEXTERNAL` started a running Run; the member's home bot is not installed. Private artifact storage holds the 42-byte `report.csv` and Slack accepts external uploads as file `F_EXTERNAL_OUTPUT`.
- When: The Run token calls `POST /api/integrations/slack/upload-file/init` with a canonical operation for `CEXTERNAL`, `POST /api/integrations/slack/upload-file/materialize`, then `POST /api/integrations/slack/upload-file/complete` naming channel `COTHERENTRY` three times: while the sender is absent from `CEXTERNAL`, after the sender is back, and after the member disconnects Slack.
- Then: Init returns a canonical asset and materialize returns HTTP 200 with delivery `pending`, using Org B's bot token. The first completion returns HTTP 200 for channel `CEXTERNAL` with `deliveryStatus: "failed"` and no Slack completion call. The second returns `deliveryStatus: "delivered"` for `CEXTERNAL`, completing the Slack upload exactly once with `channel_id` `CEXTERNAL`. The third returns the identical receipt without another Slack upload.

## integrations.bdd-014

- Vitest: "INT-01: Slack app deep webhook flows > rejects external Slack ingress with a different workspace"
- Mode: run
- Given: A member has connected their Slack identity from their home workspace (home bot since uninstalled), another organization installed a different workspace, and Slack reports the sender as belonging to an unconnected team `T_UNCONNECTED_IDENTITY` (parameter: different workspace).
- When: A signed `app_mention` from that Slack user arrives at `POST /api/webhooks/slack/events` for the other organization's workspace.
- Then: The member's Slack-triggered run logs remain empty.

## integrations.bdd-015

- Vitest: "INT-01: Slack app deep webhook flows > rejects external Slack ingress with a deleted member"
- Mode: run
- Given: A member has connected their Slack identity from their home workspace (home bot since uninstalled), another organization installed a different workspace, and Slack reports the sender as a deleted member of the home workspace (parameter: deleted member).
- When: A signed `app_mention` from that Slack user arrives at `POST /api/webhooks/slack/events` for the other organization's workspace.
- Then: The member's Slack-triggered run logs remain empty.

## integrations.bdd-016

- Vitest: "INT-01: Slack app deep webhook flows > rejects external Slack ingress with a missing identity"
- Mode: run
- Given: A member has connected their Slack identity from their home workspace (home bot since uninstalled), another organization installed a different workspace, and Slack's user lookup returns no user (parameter: missing identity).
- When: A signed `app_mention` from that Slack user arrives at `POST /api/webhooks/slack/events` for the other organization's workspace.
- Then: The member's Slack-triggered run logs remain empty.

## integrations.bdd-017

- Vitest: "INT-01: Slack app deep webhook flows > checks the pinned thread's organization after the Slack account moves to another organization"
- Mode: run
- Given: A member's external Slack mention created a pinned Slack thread whose Run has completed. The same Okou user then connects the same Slack identity under a new organization, and 61 seconds later Clerk reports the user only as an admin of that new organization.
- When: A follow-up `app_mention` arrives in the same Slack thread at `POST /api/webhooks/slack/events`.
- Then: After the Runner heartbeats, no new Run is dispatched for the pinned thread.

## integrations.bdd-018

- Vitest: "INT-01: Slack app deep webhook flows > keeps external Slack sessions processing after enqueue while the home bot is installed"
- Mode: run
- Given: A member's Slack identity is connected with their home bot still installed, and another organization's workspace has Okou installed.
- When: The member mentions Okou in the external workspace via `POST /api/webhooks/slack/events`.
- Then: A Run is dispatched and reads back as `running`. Slack receives `agents.sessions.setStatus` with status `processing` for the channel and thread, and never status `active`.

## integrations.bdd-019

- Vitest: "INT-01: Slack app deep webhook flows > routes external Slack mentions to the connected owner without a home bot and preserves status, replies and Stop"
- Mode: run
- Given: A member has connected their Slack identity but their home bot is uninstalled; another organization's workspace has Okou installed.
- When: The member mentions Okou in that external workspace, the Run's sandbox reports an assistant reply and completes, the member mentions Okou again in the same thread, and Slack sends an `agent_session_stopped` event for the thread, all via `POST /api/webhooks/slack/events` and the agent webhook callbacks.
- Then: The member's connect status is connected. The first Run is `running` with prompt "use my connected Okou" and Slack receives status `processing`; after completion Slack receives a threaded reply "External identity reply". After the Stop event, the second Run reads back `cancelled` and the last Slack status call sets the thread to `active`.

## integrations.bdd-020

- Vitest: "INT-01: Slack app deep webhook flows > processes the current Slack message without unauthorized optional context"
- Mode: run
- Given: A member with a Pro entitlement installed Slack and is the installer; Slack rejects the thread-context read (`conversations.replies`) once with `missing_scope`.
- When: A signed `app_mention` in a group DM thread is posted to `POST /api/webhooks/slack/events`.
- Then: The member's run logs contain a Slack-triggered run whose prompt contains "preserve this current message", and Slack's thread-context read was attempted exactly once.

## integrations.bdd-021

- Vitest: "INT-01: Slack app deep webhook flows > keeps permanent Slack failures terminal across provider retries"
- Mode: run
- Given: A member with a Pro entitlement installed Slack; Slack rejects every thread-context read with the permanent error `invalid_auth`.
- When: The same signed `app_mention` event is posted to `POST /api/webhooks/slack/events` and then redelivered with `x-slack-retry-num: 1`.
- Then: After both deliveries the member's run logs are empty, and Slack's thread-context read was attempted exactly once.

## integrations.bdd-022

- Vitest: "INT-01: Slack app deep webhook flows > bounds explicitly retryable Slack failures with backoff"
- Mode: run
- Given: A member with a Pro entitlement installed Slack; Slack rate-limits every thread-context read.
- When: The same signed `app_mention` event is posted to `POST /api/webhooks/slack/events` five times as Slack retries, with the clock advancing 1 minute, 5 minutes, 30 minutes and 2 hours between attempts; an extra retry arrives 1 ms after the first attempt, and a final retry arrives 24 hours after the fifth.
- Then: Each scheduled attempt makes exactly one more Slack thread-context read (1 through 5) and no run is created. The early retry and the retry after 24 hours make no additional read, leaving a total of 5.

## integrations.bdd-023

- Vitest: "INT-01: Slack app deep webhook flows > keeps failed canonical inputs inert across historical reads"
- Mode: run
- Given: A member with a Pro entitlement installed Slack; the first Slack download of an attached `source-notes.txt` fails.
- When: A signed `app_mention` with the file is posted to `POST /api/webhooks/slack/events`, and the member later lists the resulting chat thread's events while Slack file downloads would fail.
- Then: The member owns exactly one Slack-sourced chat thread whose user message has a file part with the canonical input asset ID, and listing the events makes no Slack file download.

## integrations.bdd-024

- Vitest: "INT-01: Slack app deep webhook flows > preserves a mention-only Slack request with the preceding link and image"
- Mode: run
- Given: A member with a Pro entitlement installed Slack. Slack's thread history holds the member's earlier root message "This article is still broken: https://example.com/article" with image `article.png` (`F_ARTICLE_SCREENSHOT`), followed by a message that only mentions the bot.
- When: A signed mention-only `app_mention` reply in that thread is posted to `POST /api/webhooks/slack/events` and the dispatched Run completes.
- Then: The dispatched Run's prompt is exactly `@Slack User (<botUserId>)`. Its appended system prompt contains the article URL, `[ID] F_ARTICLE_SCREENSHOT`, and a `# Slack Thread Context` section with the root message at `RELATIVE_INDEX: -1`, the sender's ID, name, email and UTC timezone, the article text and the `[Slack file] article.png (image/png)` line.

## integrations.bdd-025

- Vitest: "INT-01: Slack app deep webhook flows > deduplicates canonical Slack retries and preserves same-name mention identities"
- Mode: run
- Given: A member with a Pro entitlement installed Slack; two other workspace users are both displayed as "Slack User", and Slack serves a 26-byte text attachment `source-notes.txt` advertised as `application/octet-stream`.
- When: A signed `app_mention` that mentions the bot and both users and attaches the file is posted to `POST /api/webhooks/slack/events`, then redelivered three times with `x-slack-retry-num` 1, 2 and 3; the dispatched Run then completes.
- Then: The member owns one Slack-sourced thread with exactly one `created` lifecycle event and exactly one Slack run whose prompt contains "admit this event once"; Slack status is set to `processing` exactly once. The thread is readable and its `input.prompt` event has `content: null` and parts: the file (`source-notes.txt`, `text/plain`), the text "@Slack User admit this event once with @Slack User and @Slack User", and a Slack source link to the message permalink; the input file previews with the original bytes. The Run prompt keeps each mention's ID (`@Slack User (<id>)`) and lists the file as `[Web file] source-notes.txt (text/plain)` with its asset ID, and the system prompt contains the current Slack integration block, the private-artifact upload rule and `okou web download-file -h`. Slack's permalink lookup is called for the thread root.

## integrations.bdd-026

- Vitest: "INT-01: Slack app deep webhook flows > keeps queued Web and Slack sends on one canonical session"
- Mode: run
- Given: A member with a Pro entitlement and a push subscription installed Slack. A Slack mention with an attached `session-notes.txt` started a running Run on a canonical thread; Slack's permalink lookup fails once.
- When: While the Run runs, the member queues a Web message on the same thread with `POST` to the chat send endpoint and a second Slack reply arrives in the same Slack thread; then the first Run, the queued Web Run and the Slack follow-up Run complete in turn via the agent webhooks.
- Then: The Web send returns HTTP 201 for the same thread, and the Slack reply joins that same thread; both inputs are `input.prompt` events without a run, and the Slack reply's source part is `{ type: "source", kind: "slack" }` with no link. The first Run posts exactly one Slack reply "Canonical Slack answer one" in the thread. The Web Run launches next with trigger source `web`, continues the Slack Run's session, posts nothing to Slack and sends one Web Push notification. The Slack follow-up then launches with trigger source `slack`, continues the Web Run's session, includes the follow-up text, `session-notes.txt`, the Slack integration block, display name and Slack user ID, and posts exactly one Slack reply "Canonical Slack answer two", which also appears as an `output.message` in the thread; no further push is sent. Each Run's result records its own framework session ID.

## integrations.bdd-027

- Vitest: "INT-01: Slack app deep webhook flows > recovers canonical Slack gpt-6-luna after cancellation without duplicate ownership"
- Mode: run
- Given: A member with a Pro entitlement and native subscription models installed Slack, completed a Claude Slack thread, and then selected thread model `gpt-6-luna` (parameter).
- When: The member mentions Okou in the same Slack thread; the first Pi turn completes; a second mention starts a continued turn that the member cancels with the run cancel endpoint before the Sandbox reports exit; a third mention starts a new turn that completes, all via `POST /api/webhooks/slack/events` and the agent webhooks.
- Then: The first turn runs Pi with provider `openai-codex`, model `gpt-6-luna`, thinking level `xhigh`, session ID equal to the chat thread, no native session and a recovery prompt pointing to `okou chat messages`; it posts exactly one Slack reply and records one `output.message` and one `run.completed`, with zero thread model credits. The continued turn continues that session from the first run; cancelling it reads back `cancelled`, posts one Slack "Run cancelled" reply and records one `run.cancelled`. The recovery turn starts with no native session or generation run, its history includes the first and cancelled prompts, it completes with the original session ID, posts one Slack reply "Continued Slack Pi answer" and reads back `completed`.

## integrations.bdd-028

- Vitest: "INT-01: Slack app deep webhook flows > recovers canonical Slack gpt-6-sol after cancellation without duplicate ownership"
- Mode: run
- Given: A member with a Pro entitlement and native subscription models installed Slack, completed a Claude Slack thread, and then selected thread model `gpt-6-sol` (parameter).
- When: The member mentions Okou in the same Slack thread; the first Pi turn completes; a second mention starts a continued turn that the member cancels with the run cancel endpoint before the Sandbox reports exit; a third mention starts a new turn that completes, all via `POST /api/webhooks/slack/events` and the agent webhooks.
- Then: The first turn runs Pi with provider `openai-codex`, model `gpt-6-sol`, thinking level `max`, session ID equal to the chat thread, no native session and a recovery prompt pointing to `okou chat messages`; it posts exactly one Slack reply and records one `output.message` and one `run.completed`, with zero thread model credits. The continued turn continues that session from the first run; cancelling it reads back `cancelled`, posts one Slack "Run cancelled" reply and records one `run.cancelled`. The recovery turn starts with no native session or generation run, its history includes the first and cancelled prompts, it completes with the original session ID, posts one Slack reply "Continued Slack Pi answer" and reads back `completed`.

## integrations.bdd-029

- Vitest: "INT-01: Slack app deep webhook flows > recovers canonical Slack gpt-6.1-sol after cancellation without duplicate ownership"
- Mode: run
- Given: A member with a Pro entitlement and native subscription models installed Slack, completed a Claude Slack thread, and then selected thread model `gpt-6.1-sol` (parameter).
- When: The member mentions Okou in the same Slack thread; the first Pi turn completes; a second mention starts a continued turn that the member cancels with the run cancel endpoint before the Sandbox reports exit; a third mention starts a new turn that completes, all via `POST /api/webhooks/slack/events` and the agent webhooks.
- Then: The first turn runs Pi with provider `openai-codex`, model `gpt-6.1-sol`, thinking level `medium`, session ID equal to the chat thread, no native session and a recovery prompt pointing to `okou chat messages`; it posts exactly one Slack reply and records one `output.message` and one `run.completed`, with zero thread model credits. The continued turn continues that session from the first run; cancelling it reads back `cancelled`, posts one Slack "Run cancelled" reply and records one `run.cancelled`. The recovery turn starts with no native session or generation run, its history includes the first and cancelled prompts, it completes with the original session ID, posts one Slack reply "Continued Slack Pi answer" and reads back `completed`.

## integrations.bdd-030

- Vitest: "INT-01: Slack app deep webhook flows > with a configured Slack workspace > resumes the member’s Slack DM session"
- Mode: run
- Given: A member with a Pro entitlement and native subscription models installed Slack as the installer and has a provisioned workspace; they write to Okou in a Slack DM.
- When: The member sends a DM message via `POST /api/webhooks/slack/events`, its Run completes through the agent webhooks, and the member sends a new top-level DM message that also completes with an assistant reply.
- Then: The first Run starts with no native session. The second Run continues the first Run's session (`bdd-slack-cli-<firstRunId>`), and its reply "Returned main Slack DM answer" is posted to the DM channel threaded on the new message.

## integrations.bdd-031

- Vitest: "INT-01: Slack app deep webhook flows > with a configured Slack workspace > keeps the main Slack DM session when its destination channel changes"
- Mode: run
- Given: A member with a Pro entitlement and native subscription models installed Slack as the installer and has a provisioned workspace; their first DM message in channel `D_BDD_SESSION_ROUTING` started a Run that completed.
- When: The member sends a new top-level DM message from a different DM channel `D_BDD_SESSION_ROUTING_REPLACEMENT` via `POST /api/webhooks/slack/events`, and that Run completes with an assistant reply.
- Then: The new Run continues the first Run's session, its system prompt contains `Channel ID: D_BDD_SESSION_ROUTING_REPLACEMENT`, and it belongs to the same chat thread as the first Run. The reply is posted to the new channel threaded on the new message.

## integrations.bdd-032

- Vitest: "INT-01: Slack app deep webhook flows > forks Slack DM threads without replacing the main session"
- Mode: run
- Given: A member with a Pro entitlement and native subscription models installed Slack as the installer and has a provisioned workspace.
- When: Through `POST /api/webhooks/slack/events` the member sends a top-level DM, then a reply in that DM's Slack thread, then a second reply in the same Slack thread, then a new top-level DM, with each Run completing before the next message.
- Then: The main DM Run and the first thread reply both start with no native session. The second thread reply continues the first thread reply's session, and the later top-level DM continues the main DM Run's session.

## integrations.bdd-033

- Vitest: "INT-01: Slack app deep webhook flows > handles native Slack Stop without affecting other threads or newer inputs"
- Mode: run
- Given: A member with a Pro entitlement installed Slack. A mention in thread A started a running Run, a second mention in thread A is queued without a run, and a mention in a separate top-level thread B started another running Run.
- When: Slack sends an `agent_session_stopped` event for thread A, then a redelivery with `x-slack-retry-num: 1`; the stopped Run's Sandbox reports exit 137; a new mention arrives in thread A; and the Stop retry is delivered again.
- Then: After Stop, thread A's Run reads `cancelled`, thread B's Run stays `running`, the thread records a `control.revoke` for the queued input, Slack's status is last set to `active` (never `processing`), exactly one "Run cancelled" reply is posted in thread A and no ephemeral message is sent. The retry keeps status `active`, adds no reply and no ephemeral. The new mention starts a fresh Run; after the stale Stop retry the fresh Run and thread B's Run are both `running`, no ephemeral is sent, and the status is last set to `processing`.

## integrations.bdd-034

- Vitest: "INT-01: Slack app deep webhook flows > handles native Slack Stop only for the sender's tasks in the signed workspace"
- Mode: run
- Given: A member with a Pro entitlement installed Slack and a mention from their Slack user started a running Run in a channel thread.
- When: Via `POST /api/webhooks/slack/events`, Slack sends `agent_session_stopped` for the thread from a different Slack user, then from the sender but signed for a different team ID, then from the sender in the correct workspace, then again from the other user while Slack rejects ephemerals with `user_not_in_channel`.
- Then: The other user's Stop posts no reply, sends that user the ephemeral "You have no tasks to stop in this thread. You can only stop tasks you started." and leaves status `processing`. The other-team Stop leaves the Run `running` with no Slack status or ephemeral call. The sender's Stop cancels the Run, the Runner sees a present cooperative cancellation, exactly one "Run cancelled" reply is posted, no ephemeral is sent and status becomes `active`. The final foreign Stop leaves the Run `cancelled` and status `active`, never `processing`.

## integrations.bdd-035

- Vitest: "INT-01: Slack app deep webhook flows > handles native Slack Stop while ingress enrichment is still in flight"
- Mode: run
- Given: A member with a Pro entitlement installed Slack, and Slack's permalink lookup for a new mention is still in flight.
- When: The member mentions Okou via `POST /api/webhooks/slack/events` and, before the permalink lookup resolves, Slack delivers `agent_session_stopped` for the same thread.
- Then: No Slack-triggered run is created for the member, and Slack's status for the thread is last set to `active`.

## integrations.bdd-036

- Vitest: "INT-01: Slack app deep webhook flows > handles native Slack Stop per physical thread in the shared main DM session"
- Mode: run
- Given: A member with a Pro entitlement installed Slack. A top-level DM message started a running Run, and a second top-level DM message in the same DM channel is queued in the shared main DM chat thread.
- When: Slack sends `agent_session_stopped` for the first message's thread via `POST /api/webhooks/slack/events`, then another Stop for the second message's thread.
- Then: The first Run reads `cancelled`, the queued input from the other DM root is not revoked, and Slack's status for the first thread is set to `active`.

## integrations.bdd-037

- Vitest: "INT-01: Slack app deep webhook flows > handles native Slack Stop without cancelling another sender in the same thread"
- Mode: run
- Given: An admin installed Slack and a member of the same organization connected a different Slack user and completed onboarding; both have subscription models. The admin's mention started a running Run in a channel thread, the member's reply in that thread started the member's own running Run, and a further member reply is queued.
- When: Slack sends `agent_session_stopped` for the thread from the admin's Slack user, then from the member's Slack user, via `POST /api/webhooks/slack/events`.
- Then: After the admin's Stop, the admin's Run is `cancelled`, the member's Run stays `running`, the member's queued input is not revoked, status remains `processing`, exactly one "Run cancelled" reply is posted and the admin alone receives the ephemeral "Your tasks have stopped. Other tasks in this thread are still running." After the member's Stop, both Runs are `cancelled`, exactly one more "Run cancelled" reply is posted, no ephemeral is sent, and status is last set to `active` (never `processing`).

## integrations.bdd-038

- Vitest: "INT-01: Slack app deep webhook flows > keeps native Slack Stop idle after a delayed busy status response"
- Mode: run
- Given: A member with a Pro entitlement installed Slack, and their mention started a running Run; Slack's next status update is slow to respond.
- When: An unrelated Slack user's `agent_session_stopped` for the thread is posted to `POST /api/webhooks/slack/events`, and while its status update is pending the sender's own Stop arrives.
- Then: The Run reads `cancelled` and Slack's status for the thread is last set to `active`.

## integrations.bdd-039

- Vitest: "INT-01: Slack app deep webhook flows > routes retry-only Slack events through canonical ingress"
- Mode: run
- Given: A member with a Pro entitlement installed Slack as the installer.
- When: The first delivery Okou receives for a new `app_mention` is a signed Slack retry (`x-slack-retry-num: 1`) to `POST /api/webhooks/slack/events`.
- Then: The member owns a Slack-sourced chat thread whose `input.prompt` has a run ID and a Slack source link `https://vm0.slack.com/archives/C_BDD_RETRY_INGRESS/p2900000300`. That run's log shows trigger source `slack` with the mention text, and Slack's status is set to `processing` for the thread.

## integrations.bdd-040

- Vitest: "INT-01: Slack app deep webhook flows > tells the Slack sender when the org is at its concurrent run limit"
- Mode: run
- Given: The concurrent run limit cap is 1, and a member with a Pro entitlement installed Slack; one Slack mention already started an active Run.
- When: The member mentions Okou in another channel via `POST /api/webhooks/slack/events`.
- Then: Slack receives a threaded reply "The workspace has reached its concurrent run limit; this will start automatically when a slot frees up.", and the waiting thread's Slack status is last set to `active`.

## integrations.bdd-041

- Vitest: "INT-01: Slack app deep webhook flows > titles canonical Slack threads when their run is created"
- Mode: run
- Given: A member with a Pro entitlement installed Slack, and the title-generation model returns "Canonical Slack Title".
- When: The member mentions Okou with "title this canonical Slack thread" via `POST /api/webhooks/slack/events`, and the Run later completes.
- Then: While the Run is still in flight, the member's thread lifecycle feed includes a `renamed` event for the thread with title "Canonical Slack Title". Exactly one title request is made, containing the prompt, and none is added after completion.

## integrations.bdd-042

- Vitest: "INT-01: Slack app deep webhook flows > uses default launch bindings for canonical Slack threads"
- Mode: run
- Given: A member with a Pro entitlement, native subscription models and a provisioned workspace installed Slack as the installer.
- When: The member mentions Okou with "summarize this thread" via `POST /api/webhooks/slack/events`, the Run completes with an assistant reply, and the member follows up in the same Slack thread, whose Run also completes.
- Then: Slack status is set to `processing`. The first Run's prompt is "summarize this thread", it runs `claude-code` with a Claude OAuth token, `OKOU_CURRENT_INTEGRATION` is `slack`, the system prompt says it runs inside Slack with display name "Slack User", and it reads `running` with trigger source `slack`. After completion a threaded reply is posted and the Run is `completed` with a session ID. The follow-up continues `bdd-slack-cli-<run1Id>` and records its own session `bdd-slack-cli-<run2Id>`.

## integrations.bdd-043

- Vitest: "INT-01: Slack app deep webhook flows > pins model choices to canonical Slack threads"
- Mode: run
- Given: A member with a Pro entitlement and native subscription models installed Slack and set their model preference to `gpt-6-astra`.
- When: The member mentions Okou in a new Slack thread via `POST /api/webhooks/slack/events` and the Run completes; the member switches their preference to `claude-fable-5-1` and replies in the same Slack thread.
- Then: The first Run uses `codex` with a ChatGPT access token and `OPENAI_MODEL` `gpt-6-astra`. The continuation still uses `codex` with `gpt-6-astra`, continues the first Run's session, and records its own session `bdd-slack-cli-<continuationRunId>`.

## integrations.bdd-044

- Vitest: "INT-01: Slack app deep webhook flows > keeps an explicit Auto pin on a historical Slack thread when the member preference changes"
- Mode: run
- Given: A member with a Pro entitlement and native subscription models installed Slack; their mention created a Slack thread whose first Run used `claude-code` with `ANTHROPIC_MODEL` `claude-fable-5-1` and completed.
- When: The member sets the thread's model selection to Auto (`null`) and then changes their member model preference to `gpt-6-astra`.
- Then: The thread's history contains the first Run's `input.prompt`. The thread metadata reports `selectedModel: "auto"`, and the thread lifecycle feed has no `model_selection_updated` event setting the thread to `gpt-6-astra`.

## integrations.bdd-045

- Vitest: "INT-01: Slack app deep webhook flows > prompts disconnected Slack users and filters non-actionable messages"
- Mode: run
- Given: A member installed Slack; the sending Slack user has no Okou connection. A second Slack workspace is installed without an Okou organization binding.
- When: Via `POST /api/webhooks/slack/events` the unconnected user mentions Okou in a channel, sends a DM, sends a bot DM, an edited (`message_changed`) DM, plain channel chatter, a `file_share` DM, and finally a DM to the unbound workspace.
- Then: The mention gets an ephemeral message containing "connect your account" and the DM gets the reply "Please connect your account first". The bot message, edit and channel chatter produce no Slack message or ephemeral. The `file_share` DM produces exactly one "Please connect your account first" reply. The unbound workspace DM produces no message, ephemeral or Slack API call.

## integrations.bdd-046

- Vitest: "INT-01: Slack app deep webhook flows > opens the connected member's chat for Slack mentions and DMs without a profile"
- Mode: run
- Given: A member installed Slack as the installer and has no Okou profile setup.
- When: The member mentions Okou in a channel, then sends a DM, each via `POST /api/webhooks/slack/events`.
- Then: After the mention the member's thread lifecycle feed has one created thread; after the DM it has two distinct created threads including the first.

## integrations.bdd-047

- Vitest: "INT-01: Slack app deep webhook flows > serves Slack help, connect, and disconnect commands"
- Mode: run
- Given: A member on limited free onboarding installed Slack as the installer and is connected.
- When: The member posts `/okou` commands to `POST /api/webhooks/slack/commands` with empty text, `help`, `unknown`, then `connect`, `disconnect`, `disconnect` again and `connect` again.
- Then: Empty, `help` and `unknown` each return help containing `<@bot> Slack Bot Help`, `/okou help`, `/okou connect`, `/okou disconnect` and the bot mention. `connect` says "already connected"; `disconnect` says "disconnected", republishes the user's App Home, and `GET /api/integrations/slack/connect` then shows `isConnected: false`. The second `disconnect` says "not connected", and the final `connect` links to `https://app.okou.test/settings/slack`.

## integrations.bdd-048

- Vitest: "INT-01: Slack app deep webhook flows > handles Slack commands for unknown workspaces and unbound installations"
- Mode: run
- Given: A Slack team has no Okou installation, and another Slack workspace is installed without an organization binding.
- When: Slack users post `/okou connect` and `/okou help` for the uninstalled team and `/okou help` for the unbound installation to `POST /api/webhooks/slack/commands`.
- Then: The uninstalled team's `connect` says the workspace "hasn't been set up"; its help contains "Slack Bot Help" and "mention it in a channel" without "@Okou". The unbound installation's help contains `/okou connect` and `/okou help`.

## integrations.bdd-049

- Vitest: "INT-01: Slack app deep webhook flows > prompts for login for an unsupported command without a Slack connection"
- Mode: run
- Given: A member on limited free onboarding installed Slack, and the commanding Slack user has no Okou connection.
- When: That user posts `/okou unknown` to `POST /api/webhooks/slack/commands`.
- Then: The response is ephemeral and mentions connecting.

## integrations.bdd-050

- Vitest: "INT-01: Slack app deep webhook flows > keeps App Home, welcome and account lifecycle behavior"
- Mode: run
- Given: A provisioned, onboarded member installed Slack, disconnected, and reconnected their Slack user from channel `C_BDD_HOME`. Later a second workspace is installed without an organization binding, and a third unbound workspace is installed that the member connects to.
- When: Through `POST /api/webhooks/slack/events` and `POST /api/webhooks/slack/interactive` the member opens App Home `home` twice and `messages` twice, clicks `home_disconnect` twice, opens `home` and `messages` again, Slack sends `app_uninstalled`; then the unbound workspace is uninstalled and its App Home opened; then the third workspace sends `tokens_revoked`.
- Then: Reconnecting sends a DM welcome containing "Hi! I'm". The home tab publishes a view with a `Settings` button (`home_environment_setup`) linking to `<APP_URL>/works`, "Connected to Okou", `/okou help`, "chat with Okou", `/okou connect` and `/okou disconnect`; opening Messages posts no message. The first disconnect click returns an empty body and publishes one view linking to `https://app.okou.ai/settings/slack`, and connect status becomes `isConnected: false`; the repeat click publishes nothing more. The home tab then shows "Account not connected" with a `Connect` button (`home_login_prompt`) linking to `<APP_URL>/settings/slack?w=<teamId>&u=<slackUserId>`, and Messages posts nothing. After `app_uninstalled`, `GET /api/integrations/slack` shows `isInstalled: false`, `isConnected: false`. The uninstalled unbound workspace publishes no App Home. After `tokens_revoked`, the status shows `isInstalled: false`, `isConnected: true`.

## integrations.bdd-051

- Vitest: "INT-01: Slack app deep webhook flows > retries a rejected DM welcome when the connected user opens Messages and stops after successful delivery"
- Mode: run
- Given: A member on limited free onboarding installed Slack, disconnected, and reconnected while Slack rejected the DM welcome with `cannot_dm_user`; the member's connect status is connected.
- When: The member opens the App Home Messages tab via `POST /api/webhooks/slack/events`; then opens it again while the retried welcome is still being delivered, opens it a third time during that delivery, and opens it once more after the welcome succeeds.
- Then: The first open retries the welcome once. The concurrent opens produce only one more delivery attempt (two in total), and the open after successful delivery sends no further welcome.

## integrations.bdd-052

- Vitest: "INT-01: Slack app deep webhook flows > replies with canonical run-creation errors for Slack messages"
- Mode: run
- Given: An onboarded member with native subscription models and a provisioned workspace installed Slack, but their plan was canceled so a run cannot be created.
- When: The member sends a DM "please run something" via `POST /api/webhooks/slack/events`.
- Then: Slack receives a threaded reply in the DM containing "Add credits" with no "Sent via" attribution, and the DM session status is set to `processing` and then `active`.

## integrations.bdd-053

- Vitest: "INT-01: Slack app deep webhook flows > keeps Slack reply and outbound attribution consistent across model changes"
- Mode: run
- Given: A member with a Pro entitlement connected a Codex OAuth model provider, prefers `gpt-6-astra`, has a provisioned workspace, and installed Slack; Slack reports the sender and the bot as members of channel `C_BDD_FAST_FOOTER`.
- When: The member mentions Okou and the Codex Run completes with "standard answer"; the member pins the thread to `gpt-6-astra` with service tier `fast` and replies in the thread; the fast Run's token posts `POST /api/integrations/slack/message` to the channel; the member clears the service tier and the fast Run completes with "fast answer".
- Then: The standard reply is posted with text "standard answer" and a single markdown block of the same text. The follow-up Run uses `codex` with `OKOU_CODEX_SERVICE_TIER` `fast`. The agent send returns HTTP 200 `{ ok: true }` and includes the attribution `Triggered by <@slackUserId>`. The fast reply is posted with text "fast answer" and a single markdown block of the same text.

## integrations.bdd-054

- Vitest: "INT-01: Slack app deep webhook flows > delivers canonical Slack callbacks for progress, attribution footers, failures, and Slack errors"
- Mode: run
- Given: A member with a Pro entitlement, native subscription models, a provisioned workspace, Okou debug enabled and a Web Push subscription installed Slack as the installer; a second member of the organization later connects a different Slack user and prefers `claude-fable-5-1`.
- When: Through `POST /api/webhooks/slack/events` and the agent heartbeat/events/complete webhooks: Run 1 heartbeats and completes with result "SLACK_BDD_OUTPUT" while realtime publications fail; Run 2 completes with a Codex agent message; the second member mentions Okou in Run 1's thread and that Run completes; Run 4 fails with "Cannot continue session from history"; a follow-up in that thread fails with exit code 1; Run 6 completes while Slack rejects the reply with `channel_not_found`.
- Then: The heartbeat sets Slack status `processing`. Run 1's result is posted in thread with text and one markdown block "SLACK_BDD_OUTPUT" even though message and thread-list realtime publications failed, status is then set to `active`, and the Run is `completed`. Run 2 posts "final codex answer". The second member's Run posts a reply attributed `Reply to <@slackUser2>` and completes. Runs 4 and 5 each post "Oops, something went wrong. Please try again later." and read `failed`. Run 6 attempts to post "UNDELIVERED_OUTPUT" in thread and still reads `completed`. No Web Push notification is sent and no notification-summary generation is requested.

## integrations.bdd-055

- Vitest: "INT-01: Slack app deep webhook flows > keeps canonical Slack callbacks visible when status updates fail and installs vanish"
- Mode: run
- Given: A member with a Pro entitlement and native subscription models installed Slack as the installer; the next Slack status update fails with an error.
- When: The member mentions Okou via `POST /api/webhooks/slack/events`, the Run heartbeats and completes with result "CALLBACK_RESILIENCE_OUTPUT"; a second mention starts another Run, Slack sends `app_uninstalled`, and that Run heartbeats and completes.
- Then: The first Run uses `claude-code` with `ANTHROPIC_MODEL` `claude-fable-5-1`; its heartbeat still attempts Slack status `processing`, the result is posted in thread, and the Run is `completed`. After uninstall, the second Run's heartbeat makes no Slack API call, its completion posts no Slack message, and it reads `completed`.

## integrations.bdd-056

- Vitest: "INT-02: Telegram integration > keeps Telegram webhook missing, auth, and no-op update boundaries visible"
- Mode: run
- Given: The official Telegram bot is first unconfigured, then configured with a bot token, webhook secret and username.
- When: Requests are posted to `POST /api/telegram/webhook/<officialBotId>`: unconfigured; configured without a secret header; with secret `bad-secret`; with the correct secret and an update without a message; and with the correct secret and a private message without text or media.
- Then: Unconfigured returns HTTP 404 `Not Found`. Missing and wrong secrets return HTTP 401 `Unauthorized`. Both no-op updates return HTTP 200 `OK`.

## integrations.bdd-057

- Vitest: "INT-02: Telegram integration > offers billing recovery when a running Telegram task runs out of credits"
- Mode: run
- Given: A member with a Pro entitlement, a Codex OAuth model provider, `gpt-6-astra` Fast preference and a provisioned workspace linked their Telegram account to the official bot with `POST /api/integrations/telegram/link`; Telegram accepts chat actions and messages.
- When: The member's private Telegram message "Finish this task" arrives at `POST /api/telegram/webhook/<officialBotId>`, and the dispatched Run's Sandbox reports completion with exit code 1 and failure reason `insufficient_credits`.
- Then: The last message the bot sends to the member contains a billing recovery link `/?settings=billing`.

## integrations.bdd-058

- Vitest: "INT-02: Telegram integration > keeps Telegram reply and outbound attribution consistent across model changes"
- Mode: run
- Given: A member with a Pro entitlement, Okou debug enabled, a Codex OAuth model provider, `gpt-6-astra` Fast preference, a Web Push subscription and a provisioned workspace linked their Telegram account (`BDD`) to the official bot; `APP_URL` is `https://app.okou.ai`.
- When: The member's private message arrives at `POST /api/telegram/webhook/<officialBotId>`; the dispatched Run's token sends `POST /api/integrations/telegram/message` to the member's chat; the member then changes their preference to `gpt-6-astra` without a service tier; the Run completes with a Codex agent message "telegram fast reply".
- Then: The webhook returns HTTP 200 `OK`. The Run uses `codex` with `OKOU_CODEX_SERVICE_TIER` `fast`. The agent send returns HTTP 200 `{ ok: true }` and Telegram receives `agent-initiated fast message` followed by the italic attribution `Triggered by <a href="tg://user?id=<telegramUserId>">BDD</a>`. On completion Telegram receives exactly one message "telegram fast reply", and no Web Push notification is sent.

## integrations.bdd-059

- Vitest: "INT-02: Telegram integration > refreshes telegram typing while the dispatched callback is pending"
- Mode: run
- Given: A member prefers `claude-fable-5-1`, has a provisioned workspace and linked their Telegram account to the official bot; `GET /api/integrations/telegram/link` reports `linked: true`.
- When: The member's private Telegram message arrives at `POST /api/telegram/webhook/<officialBotId>`; the dispatched Run's Sandbox posts an assistant event to the agent events webhook; the member cancels the Run; and the Sandbox posts the same event again.
- Then: The webhook returns HTTP 200 `OK`. The first event post returns `{ received: 1, firstSequence: 1, lastSequence: 1 }` and Telegram receives exactly one `typing` chat action for the DM chat. After cancellation the Run reads `cancelled`, the repeated event post returns the same receipt, and no further chat action is sent.

## integrations.bdd-060

- Vitest: "INT-03: GitHub and AgentPhone integrations > keeps GitHub OAuth install and connect-start errors visible through redirects"
- Mode: run
- Given: The App, Web and API base URLs are `https://app.okou.ai`, `https://www.okou.ai` and `https://api.okou.ai`. The GitHub App provider is first unconfigured, then configured for installs; an organization admin, a member of that organization, and an unauthenticated caller exist; user GitHub OAuth is not configured.
- When: Callers request `GET /api/github/oauth/install` unconfigured, unauthenticated after configuration, and as the member for their organization; then `GET /api/github/oauth/connect` unauthenticated, as a signed-in user with an unsigned `installation`/`ghUser` link, with a validly signed link for installation `12345`, and with no parameters.
- Then: Unconfigured install returns HTTP 503 `GitHub App integration is not configured`. The unauthenticated install redirects (307) to `/sign-in` with `Cache-Control: no-store`, and the member's install redirects with "Only organization admins can install GitHub". The unauthenticated connect redirects to `https://app.okou.ai/sign-in` with a `redirect_url` back to `/api/github/oauth/connect`. The unsigned link redirects with "Invalid or expired GitHub connect link", the signed link with "No GitHub installation found for this workspace", and the plain connect with "GitHub OAuth is not available".

## integrations.bdd-061

- Vitest: "INT-03: GitHub and AgentPhone integrations > starts configured GitHub user OAuth with connector state"
- Mode: run
- Given: The GitHub App provider is cleared and user GitHub OAuth is configured with client ID `bdd-github-client-id`; GitHub exchanges the code for a token with `repo,project,workflow` scope and reports user `bdd-github-user` (ID 4242, no email). The signed-in user has no GitHub connector account.
- When: The user requests `GET /api/github/oauth/connect`, then completes the connector OAuth callback for `github` with the returned state.
- Then: The response is a 307 redirect to `https://github.com/login/oauth/authorize` with the configured `client_id`, `redirect_uri` `https://api.okou.ai/api/connectors/github/callback`, a 64-hex-character `state` and `Cache-Control: no-store`, and no GitHub account exists yet. The callback redirects to `https://app.okou.ai/connector/success` without a message, the token exchange uses the same redirect URI, and the user now has one connected built-in GitHub OAuth account with external ID `4242`, username `bdd-github-user` and null email.

## integrations.bdd-062

- Vitest: "INT-03: GitHub and AgentPhone integrations > signs the GitHub install callback redirect in provider state"
- Mode: run
- Given: The GitHub App provider is configured for installs and callbacks; a signed-in admin starts an install.
- When: The admin requests `GET /api/github/oauth/install` for their user and organization, then GitHub calls `GET /api/github/app/setup/callback` with `error=access_denied` and the returned state, and again with a state whose `callbackRedirectUri` is changed to `https://attacker.example/callback`.
- Then: The install redirect's state carries `callbackRedirectUri` `https://api.okou.ai/api/github/app/setup/callback` plus 64-hex `callbackRedirectUriSig` and `sig`. Both callback errors redirect (307) to the `https://app.okou.ai` origin, including the tampered one.

## integrations.bdd-063

- Vitest: "INT-03: GitHub and AgentPhone integrations > keeps GitHub app setup callback errors visible through redirects"
- Mode: run
- Given: The App, Web and API base URLs are set; the GitHub App provider is first unconfigured, then configured for installs and callbacks; an organization admin exists.
- When: GitHub calls `GET /api/github/app/setup/callback` unconfigured, with `setup_action=update`, with `error=setup_denied`, with an invalid state, with an admin-issued state whose `sig` is zeroed, with `setup_action=request` and a valid state, and with `setup_action=install` and a valid state but no installation ID.
- Then: Every response is a 307 redirect: "GitHub App integration is not configured", a location containing `/workflows`, "Setup denied", "Invalid OAuth state", "Invalid state signature", a message about needing permission to install this GitHub App, and "Missing installation ID from GitHub".

## integrations.bdd-064

- Vitest: "INT-03: GitHub and AgentPhone integrations > keeps GitHub no-install read and upload-init surfaces visible through APIs"
- Mode: run
- Given: The GitHub App provider is configured; a signed-in organization admin and a member have no GitHub installation, and object storage accepts uploads.
- When: The admin and member read `GET /api/integrations/github`; the admin calls `POST /api/integrations/github/upload-file/init` for a 10-byte `artifact.txt`, then `POST /api/integrations/github/upload-file/complete` for repo `okou-ai/okou` issue 1.
- Then: The admin read returns HTTP 404 `No GitHub installation found` with an install URL at `https://github.com/apps/bdd-github-app/installations/new` whose `redirect_uri` is `https://api.okou.ai/api/github/app/setup/callback`; the member read returns HTTP 404 with a null install URL. Upload init returns HTTP 200 with the filename, `text/plain`, size 10 and an HTTP upload URL, and upload complete returns HTTP 404 `No GitHub installation found`.

## integrations.bdd-065

- Vitest: "INT-03: GitHub and AgentPhone integrations > keeps AgentPhone status, invalid connect, auth, and unlinked-send errors visible through APIs"
- Mode: run
- Given: AgentPhone is configured with agent number `+19039853128`; a signed-in user has no linked phone; one request is unauthenticated; object storage accepts uploads but later reports the uploaded artifact as missing.
- When: The user reads `GET /api/integrations/agentphone/link`, posts `POST /api/agentphone/connect` with signature `bad-signature`, sends `POST /api/integrations/phone/message` unauthenticated and authenticated, calls `POST /api/integrations/phone/upload-file/init` for a 13-byte `agentphone-note.txt`, then `POST /api/integrations/phone/upload-file/complete` for that upload.
- Then: Link status is exactly `{ linked: false, agentPhoneNumber: "+19039853128", configured: true }`. The bad-signature connect returns HTTP 400 `BAD_REQUEST`. The unauthenticated send returns HTTP 401 `UNAUTHORIZED`, and the unlinked send returns HTTP 404 `No phone is connected to this Okou account`. Upload init returns HTTP 200 with the filename, `text/plain`, size 13 and an HTTP upload URL, and upload complete returns HTTP 404 `NOT_FOUND`.

## integrations.bdd-066

- Vitest: "INT-03: GitHub and AgentPhone integrations > keeps AgentPhone start-link, unlink, and webhook boundaries visible through APIs"
- Mode: run
- Given: `APP_URL` is `https://app.okou.ai`; a signed-in user exists and the AgentPhone provider is first unconfigured, then configured with agent number `+19039853128` and a provider that accepts verification texts; the AgentPhone webhook secret is configured later.
- When: The user starts `POST /api/integrations/agentphone/link` unauthenticated, unconfigured, configured, and again immediately; connects with `POST /api/agentphone/connect` using a forged signature, channel `voice`, and the real link parameters; sends `POST /api/integrations/phone/message` without an agent ID, with it, when the provider omits a message ID, and when the provider returns 503; another user connects the same link; the user starts another link and unlinks twice with `DELETE /api/integrations/agentphone/link`; a new user starts a link; then `POST /api/agentphone/webhook` receives unconfigured, invalid-signature, lifecycle, unsupported-channel, missing-message-ID, missing-agent-ID, wrong-destination, invalid-recipient, duplicate SMS `/connect`, and unmentioned group payloads.
- Then: Start-link returns HTTP 401 `UNAUTHORIZED`, HTTP 503 `Phone messaging is not configured` (`NOT_CONFIGURED`), HTTP 200 `{ phoneHandle, verificationSent: true }`, then HTTP 429 `TOO_MANY_REQUESTS`; the verification text links to `https://app.okou.ai` with query keys `handle`, `agent`, `ts`, `sig`, `channel`. The forged and `voice` connects return HTTP 400 and leave the user unlinked; the real connect returns `{ phoneHandle }` and status becomes linked with that handle. Sends return HTTP 404 `Phone agent not found`, then HTTP 200 `{ ok: true, messageId: "msg-bdd-agentphone", channel: "sms", toNumber }`, then an undeclared HTTP 500, then HTTP 502 `AGENTPHONE_ERROR`. The duplicate connect and the second start-link return HTTP 409 `CONFLICT`. Unlink returns HTTP 204 and status returns to unlinked, a second unlink returns HTTP 404, and a new user's start-link, while the provider still returns 503, returns HTTP 503 `PROVIDER_UNAVAILABLE` asking to wait a minute. The unconfigured webhook returns HTTP 404 `Not Found` and the invalid signature HTTP 401 `Unauthorized`; lifecycle, unsupported channel, wrong destination, both SMS deliveries and the unmentioned group message return HTTP 200 `OK`; missing message ID, missing agent ID and invalid recipient return HTTP 500 with their specific error texts.
