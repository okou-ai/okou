# feishu-conversation

## feishu-conversation-001

- Vitest: "feishu integration > offers billing recovery when a running task runs out of credits"
- Mode: run
- Given: Platform: Feishu. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Feishu custom app installation and an online Runner group, and has connected their Feishu account (open ID `ou_feishu_user`).
- When: The user sends a direct message as a signed, encrypted `im.message.receive_v1` event to `POST /api/webhooks/feishu/events/:installationId`, the Runner picks up the run via `POST /api/runners/heartbeat`, and the sandbox reports `POST /api/webhooks/run/complete` with exit code 1 and error and failure reason `insufficient_credits`.
- Then: The completion returns HTTP 200, and at least one message sent back to Feishu after the failure contains a `/?settings=billing` link.

## feishu-conversation-002

- Vitest: "feishu integration > retains platform run history when a model change starts a fresh session"
- Mode: run
- Given: Platform: Feishu. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Feishu custom app installation and an online Runner group. The admin has connected their Feishu account and completed a first Feishu direct-message run inside Feishu thread T with a native Claude session. The admin then connects a personal Claude subscription and completes a personal Codex device login, and changes the resulting chat thread's model to `gpt-6-astra` with `POST /api/chat-threads/:id/model-selection` (HTTP 204).
- When: The user sends another direct message in the same Feishu thread T to `POST /api/webhooks/feishu/events/:installationId`, and the Runner picks up the new run via `POST /api/runners/heartbeat`.
- Then: `GET /api/logs/:id` reports trigger source `feishu` for the new run. The chat thread's event rows (`GET /api/chat-threads/:threadId/event-rows`) contain an `input.prompt` event for that run whose user message includes a `feishu` source part. The run's execution input carries a native-continuation recovery prompt containing `okou chat messages --output-dir /tmp/okou-chat-history`.

## feishu-conversation-003

- Vitest: "feishu integration > builds Feishu DM context and canonical response metadata"
- Mode: run
- Given: Platform: Feishu. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Feishu custom app installation and an online Runner group, and has connected their Feishu account (open ID `ou_feishu_user`, display name Feishu User). The Feishu chat history API returns two earlier direct messages from Previous User (`ou_previous_user`): the text "Earlier Feishu conversation context" and a file `history-report.pdf` with a long raw file key.
- When: The user sends the direct message "do the Feishu task" in chat `oc_feishu_dm` to `POST /api/webhooks/feishu/events/:installationId`; the admin reads `GET /api/logs` filtered by trigger source `feishu` and `lark`, `GET /api/logs/:id` and the chat thread's event rows; the Runner picks up the run; the sandbox posts the assistant answer "Canonical Feishu answer" to `POST /api/webhooks/run/events` and completes with a CLI session through `POST /api/webhooks/run/complete`; finally the admin calls `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: Exactly one reaction is added to the incoming message and no `feishu:changed` realtime publication with a null payload occurs. The run has trigger source `feishu`: the `feishu` log filter lists it and offers `feishu` as a source, while the `lark` filter returns no runs. The chat thread holds a user message with the text "do the Feishu task" and a `feishu` source linking to `https://applink.feishu.cn/client/chat/open?openChatId=oc_feishu_dm`. The execution has that prompt, `OKOU_CHAT_THREAD_ID` set to the chat thread and `OKOU_CURRENT_INTEGRATION` set to `feishu`; its system prompt says it runs inside Feishu, includes Current User Info with the Feishu display name and open ID, Direct message scope, the tenant key, chat ID `oc_feishu_dm` (no Group ID) and the installation ID, the `okou feishu` messaging, message send, download-file and upload-file help, no Lark messaging or open ID lines, and a Feishu Thread Context with the earlier text (relative index -1, sender Previous User) and the file as an opaque `feishu_file_` reference instead of the raw key. After completion the queued input is claimed into an `input.prompt` event for the run that revokes the queued event, exactly one interactive card titled Okou with the answer as markdown is sent as an in-thread reply to the original message, one reaction is removed, and the installation removal returns HTTP 200.

