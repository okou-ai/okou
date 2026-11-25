# feishu-branding-connection

## feishu-branding-connection-001

- Vitest: "feishu integration > uses Okou branding for installation status without renaming the provider bot"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with the Feishu integration enabled and a Feishu installation whose setup is complete and whose callback URL is verified. The Feishu API reports the app's bot as `Owner Managed Bot` with its own avatar.
- When: The admin requests `GET /api/integrations/feishu` from the `https://app.okou.ai` origin, then removes the installation with `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: The status request returns HTTP 200 and the first installation reports `botName` `Owner Managed Bot` and the installation's callback URL. The removal returns HTTP 200.

## feishu-branding-connection-002

- Vitest: "feishu integration > uses Okou branding for unconnected commands without renaming the provider bot"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with the Feishu integration enabled and a set-up, callback-verified Feishu installation; the app URL is `https://app.okou.ai`. The Feishu API reports the app's bot as `Owner Managed Bot`. The Feishu sender `ou_feishu_unconnected` has not connected an Okou account.
- When: The sender sends the direct messages `/help` and then `hello`, each delivered as an encrypted, signed event to `POST /api/webhooks/feishu/events/:installationId`; the admin then removes the installation with `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: The messages sent back through the Feishu API include `Owner Managed Bot commands` and `To use Okou in Feishu`, and the first URL in them has the host `app.okou.ai`. The removal returns HTTP 200.

## feishu-branding-connection-003

- Vitest: "feishu integration > uses Okou branding for connected commands without renaming the provider bot"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with the Feishu integration enabled and a set-up, callback-verified Feishu installation. The Feishu API reports the app's bot as `Owner Managed Bot`. The Feishu user `ou_feishu_user` has connected their account to the admin through the Feishu OAuth flow.
- When: The connected user sends the direct messages `/help` and `/connect` as encrypted, signed events to `POST /api/webhooks/feishu/events/:installationId`; the admin then removes the installation with `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: The messages sent back through the Feishu API include `Owner Managed Bot commands` and `Your Feishu account is already connected to Okou`. The removal returns HTTP 200.

## feishu-branding-connection-004

- Vitest: "feishu integration > uses Okou for Feishu asynchronous delivery"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a personal model subscription, a Runner group and a set-up Feishu installation whose bot the Feishu API names `Okou Feishu`. The Feishu user `ou_feishu_user` has connected their account.
- When: The user sends the direct message `run with the Okou default identity` as an encrypted, signed event to `POST /api/webhooks/feishu/events/:installationId`. The Runner sends `POST /api/runners/heartbeat` and receives the run; the sandbox reports the assistant text `Host-branded Feishu response` through `POST /api/webhooks/run/events` and completes successfully through `POST /api/webhooks/run/complete`.
- Then: The admin's active Run list contains a Run with that prompt, and its Runner execution's appended system prompt contains `Your name is Okou.`. After completion, a message containing `Host-branded Feishu response` is sent through the Feishu API and includes an element whose `content` is exactly `Okou`.

## feishu-branding-connection-005

- Vitest: "feishu integration > preserves the custom Feishu app's connection identity when credentials rotate"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a Runner group and a set-up, callback-verified Feishu installation; the Feishu user `ou_feishu_user` has connected their account. `GET /api/custom-connectors` lists the integration-managed Feishu connector, and a direct message signed with the original verification token starts a Run whose Runner execution targets that connector through a specific connected source.
- When: The admin re-submits `POST /api/integrations/feishu` with the same installation ID, App ID, App Secret and encrypt key but a rotated verification token, lists `GET /api/custom-connectors`, and the user sends a new direct message signed with the rotated token to the same callback URL.
- Then: Setup returns HTTP 200 with the same installation ID, `botName` `Okou Feishu`, the same callback URL, `callbackVerified` false, `setupCompleted` true and `isConnected` true. The connector list contains exactly the same connector with the same ID and `storageVersion` and an OAuth client ID equal to the App ID. The new message starts a Run whose Runner execution uses the same connector source ID as before. Removing the installation returns HTTP 200.

## feishu-branding-connection-006

- Vitest: "feishu integration > preserves the custom Feishu app's rotated callback when credentials rotate"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a Runner group and a set-up, callback-verified Feishu installation; the Feishu user `ou_feishu_user` has connected their account and a direct message signed with the original verification token has already started and resolved a Run through the managed Feishu connector.
- When: The admin re-submits `POST /api/integrations/feishu` with the same installation ID, App ID, App Secret and encrypt key but a rotated verification token; the user then sends a new direct message signed with the rotated token to the original callback URL `POST /api/webhooks/feishu/events/:installationId`.
- Then: Setup returns HTTP 200 with the same installation ID, `botName` `Okou Feishu`, the same callback URL, `callbackVerified` false, `setupCompleted` true and `isConnected` true. The event returns HTTP 200 and the admin's active Run list contains a Run with the new prompt, which is cancelled with HTTP 200. Removing the installation returns HTTP 200.

