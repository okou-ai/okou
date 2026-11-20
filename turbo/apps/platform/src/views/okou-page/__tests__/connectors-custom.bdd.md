# Connectors custom

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-custom.test.tsx](connectors-custom.test.tsx).

## connectors-custom-001

Original test `Do not complete or authorize an exact account when required configuration is incomplete`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L199).

- **Given** A custom account is missing a required secret and an agent has no connector grant.
- **When** I enter the secret and save while required configuration is incomplete.
- **Then** An additional-setup error remains in the connection dialog, no account-naming dialog opens, and the agent remains unauthorized.

## connectors-custom-002

Original test `Do not complete or authorize an exact account when configuration is invalid`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L199).

- **Given** A custom account has invalid configuration and an agent has no connector grant.
- **When** I enter the secret and save while configuration is invalid.
- **Then** An additional-setup error remains in the connection dialog, no account-naming dialog opens, and the agent remains unauthorized.

## connectors-custom-003

Original test `Create a custom connector without authentication`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L264).

- **Given** I am creating a custom HTTP connector and have entered its display name and URL prefix.
- **When** I choose No authentication and create it.
- **Then** The connector is created and shown. Authentication-dependent fields disappear or retain their draft values when switching modes, Automatic is not offered, and Create is enabled for No authentication.

## connectors-custom-004

Original test `Add and optionally name a custom connector account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L333).

- **Given** Acme Search and Acme MCP require a secret, and Research is available as an agent.
- **When** I connect each by entering a secret and skip naming the account.
- **Then** Both connectors show Connected and Used by Research; the account name is optional.

## connectors-custom-005

Original test `Reflect a late successful agent grant after another grant has failed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L418).

- **Given** Research and Support are available; connecting Acme Search grants access to both, but Research's grant request fails while Support's request is delayed.
- **When** I connect the account, wait for Research's failure, then allow Support's grant to complete.
- **Then** Research's access-denied error remains visible, Support eventually appears as using the connector and has authorized access, and Research remains unauthorized.

## connectors-custom-006

Original test `Preserve revoked access when adding another account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L514).

- **Given** Default and Research have grants for Acme Search, which already has an account.
- **When** I revoke Default's access, then add a second account and skip naming it.
- **Then** The new account is added without restoring Default's revoked grant; Research remains authorized.

## connectors-custom-007

Original test `Manage agent access and permissions for a custom connector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L628).

- **Given** Acme Search supports the standard:use and messages:send-as-user permissions, with defaults allow and deny respectively, and Research and Support are available.
- **When** I authorize Support, allow messages:send-as-user, apply it, edit the grant to deny that permission, apply again, then revoke access.
- **Then** Applying permission changes updates the grant only when Apply is used; the grant first contains messages:send-as-user, then contains no permissions, and finally Support's access is revoked.

## connectors-custom-008

Original test `Complete a custom connector’s declared fields`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L798).

- **Given** A connector declares required API token and Account ID fields and optional Region, Backup token, and Constructor ID fields.
- **When** I provide an API token with spaces and a newline, an Account ID with surrounding spaces, and whitespace only for Region, then save.
- **Then** Save is disabled until both required fields have non-whitespace values. The submitted values are trimmed to “xaat” and “Acme West”; blank optional values are omitted.

## connectors-custom-009

Original test `Create and edit a custom definition without ordinary legacy status projections`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L897).

- **Given** I am creating a custom HTTP definition named Canonical API with an API prefix and API authentication.
- **When** I create it and rename it to Edited Canonical API.
- **Then** Both the new and edited connector appear with No accounts; the definition can be managed without projecting ordinary legacy status.

## connectors-custom-010

Original test `Manage a custom HTTP connector through creation and connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L963).

- **Given** I am viewing the custom connector scope and Research and Support are available.
- **When** I create an API-authenticated HTTP connector named Acme API with prefix https://api.acme.test/v1/, then connect it using a secret and skip naming.
- **Then** The card identifies an HTTP API, shows the prefix, and initially shows No accounts; afterward it shows Connected and Used by 2 agents.

## connectors-custom-011

Original test `Manage a custom HTTP connector through rename and deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1018).

- **Given** A connected custom HTTP API named Acme API has prefix https://api.acme.test/v1/.
- **When** I rename it to Acme Billing API and then delete it.
- **Then** The renamed card stays Connected and retains its prefix; after deletion, the empty custom-connector prompt appears.

## connectors-custom-012

Original test `Manage custom HTTP OAuth through creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1084).

- **Given** I am creating a custom HTTP connector with OAuth authentication.
- **When** I enter its API prefix, authorization and token URLs, client ID and secret, two scopes, S256 PKCE, resource, audience, offline access type, and consent prompt; copy the redirect URL and create it.
- **Then** The connector is created without an account, with the entered OAuth configuration, scopes, and parameters. The redirect URL is the app's custom callback URL, the secret is not shown on the card, and the test verifies the secret in the creation request.

## connectors-custom-013

Original test `Manage custom HTTP OAuth through configuration update and connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1242).

- **Given** An OAuth HTTP connector has existing connections, scopes search.read and search.write, and prefix https://api.acme.test/v1/.
- **When** I change the prefix to /v2/ and scopes to search.read and calendar.write, confirm Save and disconnect, then connect and skip naming.
- **Then** No update occurs before confirmation; the confirmation states existing OAuth connections will be disconnected. After confirmation the update omits a client secret, the card shows the new prefix, and OAuth connection completes with the Research usage indicator.

## connectors-custom-014

Original test `Manage a manual MCP connector through its lifecycle`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1392).

