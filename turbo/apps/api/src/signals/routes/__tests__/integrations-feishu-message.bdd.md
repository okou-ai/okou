# integrations-feishu-message

## integrations-feishu-message-001

- Vitest: "POST /api/integrations/feishu/message > requires authentication and the feishu:write capability"
- Mode: run
- Given: One caller sends no credentials; another uses a run's sandbox token, which lacks the `feishu:write` capability.
- When: Each caller sends `POST /api/integrations/feishu/message` with `chat: "oc_chat"` and text "hello".
- Then: The unauthenticated request returns HTTP 401 with error code `UNAUTHORIZED`. The sandbox-token request returns HTTP 403 with an error message mentioning `feishu:write`.

## integrations-feishu-message-002

- Vitest: "POST /api/integrations/feishu/message > sends chat, current-user, and threaded reply messages on feishu"
- Mode: run
- Given: A Pro-entitled workspace admin has a completed Feishu installation and has connected their Feishu identity (`ou_current_user`, "Feishu CLI User"); the user and bot are members of the target group chat. The caller uses a run's Okou token.
- When: The caller sends `POST /api/integrations/feishu/message` with text to chat `oc_target_chat`; a schema 2.0 card, a legacy card and a template card to `user: "me"`; and a threaded text reply to `om_parent`.
- Then: The first send returns exactly `{ ok: true, messageId: "om_1", chatId: "oc_feishu_cli" }`. Feishu receives, in order: a `chat_id` text send to `oc_target_chat` ending with `Triggered by <at user_id="ou_current_user">Feishu CLI User</at>`; an `open_id` interactive send to `ou_current_user` with the 2.0 card plus an `hr` and a notation-size "Triggered by" markdown element; the legacy card plus an `hr` and a `note` with a `lark_md` "Triggered by" mention; the template card unchanged; and a reply to `om_parent` with the text plus attribution and `reply_in_thread` true.

## integrations-feishu-message-003

- Vitest: "POST /api/integrations/feishu/message > sends chat, current-user, and threaded reply messages on lark"
- Mode: run
- Given: A Pro-entitled workspace admin has a completed Lark installation and has connected their Lark identity (`ou_current_user`, "Feishu CLI User"); the user and bot are members of the target group chat. The caller uses a run's Okou token.
- When: The caller sends `POST /api/integrations/lark/message` with text to chat `oc_target_chat`; a schema 2.0 card, a legacy card and a template card to `user: "me"`; and a threaded text reply to `om_parent`.
- Then: The first send returns exactly `{ ok: true, messageId: "om_1", chatId: "oc_feishu_cli" }`. Lark receives, in order: a `chat_id` text send to `oc_target_chat` ending with `Triggered by <at user_id="ou_current_user">Feishu CLI User</at>`; an `open_id` interactive send to `ou_current_user` with the 2.0 card plus an `hr` and a notation-size "Triggered by" markdown element; the legacy card plus an `hr` and a `note` with a `lark_md` "Triggered by" mention; the template card unchanged; and a reply to `om_parent` with the text plus attribution and `reply_in_thread` true.

## integrations-feishu-message-004

- Vitest: "POST /api/integrations/feishu/message > maps Feishu request and response failures to contract errors"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token. Feishu answers the first message send with code 230001 "chat not found" and the second with success but no message data.
- When: The caller sends `POST /api/integrations/feishu/message` to chat `oc_missing` twice.
- Then: The first request returns HTTP 400 with error exactly `{ code: "FEISHU_ERROR", message: "Feishu API error: chat not found" }`. The second returns HTTP 502 with error `{ code: "FEISHU_ERROR", message: "Feishu API error: Feishu message response is incomplete" }`.

## integrations-feishu-message-005

- Vitest: "POST /api/integrations/feishu/message > denies feishu writes and downloads after the user leaves the chat"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token, but the target chat's member list no longer includes the user.
- When: The caller sends `POST /api/integrations/feishu/message` to `oc_target_chat` and as a reply to `om_parent`, then requests `GET /api/integrations/feishu/download-file` for a file in `om_parent`.
- Then: Both sends and the download return HTTP 403, and no message is sent to Feishu.

