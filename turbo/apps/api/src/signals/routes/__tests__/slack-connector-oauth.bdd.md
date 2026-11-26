# slack-connector-oauth

## slack-connector-oauth-001

- Vitest: "connects a workspace identity before bot installation without granting another workspace's bot"
- Mode: run
- Given: A signed-in `org:member` whose organization has no Slack bot installation.
- When: The member starts Slack account connection with `POST /api/integrations/slack/connect`, follows `GET /api/slack/oauth/connect`, Slack completes `GET /api/integrations/slack/oauth/callback`, then the member calls `POST /api/integrations/slack/message`, `GET /api/integrations/slack/channels` and `DELETE /api/integrations/slack`.
- Then: The callback redirects with `status=connected` and no Slack message is posted. `GET /api/integrations/slack` reports connected but not installed. Sending a message to another workspace's channel and listing channels both return HTTP 404. After disconnecting, status reports neither connected nor installed.

## slack-connector-oauth-002

- Vitest: "web account connection sends a DM welcome when its own workspace bot is installed"
- Mode: run
- Given: A signed-in admin installed the Slack bot for their own workspace through the install OAuth flow and then disconnected their chat account with `DELETE /api/integrations/slack`.
- When: The admin reconnects through `POST /api/integrations/slack/connect`, `GET /api/slack/oauth/connect` and `GET /api/integrations/slack/oauth/callback`.
- Then: The callback redirects with `status=connected`, and Slack receives a DM to the admin's Slack user ID with text containing "Hi! I'm" and blocks.

## slack-connector-oauth-003

- Vitest: "installing the workspace bot delivers pending welcomes to previously connected members"
- Mode: run
- Given: An `org:member` connected their Slack account before any bot installation, and no welcome was sent. An admin of the same organization and Slack workspace then installs the bot.
- When: The admin completes the install OAuth flow through `GET /api/slack/oauth/install` and `GET /api/integrations/slack/oauth/callback`.
- Then: Slack receives welcome DMs containing "Hi! I'm" for both the previously connected member's and the admin's Slack user IDs.

## slack-connector-oauth-004

- Vitest: "an independently connected account cannot borrow another Okou workspace's bot for its welcome"
- Mode: run
- Given: One organization's admin installed the Slack bot for a Slack workspace. A user of a different organization belongs to the same Slack workspace.
- When: The other user connects their Slack account through `POST /api/integrations/slack/connect`, `GET /api/slack/oauth/connect` and `GET /api/integrations/slack/oauth/callback`.
- Then: The callback redirects with `status=connected`, and no welcome message is posted.

## slack-connector-oauth-005

- Vitest: "switches a legacy workspace connection to a new home identity without retaining the old bot capability"
- Mode: run
- Given: A signed-in admin installed the Slack bot and prepared a file upload with `POST /api/integrations/slack/upload-file/init`. The admin then authenticates Slack as a different workspace and Slack user.
- When: The admin first completes an ordinary connect flow, then a switch flow via `POST /api/integrations/slack/connect/switch`, then calls `POST /api/integrations/slack/message` and `POST /api/integrations/slack/upload-file/complete` for the earlier upload.
- Then: The upload init returns HTTP 200. The ordinary connect callback redirects with an error mentioning "Switch" and status stays connected and installed. The switch callback redirects with `status=connected`. Sending a message and completing the earlier upload both return HTTP 404, and Slack's upload completion is not called.

## slack-connector-oauth-006

- Vitest: "checks connected user access before downloading a file from a own file"
- Mode: run
- Given: A signed-in admin installed the Slack bot. Slack's `files.info` reports a file uploaded by the admin that is only in channel `C_BOT_ONLY`, while the admin's own channels include only `C_USER_SHARED` (row `own file`).
- When: The admin requests `GET /api/integrations/slack/download-file` with `file_id` `F_ACCESS_CHECK`.
- Then: The response is HTTP 404 and the file bytes are never fetched from Slack.

## slack-connector-oauth-007

