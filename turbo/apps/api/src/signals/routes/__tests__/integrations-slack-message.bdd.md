# integrations-slack-message

## integrations-slack-message-001

- Vitest: "POST /api/integrations/slack/message > selects the installation across the membership boundary"
- Mode: run
- Given: A workspace admin's organization has Slack workspace A installed with the admin connected, and a regular member of the same organization has also connected to workspace A. Each caller uses their own run's Okou token.
- When: The admin, then the member, then the admin again (on the same run) send `POST /api/integrations/slack/message` with a distinct channel, text and `threadTs`.
- Then: Every request returns HTTP 200 with exactly `{ ok: true, ts, channel }` echoing Slack's result. Each request creates a Slack client with workspace A's bot token only and posts exactly one message with the requested channel, text and `thread_ts`.

## integrations-slack-message-002

- Vitest: "POST /api/integrations/slack/message > selects the installation across the organization boundary"
- Mode: run
- Given: Two admins in different organizations have each installed and connected their own Slack workspace (A and B). Each caller uses their own run's Okou token.
- When: The first admin, then the second admin, then the first admin again send `POST /api/integrations/slack/message` with a distinct channel, text and `threadTs`.
- Then: Every request returns HTTP 200 with exactly `{ ok: true, ts, channel }`. The first admin's requests use only workspace A's bot token and the second admin's request uses only workspace B's bot token, and each posts exactly one message with the requested channel, text and `thread_ts`.

## integrations-slack-message-003

- Vitest: "POST /api/integrations/slack/message > selects the installation across the missing boundary"
- Mode: run
- Given: A workspace admin's organization has Slack workspace A installed and connected; another admin's organization has no Slack installation. Each caller uses their own run's Okou token.
- When: The first admin, then the admin without an installation, then the first admin again send `POST /api/integrations/slack/message` with a distinct channel, text and `threadTs`.
- Then: The first admin's requests return HTTP 200 with `{ ok: true, ts, channel }`, use workspace A's bot token and post exactly one message each. The admin without an installation receives HTTP 404 with error code `NOT_FOUND`, and no Slack client is created and nothing is posted for that request.

## integrations-slack-message-004

- Vitest: "POST /api/integrations/slack/message > returns 401 when the token has no active organization membership"
- Mode: run
- Given: A run's Okou token belongs to a user who has since been removed from the organization.
- When: The caller sends `POST /api/integrations/slack/message` to channel `C123` with text "hello".
- Then: The response is HTTP 401 with exactly `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }`.

## integrations-slack-message-005

- Vitest: "POST /api/integrations/slack/message > returns 403 when sandbox token lacks slack:write"
- Mode: run
- Given: The caller uses a run's sandbox token, which lacks the `slack:write` capability.
- When: The caller sends `POST /api/integrations/slack/message` to channel `C123` with text "hello".
- Then: The response is HTTP 403 with an error message mentioning `slack:write`.

## integrations-slack-message-006

- Vitest: "POST /api/integrations/slack/message > sends message successfully and returns Slack response"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin has connected their Slack user; the caller uses a run's Okou token and shares channel `C123456`.
- When: The caller sends `POST /api/integrations/slack/message` to `C123456` with text "Hello from agent" and `threadTs` "1234567890.123456".
- Then: The response is HTTP 200 with `ok` true and `ts` "mock.ts". Slack's last post has channel `C123456`, the text and `thread_ts` "1234567890.123456".

## integrations-slack-message-007

- Vitest: "POST /api/integrations/slack/message > denies a group channel that the caller does not share"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected, but the admin's Slack user shares no conversations; the caller uses a run's Okou token.
- When: The caller sends `POST /api/integrations/slack/message` to `C_PRIVATE_OTHER` and to `G_PRIVATE_OTHER`.
- Then: Both requests return HTTP 404 with error code `NOT_FOUND`, and nothing is posted to Slack.

## integrations-slack-message-008

- Vitest: "POST /api/integrations/slack/message > allows an outbound bot DM to another recipient: {\"user\":\"U_OTHER_USER\"}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Slack opens a bot DM `D-mock-dm` with `U_OTHER_USER`.
- When: The caller sends `POST /api/integrations/slack/message` with `user: "U_OTHER_USER"` and text "Hello recipient".
- Then: The response is HTTP 200. Slack opens a conversation with exactly `{ users: "U_OTHER_USER" }` and the last post goes to `D-mock-dm` with the text.

## integrations-slack-message-009

- Vitest: "POST /api/integrations/slack/message > allows an outbound bot DM to another recipient: {\"channel\":\"D_OTHER_USER\"}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. `D_OTHER_USER` is the bot's DM with `U_OTHER_USER`.
- When: The caller sends `POST /api/integrations/slack/message` with `channel: "D_OTHER_USER"` and text "Hello recipient".
- Then: The response is HTTP 200 and the last Slack post goes to `D_OTHER_USER` with the text.