## feishu-branding-connection-007

- Vitest: "feishu integration > preserves the installation state after rejecting a replacement Feishu app"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a set-up, callback-verified Feishu installation whose bot the Feishu API names `Okou Feishu`; the Feishu user `ou_feishu_user` has connected their account, and the admin's custom connector list is known.
- When: The admin sends `POST /api/integrations/feishu` for the existing installation ID with a different App ID, App Secret, verification token and encrypt key, then reads `GET /api/integrations/feishu` and `GET /api/custom-connectors`.
- Then: Setup returns HTTP 409 with an error message containing `cannot be changed to a different App ID`. The status returns HTTP 200 with the installation unchanged: same ID and original App ID, `botName` `Okou Feishu`, `botAvatarUrl` `https://example.com/okou-feishu.png`, the original callback URL, `callbackVerified`, `setupCompleted` and `isConnected` all true, and the original tenant key. The custom connector list is identical to the one before the attempt. Removing the installation returns HTTP 200.

## feishu-branding-connection-008

- Vitest: "feishu integration > preserves the original callback after rejecting a replacement Feishu app"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a set-up, callback-verified Feishu installation whose bot the Feishu API names `Okou Feishu`; the Feishu user `ou_feishu_user` has connected their account.
- When: The admin sends `POST /api/integrations/feishu` for the existing installation ID with a different App ID, App Secret, verification token and encrypt key; the connected user then sends `/help` signed with the original credentials to the original callback URL `POST /api/webhooks/feishu/events/:installationId`.
- Then: Setup returns HTTP 409 with an error message containing `cannot be changed to a different App ID`. The event returns HTTP 200 and the reply sent through the Feishu API contains `Okou Feishu commands`. Removing the installation returns HTTP 200.

## feishu-branding-connection-009

- Vitest: "feishu integration > rejects an in-place setup update that resolves to a different provider bot"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a set-up Feishu installation whose bot was identified as `Okou Feishu` (open ID `ou_feishu_bot`). The Feishu API now reports a different bot, `Replacement Bot`, with open ID `ou_replacement_bot`.
- When: The admin sends `PATCH /api/integrations/feishu/installations/:installationId` with `setupCompleted: true`, then reads `GET /api/integrations/feishu`.
- Then: The update returns HTTP 409 with an error message containing `different bot identity`. The status returns HTTP 200 and the installation still reports `botName` `Okou Feishu` and `botAvatarUrl` `https://example.com/okou-feishu.png`. Removing the installation returns HTTP 200.

## feishu-branding-connection-010

- Vitest: "feishu integration > deduplicates unconnected messages and sends one connect link"
- Mode: run
- Given: An organization admin has an onboarded, entitled workspace with a set-up, callback-verified Feishu installation. The Feishu user `ou_feishu_user` has not connected an Okou account.
- When: The same encrypted, signed `hello` direct-message event with a fixed message ID is posted twice to `POST /api/webhooks/feishu/events/:installationId`.
- Then: Both deliveries return HTTP 200 and a `feishu:changed` realtime notification is published. Exactly one reply is sent through the Feishu API: an in-thread interactive card replying to the original message ID that contains `Connect your account` and `To use Okou in Feishu, please connect your account first.`, with a connect URL whose origin and path are `https://app.okou.ai/settings/feishu`.

## feishu-branding-connection-011

- Vitest: "feishu integration > offers connection to an unlinked sender before workspace onboarding"
- Mode: run
- Given: A newly created, signed-in organization admin with the Feishu integration enabled, whose workspace has not been provisioned or onboarded, has configured a Feishu installation with `POST /api/integrations/feishu`, marked its setup complete and passed the callback URL verification challenge. The Feishu user `ou_feishu_user` has not connected an account.
- When: The admin reads `GET /api/integrations/feishu`; the Feishu user sends `hello before onboarding` with a fixed message ID as an encrypted, signed event to `POST /api/webhooks/feishu/events/:installationId`, and the same event is delivered again.
- Then: The status returns HTTP 200 with `isInstalled` and `callbackVerified` true. Both deliveries return HTTP 200. Exactly one reply is sent through the Feishu API, an in-thread interactive card replying to that message ID that contains `Connect your account`; the duplicate delivery sends no further reply.