- Vitest: "checks connected user access before downloading a file from a shared channel"
- Mode: run
- Given: A signed-in admin installed the Slack bot. Slack's `files.info` reports a file from another member in channel `C_USER_SHARED`, which the admin is a member of (row `shared channel`).
- When: The admin requests `GET /api/integrations/slack/download-file` with `file_id` `F_ACCESS_CHECK`.
- Then: The response is HTTP 200 and the file is fetched from Slack exactly once.

## slack-connector-oauth-008

- Vitest: "checks connected user access before downloading a file from a bot-only channel"
- Mode: run
- Given: A signed-in admin installed the Slack bot. Slack's `files.info` reports a file from another member only in channel `C_BOT_ONLY`, which the admin is not a member of (row `bot-only channel`).
- When: The admin requests `GET /api/integrations/slack/download-file` with `file_id` `F_ACCESS_CHECK`.
- Then: The response is HTTP 404 and the file bytes are never fetched from Slack.

## slack-connector-oauth-009

- Vitest: "checks connected user access before downloading a file from a missing visibility"
- Mode: run
- Given: A signed-in admin installed the Slack bot. Slack's `files.info` reports the file without any uploader or channel information (row `missing visibility`).
- When: The admin requests `GET /api/integrations/slack/download-file` with `file_id` `F_ACCESS_CHECK`.
- Then: The response is HTTP 404 and the file bytes are never fetched from Slack.

## slack-connector-oauth-010

- Vitest: "connects through an external bot and authorizes only the sender's installed workspace"
- Mode: run
- Given: An entry organization installed its bot in one Slack workspace. A second organization's admin, whose Slack account lives in another workspace, connects from shared channel `C_SHARED_ENTRY` through the entry workspace; later a third organization installs a bot in the admin's own Slack workspace, uninstalls it, and the admin installs it for their own organization.
- When: The admin connects via `POST /api/integrations/slack/connect` and the OAuth callback, then calls `POST /api/integrations/slack/message`, `GET /api/integrations/slack/history` and `DELETE /api/integrations/slack?action=uninstall` across these stages.
- Then: The authorization targets the admin's own workspace and the callback returns `status=connected`; status is connected but not installed, and stays so (with `isAdmin` true) while another organization owns the bot, during which sending returns 404. After installing their own bot, status is connected and installed: posting to their shared channel returns 200, a bot-only channel returns 404, an explicit DM returns 200, reading that DM's history returns 404, posting to a channel restricted to other users returns 404 without calling Slack, and posting after the Slack user is deleted returns 404. After uninstalling, status is connected but not installed and posting to the entry channel returns 404.

## slack-connector-oauth-011

- Vitest: "preserves connected OAuth state with a primary email profile lookup"
- Mode: run
- Given: A signed-in admin's Clerk profile has a primary email and a different secondary email (row `primary email`).
- When: The admin completes the Slack install OAuth flow through `GET /api/slack/oauth/install` and `GET /api/integrations/slack/oauth/callback`.
- Then: The callback redirects with `status=connected` and status reports connected. The Clerk profile is read exactly once for the admin, and the Slack App Home is published once containing the primary email but not the secondary one.

## slack-connector-oauth-012

- Vitest: "preserves connected OAuth state with a missing user profile lookup"
- Mode: run
- Given: A signed-in admin's Clerk profile lookup reports the user as not found (row `missing user`).
- When: The admin completes the Slack install OAuth flow through `GET /api/slack/oauth/install` and `GET /api/integrations/slack/oauth/callback`.
- Then: The callback redirects with `status=connected` and status reports connected. The Clerk profile is read exactly once, and the Slack App Home is published once without the admin's email.

## slack-connector-oauth-013

- Vitest: "preserves connected OAuth state with a provider failure profile lookup"
- Mode: run
- Given: A signed-in admin's Clerk profile lookup fails with a provider error (row `provider failure`).
- When: The admin completes the Slack install OAuth flow through `GET /api/slack/oauth/install` and `GET /api/integrations/slack/oauth/callback`.
- Then: The callback redirects with `status=connected` and status reports connected. The Clerk profile is read exactly once, and the Slack App Home is not published.

## slack-connector-oauth-014

