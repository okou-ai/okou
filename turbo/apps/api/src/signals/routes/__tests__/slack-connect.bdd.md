# slack-connect

## slack-connect-001

- Vitest: "GET /api/integrations/slack/connect > returns 401 when the authenticated session has no active organization"
- Mode: run
- Given: An organization has an installed Slack workspace, and the caller's authenticated session has no active organization.
- When: The caller requests `GET /api/integrations/slack/connect`.
- Then: The response is HTTP 401 with `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }`.

## slack-connect-002

- Vitest: "GET /api/integrations/slack/connect > returns isConnected: false when the user has no slack connection"
- Mode: run
- Given: An organization admin's workspace has an installed Slack workspace, but the admin has no Slack account connection.
- When: The admin requests `GET /api/integrations/slack/connect`.
- Then: The response is HTTP 200 with exactly `{ isConnected: false, isAdmin: true }`.

## slack-connect-003

- Vitest: "GET /api/integrations/slack/connect > returns isConnected: true with workspace info when the user is connected"
- Mode: run
- Given: An organization admin's workspace has an installed Slack workspace and the admin's Slack account is connected.
- When: The admin requests `GET /api/integrations/slack/connect`.
- Then: The response is HTTP 200 with exactly `isConnected` true, `isAdmin` true and the Slack workspace name.

## slack-connect-004

- Vitest: "GET /api/integrations/slack/connect > offers OAuth before resolving another user's Slack account ownership"
- Mode: run
- Given: An organization's installed Slack workspace has a connected Slack user belonging to another member. A different admin of that organization has no Slack connection.
- When: The admin requests `GET /api/integrations/slack/connect/link-status` for that workspace and the other member's Slack user ID.
- Then: The response is HTTP 200 with exactly `{ isConnected: false, isAdmin: true, linkStatus: { kind: "connect" } }`.

## slack-connect-005

- Vitest: "GET /api/integrations/slack/connect > reports the identity switch when another workspace belongs to another organization"
- Mode: run
- Given: An admin is connected to their organization's Slack workspace. Another organization has its own installed workspace with a connected Slack user.
- When: The admin requests `GET /api/integrations/slack/connect/link-status` for the other workspace and its Slack user ID.
- Then: The response is HTTP 200 with `isConnected` true, `isAdmin` true, the admin's current workspace name, and `linkStatus` `slack_account_mismatch` with the admin's current and the requested Slack user IDs.

## slack-connect-006

- Vitest: "GET /api/integrations/slack/connect > reports when the current user is linked to a different Slack account"
- Mode: run
- Given: An admin is connected to their organization's Slack workspace with one Slack user ID.
- When: The admin requests `GET /api/integrations/slack/connect/link-status` for the same workspace and a different Slack user ID.
- Then: The response is HTTP 200 with `isConnected` true, `isAdmin` true, the workspace name, and `linkStatus` `slack_account_mismatch` with the current and requested Slack user IDs.

## slack-connect-007

- Vitest: "GET /api/integrations/slack/connect > offers connect when the requested account is not linked"
- Mode: run
- Given: An admin's organization has an installed Slack workspace and the admin has no Slack connection.
- When: The admin requests `GET /api/integrations/slack/connect/link-status` for that workspace and the admin's Slack user ID.
- Then: The response is HTTP 200 with exactly `{ isConnected: false, isAdmin: true, linkStatus: { kind: "connect" } }`.

## slack-connect-008

- Vitest: "GET /api/integrations/slack/connect > keeps unbound workspace link eligibility for org:admin"
- Mode: run
- Given: A Slack workspace is installed but not bound to any organization, and the caller is an `org:admin` without a Slack connection.
- When: The caller requests `GET /api/integrations/slack/connect/link-status` for that workspace and Slack user ID.
- Then: The response is HTTP 200 with exactly `{ isConnected: false, isAdmin: true, linkStatus: { kind: "connect" } }`.

## slack-connect-009

- Vitest: "GET /api/integrations/slack/connect > keeps unbound workspace link eligibility for org:member"
- Mode: run
- Given: A Slack workspace is installed but not bound to any organization, and the caller is an `org:member` without a Slack connection.
- When: The caller requests `GET /api/integrations/slack/connect/link-status` for that workspace and Slack user ID.
- Then: The response is HTTP 200 with exactly `{ isConnected: false, isAdmin: false, linkStatus: { kind: "connect" } }`.

## slack-connect-010

