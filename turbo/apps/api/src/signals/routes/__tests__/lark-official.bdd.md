# lark-official

## lark-official-001

- Vitest: "Okou Official Lark bot > requires the feature switch and keeps an unconfigured app unavailable"
- Mode: run
- Given: An onboarded workspace member first has the Lark Official bot switch disabled; a second onboarded member has it enabled while the Official app secret is unset.
- When: Each member reads `GET /api/integrations/lark/official` and calls `POST /api/integrations/lark/official/connect`; the second member also reads `GET /api/integrations/lark`.
- Then: With the switch disabled both requests return HTTP 403. With the switch enabled but the app unconfigured, status returns HTTP 200 exactly `{ isConfigured: false, isConnected: false, connectedUserName: null, installationId: null }`, connect returns HTTP 503, and the custom Lark status reports not installed.

## lark-official-002

- Vitest: "Okou Official Lark bot > connects with store scopes while leaving the custom bot and its setup unchanged"
- Mode: run
- Given: An onboarded member with the Lark Official bot and custom Lark switches enabled set up a custom Lark bot; Lark has delivered a valid app ticket for the Official app.
- When: The member starts `POST /api/integrations/lark/official/connect`, follows the authorization URL and completes `GET /api/integrations/feishu/oauth/callback`; then tries to complete and delete the Official installation through the custom Lark installation routes and to set up a custom bot with the Official App ID; then disconnects with `DELETE /api/integrations/lark/official/connect`.
- Then: The authorization redirect goes to `https://accounts.larksuite.com` with redirect URI `https://app.okou.ai/integrations/lark/callback` and the Official App ID as client ID; its scopes include `im:chat:read` and `calendar:calendar.event:create` and exclude `drive:export:readonly`, `contact:user.id:readonly`, `im:chat` and `im:message.group_msg:get_as_user`. The callback returns HTTP 200 and the Official status is connected while the custom installations are unchanged. Updating and removing the Official installation via custom routes return HTTP 404 and the custom setup with the Official App ID returns HTTP 409. Disconnect returns HTTP 200, the Official status is no longer connected, and custom installations are still unchanged.

## lark-official-003

- Vitest: "Okou Official Lark bot > verifies ticket callbacks and prevents delayed tickets from replacing newer tickets"
- Mode: run
- Given: An onboarded member has the Lark Official bot enabled and the Official app is configured.
- When: An app ticket event with an invalid signature is posted to `POST /api/webhooks/lark/official/events`; then a valid ticket `new-ticket` arrives, followed by a delayed valid ticket `old-ticket` timestamped 60 seconds earlier; the member then completes the Official OAuth flow.
- Then: The invalid signature returns HTTP 401. The OAuth callback returns the bot deep link `https://applink.larksuite.com/client/bot/open?appId=<appId>`, and the app access token is requested with `new-ticket`.

## lark-official-004

- Vitest: "Okou Official Lark bot > isolates tenants and rejects an OAuth account from another workspace tenant"
- Mode: run
- Given: An onboarded member with the Lark Official bot enabled connected the Official bot for their workspace's Lark tenant; a second onboarded member is in another workspace.
- When: The first member starts another Official authorization but Lark returns a user from a different tenant at `GET /api/integrations/feishu/oauth/callback`; then the second member completes the Official OAuth flow with a new tenant.
- Then: The wrong-tenant callback returns a redirect URL mentioning the tenant and the first member's Official status stays connected. The second member's callback returns the bot deep link and their Official status is connected.

## lark-official-005

- Vitest: "Okou Official Lark bot > prevents one tenant from being bound to two workspaces"
- Mode: run
- Given: An onboarded member connected the Lark Official bot for a Lark tenant; a member of a different workspace has the Official bot enabled.
- When: The second member completes the Official OAuth flow and Lark returns the same tenant.
- Then: The callback returns a redirect URL mentioning the tenant, and the second member's `GET /api/integrations/lark/official` reports not connected.

## lark-official-006

- Vitest: "Okou Official Lark bot > reads shared groups with the bot token and checks both members before reading"
- Mode: run
- Given: An onboarded member with only the Lark Official bot enabled connected it; Lark lists group `oc_shared` (with a next page) and its history holds message `om_history`.
- When: The member lists `GET /api/integrations/lark/official/chats?limit=20` and reads `GET /api/integrations/lark/official/messages` for `oc_shared` with a time range; then reads history when the bot is absent, when the user is absent, lists chats while the user is absent, reads a private (`p2p`) chat, and reads again after `DELETE /api/integrations/lark/official/connect`.
- Then: The chat list returns HTTP 200 containing `oc_shared` with `nextCursor` `next-page`. The history returns HTTP 200 with `om_history`, fetched once using the tenant bot token. Reads with the bot or the user absent return HTTP 403, the chat list without the user returns no chats but keeps `nextCursor` `next-page`, and the private chat read returns HTTP 403, with no further Lark history fetch. After disconnect the history read returns HTTP 404.

## lark-official-007

- Vitest: "Okou Official Lark bot > handles unavailable and empty Lark group lists"
- Mode: run
- Given: An onboarded member with only the Lark Official bot enabled connected it.
- When: The member lists `GET /api/integrations/lark/official/chats?limit=20` while Lark's chat list returns HTTP 503, then while Lark returns no items and `has_more: false`.
- Then: The first list returns HTTP 502 with error code `LARK_ERROR`. The second returns HTTP 200 with an empty `chats` array and `hasMore` false.

## lark-official-008

- Vitest: "Okou Official Lark bot > stops access after the tenant disables the Official app and ignores older lifecycle events"
- Mode: run
- Given: An onboarded member connected the Lark Official bot for their tenant.
- When: Lark posts a signed `app_status_change` event `stop_by_tenant` to `POST /api/webhooks/lark/official/events`, then an older `start_by_tenant` event timestamped 60 seconds earlier; the member reads status, calls connect, and reads chat history.
- Then: The stop event returns HTTP 200. `GET /api/integrations/lark/official` reports not connected, `POST /api/integrations/lark/official/connect` returns HTTP 409, and `GET /api/integrations/lark/official/messages` for `oc_shared` returns HTTP 404.

## lark-official-009

- Vitest: "Okou Official Lark bot > keeps Official callbacks separate from custom callbacks and acknowledges unbound tenants without dispatch"
- Mode: run
- Given: An onboarded member connected the Lark Official bot for their tenant.
- When: Signed, encrypted `unhandled.event` callbacks are posted to `POST /api/webhooks/lark/official/events` for the member's tenant, for an unbound tenant, and with a foreign custom App ID; the same callback is also posted to the custom installation path `/api/webhooks/feishu/events/<officialInstallationId>`.
- Then: The member's tenant and the unbound tenant both return HTTP 200, the foreign App ID returns HTTP 401, and the custom callback path returns HTTP 404.

## lark-official-010

- Vitest: "Okou Official Lark bot > preserves the custom bot as the default and lets callers select Official explicitly"
- Mode: run
- Given: An onboarded member with both Lark switches enabled has a completed custom Lark bot installation (without a connected Lark user account) and has also connected the Lark Official bot.
- When: The member sends `POST /api/integrations/lark/message` to `oc_shared` without an installation ID, then again with the Official installation ID.
- Then: The default send uses the custom bot and returns HTTP 403. The send selecting the Official installation returns HTTP 200 with `ok` true.