- Vitest: "installation grants bot and user scopes and connects the OAuth account"
- Mode: run
- Given: A signed-in admin whose organization has no Slack installation.
- When: The admin follows the install link through `GET /api/slack/oauth/install`, Slack completes `GET /api/integrations/slack/oauth/callback`, and the same state is replayed with another code.
- Then: The authorization URL is on `https://slack.com` with bot scope `app_mentions:read` and user scope `chat:write` but not `identity.basic`. The callback redirects with `status=connected`, status is installed and connected, and `GET /api/connector-accounts/connections` lists one connected account for the admin's Slack user. The replay redirects with an error containing "already used" and still only one account exists.

## slack-connector-oauth-015

- Vitest: "connect reuses the same OAuth account and both disconnect operations stay independent"
- Mode: run
- Given: A signed-in admin installed Slack and has one connected Slack connector account, then disconnects chat with `DELETE /api/integrations/slack`.
- When: The admin reconnects through the status `connectUrl` and OAuth callback, then deletes the connector account with `DELETE /api/connector-accounts/:connectionId`.
- Then: After the chat disconnect, status is installed but not connected while the connector account stays connected. The reconnect authorization has no bot `scope` and its user scope includes `users:read`; it returns `status=connected` and reuses the same account ID. Deleting the connector account leaves zero accounts while status remains installed and connected.

## slack-connector-oauth-016

- Vitest: "a Slack-origin connect requests OAuth before binding and rejects another Slack identity"
- Mode: run
- Given: A signed-in admin installed Slack and disconnected chat. The admin starts a Slack-origin connect from channel `C_ORIGIN` thread `42.0`.
- When: `POST /api/integrations/slack/connect` returns a pending authorization; Slack completes the callback as a different Slack user `U_DIFFERENT`; the admin then retries a plain connect and completes it as the correct Slack user.
- Then: The connect returns HTTP 202 and status stays not connected. The mismatched callback redirects with an error mentioning "Slack account", status stays not connected, and the connector account list still holds only the admin's original Slack identity. The retry completes with `status=connected`.

## slack-connector-oauth-017

- Vitest: "a Slack identity already linked to another user cannot create a partial connector connection"
- Mode: run
- Given: An admin installed Slack and linked their Slack identity. A second member of the same organization authenticates in Slack as that same Slack user.
- When: The second member follows the status `connectUrl` and completes the OAuth callback.
- Then: The callback redirects with an error containing "another user". The second member has no connector accounts and is not connected; the original admin still has one account and is connected.

## slack-connector-oauth-018

- Vitest: "reinstall refreshes the existing connector and preserves the upgrade redirect"
- Mode: run
- Given: A signed-in admin installed Slack with only the `chat:write` bot scope, so status reports a scope mismatch with a `reinstallUrl`.
- When: The admin follows the reinstall link and completes the OAuth callback with the full requested scopes.
- Then: The authorization targets the admin's Slack workspace. The callback redirects to `/settings/slack` with `updated=1`, the connector account keeps its original ID, and status reports `scopeMismatch` false.

## slack-connector-oauth-019

- Vitest: "incomplete user consent does not report a connected installation: {\"missingUserToken\":true}"
- Mode: run
- Given: A signed-in admin whose organization has no Slack installation, and Slack's OAuth result omits the user access token (`{"missingUserToken":true}`).
- When: The admin completes the install flow through `GET /api/slack/oauth/install` and `GET /api/integrations/slack/oauth/callback`.
- Then: The callback redirect carries an `error`, no connector accounts exist, and status reports neither installed nor connected.

## slack-connector-oauth-020

- Vitest: "incomplete user consent does not report a connected installation: {\"userScopes\":\"users:read\"}"
- Mode: run
- Given: A signed-in admin whose organization has no Slack installation, and Slack grants only the `users:read` user scope (`{"userScopes":"users:read"}`).
- When: The admin completes the install flow through `GET /api/slack/oauth/install` and `GET /api/integrations/slack/oauth/callback`.
- Then: The callback redirect carries an `error`, no connector accounts exist, and status reports neither installed nor connected.

## slack-connector-oauth-021

