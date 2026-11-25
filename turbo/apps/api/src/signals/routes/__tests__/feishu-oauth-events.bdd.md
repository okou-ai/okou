# feishu-oauth-events

## feishu-oauth-events-001

- Vitest: "feishu integration > connects the current Feishu user through signed OAuth state"
- Mode: run
- Given: An onboarded workspace admin has installed a Feishu bot and a member has integration access. Setup publishes one integration-managed OAuth connector and its matching skill, with the provider's OpenAPI endpoints, standard Feishu permission bundle, and the official scope list.
- When: The admin attempts general custom-connector OAuth, update, deletion, values and proposal actions. The signed-out member follows the signed `/api/integrations/feishu` connect URL, then completes and reconnects from Feishu OAuth. The member disconnects and the admin removes the installation.
- Then: General connector mutations return HTTP 403 with `This connector is managed by its integration`; setup alone does not connect the admin. OAuth starts with HTTP 307 to `https://accounts.feishu.cn` for the installed app and official scopes, pinning `/connectors/feishu/callback` to the app origin even if the callback target query changes. The browser handoff is HTTP 307 and preserves code and state. JSON completion is HTTP 200, token exchange uses the app callback, and the redirect opens the installed bot at `https://applink.feishu.cn`. The member's managed connector becomes connected in both read surfaces and the initial account receives an interactive welcome. Reconnect also uses the pinned URI. Disconnect retains the installation but clears member readiness and connected briefs. Removing the installation clears the integration and connector listings.

## feishu-oauth-events-002

- Vitest: "feishu integration > uses the configured Okou origins for Feishu OAuth"
- Mode: run
- Given: The deployment uses separate Okou app, API and web origins with the Feishu callback on the API origin.
- When: A signed-in member reads integration status from the app origin, follows its OAuth link, receives a provider denial, then starts again and completes authorization.
- Then: The status and installation expose the app callback at `/connectors/feishu/callback` and a connect URL on the API origin whose signed state pins the same app callback. HTTP 307 starts provider authorization with that callback and a 64-character hexadecimal state. On denial the browser redirects to the app callback and the HTTP 200 JSON redirect names the app's `/settings/feishu` and the provider's error description. A fresh attempt exchanges one token with the same app URI and opens the installed bot at `https://applink.feishu.cn`.

## feishu-oauth-events-003

- Vitest: "feishu integration > uses the configured Okou origins for Feishu message-link OAuth"
- Mode: run
- Given: The Okou app and API origins differ, and an unconnected Feishu user sends an encrypted DM to an installed bot.
- When: The member follows the connection card and posts its signed link fields to `POST /api/feishu/connect` with the app origin and session cookie, then completes OAuth.
- Then: The bot's link opens the app origin. The connection response is HTTP 200 with an authorization URL on `https://accounts.feishu.cn`, a 64-character hexadecimal state, and the app callback `/connectors/feishu/callback`. JSON completion exchanges one token with that URI and redirects to the installed bot at `https://applink.feishu.cn`.

## feishu-oauth-events-004

- Vitest: "feishu integration > verifies and decrypts URL verification callbacks"
- Mode: run
- Given: A signed-in admin configures a Feishu bot with a verification token and encryption key.
- When: The provider sends plaintext and encrypted unsigned URL challenges carrying the valid token, then sends an encrypted ordinary event with an invalid signature and an event with a stale timestamp.
- Then: Each URL challenge returns HTTP 200 with the original challenge string, and status shows callback verification. Each invalid ordinary event returns HTTP 401 and does not clear the verified status.

## feishu-oauth-events-005

- Vitest: "feishu integration > backfills bot identity before handling a group mention"
- Mode: run
- Given: An onboarded admin configured the Feishu bot with event verification, but the installation's bot identity is not yet recorded. The group sender has not connected their account.
- When: The provider delivers an encrypted group message mentioning the bot.
- Then: The provider receives an in-thread reply inviting the sender to connect. The authenticated installation status shows bot name `Okou Feishu` and a verified callback.

## feishu-oauth-events-006

- Vitest: "feishu integration > emits the final path and serves it"
- Mode: run
- Given: A Feishu integration installation exposes its callback on the configured callback origin.
- When: The provider posts an unknown encrypted event to `/api/webhooks/feishu/events/:installationId` first with a valid and then with an invalid signature.
- Then: The reported callback URL uses that exact path. The valid request gets HTTP 200 with plain text `OK`; the invalid one gets HTTP 401 with JSON error `Invalid Feishu signature`.

## feishu-oauth-events-007

- Vitest: "feishu integration > retries a durably admitted Feishu event after dispatch fails"
- Mode: run
- Given: A Feishu installation can receive encrypted messages from an unconnected user, but outbound delivery to this message fails on its first attempt.
- When: The provider delivers the encrypted DM, waits for the failed dispatch, and redelivers the same event and message ID.
- Then: Both webhook responses are HTTP 200. There is no delivered reply after the first attempt and exactly one connection prompt after redelivery.