## feishu-branding-connection-012

- Vitest: "feishu integration > keeps a failed credential preparation disconnected and permits a fresh authorization"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a set-up Feishu installation and the integration-managed Feishu connector. The Feishu user `ou_feishu_user` received a connect link by direct message, and the admin started the connection with `POST /api/feishu/connect`, receiving a Feishu authorization URL with an OAuth state. The key management service fails to issue a data key for encrypting credentials while the connection credentials are prepared.
- When: The OAuth callback `GET /api/integrations/feishu/oauth/callback` is requested with a code, the state and `responseMode=json`. After the key management service recovers, the admin reads `GET /api/integrations/feishu` and `GET /api/connectors/connected`, then connects again through a fresh connect request and Feishu authorization.
- Then: The failed callback returns HTTP 500. The status then reports `isConnected` false and the connected connectors list has no custom connectors. After the fresh authorization, the status reports `isConnected` true and the connected connectors list contains exactly the integration-managed Feishu connector with `integrationManaged` true.

## feishu-branding-connection-013

- Vitest: "feishu integration > preserves member permissions and retries welcome when reconnecting"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a set-up Feishu installation; the Feishu user `ou_feishu_user` received a connect link by direct message. The Feishu API rejects the first direct message sent to `ou_feishu_user`, which carries an idempotency key, with a temporary failure.
- When: The admin sends `POST /api/feishu/connect` with the signed link parameters and completes the Feishu OAuth callback, grants `messages:send-as-user` (allow, 1 hour) on the managed Feishu connector with `PUT /api/connector-permissions`, then reconnects through a new connect request and OAuth callback.
- Then: The authorization URL requests exactly the expected Feishu OAuth scopes, the first callback redirects to `https://applink.feishu.cn/client/bot/open?appId=<App ID>`, a `feishu:changed` realtime notification is published, `GET /api/integrations/feishu` shows `connectedUserName` `Feishu User`, and no `You're connected!` welcome is delivered. After reconnecting, `GET /api/connector-permissions` returns exactly the granted permissions, and the welcome is sent directly to `ou_feishu_user` as an interactive card containing `Okou` with the same idempotency key as the rejected attempt. The status lists the installation with its App ID, `isConnected` true and `connectedUserName` `Feishu User`.

## feishu-branding-connection-014

- Vitest: "lark integration > uses Okou branding for installation status without renaming the provider bot"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with the Lark integration enabled and a Lark installation whose setup is complete and whose callback URL is verified. The Lark API reports the app's bot as `Owner Managed Bot` with its own avatar.
- When: The admin requests `GET /api/integrations/lark` from the `https://app.okou.ai` origin, then removes the installation with `DELETE /api/integrations/lark/installations/:installationId`.
- Then: The status request returns HTTP 200 and the first installation reports `botName` `Owner Managed Bot` and the installation's callback URL. The removal returns HTTP 200.

## feishu-branding-connection-015

- Vitest: "lark integration > uses Okou branding for unconnected commands without renaming the provider bot"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with the Lark integration enabled and a set-up, callback-verified Lark installation; the app URL is `https://app.okou.ai`. The Lark API reports the app's bot as `Owner Managed Bot`. The Lark sender `ou_feishu_unconnected` has not connected an Okou account.
- When: The sender sends the direct messages `/help` and then `hello`, each delivered as an encrypted, signed event to `POST /api/webhooks/feishu/events/:installationId`; the admin then removes the installation with `DELETE /api/integrations/lark/installations/:installationId`.
- Then: The messages sent back through the Lark API include `Owner Managed Bot commands` and `To use Okou in Lark`, and the first URL in them has the host `app.okou.ai`. The removal returns HTTP 200.

## feishu-branding-connection-016

- Vitest: "lark integration > uses Okou branding for connected commands without renaming the provider bot"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with the Lark integration enabled and a set-up, callback-verified Lark installation. The Lark API reports the app's bot as `Owner Managed Bot`. The Lark user `ou_feishu_user` has connected their account to the admin through the Lark OAuth flow.
- When: The connected user sends the direct messages `/help` and `/connect` as encrypted, signed events to `POST /api/webhooks/feishu/events/:installationId`; the admin then removes the installation with `DELETE /api/integrations/lark/installations/:installationId`.
- Then: The messages sent back through the Lark API include `Owner Managed Bot commands` and `Your Lark account is already connected to Okou`. The removal returns HTTP 200.

## feishu-branding-connection-017

