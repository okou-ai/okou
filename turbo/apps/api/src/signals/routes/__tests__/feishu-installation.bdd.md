# feishu-installation

## feishu-installation-001

- Vitest: "feishu integration > rejects configuration API access when the feature switch is disabled"
- Mode: run
- Given: A signed-in organization admin belongs to a workspace where the Feishu integration feature switch is not enabled.
- When: The admin requests `GET /api/integrations/feishu`.
- Then: The API responds with HTTP 403 and error code `FORBIDDEN` with the message "Feishu integration is not enabled".

## feishu-installation-002

- Vitest: "feishu integration > uses the public callback origin and rotates plaintext verification credentials"
- Mode: run
- Given: A signed-in organization admin has the Feishu integration feature switch enabled, the public callback base URL is configured as `https://tunnel-feishu.okou.test`, and object storage accepts writes. The Feishu API issues tenant access tokens.
- When: The admin configures an app with `POST /api/integrations/feishu` (App ID, App Secret, verification token) and posts an unsigned plaintext `url_verification` challenge with that token to the returned callback URL. The admin then repeats setup for the returned installation with unchanged credentials while the Feishu tenant access token endpoint returns HTTP 503, and again with a replacement verification token while the endpoint succeeds, then posts challenges with the old and the new token, reads `GET /api/integrations/feishu` and `GET /api/custom-connectors`, and removes the integration with `DELETE /api/integrations/feishu`.
- Then: Setup returns HTTP 200 with an installation ID and a callback URL on the configured public origin. The first challenge returns HTTP 200 with body `{ challenge: "plaintext-challenge" }` and a `feishu:changed` realtime event is published. The unchanged-credential setup returns HTTP 200 with the same installation ID and callback URL and `callbackVerified: true`; the rotated-token setup returns the same installation ID and callback URL with `callbackVerified: false`. The challenge with the old token returns HTTP 401, the challenge with the new token returns HTTP 200 echoing `rotated-callback`, and the status then reports `callbackVerified` true. The custom connector list still contains exactly the original managed connector with the same ID and storage version, and removal returns HTTP 200.

## feishu-installation-003

- Vitest: "feishu integration > keeps one Feishu app installed per organization"
- Mode: run
- Given: A signed-in organization admin has the Feishu integration feature switch enabled and object storage accepts writes.
- When: The admin creates an app with `POST /api/integrations/feishu` (`createNew: true`), repeats setup for the same App ID without `createNew`, tries to create a second App ID with `createNew: true`, checks the first App ID and an unused App ID with `GET /api/integrations/feishu/app-id`, and reads `GET /api/integrations/feishu`. The admin then submits setup for the first App ID with an unknown installation ID, for the second App ID with the existing installation ID, and for the first App ID with the existing installation ID, and finally sends `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: The first two setups return HTTP 200 and the second-app creation returns HTTP 409 with the message "This workspace already has a Feishu bot". The App ID check returns HTTP 409 "This Feishu App ID is already registered in Okou" for the first App ID and HTTP 200 for the unused one. The status lists exactly one installation, with the first App ID. Setup with an unknown installation ID returns HTTP 409 "This Feishu App ID is already registered in Okou", the App ID change returns HTTP 409 with a message containing "cannot be changed to a different App ID", and the replay returns HTTP 200 listing that installation with the first App ID. Removal returns HTTP 200.

## feishu-installation-004

- Vitest: "feishu integration > accepts one concurrent Feishu app creation per organization"
- Mode: run
- Given: A signed-in organization admin has the Feishu integration feature switch enabled and object storage accepts writes.
- When: The admin concurrently sends two `POST /api/integrations/feishu` requests with different App IDs and `createNew: true`, then reads `GET /api/integrations/feishu` and sends `DELETE /api/integrations/feishu/installations/:installationId` for the listed installation.
- Then: One request returns HTTP 200 and the other HTTP 409 with the message "This workspace already has a Feishu bot". The status lists exactly one installation, and removal returns HTTP 200.

## feishu-installation-005

- Vitest: "feishu integration > converges concurrent setup retries for the same Feishu app (overlapping)"
- Mode: run
- Given: A signed-in organization admin has the Feishu integration feature switch enabled and object storage accepts writes. The Feishu tenant access token endpoint holds both credential validations until both have started, then answers them back to back (overlapping completion).
- When: The admin sends two concurrent `POST /api/integrations/feishu` requests with the same App ID, App Secret and verification token (no `createNew`), then reads `GET /api/integrations/feishu` and `GET /api/custom-connectors` and sends `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: Both setups return HTTP 200 with the same installation ID. The status lists exactly one installation, with that ID and the submitted App ID, the custom connector list contains exactly one connector, and removal returns HTTP 200.