## feishu-conversation-004

- Vitest: "feishu integration > keeps Feishu group control cases out of runs"
- Mode: run
- Given: Platform: Feishu. A workspace admin has a set-up Feishu custom app installation. A second workspace member with the Feishu integration enabled has not yet connected their Feishu account (open ID `ou_feishu_canonical_group_user`).
- When: The member mentions the bot in group `oc_feishu_group` with "unconnected group task" via `POST /api/webhooks/feishu/events/:installationId`; then, after connecting their Feishu account, mentions the bot with `/help`.
- Then: The first mention gets a reply containing "Connect your account" and the `/help` mention gets a message containing "Okou Feishu commands". Neither `@Nova unconnected group task` nor `@Nova /help` appears among the member's pending or running runs in `GET /api/logs`.

## feishu-conversation-005

- Vitest: "feishu integration > resumes queued Feishu group tasks through the canonical session"
- Mode: run
- Given: Platform: Feishu. A workspace admin has a set-up Feishu custom app installation and an online Runner group. A second, onboarded member has connected their Feishu account (open ID `ou_feishu_canonical_group_user`) and their own personal Claude subscription with model `claude-fable-5-1`.
- When: The member mentions the bot in group `oc_feishu_group` with "first canonical group task", then mentions it with "second queued canonical group task" in a thread rooted at the first message while the first run is still active (both via `POST /api/webhooks/feishu/events/:installationId`); the Runner picks up the first run, the sandbox completes it with a CLI session ID through `POST /api/webhooks/run/complete`, and the Runner then picks up the next run.
- Then: Before the first run completes, `GET /api/logs` shows no run for `@Nova second queued canonical group task` and the member's chat thread holds it as a queued `input.prompt` without a run. After completion a run for the second prompt exists with trigger source `feishu`; its execution prompt is `@Nova second queued canonical group task`, its system prompt contains "Scope: Group mention", and its native continuation resumes the first run's CLI session ID.

## feishu-conversation-006

- Vitest: "feishu integration > ignores unmentioned group messages, app messages and system notifications"
- Mode: run
- Given: Platform: Feishu. A workspace admin has a set-up Feishu custom app installation and has connected their Feishu account (open ID `ou_feishu_user`).
- When: Feishu delivers four message events to `POST /api/webhooks/feishu/events/:installationId`: a group message without a bot mention, a group message mentioning another bot (`ou_another_bot`), an app-authored group message mentioning the bot, and a direct-chat `system` notification message.
- Then: None of the admin's pending or running runs listed by `GET /api/logs` has a prompt containing "ignore ".

## feishu-conversation-007

- Vitest: "feishu integration > runs mention-only group requests with thread history and dedupe"
- Mode: run
- Given: Platform: Feishu. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Feishu custom app installation and an online Runner group, and has connected their Feishu account. The Feishu chat history API returns a recent group message from Recent User and the thread root "Thread root question"; the thread history API returns a copy of the current message, a file `topic-context.pdf`, a reply from Thread User linking `https://example.com/broken-article`, a deleted reply and the root. The Feishu resource API serves the file.
- When: The same mention-only group event (just `@Nova`, no text) in that thread of `oc_feishu_group` is delivered twice to `POST /api/webhooks/feishu/events/:installationId`; the Runner picks up the run; the file is downloaded with `GET /api/integrations/feishu/download-file` using the run's Okou token; and the run completes with "Canonical Feishu group answer".
- Then: Exactly one active run with prompt `@Nova` exists. Its system prompt has Group mention scope, the tenant key, chat ID and group ID `oc_feishu_group` (usable as `--to` for `okou feishu message send`), the thread ID, a Recent Channel Messages section and a Feishu Thread Context with both senders, the recent context and the URL; the root question appears exactly once, the current message copy and the deleted reply are absent, and the thread context orders root, URL reply, then file. The file appears as a single opaque `feishu_file_` reference (no raw key) that downloads with HTTP 200 and the file bytes. The final reply to the mention is sent in thread and does not contain "Reply to".

## feishu-conversation-008