- Vitest: "lark integration > uses Okou for Feishu asynchronous delivery"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a personal model subscription, a Runner group and a set-up Lark installation whose bot the Lark API names `Okou Feishu`. The Lark user `ou_feishu_user` has connected their account.
- When: The user sends the direct message `run with the Okou default identity` as an encrypted, signed event to `POST /api/webhooks/feishu/events/:installationId`. The Runner sends `POST /api/runners/heartbeat` and receives the run; the sandbox reports the assistant text `Host-branded Feishu response` through `POST /api/webhooks/run/events` and completes successfully through `POST /api/webhooks/run/complete`.
- Then: The admin's active Run list contains a Run with that prompt, and its Runner execution's appended system prompt contains `Your name is Okou.`. After completion, a message containing `Host-branded Feishu response` is sent through the Lark API and includes an element whose `content` is exactly `Okou`.

## feishu-branding-connection-018

- Vitest: "lark integration > preserves the custom Feishu app's connection identity when credentials rotate"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a Runner group and a set-up, callback-verified Lark installation; the Lark user `ou_feishu_user` has connected their account. `GET /api/custom-connectors` lists the integration-managed Feishu connector, and a direct message signed with the original verification token starts a Run whose Runner execution targets that connector through a specific connected source.
- When: The admin re-submits `POST /api/integrations/lark` with the same installation ID, App ID, App Secret and encrypt key but a rotated verification token, lists `GET /api/custom-connectors`, and the user sends a new direct message signed with the rotated token to the same callback URL.
- Then: Setup returns HTTP 200 with the same installation ID, `botName` `Okou Feishu`, the same callback URL, `callbackVerified` false, `setupCompleted` true and `isConnected` true. The connector list contains exactly the same connector with the same ID and `storageVersion` and an OAuth client ID equal to the App ID. The new message starts a Run whose Runner execution uses the same connector source ID as before. Removing the installation returns HTTP 200.

## feishu-branding-connection-019

- Vitest: "lark integration > preserves the custom Feishu app's rotated callback when credentials rotate"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a Runner group and a set-up, callback-verified Lark installation; the Lark user `ou_feishu_user` has connected their account and a direct message signed with the original verification token has already started and resolved a Run through the managed Feishu connector.
- When: The admin re-submits `POST /api/integrations/lark` with the same installation ID, App ID, App Secret and encrypt key but a rotated verification token; the user then sends a new direct message signed with the rotated token to the original callback URL `POST /api/webhooks/feishu/events/:installationId`.
- Then: Setup returns HTTP 200 with the same installation ID, `botName` `Okou Feishu`, the same callback URL, `callbackVerified` false, `setupCompleted` true and `isConnected` true. The event returns HTTP 200 and the admin's active Run list contains a Run with the new prompt, which is cancelled with HTTP 200. Removing the installation returns HTTP 200.

## feishu-branding-connection-020

- Vitest: "lark integration > preserves the installation state after rejecting a replacement Feishu app"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a set-up, callback-verified Lark installation whose bot the Lark API names `Okou Feishu`; the Lark user `ou_feishu_user` has connected their account, and the admin's custom connector list is known.
- When: The admin sends `POST /api/integrations/lark` for the existing installation ID with a different App ID, App Secret, verification token and encrypt key, then reads `GET /api/integrations/lark` and `GET /api/custom-connectors`.
- Then: Setup returns HTTP 409 with an error message containing `cannot be changed to a different App ID`. The status returns HTTP 200 with the installation unchanged: same ID and original App ID, `botName` `Okou Feishu`, `botAvatarUrl` `https://example.com/okou-feishu.png`, the original callback URL, `callbackVerified`, `setupCompleted` and `isConnected` all true, and the original tenant key. The custom connector list is identical to the one before the attempt. Removing the installation returns HTTP 200.

## feishu-branding-connection-021

- Vitest: "lark integration > preserves the original callback after rejecting a replacement Feishu app"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a set-up, callback-verified Lark installation whose bot the Lark API names `Okou Feishu`; the Lark user `ou_feishu_user` has connected their account.
- When: The admin sends `POST /api/integrations/lark` for the existing installation ID with a different App ID, App Secret, verification token and encrypt key; the connected user then sends `/help` signed with the original credentials to the original callback URL `POST /api/webhooks/feishu/events/:installationId`.
- Then: Setup returns HTTP 409 with an error message containing `cannot be changed to a different App ID`. The event returns HTTP 200 and the reply sent through the Lark API contains `Okou Feishu commands`. Removing the installation returns HTTP 200.

## feishu-branding-connection-022