## integrations-slack-message-010

- Vitest: "POST /api/integrations/slack/message > does not treat an invalid DM destination as an outbound grant: {\"is_im\":false}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Slack describes the opened DM `D-mock-dm` with `is_im: false`.
- When: The caller sends `POST /api/integrations/slack/message` with `user: "U_OTHER_USER"` and text "must not send".
- Then: The response is HTTP 404 and nothing is posted to Slack.

## integrations-slack-message-011

- Vitest: "POST /api/integrations/slack/message > does not treat an invalid DM destination as an outbound grant: {\"is_im\":true,\"is_mpim\":true,\"user\":\"U_OTHER_USER\"}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Slack describes the opened DM as both `is_im` and `is_mpim` with user `U_OTHER_USER`.
- When: The caller sends `POST /api/integrations/slack/message` with `user: "U_OTHER_USER"` and text "must not send".
- Then: The response is HTTP 404 and nothing is posted to Slack.

## integrations-slack-message-012

- Vitest: "POST /api/integrations/slack/message > does not treat an invalid DM destination as an outbound grant: {\"is_im\":true,\"user\":\"U_WRONG_RECIPIENT\"}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Slack describes the opened DM as an IM with a different user, `U_WRONG_RECIPIENT`.
- When: The caller sends `POST /api/integrations/slack/message` with `user: "U_OTHER_USER"` and text "must not send".
- Then: The response is HTTP 404 and nothing is posted to Slack.

## integrations-slack-message-013

- Vitest: "POST /api/integrations/slack/message > denies restricted Slack posting for {\"is_read_only\":true}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Slack reports channel `C123456` as read-only.
- When: The caller sends `POST /api/integrations/slack/message` to `C123456`.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and nothing is posted to Slack.

## integrations-slack-message-014

- Vitest: "POST /api/integrations/slack/message > denies restricted Slack posting for {\"properties\":{\"posting_restricted_to\":{\"type\":[\"admin\"]}}}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Slack reports that posting in `C123456` is restricted to the `admin` type.
- When: The caller sends `POST /api/integrations/slack/message` to `C123456`.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and nothing is posted to Slack.

## integrations-slack-message-015

- Vitest: "POST /api/integrations/slack/message > denies restricted Slack posting for {\"properties\":{\"threads_restricted_to\":{\"user\":[\"U_OTHER_USER\"]}}}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Slack reports that thread replies in `C123456` are restricted to user `U_OTHER_USER`.
- When: The caller sends `POST /api/integrations/slack/message` to `C123456` with `threadTs` "1234567890.123456".
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and nothing is posted to Slack.

## integrations-slack-message-016

- Vitest: "POST /api/integrations/slack/message > checks Slack posting roles for {\"role\":\"ra\",\"admin\":false,\"external\":false,\"guest\":true,\"allowed\":true}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Channel `C123456` (not externally shared) restricts posting to role `ra`, and the connected Slack user is a non-admin guest (restricted) from another team.
- When: The caller sends `POST /api/integrations/slack/message` to `C123456` with text "role-checked".
- Then: The response is HTTP 200 and exactly one message is posted.

## integrations-slack-message-017

- Vitest: "POST /api/integrations/slack/message > checks Slack posting roles for {\"role\":\"regular\",\"admin\":false,\"external\":false,\"guest\":false,\"allowed\":true}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Channel `C123456` (not externally shared) restricts posting to role `regular`, and the connected Slack user is a non-admin, non-guest member.
- When: The caller sends `POST /api/integrations/slack/message` to `C123456` with text "role-checked".
- Then: The response is HTTP 200 and exactly one message is posted.

## integrations-slack-message-018

- Vitest: "POST /api/integrations/slack/message > checks Slack posting roles for {\"role\":\"regular\",\"admin\":false,\"external\":false,\"guest\":true,\"allowed\":false}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Channel `C123456` (not externally shared) restricts posting to role `regular`, and the connected Slack user is a guest.
- When: The caller sends `POST /api/integrations/slack/message` to `C123456` with text "role-checked".
- Then: The response is HTTP 404 and nothing is posted.

## integrations-slack-message-019

- Vitest: "POST /api/integrations/slack/message > checks Slack posting roles for {\"role\":\"admin\",\"admin\":true,\"external\":false,\"guest\":false,\"allowed\":true}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Channel `C123456` (not externally shared) restricts posting to role `admin`, and the connected Slack user is a Slack admin.
- When: The caller sends `POST /api/integrations/slack/message` to `C123456` with text "role-checked".
- Then: The response is HTTP 200 and exactly one message is posted.

