# Team connectors

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [team-connectors.test.tsx](team-connectors.test.tsx).

## team-connectors-001

Original test `Cancelled custom connector permission edits do not appear on another agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L261).

- **Given** A user is editing Acme Search permissions for the Research Agent, with a separate Support Agent available.
- **When** They change the permission to Allow, cancel the edits, and open the Support Agent.
- **Then** The permission editor is closed, the Support Agent shows the Grant Acme Search access control without an open permission editor, and no custom permission change was saved.

## team-connectors-002

Original test `An agent with no connected services guides the user to Connectors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L286).

- **Given** An agent has no connected services.
- **When** The user opens the agent's details.
- **Then** The page shows guidance that there are no connected services and links to Connectors at /connectors.

## team-connectors-003

Original test `A user can authorize a connected MCP custom connector for an agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L300).

- **Given** The DeepWiki MCP custom connector is connected for the user and available on the agent page.
- **When** The user grants DeepWiki access to the agent.
- **Then** DeepWiki's endpoint is visible, its access control changes from Grant to Revoke, and the page confirms that custom connectors were saved. Permission management is not offered for this connector.

## team-connectors-004

Original test `Connector permission management appears only when permissions exist`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L322).

- **Given** A connected Axiom builtin connector and an Acme Search custom connector are available, neither with permission settings.
- **When** The user opens the agent's details.
- **Then** Both connectors are visible, but neither connector has a permission-management control.

## team-connectors-005

Original test `An unconfigured custom connector is not offered to an agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L354).

- **Given** Axiom is connected, while the Acme Search custom connector has no configured account.
- **When** The user opens the agent's details.
- **Then** Axiom is shown, but Acme Search is not offered to the agent.

## team-connectors-006

Original test `Granting custom access stays busy through account preparation and saving`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L373).

- **Given** Acme Search is available to an agent, and preparing its account and saving the grant are delayed.
- **When** The user grants Acme Search access while account preparation is pending and then while saving is pending.
- **Then** The Grant Acme Search access control remains disabled throughout both waits. After saving completes, the page confirms the save and the Revoke Acme Search access control is enabled.

## team-connectors-007

Original test `An agent can grant access through a healthy configured default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L427).

- **Given** Acme Search has a healthy configured default account and is available to an agent.
- **When** The user grants access.
- **Then** The save succeeds, and the grant contains no permission names and is added for that agent.

## team-connectors-008

Original test `Check a canonical custom default only when granting access (connected)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L455).

- **Given** Acme Search has a connected canonical default account, and the agent has not granted it access.
- **When** The user views the agent's connectors and then grants Acme Search access.
- **Then** Viewing the page does not read the account list or show a reconnect warning. Granting access reads the account list, saves the grant, and shows no alert.

## team-connectors-009

Original test `Check a canonical custom default only when granting access (reconnect-required)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L455).

- **Given** Acme Search's canonical default account requires reconnection, and the agent has not granted it access.
- **When** The user views the agent's connectors and then tries to grant Acme Search access.
- **Then** Viewing the page does not read the account list or show a reconnect warning. The grant attempt reads the account list, does not save a grant, and shows one alert asking for a fully configured default account.

## team-connectors-010

Original test `Check a canonical custom default only when granting access (configuration_incomplete)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L455).

- **Given** Acme Search's canonical default account is incomplete because the required secret is missing, and the agent has not granted it access.
- **When** The user views the agent's connectors and then tries to grant Acme Search access.
- **Then** Viewing the page does not read the account list or show a reconnect warning. The grant attempt reads the account list, does not save a grant, and shows one alert asking for a fully configured default account.

## team-connectors-011

Original test `An expired custom default permits reductions but checks access expansion (reduce)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L514).

- **Given** Acme Search has an expired default account, and the agent currently has search:run and report:read permissions.
- **When** The user changes search:run to Deny and applies the change.
- **Then** The reduction succeeds without reading the account list, and the saved grant retains only report:read. The permission editor closes.

## team-connectors-012

Original test `An expired custom default permits reductions but checks access expansion (expand)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L514).

- **Given** Acme Search has an expired default account, and the agent currently has only report:read permission.
- **When** The user changes search:run to Allow and applies the change.
- **Then** The expansion is blocked after reading the account list; no grant is saved, and an alert asks for a fully configured default account. The permission editor remains open.

## team-connectors-013

Original test `An unavailable custom default keeps its existing agent grant revocable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L606).

- **Given** Acme Search is unavailable, but the agent already has an existing grant for it.
- **When** The user revokes access.
- **Then** The removal succeeds without disabling the revoke control, and the control changes to Grant Acme Search access.

## team-connectors-014

Original test `Saved builtin and unavailable custom connectors stay visible without account list reads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L640).

- **Given** GitHub is saved as a builtin connector and Acme Search is saved as a custom connector, but no account-list entries are available.
- **When** The user opens the agent's details.
- **Then** Both connectors remain visible, Acme Search access can be granted, and the page does not show the no-connected-services message or read the account list.

## team-connectors-015

Original test `Managed Feishu keeps its integration-owned access lifecycle`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L667).

- **Given** Feishu is a connected OAuth custom connector managed by its integration.
- **When** The user opens the agent's details.
- **Then** Grant Feishu access is enabled, and neither a No accounts message nor the no-connected-services message appears.

## team-connectors-016

Original test `Managed Lark keeps its integration-owned access lifecycle`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L667).

- **Given** Lark is a connected OAuth custom connector managed by its integration.
- **When** The user opens the agent's details.
- **Then** Grant Lark access is enabled, and neither a No accounts message nor the no-connected-services message appears.

## team-connectors-017

Original test `A slower account check preserves the newer connector permission draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-connectors.test.tsx#L703).

- **Given** Acme Search and Second Search both support permission management, and the account check for Acme Search is delayed.
- **When** The user opens Acme Search's grant flow, opens Second Search's permission editor before the first account check completes, and then allows the first check to finish.
- **Then** The Acme Search control becomes enabled, while Second Search's permission editor remains open and no alert appears.