- Vitest: "feishu integration > keeps available conversation context when chat history fails"
- Mode: run
- Given: Platform: Feishu. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Feishu custom app installation and an online Runner group, and has connected their Feishu account. Parameter `chat`: the Feishu message history API fails with HTTP 500 for the group chat history, while the thread history returns "Thread history survived".
- When: The admin mentions the bot with "continue this topic" in a thread of group `oc_feishu_group` via `POST /api/webhooks/feishu/events/:installationId`, and the Runner picks up the run.
- Then: A run with prompt `@Nova continue this topic` is still created, and its system prompt contains "Thread history survived".

## feishu-conversation-009

- Vitest: "feishu integration > keeps available conversation context when thread history fails"
- Mode: run
- Given: Platform: Feishu. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Feishu custom app installation and an online Runner group, and has connected their Feishu account. Parameter `thread`: the Feishu message history API fails with HTTP 500 for the thread history, while the group chat history returns "Recent chat survived".
- When: The admin mentions the bot with "continue this topic" in a thread of group `oc_feishu_group` via `POST /api/webhooks/feishu/events/:installationId`, and the Runner picks up the run.
- Then: A run with prompt `@Nova continue this topic` is still created, and its system prompt contains "Recent chat survived".

## feishu-conversation-010

- Vitest: "feishu integration > attributes mentioned group replies to the triggering user"
- Mode: run
- Given: Platform: Feishu. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Feishu custom app installation and an online Runner group, and has connected their Feishu account (open ID `ou_feishu_user`). The admin's group mention "establish group reply attribution" started a run that was picked up and then cancelled. A second, onboarded member has connected their Feishu account (open ID `ou_feishu_second_user`) and their own personal Claude subscription.
- When: The second member mentions the bot with "handle this group task as another user" in the thread rooted at the admin's message via `POST /api/webhooks/feishu/events/:installationId`; the Runner picks up the run and the sandbox completes it with the answer "Canonical Feishu second group answer".
- Then: A run is created for the second member, and the Feishu reply carrying the answer contains `Reply to <at id=ou_feishu_second_user></at>`.

## feishu-conversation-011

- Vitest: "lark integration > offers billing recovery when a running task runs out of credits"
- Mode: run
- Given: Platform: Lark. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Lark custom app installation and an online Runner group, and has connected their Lark account (open ID `ou_feishu_user`).
- When: The user sends a direct message as a signed, encrypted `im.message.receive_v1` event to `POST /api/webhooks/feishu/events/:installationId`, the Runner picks up the run via `POST /api/runners/heartbeat`, and the sandbox reports `POST /api/webhooks/run/complete` with exit code 1 and error and failure reason `insufficient_credits`.
- Then: The completion returns HTTP 200, and at least one message sent back to Lark after the failure contains a `/?settings=billing` link.

## feishu-conversation-012

- Vitest: "lark integration > retains platform run history when a model change starts a fresh session"
- Mode: run
- Given: Platform: Lark. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Lark custom app installation and an online Runner group. The admin has connected their Lark account and completed a first Lark direct-message run inside Lark thread T with a native Claude session. The admin then connects a personal Claude subscription and completes a personal Codex device login, and changes the resulting chat thread's model to `gpt-6-astra` with `POST /api/chat-threads/:id/model-selection` (HTTP 204).
- When: The user sends another direct message in the same Lark thread T to `POST /api/webhooks/feishu/events/:installationId`, and the Runner picks up the new run via `POST /api/runners/heartbeat`.
- Then: `GET /api/logs/:id` reports trigger source `lark` for the new run. The chat thread's event rows (`GET /api/chat-threads/:threadId/event-rows`) contain an `input.prompt` event for that run whose user message includes a `lark` source part. The run's execution input carries a native-continuation recovery prompt containing `okou chat messages --output-dir /tmp/okou-chat-history`.

## feishu-conversation-013

