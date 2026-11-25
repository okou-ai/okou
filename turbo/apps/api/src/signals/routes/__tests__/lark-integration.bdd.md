# lark-integration

## lark-integration-001

- Vitest: "Lark integration > keeps Lark installations separate from the legacy Feishu default"
- Mode: run
- Given: An onboarded workspace admin with a Pro entitlement and both the Lark and Feishu integration switches enabled has set up and completed one Feishu installation and one Lark installation.
- When: The admin reads `GET /api/integrations/feishu` and `GET /api/integrations/lark`, tries to delete the Lark installation through `DELETE /api/integrations/feishu/installations/:installationId`, sends two concurrent `DELETE /api/integrations/lark/installations/:installationId` requests, and reads both statuses again.
- Then: The Feishu status lists only the Feishu installation and the Lark status lists only the Lark installation, with OAuth redirect URL `https://app.okou.ai/integrations/lark/callback`. Deleting via the Feishu route returns HTTP 404. The concurrent Lark deletions return one HTTP 200 and one HTTP 404. Afterwards Lark reports `isInstalled: false` with no installations, and Feishu still reports the Feishu installation ID.

## lark-integration-002

- Vitest: "Lark integration > shares Lark rollout with other members of the installation organization"
- Mode: run
- Given: An onboarded workspace admin with Lark enabled set up and completed a Lark installation; another user is a member of the same organization.
- When: The member reads `GET /api/integrations/lark`.
- Then: The API returns HTTP 200 with `isAdmin` false and the admin's Lark installation ID.

## lark-integration-003

- Vitest: "Lark integration > rejects an App ID already registered on the other platform"
- Mode: run
- Given: An onboarded workspace admin with Lark and Feishu enabled has a completed Feishu installation.
- When: The admin checks that Feishu App ID with `GET /api/integrations/lark/app-id?appId=<id>`.
- Then: The API returns HTTP 409 with error code `CONFLICT`.

## lark-integration-004

- Vitest: "Lark integration > uses Lark for OAuth, user identity, and the bot deep link"
- Mode: run
- Given: An onboarded workspace admin with Lark enabled completed a Lark installation; Lark's OAuth token exchange and user info succeed for "Lark User".
- When: The admin opens the installation's connect URL, then calls `GET /api/integrations/feishu/oauth/callback` with the returned state, code `lark-code` and `responseMode=json`, and reads `GET /api/integrations/lark`.
- Then: The connect URL redirects (307) to `https://accounts.larksuite.com` with redirect URI `https://app.okou.ai/integrations/lark/callback`. The callback returns HTTP 200 with `redirectUrl` `https://applink.larksuite.com/client/bot/open?appId=<appId>`. The Lark token request uses `authorization_code` with the same redirect URI, Lark's OAuth and user-info endpoints are called, and the Lark status reports `connectedUserName` "Lark User".

## lark-integration-005

- Vitest: "Lark integration > verifies Lark callbacks and rejects them after the owner disables Lark"
- Mode: run
- Given: An onboarded workspace admin with Lark and Feishu enabled completed a Lark installation with verification token `test-verification`.
- When: Lark posts a `url_verification` challenge to the installation's callback URL; the admin then disables the Lark switch (Feishu stays enabled); Lark posts the challenge again and the admin reads `GET /api/integrations/lark` and `GET /api/integrations/feishu`.
- Then: The first challenge returns HTTP 200 echoing `{ challenge: "lark-challenge" }`. After Lark is disabled the challenge returns HTTP 404, the Lark status returns HTTP 403, and the Feishu status returns HTTP 200.

## lark-integration-006

- Vitest: "Lark integration > sends through Lark only and blocks sends when the switch is disabled"
- Mode: run
- Given: An onboarded workspace admin with Lark enabled completed a Lark installation and connected their Lark account through OAuth; Lark reports the chat `oc_lark` as a group the user belongs to. One Run token was issued while Lark was disabled and another while it was enabled.
- When: The caller sends `POST /api/integrations/lark/message` to `oc_lark` with the token issued while Lark was disabled, then with the current token, then sends the same body to `POST /api/integrations/feishu/message`; the admin disables Lark and retries the Lark send and `POST /api/integrations/lark/upload-file/init`.
- Then: The send with the Lark-disabled token returns HTTP 403, the current token's send returns HTTP 200 and Lark receives exactly one new message, and the Feishu route returns HTTP 404. After disabling Lark, the send returns HTTP 403 and upload init returns HTTP 403 `FORBIDDEN`; no further Lark message is sent.

## lark-integration-007

- Vitest: "Lark integration > with an installed Lark app > answers an incoming Lark message with a Lark account-connect card"
- Mode: run
- Given: An onboarded workspace admin with Lark enabled completed a Lark installation; a Lark user without an Okou connection messages the bot.
- When: Lark posts an `im.message.receive_v1` event for a private text message "Hello" to the installation's callback URL.
- Then: The callback returns HTTP 200, and Okou replies to the incoming message in thread with an interactive card that mentions "in Lark" and links to `/settings/lark?` and not `/settings/feishu`.