- Vitest: "GET /api/integrations/slack/connect > keeps the current connection when an admin requests another unbound workspace"
- Mode: run
- Given: An admin is connected to their organization's Slack workspace, and another Slack workspace is installed but unbound.
- When: The admin requests `GET /api/integrations/slack/connect/link-status` for the unbound workspace and its Slack user ID.
- Then: The response is HTTP 200 with `isConnected` true, `isAdmin` true, the current workspace name, and `linkStatus` `slack_account_mismatch` with the current and requested Slack user IDs.

## slack-connect-011

- Vitest: "GET /api/integrations/slack/connect > offers identity OAuth without requiring an installed workspace"
- Mode: run
- Given: A signed-in user's organization has no Slack installation, and the requested Slack workspace is not installed anywhere.
- When: The user requests `GET /api/integrations/slack/connect/link-status` for that workspace and a Slack user ID.
- Then: The response is HTTP 200 with exactly `{ isConnected: false, isAdmin: true, linkStatus: { kind: "connect" } }`.

## slack-connect-012

- Vitest: "GET /api/integrations/slack/connect > returns isAdmin: true for admin users"
- Mode: run
- Given: An `org:admin` is connected to the organization's installed Slack workspace.
- When: The admin requests `GET /api/integrations/slack/connect`.
- Then: The response is HTTP 200 with `isAdmin` true.

## slack-connect-013

- Vitest: "GET /api/integrations/slack/connect > returns isAdmin: false for member users"
- Mode: run
- Given: An `org:member` is connected to the organization's installed Slack workspace.
- When: The member requests `GET /api/integrations/slack/connect`.
- Then: The response is HTTP 200 with `isAdmin` false.

## slack-connect-014

- Vitest: "POST /api/integrations/slack/connect > returns 401 when not authenticated"
- Mode: run
- Given: The caller sends no authentication.
- When: The caller posts `POST /api/integrations/slack/connect` with user scopes requested for workspace `T-test` and user `U-test`.
- Then: The response is HTTP 401 with `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }`.

## slack-connect-015

- Vitest: "POST /api/integrations/slack/connect > starts identity OAuth when the workspace has no installation"
- Mode: run
- Given: An admin's organization has an installed Slack workspace, but the requested workspace `T-nonexistent` has no installation.
- When: The admin posts `POST /api/integrations/slack/connect` with user scopes requested for `T-nonexistent`.
- Then: The response is HTTP 202 with an authorization URL whose path is `/api/slack/oauth/connect`.

## slack-connect-016

- Vitest: "POST /api/integrations/slack/connect > member starts user OAuth before connecting to a bound workspace"
- Mode: run
- Given: An `org:member`'s organization has a bound installed Slack workspace and the member has no Slack connection.
- When: The member posts `POST /api/integrations/slack/connect` for that workspace, then reads `GET /api/integrations/slack/connect`.
- Then: The connect returns HTTP 202 with an authorization URL containing `/api/slack/oauth/connect?connectorState=`, and the status read still reports `isConnected` false.

## slack-connect-017

- Vitest: "POST /api/integrations/slack/connect > starts identity OAuth for a member of an unbound workspace"
- Mode: run
- Given: An `org:member`'s requested Slack workspace is installed but unbound.
- When: The member posts `POST /api/integrations/slack/connect` for that workspace and Slack user ID.
- Then: The response is HTTP 202 with an authorization URL whose path is `/api/slack/oauth/connect`.

## slack-connect-018

- Vitest: "POST /api/integrations/slack/connect > starts identity OAuth through another organization's installation"
- Mode: run
- Given: An admin requests a Slack workspace that is installed by another organization.
- When: The admin posts `POST /api/integrations/slack/connect` for that workspace and Slack user ID.
- Then: The response is HTTP 202 with an authorization URL whose path is `/api/slack/oauth/connect`.

## slack-connect-019

- Vitest: "POST /api/integrations/slack/connect/switch > returns 401 when not authenticated"
- Mode: run
- Given: The caller sends no authentication.
- When: The caller posts `POST /api/integrations/slack/connect/switch` with user scopes requested for workspace `T-test` and user `U-test`.
- Then: The response is HTTP 401 with `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }`.

## slack-connect-020

- Vitest: "POST /api/integrations/slack/connect/switch > uses a distinct route for switch intent"
- Mode: run
- Given: An `org:member`'s organization has an installed Slack workspace.
- When: The member posts `POST /api/integrations/slack/connect/switch` for that workspace and Slack user ID.
- Then: The switch route path is `/api/integrations/slack/connect/switch`. The response is HTTP 202 with an authorization URL whose path is `/api/slack/oauth/connect` and which carries a `connectorState` parameter.