## feishu-oauth-events-008

- Vitest: "lark integration > connects the current Feishu user through signed OAuth state"
- Mode: run
- Given: An onboarded workspace admin has installed a Lark bot and a member has integration access. Setup publishes one integration-managed OAuth connector and its matching skill, with the provider's OpenAPI endpoints, standard Feishu permission bundle, and the official scope list.
- When: The admin attempts general custom-connector OAuth, update, deletion, values and proposal actions. The signed-out member follows the signed `/api/integrations/lark` connect URL, then completes and reconnects from Lark OAuth. The member disconnects and the admin removes the installation.
- Then: General connector mutations return HTTP 403 with `This connector is managed by its integration`; setup alone does not connect the admin. OAuth starts with HTTP 307 to `https://accounts.larksuite.com` for the installed app and official scopes, pinning `/integrations/lark/callback` to the app origin even if the callback target query changes. The browser handoff is HTTP 307 and preserves code and state. JSON completion is HTTP 200, token exchange uses the app callback, and the redirect opens the installed bot at `https://applink.larksuite.com`. The member's managed connector becomes connected in both read surfaces and the initial account receives an interactive welcome. Reconnect also uses the pinned URI. Disconnect retains the installation but clears member readiness and connected briefs. Removing the installation clears the integration and connector listings.

## feishu-oauth-events-009

- Vitest: "lark integration > uses the configured Okou origins for Feishu OAuth"
- Mode: run
- Given: The deployment uses separate Okou app, API and web origins with the Lark callback on the API origin.
- When: A signed-in member reads integration status from the app origin, follows its OAuth link, receives a provider denial, then starts again and completes authorization.
- Then: The status and installation expose the app callback at `/integrations/lark/callback` and a connect URL on the API origin whose signed state pins the same app callback. HTTP 307 starts provider authorization with that callback and a 64-character hexadecimal state. On denial the browser redirects to the app callback and the HTTP 200 JSON redirect names the app's `/settings/lark` and the provider's error description. A fresh attempt exchanges one token with the same app URI and opens the installed bot at `https://applink.larksuite.com`.

## feishu-oauth-events-010

- Vitest: "lark integration > uses the configured Okou origins for Feishu message-link OAuth"
- Mode: run
- Given: The Okou app and API origins differ, and an unconnected Lark user sends an encrypted DM to an installed bot.
- When: The member follows the connection card and posts its signed link fields to `POST /api/feishu/connect` with the app origin and session cookie, then completes OAuth.
- Then: The bot's link opens the app origin. The connection response is HTTP 200 with an authorization URL on `https://accounts.larksuite.com`, a 64-character hexadecimal state, and the app callback `/integrations/lark/callback`. JSON completion exchanges one token with that URI and redirects to the installed bot at `https://applink.larksuite.com`.

## feishu-oauth-events-011

- Vitest: "lark integration > verifies and decrypts URL verification callbacks"
- Mode: run
- Given: A signed-in admin configures a Lark bot with a verification token and encryption key.
- When: The provider sends plaintext and encrypted unsigned URL challenges carrying the valid token, then sends an encrypted ordinary event with an invalid signature and an event with a stale timestamp.
- Then: Each URL challenge returns HTTP 200 with the original challenge string, and status shows callback verification. Each invalid ordinary event returns HTTP 401 and does not clear the verified status.

## feishu-oauth-events-012

- Vitest: "lark integration > backfills bot identity before handling a group mention"
- Mode: run
- Given: An onboarded admin configured the Lark bot with event verification, but the installation's bot identity is not yet recorded. The group sender has not connected their account.
- When: The provider delivers an encrypted group message mentioning the bot.
- Then: The provider receives an in-thread reply inviting the sender to connect. The authenticated installation status shows bot name `Okou Feishu` and a verified callback.

## feishu-oauth-events-013

- Vitest: "lark integration > emits the final path and serves it"
- Mode: run
- Given: A Lark integration installation exposes its callback on the configured callback origin.
- When: The provider posts an unknown encrypted event to `/api/webhooks/feishu/events/:installationId` first with a valid and then with an invalid signature.
- Then: The reported callback URL uses that exact path. The valid request gets HTTP 200 with plain text `OK`; the invalid one gets HTTP 401 with JSON error `Invalid Feishu signature`.

## feishu-oauth-events-014

- Vitest: "lark integration > retries a durably admitted Feishu event after dispatch fails"
- Mode: run
- Given: A Lark installation can receive encrypted messages from an unconnected user, but outbound delivery to this message fails on its first attempt.
- When: The provider delivers the encrypted DM, waits for the failed dispatch, and redelivers the same event and message ID.
- Then: Both webhook responses are HTTP 200. There is no delivered reply after the first attempt and exactly one connection prompt after redelivery.