## integrations-slack-message-020

- Vitest: "POST /api/integrations/slack/message > checks Slack posting roles for {\"role\":\"admin\",\"admin\":true,\"external\":true,\"guest\":false,\"allowed\":false}"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Channel `C123456` is externally shared and hosted by team `T_HOME`, restricts posting to role `admin`, and the connected Slack user is an admin of a different team (`T_AWAY`).
- When: The caller sends `POST /api/integrations/slack/message` to `C123456` with text "role-checked".
- Then: The response is HTTP 404 and nothing is posted.

## integrations-slack-message-021

- Vitest: "POST /api/integrations/slack/message > fails closed when Slack cannot verify conversation access"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Slack's `users.conversations` responds with HTTP 503.
- When: The caller sends `POST /api/integrations/slack/message` to `C123456`.
- Then: The response is HTTP 400 with error code `SLACK_ERROR`, and nothing is posted.

## integrations-slack-message-022

- Vitest: "POST /api/integrations/slack/message > requires the caller's own Slack connection for an explicit channel"
- Mode: run
- Given: A workspace admin's organization has Slack installed, but the admin has not connected their own Slack user; the caller uses a run's Okou token.
- When: The caller sends `POST /api/integrations/slack/message` to channel `C123456`.
- Then: The response is HTTP 404 with error code `NOT_FOUND`, and nothing is posted.

## integrations-slack-message-023

- Vitest: "POST /api/integrations/slack/message > forwards Slack API error with 400 status"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Slack rejects the post with `channel_not_found`.
- When: The caller sends `POST /api/integrations/slack/message` to `C-invalid` with text "hello".
- Then: The response is HTTP 400 with error code `SLACK_ERROR` and a message containing "channel_not_found".

## integrations-slack-message-024

- Vitest: "POST /api/integrations/slack/message > sends to the connected user through its explicit Slack ID"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin has connected their Slack user; the caller uses a run's Okou token.
- When: The caller sends `POST /api/integrations/slack/message` with `user` set to their own Slack user ID and text "Hello DM!".
- Then: The response is HTTP 200 with `ok` true. Slack opens a conversation with exactly `{ users: <their Slack user ID> }` and the last post goes to `D-mock-dm` with "Hello DM!".

## integrations-slack-message-025

- Vitest: "POST /api/integrations/slack/message > returns 404 when conversations.open fails with user_not_found"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin is connected; the caller uses a run's Okou token. Slack's `conversations.open` fails with `user_not_found`.
- When: The caller sends `POST /api/integrations/slack/message` with `user: "me"` and text "hello".
- Then: The response is HTTP 404 with error code `NOT_FOUND` and a message containing "user_not_found".

## integrations-slack-message-026

- Vitest: "POST /api/integrations/slack/message > resolves 'me' to current user's Slack ID and sends DM"
- Mode: run
- Given: A workspace admin's organization has Slack installed and the admin has connected their Slack user; the caller uses a run's Okou token.
- When: The caller sends `POST /api/integrations/slack/message` with `user: "me"` and text "Hello self!".
- Then: The response is HTTP 200 with `ok` true, and Slack opens a conversation with exactly `{ users: <the admin's Slack user ID> }`.

## integrations-slack-message-027

- Vitest: "POST /api/integrations/slack/message > returns 404 when 'me' is used but no Slack connection exists"
- Mode: run
- Given: A workspace admin's organization has Slack installed, but the admin has no Slack connection; the caller uses a run's Okou token.
- When: The caller sends `POST /api/integrations/slack/message` with `user: "me"` and text "hello".
- Then: The response is HTTP 404 with a message containing "No Slack connection found".

## integrations-slack-message-028

- Vitest: "POST /api/integrations/slack/message > appends the triggering member to the run footer"
- Mode: run
- Given: A Pro-entitled workspace admin with a connected Slack user started a thread run "send slack message", which a Runner claimed; the caller uses the run's Okou token.
- When: The run sends `POST /api/integrations/slack/message` to `C123456` with text "Hello".
- Then: The response is HTTP 200 with `ok` true. The Slack post has exactly three blocks: a section with text "Hello", a divider, and a context block whose text matches `Triggered by <@U_...>`.

## integrations-slack-message-029

- Vitest: "POST /api/integrations/slack/message > appends user attribution footer when run is user-triggered (not scheduled)"
- Mode: run
- Given: A Pro-entitled workspace admin started a thread run, which a Runner claimed, and connected their Slack user afterwards; the caller uses the run's Okou token.
- When: The run sends `POST /api/integrations/slack/message` to `C123456` with text "Hello".
- Then: The response is HTTP 200 with `ok` true. The Slack post has exactly three blocks, and the last is a context block with text `Triggered by <@<the admin's Slack user ID>>`.