## feishu-installation-006

- Vitest: "feishu integration > converges concurrent setup retries for the same Feishu app (after callback verification)"
- Mode: run
- Given: A signed-in organization admin has the Feishu integration feature switch enabled and object storage accepts writes. The Feishu tenant access token endpoint holds both credential validations until both have started, answers the first, and answers the second only after the callback has been verified (after callback verification).
- When: The admin sends two concurrent `POST /api/integrations/feishu` requests with the same App ID, App Secret and verification token (no `createNew`). Once one setup returns, an unsigned `url_verification` challenge with the verification token is posted to its callback URL before the second validation is answered. The admin then reads `GET /api/integrations/feishu` and `GET /api/custom-connectors` and sends `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: The challenge returns HTTP 200 echoing `concurrent-setup-challenge`. Both setups return HTTP 200 with the same installation ID. The status lists exactly one installation, with that ID and the submitted App ID, and reports `callbackVerified` true; the custom connector list contains exactly one connector, and removal returns HTTP 200.

## feishu-installation-007

- Vitest: "feishu integration > keeps a concurrently registered Feishu app in its winning organization"
- Mode: run
- Given: Two different organizations each have a signed-in admin with the Feishu integration feature switch enabled, and object storage accepts writes.
- When: Both admins concurrently send `POST /api/integrations/feishu` with the same App ID and `createNew: true`, then each reads `GET /api/integrations/feishu`; the winning admin sends `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: One setup returns HTTP 200 and the other HTTP 409 with the message "This Feishu App ID is already registered in Okou". The losing organization's status reports not installed with an empty installation list. The winning organization's status lists exactly one installation whose ID matches its setup response and whose App ID is the shared one, and removal returns HTTP 200.

## feishu-installation-008

- Vitest: "feishu integration > converges concurrent managed connector retries after skill publication fails"
- Mode: run
- Given: A signed-in organization admin has the Feishu integration feature switch enabled, and object storage rejects the managed connector skill upload.
- When: The admin creates an app with `POST /api/integrations/feishu` (`createNew: true`) and reads `GET /api/custom-connectors` and `GET /api/integrations/feishu`. With object storage then reporting the skill bundle missing and holding bundle uploads until both have started, the admin sends two concurrent `PATCH /api/integrations/feishu/installations/:installationId` requests with `setupCompleted: true`, lists custom connectors again and sends `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: The failed setup returns HTTP 500, no custom connectors are listed, and the status still lists the installation. Both completion requests return HTTP 200, both bundle uploads use the same bundle key, and the connector list then contains exactly one managed connector whose skill markdown contains `okou feishu`. Removal returns HTTP 200.

## feishu-installation-009

- Vitest: "feishu integration > repairs the managed connector without accessing R2 or changing its visible skill"
- Mode: run
- Given: A signed-in organization admin has the Feishu integration feature switch enabled and created an app with `POST /api/integrations/feishu` (`createNew: true`), which activated a managed connector. Object storage now rejects every request, and the Feishu API returns bot info with app name "Okou Feishu".
- When: The admin sends `PATCH /api/integrations/feishu/installations/:installationId` with `setupCompleted: true`, lists `GET /api/custom-connectors` and sends `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: The completion returns HTTP 200 without any object storage request. The connector list contains the same connector ID with display name "Feishu-Okou Feishu" and unchanged skill markdown, and removal returns HTTP 200.

## feishu-installation-010

- Vitest: "feishu integration > requires organization admins even when the user created the bot"
- Mode: run
- Given: A user who is an organization admin with the Feishu integration feature switch enabled created an app with `POST /api/integrations/feishu` (`createNew: true`); the same user's session then carries the member role. The Feishu API returns bot info named "Okou Feishu" with avatar `https://example.com/okou-feishu.png`.
- When: As a member, the user reads `GET /api/integrations/feishu`, checks an App ID with `GET /api/integrations/feishu/app-id`, submits `POST /api/integrations/feishu` with `createNew: true`, and sends `PATCH /api/integrations/feishu/installations/:installationId` and `DELETE /api/integrations/feishu/installations/:installationId`. As an admin again, the user sends `PATCH /api/integrations/feishu/installations/:installationId` with `setupCompleted: true` and then `DELETE /api/integrations/feishu/installations/:installationId`.
- Then: As a member, the status returns HTTP 200 with `isAdmin` false, while the App ID check, setup, update and removal each return HTTP 403. As an admin, the update returns HTTP 200 with `setupCompleted` true, bot name "Okou Feishu" and bot avatar URL `https://example.com/okou-feishu.png`, and removal returns HTTP 200.

## feishu-installation-011