- **Given** I am creating a manual-authentication MCP server, and Research and Support are available.
- **When** I create Acme MCP at its server URL, connect it with a secret and skip naming, revoke and reauthorize Support, then edit its name and endpoint.
- **Then** The card initially identifies MCP and shows No accounts, then shows Connected and Used by 2 agents. Support can be revoked and reauthorized; after editing, the card shows Acme MCP v2 and the new endpoint, while the saved MCP definition retains its secret field and bearer authorization injection.

## connectors-custom-015

Original test `Create and connect an MCP server through automatic authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1587).

- **Given** I am creating an MCP server and Default and Research are available.
- **When** I switch from HTTP API to MCP, keep Automatic authentication, create Discovery MCP at its endpoint, and connect it while skipping account naming.
- **Then** MCP offers Automatic with the recommended discovery explanation, and switching back to MCP restores Automatic. The created definition has no fields or injections, initially shows No accounts, then shows Connected; the authorization window closes and the card says Used by 2 agents.

## connectors-custom-016

Original test `Do not report an empty Connected list when the connected directory is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1698).

- **Given** The connected directory is unavailable with a 503 response while the Connected scope is open.
- **When** I view the connected connectors page.
- **Then** The page reports that accounts are unavailable for this connector and does not claim that there are no connected connectors.

## connectors-custom-017

Original test `Keep saved custom accounts manageable when only the default needs reconnect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1719).

- **Given** Acme MCP has a default OAuth account requiring reconnect and two connected saved accounts named Work and Personal; Empty MCP has no accounts.
- **When** I view the custom and Connected scopes and open Acme MCP's account manager.
- **Then** Acme MCP remains Connected and is listed in Connected, while Empty MCP shows No accounts and can be connected. The account manager shows the default Original default with Reconnect enabled, plus Work and Personal.

## connectors-custom-018

Original test `Reconnect an OAuth account after cancelled consent and metadata changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1799).

- **Given** Acme OAuth has a healthy Work account and a Personal OAuth account requiring reconnect; Default and Research are available.
- **When** I start reconnecting Personal, cancel the first consent window after it opens, change Personal's metadata, then complete a second consent attempt.
- **Then** The connection dialog remains open after cancellation and can be continued again despite the metadata change. On completion the dialog closes without opening account naming, and the access summary remains Add access.

## connectors-custom-019

Original test `Create, edit, and connect an OAuth MCP connector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L1953).

- **Given** I am creating an OAuth MCP connector and an authorization window is available.
- **When** I create OAuth MCP with its endpoint, authorization and token URLs, client ID, and client secret; edit its endpoint; then connect it.
- **Then** The connector is created as MCP with no accounts, and the creation request includes the client secret. Editing leaves the new-client-secret field blank, omits the secret from the update, and changes the displayed endpoint; connecting opens the configured authorization URL.

## connectors-custom-020

Original test `Add and optionally name a custom OAuth account`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L2081).

- **Given** Acme Search uses OAuth and Research is available.
- **When** I start adding an account and skip its optional name.
- **Then** The account connects, the card shows Used by Research, the account name placeholder is Unnamed account, and the OAuth request uses add intent.

## connectors-custom-021

Original test `Edit a custom HTTP connector without losing advanced configuration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L2180).

- **Given** Acme Search has no header injections and a query injection mapping api_key to its secret.
- **When** I open Edit and save without changing the definition.
- **Then** The editor states that advanced API fields and injections are preserved, and the saved definition retains the original prefix, empty header injections, and api_key query injection.

## connectors-custom-022

Original test `Do not grant access after an unsuccessful custom connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L2245).

- **Given** Acme Incomplete needs a secret and Research is available; saving the connection initially fails because writes are unavailable.
- **When** I save once during the service failure, then retry after writes become available, and inspect access.
- **Then** The first attempt shows “Write unavailable” and keeps the dialog open. The retry reports that additional setup is needed, and Research remains unauthorized.

## connectors-custom-023

Original test `Hide integration-managed connectors from custom settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L2317).

- **Given** The custom connector list contains an integration-managed Feishu connector.
- **When** I open custom connector settings.
- **Then** Feishu is hidden and the empty custom-connector prompt is shown.

## connectors-custom-024

Original test `Manage a custom connector before it is connected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L2359).

- **Given** Acme Search is an unconnected HTTP API with a configured prefix.
- **When** I inspect its card and open its options.
- **Then** The card shows HTTP API, the prefix, and No accounts; it offers Connect but not access management, and its options offer Edit and Delete but not Connect.

## connectors-custom-025

Original test `Validate new and reconnecting custom accounts appropriately`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L2396).

- **Given** An existing default account has configured values for required Secret and Subdomain fields.
- **When** I start adding another account, enter only Secret, close the dialog, then reopen account management and reconnect the existing default with a new Secret.
- **Then** A new account requires both fields and is not labeled Configured; Save becomes enabled after both are supplied. Reconnecting the existing account enables Save with Secret alone, submits reconnect intent for that account, and does not ask for an account name.

## connectors-custom-026

Original test `Preserve custom connector grants when credentials are added`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L2509).

- **Given** Research already has an Acme Search grant for messages:send-as-user, and the connector has no connected account.
- **When** I connect it by entering its secret and skip naming.
- **Then** The connector shows Connected and Used by Research, and adding credentials makes no grant mutation, preserving the existing grant.

## connectors-custom-027

Original test `Read a custom target again when its account manager reopens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-custom.test.tsx#L2602).

- **Given** Acme Search's account manager initially contains Original account.
- **When** I close the manager, change the account's display name to Updated account, and reopen it.
- **Then** The reopened manager shows Updated account, reflecting the latest account information.
