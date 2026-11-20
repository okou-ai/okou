# Connectors catalog

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-catalog.test.tsx](connectors-catalog.test.tsx).

## connectors-catalog-001

Original test `Connector catalog describes the current experience (My Okou=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L41).

- **Given** The user opens the connector catalog with My Okou disabled and the catalog reports 42 services.
- **When** The catalog loads.
- **Then** The page says, “Connect 42 services for your agents to use.”

## connectors-catalog-002

Original test `Connector catalog describes the current experience (My Okou=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L41).

- **Given** The user opens the connector catalog with My Okou enabled and the catalog reports 42 services.
- **When** The catalog loads.
- **Then** The page says, “Connect 42 services for your Okou to use.”

## connectors-catalog-003

Original test `Show saved membership without loading accounts when catalog projections have been retired`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L68).

- **Given** The user has a saved GitHub connection, but the directory's account-list endpoint is unavailable; GitHub is present in the catalog status.
- **When** The user opens the Connected connector catalog.
- **Then** GitHub is marked Connected, the saved username is not shown, and Manage GitHub access is enabled. Connect GitHub is not offered.

## connectors-catalog-004

Original test `Authorize one agent without changing another agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L103).

- **Given** Research and Support agents are visible, and GitHub is connected but authorized for neither agent.
- **When** The user opens Manage GitHub access and authorizes Research.
- **Then** Research is shown as authorized, while Support remains unauthorized.

## connectors-catalog-005

Original test `Browse connectors by category`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L190).

- **Given** The user opens the connector catalog with GitHub connected.
- **When** The user browses the Engineering team execution category.
- **Then** The category contains GitHub and Asana, and Asana's icon is loaded lazily.

## connectors-catalog-006

Original test `Filter connected connectors by an agent after clearing the text search`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L251).

- **Given** The Connected catalog has GitHub, and Research Agent has GitHub enabled.
- **When** The user searches for “git,” clears the search, then filters by Research Agent.
- **Then** GitHub remains visible and Asana remains absent; the URL records the agent connection filter and Research Agent's ID.

## connectors-catalog-007

Original test `Require an application update before using connectors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L268).

- **Given** The connector catalog responds that a client update is required.
- **When** The user opens the catalog.
- **Then** An “Update required” dialog asks the user to refresh for the latest version, and no raw HTTP 426 message is shown.

## connectors-catalog-008

Original test `Search connectors and keep the query in the URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L284).

- **Given** The user opens the catalog with the URL query “keywords=axiom,” and Axiom and GitHub are available.
- **When** The user searches for “github,” then searches for “missing-service.”
- **Then** Initially the search field contains “axiom,” Axiom is shown, and GitHub is absent. The next search shows GitHub, removes Axiom, and updates the URL query to “github”; the final search shows a no-matching-connectors message.

## connectors-catalog-009

Original test `Search the full connector catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L308).

- **Given** The catalog contains 1,234 services and initially returns GitHub for an empty search.
- **When** The user searches for “Slack.”
- **Then** Slack appears and GitHub disappears; the search is sent as “Slack,” and the page continues to report 1,234 services.

## connectors-catalog-010

Original test `Present a connector with no accounts and start direct OAuth`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L341).

- **Given** The user has no GitHub accounts, and GitHub offers direct OAuth with a description and an authorization URL.
- **When** The user opens the catalog and selects Connect GitHub.
- **Then** The GitHub card shows its description, does not show “No accounts” or Manage GitHub access, and opens the OAuth authorization URL.

## connectors-catalog-011

Original test `Browse the catalog as shelves, then enter a category and come back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L429).

- **Given** The communication and collaboration category has 327 connectors, while the initial catalog response supplies a subset of that category.
- **When** The user browses the shelves, enters the communication and collaboration category, then returns to Discover.
- **Then** The shelf offers to show the category with “321 more.” Entering it updates the URL, shows all 16 returned category cards including Test Subdomain, and removes the shelf; returning clears the category query and restores the shelf.

## connectors-catalog-012

Original test `Land on Discover, then switch to the connectors this workspace has`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L517).

- **Given** The workspace has saved Gmail and Outlook Mail connections, both present in the catalog.
- **When** The user switches from Discover to the Connected scope.
- **Then** Discover initially shows a Connected count of 2 and keeps Gmail on its shelf without a Connect action. Connected shows only the two saved connectors, replaces the category filter with an agent filter, and offers an All agents option.

## connectors-catalog-013

Original test `Keep a saved connector in Connected when its account needs a reconnect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L578).

- **Given** The workspace has a saved Gmail connection that requires reconnecting because authorization expired or was revoked.
- **When** The user opens the connector catalog.
- **Then** The Connected scope still counts Gmail, and Manage Gmail accounts is enabled.

## connectors-catalog-014

Original test `Find the connectors no agent is using`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L604).

- **Given** The Connected scope contains Gmail and Outlook Mail, but Research uses only Gmail.
- **When** The user filters for “Not shared with any agent.”
- **Then** Gmail disappears, Outlook Mail remains, and the URL connection filter is “unshared.”

## connectors-catalog-015

Original test `Reach the connectors this workspace built from their own segment`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-catalog.test.tsx#L653).

- **Given** The workspace has one saved built-in connector and one custom connector named Acme Search.
- **When** The user opens the catalog and switches to the Custom scope.
- **Then** Acme Search is absent from Discover and appears in Custom; that scope has no category filter, has no catalog shelf, and offers New custom connector.