- Vitest: "lark integration > rejects an in-place setup update that resolves to a different provider bot"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a set-up Lark installation whose bot was identified as `Okou Feishu` (open ID `ou_feishu_bot`). The Lark API now reports a different bot, `Replacement Bot`, with open ID `ou_replacement_bot`.
- When: The admin sends `PATCH /api/integrations/lark/installations/:installationId` with `setupCompleted: true`, then reads `GET /api/integrations/lark`.
- Then: The update returns HTTP 409 with an error message containing `different bot identity`. The status returns HTTP 200 and the installation still reports `botName` `Okou Feishu` and `botAvatarUrl` `https://example.com/okou-feishu.png`. Removing the installation returns HTTP 200.

## feishu-branding-connection-023

- Vitest: "lark integration > deduplicates unconnected messages and sends one connect link"
- Mode: run
- Given: An organization admin has an onboarded, entitled workspace with a set-up, callback-verified Lark installation. The Lark user `ou_feishu_user` has not connected an Okou account.
- When: The same encrypted, signed `hello` direct-message event with a fixed message ID is posted twice to `POST /api/webhooks/feishu/events/:installationId`.
- Then: Both deliveries return HTTP 200 and a `feishu:changed` realtime notification is published. Exactly one reply is sent through the Lark API: an in-thread interactive card replying to the original message ID that contains `Connect your account` and `To use Okou in Lark, please connect your account first.`, with a connect URL whose origin and path are `https://app.okou.ai/settings/lark`.

## feishu-branding-connection-024

- Vitest: "lark integration > offers connection to an unlinked sender before workspace onboarding"
- Mode: run
- Given: A newly created, signed-in organization admin with the Lark integration enabled, whose workspace has not been provisioned or onboarded, has configured a Lark installation with `POST /api/integrations/lark`, marked its setup complete and passed the callback URL verification challenge. The Lark user `ou_feishu_user` has not connected an account.
- When: The admin reads `GET /api/integrations/lark`; the Lark user sends `hello before onboarding` with a fixed message ID as an encrypted, signed event to `POST /api/webhooks/feishu/events/:installationId`, and the same event is delivered again.
- Then: The status returns HTTP 200 with `isInstalled` and `callbackVerified` true. Both deliveries return HTTP 200. Exactly one reply is sent through the Lark API, an in-thread interactive card replying to that message ID that contains `Connect your account`; the duplicate delivery sends no further reply.

## feishu-branding-connection-025

- Vitest: "lark integration > keeps a failed credential preparation disconnected and permits a fresh authorization"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a set-up Lark installation and the integration-managed Feishu connector. The Lark user `ou_feishu_user` received a connect link by direct message, and the admin started the connection with `POST /api/feishu/connect`, receiving a Lark authorization URL with an OAuth state. The key management service fails to issue a data key for encrypting credentials while the connection credentials are prepared.
- When: The OAuth callback `GET /api/integrations/feishu/oauth/callback` is requested with a code, the state and `responseMode=json`. After the key management service recovers, the admin reads `GET /api/integrations/lark` and `GET /api/connectors/connected`, then connects again through a fresh connect request and Lark authorization.
- Then: The failed callback returns HTTP 500. The status then reports `isConnected` false and the connected connectors list has no custom connectors. After the fresh authorization, the status reports `isConnected` true and the connected connectors list contains exactly the integration-managed Feishu connector with `integrationManaged` true.

## feishu-branding-connection-026

- Vitest: "lark integration > preserves member permissions and retries welcome when reconnecting"
- Mode: run
- Given: A signed-in organization admin has an onboarded, entitled workspace with a set-up Lark installation; the Lark user `ou_feishu_user` received a connect link by direct message. The Lark API rejects the first direct message sent to `ou_feishu_user`, which carries an idempotency key, with a temporary failure.
- When: The admin sends `POST /api/feishu/connect` with the signed link parameters and completes the Lark OAuth callback, grants `messages:send-as-user` (allow, 1 hour) on the managed Feishu connector with `PUT /api/connector-permissions`, then reconnects through a new connect request and OAuth callback.
- Then: The authorization URL requests exactly the expected Feishu OAuth scopes, the first callback redirects to `https://applink.larksuite.com/client/bot/open?appId=<App ID>`, a `feishu:changed` realtime notification is published, `GET /api/integrations/lark` shows `connectedUserName` `Feishu User`, and no `You're connected!` welcome is delivered. After reconnecting, `GET /api/connector-permissions` returns exactly the granted permissions, and the welcome is sent directly to `ou_feishu_user` as an interactive card containing `Okou` with the same idempotency key as the rejected attempt. The status lists the installation with its App ID, `isConnected` true and `connectedUserName` `Feishu User`.