- Vitest: "lark integration > rejects configuration API access when the feature switch is disabled"
- Mode: run
- Given: A signed-in organization admin belongs to a workspace where the Lark integration feature switch is not enabled.
- When: The admin requests `GET /api/integrations/lark`.
- Then: The API responds with HTTP 403 and error code `FORBIDDEN` with the message "Lark integration is not enabled".

## feishu-installation-012

- Vitest: "lark integration > uses the public callback origin and rotates plaintext verification credentials"
- Mode: run
- Given: A signed-in organization admin has the Lark integration feature switch enabled, the public callback base URL is configured as `https://tunnel-feishu.okou.test`, and object storage accepts writes. The Lark API issues tenant access tokens.
- When: The admin configures an app with `POST /api/integrations/lark` (App ID, App Secret, verification token) and posts an unsigned plaintext `url_verification` challenge with that token to the returned callback URL. The admin then repeats setup for the returned installation with unchanged credentials while the Lark tenant access token endpoint returns HTTP 503, and again with a replacement verification token while the endpoint succeeds, then posts challenges with the old and the new token, reads `GET /api/integrations/lark` and `GET /api/custom-connectors`, and removes the integration with `DELETE /api/integrations/lark`.
- Then: Setup returns HTTP 200 with an installation ID and a callback URL on the configured public origin. The first challenge returns HTTP 200 with body `{ challenge: "plaintext-challenge" }` and a `feishu:changed` realtime event is published. The unchanged-credential setup returns HTTP 200 with the same installation ID and callback URL and `callbackVerified: true`; the rotated-token setup returns the same installation ID and callback URL with `callbackVerified: false`. The challenge with the old token returns HTTP 401, the challenge with the new token returns HTTP 200 echoing `rotated-callback`, and the status then reports `callbackVerified` true. The custom connector list still contains exactly the original managed connector with the same ID and storage version, and removal returns HTTP 200.

## feishu-installation-013

- Vitest: "lark integration > keeps one Feishu app installed per organization"
- Mode: run
- Given: A signed-in organization admin has the Lark integration feature switch enabled and object storage accepts writes.
- When: The admin creates an app with `POST /api/integrations/lark` (`createNew: true`), repeats setup for the same App ID without `createNew`, tries to create a second App ID with `createNew: true`, checks the first App ID and an unused App ID with `GET /api/integrations/lark/app-id`, and reads `GET /api/integrations/lark`. The admin then submits setup for the first App ID with an unknown installation ID, for the second App ID with the existing installation ID, and for the first App ID with the existing installation ID, and finally sends `DELETE /api/integrations/lark/installations/:installationId`.
- Then: The first two setups return HTTP 200 and the second-app creation returns HTTP 409 with the message "This workspace already has a Lark bot". The App ID check returns HTTP 409 "This Lark App ID is already registered in Okou" for the first App ID and HTTP 200 for the unused one. The status lists exactly one installation, with the first App ID. Setup with an unknown installation ID returns HTTP 409 "This Lark App ID is already registered in Okou", the App ID change returns HTTP 409 with a message containing "cannot be changed to a different App ID", and the replay returns HTTP 200 listing that installation with the first App ID. Removal returns HTTP 200.

## feishu-installation-014

- Vitest: "lark integration > accepts one concurrent Feishu app creation per organization"
- Mode: run
- Given: A signed-in organization admin has the Lark integration feature switch enabled and object storage accepts writes.
- When: The admin concurrently sends two `POST /api/integrations/lark` requests with different App IDs and `createNew: true`, then reads `GET /api/integrations/lark` and sends `DELETE /api/integrations/lark/installations/:installationId` for the listed installation.
- Then: One request returns HTTP 200 and the other HTTP 409 with the message "This workspace already has a Lark bot". The status lists exactly one installation, and removal returns HTTP 200.

## feishu-installation-015

- Vitest: "lark integration > converges concurrent setup retries for the same Feishu app (overlapping)"
- Mode: run
- Given: A signed-in organization admin has the Lark integration feature switch enabled and object storage accepts writes. The Lark tenant access token endpoint holds both credential validations until both have started, then answers them back to back (overlapping completion).
- When: The admin sends two concurrent `POST /api/integrations/lark` requests with the same App ID, App Secret and verification token (no `createNew`), then reads `GET /api/integrations/lark` and `GET /api/custom-connectors` and sends `DELETE /api/integrations/lark/installations/:installationId`.
- Then: Both setups return HTTP 200 with the same installation ID. The status lists exactly one installation, with that ID and the submitted App ID, the custom connector list contains exactly one connector, and removal returns HTTP 200.

## feishu-installation-016