## integrations-feishu-message-006

- Vitest: "POST /api/integrations/feishu/message > denies lark writes and downloads after the user leaves the chat"
- Mode: run
- Given: A workspace admin has a connected Lark installation and uses a run's Okou token, but the target chat's member list no longer includes the user.
- When: The caller sends `POST /api/integrations/lark/message` to `oc_target_chat` and as a reply to `om_parent`, then requests `GET /api/integrations/lark/download-file` for a file in `om_parent`.
- Then: Both sends and the download return HTTP 403, and no message is sent to Lark.

## integrations-feishu-message-007

- Vitest: "POST /api/integrations/feishu/message > allows outbound feishu DMs without granting private file access"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token. The target chat is a p2p DM whose only member is `ou_recipient`.
- When: The caller sends `POST /api/integrations/feishu/message` to `user: "ou_recipient"`, to chat `oc_target_chat`, and as a reply to `om_parent`, then requests `GET /api/integrations/feishu/download-file` for a file in `om_parent`.
- Then: All three sends return HTTP 200, Feishu receives three messages, and the first is an `open_id` send to `ou_recipient`. The download returns HTTP 403.

## integrations-feishu-message-008

- Vitest: "POST /api/integrations/feishu/message > allows outbound lark DMs without granting private file access"
- Mode: run
- Given: A workspace admin has a connected Lark installation and uses a run's Okou token. The target chat is a p2p DM whose only member is `ou_recipient`.
- When: The caller sends `POST /api/integrations/lark/message` to `user: "ou_recipient"`, to chat `oc_target_chat`, and as a reply to `om_parent`, then requests `GET /api/integrations/lark/download-file` for a file in `om_parent`.
- Then: All three sends return HTTP 200, Lark receives three messages, and the first is an `open_id` send to `ou_recipient`. The download returns HTTP 403.

## integrations-feishu-message-009

- Vitest: "POST /api/integrations/feishu/message > checks every Feishu membership page before allowing a shared chat"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token. Feishu's chat member list returns an empty first page with `has_more` and a second page containing the user.
- When: The caller sends `POST /api/integrations/feishu/message` to `oc_target_chat`.
- Then: The response is HTTP 200. Feishu's member list is requested with no page token and then with `second-page`, and exactly one message is sent.

## integrations-feishu-message-010

- Vitest: "POST /api/integrations/feishu/message > denies a Feishu write with absent bot"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token, but Feishu reports the bot is not in the target chat.
- When: The caller sends `POST /api/integrations/feishu/message` to `oc_target_chat`.
- Then: The response is HTTP 403 and no message is sent.

## integrations-feishu-message-011

- Vitest: "POST /api/integrations/feishu/message > denies a Feishu write with provider unavailable"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token, but Feishu's bot-membership check responds with HTTP 503.
- When: The caller sends `POST /api/integrations/feishu/message` to `oc_target_chat`.
- Then: The response is HTTP 502 and no message is sent.

## integrations-feishu-message-012

- Vitest: "POST /api/integrations/feishu/message > denies a Feishu write with invalid provider data"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token, but Feishu's bot-membership check returns success without an `is_in_chat` value.
- When: The caller sends `POST /api/integrations/feishu/message` to `oc_target_chat`.
- Then: The response is HTTP 502 and no message is sent.

## integrations-feishu-message-013

- Vitest: "POST /api/integrations/feishu/message > requires a verified Feishu identity for raw chat and user IDs"
- Mode: run
- Given: A workspace admin has a completed Feishu installation but has not connected their Feishu identity, and uses a run's Okou token.
- When: The caller sends `POST /api/integrations/feishu/message` to chat `oc_target_chat` and to user `ou_current_user`.
- Then: Both requests return HTTP 403 with error code `FEISHU_ERROR`, and no message is sent.

## integrations-feishu-message-014