- Vitest: "a combined grant cannot bypass identity checks through the standalone connector callback"
- Mode: run
- Given: A signed-in admin started the Slack install OAuth flow and holds its state.
- When: The state is first sent to the generic `GET /api/connectors/slack/callback`, then to the Slack callback `GET /api/integrations/slack/oauth/callback`.
- Then: The generic callback redirects HTTP 307 to `/connector/error` with a message containing "Invalid state", and no connector accounts exist. The Slack callback then completes with `status=connected`.

## slack-connector-oauth-022

- Vitest: "an invalid signed install entry cannot grant a user's connector account"
- Mode: run
- Given: A signed-in admin's status offers a Slack install link whose signed `connectorState` is then corrupted.
- When: The admin follows the corrupted link with `GET /api/slack/oauth/install`.
- Then: The redirect carries an `error`, and no connector accounts exist.

## slack-connector-oauth-023

- Vitest: "a Slack-origin OAuth callback confirms connection in the originating thread"
- Mode: run
- Given: A signed-in admin installed Slack and disconnected chat, then starts a Slack-origin connect from channel `C_ORIGIN` thread `42.0`.
- When: The admin completes `POST /api/integrations/slack/connect`, `GET /api/slack/oauth/connect` and `GET /api/integrations/slack/oauth/callback`.
- Then: The callback redirects with `status=connected` and status reports connected. Slack receives an ephemeral message in `C_ORIGIN` thread `42.0` for the admin's Slack user: "Your Slack account is connected. Bot tools use your own workspace's Okou installation." and a welcome DM containing "Hi! I'm".

## slack-connector-oauth-024

- Vitest: "an explicit Slack account switch replaces the previous identity after OAuth"
- Mode: run
- Given: A signed-in admin installed Slack with one Slack identity, then authenticates as a new Slack user in the same workspace.
- When: The admin completes a switch through `POST /api/integrations/slack/connect/switch` and the OAuth callback, then reads `GET /api/integrations/slack/connect/link-status` for the new and the previous Slack user; another member of the organization then reads link status for the previous Slack user.
- Then: The switch redirects with `status=connected`. The new identity's link status is `connected`, the previous identity reports `slack_account_mismatch` with the new current ID, and for the other member the previous identity reports `connect`.

## slack-connector-oauth-025

- Vitest: "an admin claims an anonymously installed workspace through install OAuth"
- Mode: run
- Given: A Slack workspace was installed anonymously (without an Okou session) through `GET /api/slack/oauth/install`, and a signed-in admin's status reports not installed.
- When: The admin completes the install OAuth flow for that workspace.
- Then: The callback redirects with `status=connected`, status reports installed, connected and admin, and one connector account exists.

## slack-connector-oauth-026

- Vitest: "an anonymous reinstall preserves the organization's connected Slack account"
- Mode: run
- Given: A signed-in admin installed Slack and has a connected Slack connector account.
- When: The same Slack workspace is reinstalled anonymously through `GET /api/slack/oauth/install` and the OAuth callback without a session.
- Then: The callback redirects to `/settings/slack` with exactly `w` (workspace ID) and `u` (Slack user ID). Status remains installed and connected with workspace name "Connected workspace", and the connector accounts are unchanged.

## slack-connector-oauth-027

- Vitest: "slack success and denial retain the verified conversation context for the canonical page"
- Mode: run
- Given: A signed-in admin installed Slack and disconnected chat, then starts a Slack-origin connect from channel `C_ORIGIN` thread `42.0`.
- When: Slack returns `access_denied` to `GET /api/integrations/slack/oauth/callback`; the admin retries the connect and Slack completes it.
- Then: The denial redirects to `/settings/slack` with `w`, `u`, `c` `C_ORIGIN`, `t` `42.0` and error "Slack authorization was not completed. Please try again.", and status stays not connected. The retry redirects to `/settings/slack` with `status=connected` and the same `w`, `u`, `c` and `t`, and status reports connected.

## slack-connector-oauth-028