- Vitest: "lark integration > converges concurrent setup retries for the same Feishu app (after callback verification)"
- Mode: run
- Given: A signed-in organization admin has the Lark integration feature switch enabled and object storage accepts writes. The Lark tenant access token endpoint holds both credential validations until both have started, answers the first, and answers the second only after the callback has been verified (after callback verification).
- When: The admin sends two concurrent `POST /api/integrations/lark` requests with the same App ID, App Secret and verification token (no `createNew`). Once one setup returns, an unsigned `url_verification` challenge with the verification token is posted to its callback URL before the second validation is answered. The admin then reads `GET /api/integrations/lark` and `GET /api/custom-connectors` and sends `DELETE /api/integrations/lark/installations/:installationId`.
- Then: The challenge returns HTTP 200 echoing `concurrent-setup-challenge`. Both setups return HTTP 200 with the same installation ID. The status lists exactly one installation, with that ID and the submitted App ID, and reports `callbackVerified` true; the custom connector list contains exactly one connector, and removal returns HTTP 200.

## feishu-installation-017

- Vitest: "lark integration > keeps a concurrently registered Feishu app in its winning organization"
- Mode: run
- Given: Two different organizations each have a signed-in admin with the Lark integration feature switch enabled, and object storage accepts writes.
- When: Both admins concurrently send `POST /api/integrations/lark` with the same App ID and `createNew: true`, then each reads `GET /api/integrations/lark`; the winning admin sends `DELETE /api/integrations/lark/installations/:installationId`.
- Then: One setup returns HTTP 200 and the other HTTP 409 with the message "This Lark App ID is already registered in Okou". The losing organization's status reports not installed with an empty installation list. The winning organization's status lists exactly one installation whose ID matches its setup response and whose App ID is the shared one, and removal returns HTTP 200.

## feishu-installation-018

- Vitest: "lark integration > converges concurrent managed connector retries after skill publication fails"
- Mode: run
- Given: A signed-in organization admin has the Lark integration feature switch enabled, and object storage rejects the managed connector skill upload.
- When: The admin creates an app with `POST /api/integrations/lark` (`createNew: true`) and reads `GET /api/custom-connectors` and `GET /api/integrations/lark`. With object storage then reporting the skill bundle missing and holding bundle uploads until both have started, the admin sends two concurrent `PATCH /api/integrations/lark/installations/:installationId` requests with `setupCompleted: true`, lists custom connectors again and sends `DELETE /api/integrations/lark/installations/:installationId`.
- Then: The failed setup returns HTTP 500, no custom connectors are listed, and the status still lists the installation. Both completion requests return HTTP 200, both bundle uploads use the same bundle key, and the connector list then contains exactly one managed connector whose skill markdown contains `okou lark`. Removal returns HTTP 200.

## feishu-installation-019

- Vitest: "lark integration > repairs the managed connector without accessing R2 or changing its visible skill"
- Mode: run
- Given: A signed-in organization admin has the Lark integration feature switch enabled and created an app with `POST /api/integrations/lark` (`createNew: true`), which activated a managed connector. Object storage now rejects every request, and the Lark API returns bot info with app name "Okou Feishu".
- When: The admin sends `PATCH /api/integrations/lark/installations/:installationId` with `setupCompleted: true`, lists `GET /api/custom-connectors` and sends `DELETE /api/integrations/lark/installations/:installationId`.
- Then: The completion returns HTTP 200 without any object storage request. The connector list contains the same connector ID with display name "Lark-Okou Feishu" and unchanged skill markdown, and removal returns HTTP 200.

## feishu-installation-020

- Vitest: "lark integration > requires organization admins even when the user created the bot"
- Mode: run
- Given: A user who is an organization admin with the Lark integration feature switch enabled created an app with `POST /api/integrations/lark` (`createNew: true`); the same user's session then carries the member role. The Lark API returns bot info named "Okou Feishu" with avatar `https://example.com/okou-feishu.png`.
- When: As a member, the user reads `GET /api/integrations/lark`, checks an App ID with `GET /api/integrations/lark/app-id`, submits `POST /api/integrations/lark` with `createNew: true`, and sends `PATCH /api/integrations/lark/installations/:installationId` and `DELETE /api/integrations/lark/installations/:installationId`. As an admin again, the user sends `PATCH /api/integrations/lark/installations/:installationId` with `setupCompleted: true` and then `DELETE /api/integrations/lark/installations/:installationId`.
- Then: As a member, the status returns HTTP 200 with `isAdmin` false, while the App ID check, setup, update and removal each return HTTP 403. As an admin, the update returns HTTP 200 with `setupCompleted` true, bot name "Okou Feishu" and bot avatar URL `https://example.com/okou-feishu.png`, and removal returns HTTP 200.