- Vitest: "lark integration > builds Feishu DM context and canonical response metadata"
- Mode: run
- Given: Platform: Lark. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Lark custom app installation and an online Runner group, and has connected their Lark account (open ID `ou_feishu_user`, display name Feishu User). The Lark chat history API returns two earlier direct messages from Previous User (`ou_previous_user`): the text "Earlier Feishu conversation context" and a file `history-report.pdf` with a long raw file key.
- When: The user sends the direct message "do the Feishu task" in chat `oc_feishu_dm` to `POST /api/webhooks/feishu/events/:installationId`; the admin reads `GET /api/logs` filtered by trigger source `lark` and `feishu`, `GET /api/logs/:id` and the chat thread's event rows; the Runner picks up the run; the sandbox posts the assistant answer "Canonical Feishu answer" to `POST /api/webhooks/run/events` and completes with a CLI session through `POST /api/webhooks/run/complete`; finally the admin calls `DELETE /api/integrations/lark/installations/:installationId`.
- Then: Exactly one reaction is added to the incoming message and no `feishu:changed` realtime publication with a null payload occurs. The run has trigger source `lark`: the `lark` log filter lists it and offers `lark` as a source, while the `feishu` filter returns no runs. The chat thread holds a user message with the text "do the Feishu task" and a `lark` source linking to `https://applink.larksuite.com/client/chat/open?openChatId=oc_feishu_dm`. The execution has that prompt, `OKOU_CHAT_THREAD_ID` set to the chat thread and `OKOU_CURRENT_INTEGRATION` set to `lark`; its system prompt says it runs inside Lark, includes Current User Info with the Lark display name and open ID, Direct message scope, the tenant key, chat ID `oc_feishu_dm` (no Group ID) and the installation ID, the `okou lark` messaging, message send, download-file and upload-file help, no Feishu messaging or open ID lines, and a Lark Thread Context with the earlier text (relative index -1, sender Previous User) and the file as an opaque `feishu_file_` reference instead of the raw key. After completion the queued input is claimed into an `input.prompt` event for the run that revokes the queued event, exactly one interactive card titled Okou with the answer as markdown is sent as an in-thread reply to the original message, one reaction is removed, and the installation removal returns HTTP 200.

## feishu-conversation-014

- Vitest: "lark integration > keeps Feishu group control cases out of runs"
- Mode: run
- Given: Platform: Lark. A workspace admin has a set-up Lark custom app installation. A second workspace member with the Lark integration enabled has not yet connected their Lark account (open ID `ou_feishu_canonical_group_user`).
- When: The member mentions the bot in group `oc_feishu_group` with "unconnected group task" via `POST /api/webhooks/feishu/events/:installationId`; then, after connecting their Lark account, mentions the bot with `/help`.
- Then: The first mention gets a reply containing "Connect your account" and the `/help` mention gets a message containing "Okou Feishu commands". Neither `@Nova unconnected group task` nor `@Nova /help` appears among the member's pending or running runs in `GET /api/logs`.

## feishu-conversation-015

- Vitest: "lark integration > resumes queued Feishu group tasks through the canonical session"
- Mode: run
- Given: Platform: Lark. A workspace admin has a set-up Lark custom app installation and an online Runner group. A second, onboarded member has connected their Lark account (open ID `ou_feishu_canonical_group_user`) and their own personal Claude subscription with model `claude-fable-5-1`.
- When: The member mentions the bot in group `oc_feishu_group` with "first canonical group task", then mentions it with "second queued canonical group task" in a thread rooted at the first message while the first run is still active (both via `POST /api/webhooks/feishu/events/:installationId`); the Runner picks up the first run, the sandbox completes it with a CLI session ID through `POST /api/webhooks/run/complete`, and the Runner then picks up the next run.
- Then: Before the first run completes, `GET /api/logs` shows no run for `@Nova second queued canonical group task` and the member's chat thread holds it as a queued `input.prompt` without a run. After completion a run for the second prompt exists with trigger source `lark`; its execution prompt is `@Nova second queued canonical group task`, its system prompt contains "Scope: Group mention", and its native continuation resumes the first run's CLI session ID.

## feishu-conversation-016