- Vitest: "POST /api/integrations/feishu/message > does not borrow a bot's posting permission in a restricted Feishu group"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token. The target group only lets its owner (`ou_owner`, not the user) post.
- When: The caller sends `POST /api/integrations/feishu/message` to `oc_target_chat`.
- Then: The response is HTTP 403 with error code `FEISHU_ERROR`, and no message is sent.

## integrations-feishu-message-015

- Vitest: "POST /api/integrations/feishu/message > checks the Feishu caller's restricted-group role: owner"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token. The target group restricts posting to its moderator list, and the user is the group owner.
- When: The caller sends `POST /api/integrations/feishu/message` to `oc_target_chat`.
- Then: The response is HTTP 200 and exactly one message is sent.

## integrations-feishu-message-016

- Vitest: "POST /api/integrations/feishu/message > checks the Feishu caller's restricted-group role: manager"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token. The target group restricts posting to its moderator list, and the user is a group manager.
- When: The caller sends `POST /api/integrations/feishu/message` to `oc_target_chat`.
- Then: The response is HTTP 200 and exactly one message is sent.

## integrations-feishu-message-017

- Vitest: "POST /api/integrations/feishu/message > checks the Feishu caller's restricted-group role: moderator"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token. The target group restricts posting to its moderator list, and the user is on that list.
- When: The caller sends `POST /api/integrations/feishu/message` to `oc_target_chat`.
- Then: The response is HTTP 200 and exactly one message is sent.

## integrations-feishu-message-018

- Vitest: "POST /api/integrations/feishu/message > checks the Feishu caller's restricted-group role: other"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token. The target group restricts posting to its moderator list, and the user is not the owner, a manager or a moderator.
- When: The caller sends `POST /api/integrations/feishu/message` to `oc_target_chat`.
- Then: The response is HTTP 403 and no message is sent.

## integrations-feishu-message-019

- Vitest: "POST /api/integrations/feishu/message > downloads a resource from a feishu message"
- Mode: run
- Given: A workspace admin has a connected Feishu installation and uses a run's Okou token. Feishu serves resource `file_resource` of message `om_resource` as a PDF named `report.pdf`.
- When: The caller requests `GET /api/integrations/feishu/download-file` with the installation, `message_id=om_resource`, `file_key=file_resource` and `type=file`.
- Then: Feishu is called with `type=file` and the tenant access token. The response is HTTP 200 with content type `application/pdf`, `x-file-name` "report.pdf", `x-file-mimetype` "application/pdf", and the exact resource bytes.

## integrations-feishu-message-020

- Vitest: "POST /api/integrations/feishu/message > downloads a resource from a lark message"
- Mode: run
- Given: A workspace admin has a connected Lark installation and uses a run's Okou token. Lark serves resource `file_resource` of message `om_resource` as a PDF named `report.pdf`.
- When: The caller requests `GET /api/integrations/lark/download-file` with the installation, `message_id=om_resource`, `file_key=file_resource` and `type=file`.
- Then: Lark is called with `type=file` and the tenant access token. The response is HTTP 200 with content type `application/pdf`, `x-file-name` "report.pdf", `x-file-mimetype` "application/pdf", and the exact resource bytes.

## integrations-feishu-message-021

- Vitest: "POST /api/integrations/feishu/message > authorizes a stored feishu file (membership revoked: false; other recipient DM: false)"
- Mode: run
- Given: A Pro-entitled workspace admin with a connected Feishu installation launched a Web run and uses its Okou token. The user stays a member of the target chat.
- When: The run calls `POST /api/integrations/feishu/upload-file/init` for `report.pdf`, uploads the bytes to the returned URL, then calls `POST /api/integrations/feishu/upload-file/complete` targeting chat `oc_file_target`.
- Then: Feishu receives a stream upload of `report.pdf` with the exact bytes. The completion returns HTTP 200 with message `om_1`, chat `oc_feishu_cli`, file key `file_uploaded`, filename, MIME type, size and the init's artifact `fileUrl`. Exactly one `chat_id` file message is sent to `oc_file_target`, and the run's thread artifacts list one file with ID `om_1`, `report.pdf`, `application/pdf`, the size and the same URL.