- Vitest: "protects the Slack connector callback actor (missing)"
- Mode: run
- Given: A signed-in admin started the Slack install flow; Slack's OAuth result is for another workspace and Slack user. The callback browser sends no session (row `missing`).
- When: The browser hits `GET /api/integrations/slack/oauth/callback`, then the same callback is requested with `responseMode=json` and no session, then resumed with a valid session.
- Then: The browser request redirects HTTP 307 with `integration=slack` and the admin is neither installed nor connected. The JSON completion returns HTTP 401 and the admin has no connector accounts. The resumed callback redirects with `status=connected` and the admin then has one account for the provider's Slack user.

## slack-connector-oauth-029

- Vitest: "protects the Slack connector callback actor (expired-cookie)"
- Mode: run
- Given: A signed-in admin started the Slack install flow; Slack's OAuth result is for another workspace and Slack user. The callback browser carries an expired session cookie (row `expired-cookie`).
- When: The browser hits `GET /api/integrations/slack/oauth/callback`, then the same callback is requested with `responseMode=json` and the expired cookie, then resumed with a valid session.
- Then: The browser request redirects HTTP 307 with `integration=slack` and the admin is neither installed nor connected. The JSON completion returns HTTP 401 and the admin has no connector accounts. The resumed callback redirects with `status=connected` and the admin then has one account for the provider's Slack user.

## slack-connector-oauth-030

- Vitest: "protects the Slack connector callback actor (matching-cookie)"
- Mode: run
- Given: A signed-in admin started the Slack install flow; Slack's OAuth result is for another workspace and Slack user. The callback browser carries the admin's own session cookie (row `matching-cookie`).
- When: The browser hits `GET /api/integrations/slack/oauth/callback`, then the same callback is requested with `responseMode=json` and the matching cookie.
- Then: The browser request redirects HTTP 307 with `integration=slack` and the admin is not yet installed or connected. The JSON completion returns HTTP 200 with a redirect URL carrying `status=connected`, and the admin has exactly one connector account for the provider's Slack user.

## slack-connector-oauth-031

- Vitest: "protects the Slack connector callback actor (different-user)"
- Mode: run
- Given: A signed-in admin started the Slack install flow; Slack's OAuth result is for another workspace and Slack user. The callback browser carries a session for a different user in the same organization (row `different-user`).
- When: The browser hits `GET /api/integrations/slack/oauth/callback`, then the same callback is requested with `responseMode=json` and that session.
- Then: The browser request redirects HTTP 307 with `integration=slack` and the admin is not installed or connected. The JSON completion returns HTTP 200 with a redirect URL whose error contains "active account or organization changed", and the admin has no connector accounts.

## slack-connector-oauth-032

- Vitest: "protects the Slack connector callback actor (different-org)"
- Mode: run
- Given: A signed-in admin started the Slack install flow; Slack's OAuth result is for another workspace and Slack user. The callback browser carries the admin's session but in a different organization (row `different-org`).
- When: The browser hits `GET /api/integrations/slack/oauth/callback`, then the same callback is requested with `responseMode=json` and that session.
- Then: The browser request redirects HTTP 307 with `integration=slack` and the admin is not installed or connected. The JSON completion returns HTTP 200 with a redirect URL whose error contains "active account or organization changed", and the admin has no connector accounts.

## slack-connector-oauth-033

- Vitest: "protects the Slack connector callback actor (invalid-bearer)"
- Mode: run
- Given: A signed-in admin started the Slack install flow; Slack's OAuth result is for another workspace and Slack user. The JSON callback carries an invalid bearer token (row `invalid-bearer`).
- When: The browser hits `GET /api/integrations/slack/oauth/callback` without a cookie, then the same callback is requested with `responseMode=json` and the invalid bearer, then resumed with a valid session.
- Then: The browser request redirects HTTP 307 with `integration=slack` and the admin is neither installed nor connected. The JSON completion returns HTTP 401 and the admin has no connector accounts. The resumed callback redirects with `status=connected` and the admin then has one account for the provider's Slack user.

## slack-connector-oauth-034

- Vitest: "reconnecting an awarded workspace preserves its single permanent award"
- Mode: run
- Intent: review
- Given: A signed-in admin installed Slack and then disconnected chat with `DELETE /api/integrations/slack`.
- When: The admin follows the status `connectUrl` and completes the OAuth callback.
- Then: Status reports installed and connected.