- Vitest: "lark integration > ignores unmentioned group messages, app messages and system notifications"
- Mode: run
- Given: Platform: Lark. A workspace admin has a set-up Lark custom app installation and has connected their Lark account (open ID `ou_feishu_user`).
- When: Lark delivers four message events to `POST /api/webhooks/feishu/events/:installationId`: a group message without a bot mention, a group message mentioning another bot (`ou_another_bot`), an app-authored group message mentioning the bot, and a direct-chat `system` notification message.
- Then: None of the admin's pending or running runs listed by `GET /api/logs` has a prompt containing "ignore ".

## feishu-conversation-017

- Vitest: "lark integration > runs mention-only group requests with thread history and dedupe"
- Mode: run
- Given: Platform: Lark. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Lark custom app installation and an online Runner group, and has connected their Lark account. The Lark chat history API returns a recent group message from Recent User and the thread root "Thread root question"; the thread history API returns a copy of the current message, a file `topic-context.pdf`, a reply from Thread User linking `https://example.com/broken-article`, a deleted reply and the root. The Lark resource API serves the file.
- When: The same mention-only group event (just `@Nova`, no text) in that thread of `oc_feishu_group` is delivered twice to `POST /api/webhooks/feishu/events/:installationId`; the Runner picks up the run; the file is downloaded with `GET /api/integrations/lark/download-file` using the run's Okou token; and the run completes with "Canonical Feishu group answer".
- Then: Exactly one active run with prompt `@Nova` exists. Its system prompt has Group mention scope, the tenant key, chat ID and group ID `oc_feishu_group` (usable as `--to` for `okou lark message send`), the thread ID, a Recent Channel Messages section and a Lark Thread Context with both senders, the recent context and the URL; the root question appears exactly once, the current message copy and the deleted reply are absent, and the thread context orders root, URL reply, then file. The file appears as a single opaque `feishu_file_` reference (no raw key) that downloads with HTTP 200 and the file bytes. The final reply to the mention is sent in thread and does not contain "Reply to".

## feishu-conversation-018

- Vitest: "lark integration > keeps available conversation context when chat history fails"
- Mode: run
- Given: Platform: Lark. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Lark custom app installation and an online Runner group, and has connected their Lark account. Parameter `chat`: the Lark message history API fails with HTTP 500 for the group chat history, while the thread history returns "Thread history survived".
- When: The admin mentions the bot with "continue this topic" in a thread of group `oc_feishu_group` via `POST /api/webhooks/feishu/events/:installationId`, and the Runner picks up the run.
- Then: A run with prompt `@Nova continue this topic` is still created, and its system prompt contains "Thread history survived".

## feishu-conversation-019

- Vitest: "lark integration > keeps available conversation context when thread history fails"
- Mode: run
- Given: Platform: Lark. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Lark custom app installation and an online Runner group, and has connected their Lark account. Parameter `thread`: the Lark message history API fails with HTTP 500 for the thread history, while the group chat history returns "Recent chat survived".
- When: The admin mentions the bot with "continue this topic" in a thread of group `oc_feishu_group` via `POST /api/webhooks/feishu/events/:installationId`, and the Runner picks up the run.
- Then: A run with prompt `@Nova continue this topic` is still created, and its system prompt contains "Recent chat survived".

## feishu-conversation-020

- Vitest: "lark integration > attributes mentioned group replies to the triggering user"
- Mode: run
- Given: Platform: Lark. A workspace admin with a Pro entitlement and a personal Claude subscription has a set-up Lark custom app installation and an online Runner group, and has connected their Lark account (open ID `ou_feishu_user`). The admin's group mention "establish group reply attribution" started a run that was picked up and then cancelled. A second, onboarded member has connected their Lark account (open ID `ou_feishu_second_user`) and their own personal Claude subscription.
- When: The second member mentions the bot with "handle this group task as another user" in the thread rooted at the admin's message via `POST /api/webhooks/feishu/events/:installationId`; the Runner picks up the run and the sandbox completes it with the answer "Canonical Feishu second group answer".
- Then: A run is created for the second member, and the Lark reply carrying the answer contains `Reply to <at id=ou_feishu_second_user></at>`.