## integrations-feishu-message-022

- Vitest: "POST /api/integrations/feishu/message > authorizes a stored lark file (membership revoked: false; other recipient DM: false)"
- Mode: run
- Given: A Pro-entitled workspace admin with a connected Lark installation launched a Web run and uses its Okou token. The user stays a member of the target chat.
- When: The run calls `POST /api/integrations/lark/upload-file/init` for `report.pdf`, uploads the bytes to the returned URL, then calls `POST /api/integrations/lark/upload-file/complete` targeting chat `oc_file_target`.
- Then: Lark receives a stream upload of `report.pdf` with the exact bytes. The completion returns HTTP 200 with message `om_1`, chat `oc_feishu_cli`, file key `file_uploaded`, filename, MIME type, size and the init's artifact `fileUrl`. Exactly one `chat_id` file message is sent to `oc_file_target`, and the run's thread artifacts list one file with ID `om_1`, `report.pdf`, `application/pdf`, the size and the same URL.

## integrations-feishu-message-023

- Vitest: "POST /api/integrations/feishu/message > authorizes a stored feishu file (membership revoked: true; other recipient DM: false)"
- Mode: run
- Given: A Pro-entitled workspace admin with a connected Feishu installation launched a Web run and uses its Okou token. The user is removed from the target chat while Feishu processes the file upload.
- When: The run calls `POST /api/integrations/feishu/upload-file/init` for `report.pdf`, uploads the bytes, then calls `POST /api/integrations/feishu/upload-file/complete` targeting chat `oc_file_target`.
- Then: The completion returns HTTP 403 and no message is sent.

## integrations-feishu-message-024

- Vitest: "POST /api/integrations/feishu/message > authorizes a stored lark file (membership revoked: true; other recipient DM: false)"
- Mode: run
- Given: A Pro-entitled workspace admin with a connected Lark installation launched a Web run and uses its Okou token. The user is removed from the target chat while Lark processes the file upload.
- When: The run calls `POST /api/integrations/lark/upload-file/init` for `report.pdf`, uploads the bytes, then calls `POST /api/integrations/lark/upload-file/complete` targeting chat `oc_file_target`.
- Then: The completion returns HTTP 403 and no message is sent.

## integrations-feishu-message-025

- Vitest: "POST /api/integrations/feishu/message > authorizes a stored feishu file (membership revoked: false; other recipient DM: true)"
- Mode: run
- Given: A Pro-entitled workspace admin with a connected Feishu installation launched a Web run and uses its Okou token.
- When: The run calls `POST /api/integrations/feishu/upload-file/init` for `report.pdf`, uploads the bytes, then calls `POST /api/integrations/feishu/upload-file/complete` targeting `user: "ou_recipient"`.
- Then: Feishu receives a stream upload with the exact bytes. The completion returns HTTP 200 with message `om_1`, file key `file_uploaded`, filename, MIME type, size and the artifact URL. Exactly one `open_id` file message is sent to `ou_recipient`, and the run's thread artifacts list the file with ID `om_1` and the same URL.

## integrations-feishu-message-026

- Vitest: "POST /api/integrations/feishu/message > authorizes a stored lark file (membership revoked: false; other recipient DM: true)"
- Mode: run
- Given: A Pro-entitled workspace admin with a connected Lark installation launched a Web run and uses its Okou token.
- When: The run calls `POST /api/integrations/lark/upload-file/init` for `report.pdf`, uploads the bytes, then calls `POST /api/integrations/lark/upload-file/complete` targeting `user: "ou_recipient"`.
- Then: Lark receives a stream upload with the exact bytes. The completion returns HTTP 200 with message `om_1`, file key `file_uploaded`, filename, MIME type, size and the artifact URL. Exactly one `open_id` file message is sent to `ou_recipient`, and the run's thread artifacts list the file with ID `om_1` and the same URL.
