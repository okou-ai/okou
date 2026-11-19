# Custom connector cloudflare authoring

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [custom-connector-cloudflare-authoring.test.tsx](custom-connector-cloudflare-authoring.test.tsx).

## custom-connector-cloudflare-authoring-001

Original test `Create a http connector with organization Cloudflare Access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L214).

- **Given** An admin is creating an HTTP custom connector with no existing connector.
- **When** They set its prefix to https://api.acme.test/v1/, choose no authentication, and select the organization Cloudflare Access gateway.
- **Then** The personal gateway is not offered. The selected organization gateway is summarized in collapsed advanced settings and is submitted with storage version 1 and no authentication; the created connector shows the Cloudflare Access requirement.

## custom-connector-cloudflare-authoring-002

Original test `Create a mcp connector with organization Cloudflare Access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L214).

- **Given** An admin is creating an MCP custom connector with no existing connector.
- **When** They select Streamable HTTP, set the endpoint to https://mcp.acme.test/server, and select the organization Cloudflare Access gateway.
- **Then** The personal gateway is not offered. The selected organization gateway is summarized in collapsed advanced settings and is submitted with storage version 1 and automatic authentication; the created connector shows the Cloudflare Access requirement.

## custom-connector-cloudflare-authoring-003

Original test `Preserve, rebind and clear a http network requirement without changing app storage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L300).

- **Given** An admin is editing an HTTP connector bound to the Corporate gateway, with storage version 7.
- **When** They rename it, rebind it to the Replacement gateway, then clear its Cloudflare Access requirement in a further edit.
- **Then** Renaming preserves the existing binding by omitting a binding change, and rebinding submits the replacement configuration while retaining storage version 7 and manual authentication. Clearing submits a null binding, and the connector card still shows its HTTP prefix.

## custom-connector-cloudflare-authoring-004

Original test `Preserve, rebind and clear a mcp network requirement without changing app storage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L300).

- **Given** An admin is editing an MCP connector bound to the Corporate gateway, with storage version 7.
- **When** They rename it, rebind it to the Replacement gateway, then clear its Cloudflare Access requirement in a further edit.
- **Then** Renaming preserves the existing binding by omitting a binding change, and rebinding submits the replacement configuration while retaining storage version 7 and manual authentication. Clearing submits a null binding, and the connector card still shows its MCP endpoint.

## custom-connector-cloudflare-authoring-005

Original test `A member following a dependency link sees the connector without admin editing controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L350).

- **Given** A member opens a dependency link for an HTTP connector bound to the Corporate gateway.
- **When** They follow the link to the connector page.
- **Then** The connector and its HTTP prefix are visible, but no edit dialog or More options control is available.

## custom-connector-cloudflare-authoring-006

Original test `A network-only OAuth edit preserves the app secret and account storage contract`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L374).

- **Given** An admin is editing an OAuth connector with an existing OAuth configuration and a Corporate gateway binding; its storage version is 7.
- **When** They change only the network requirement to the Replacement gateway and save.
- **Then** The update retains OAuth authentication, the existing OAuth configuration, and storage version 7, while changing the network binding. The update does not include a client secret.

## custom-connector-cloudflare-authoring-007

Original test `A feature-disabled http binding remains unavailable and can be explicitly removed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L412).

- **Given** An admin edits an HTTP connector with an unavailable Cloudflare Access binding while the feature is disabled.
- **When** They save a display-name change, then explicitly remove the requirement in a later edit.
- **Then** The binding remains unchanged when omitted from the first update and is shown as unavailable while the feature is off. Explicit removal submits a null binding and preserves storage version 7.

## custom-connector-cloudflare-authoring-008

Original test `A feature-disabled mcp binding remains unavailable and can be explicitly removed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L412).

- **Given** An admin edits an MCP connector with an unavailable Cloudflare Access binding while the feature is disabled.
- **When** They save a display-name change, then explicitly remove the requirement in a later edit.
- **Then** The binding remains unchanged when omitted from the first update and is shown as unavailable while the feature is off. Explicit removal submits a null binding and preserves storage version 7.

## custom-connector-cloudflare-authoring-009

Original test `A collapsed requirement distinguishes pending, failed and unavailable lookup before a valid rebind`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L459).

- **Given** An admin is editing an HTTP connector whose Cloudflare Access requirement is unavailable, and the configuration lookup is still pending.
- **When** The lookup fails, then becomes available for retry; the admin selects the Replacement gateway and saves a pending display-name change.
- **Then** The collapsed requirement shows loading, then a load-failure message while the field also reports the failure. Before a valid rebind, the collapsed summary still identifies the existing requirement as unavailable; choosing the Replacement gateway removes the unavailable warning. Saving retains the display-name draft and storage version 7, submits the new binding, and keeps manual authentication.

## custom-connector-cloudflare-authoring-010

Original test `A configuration load failure and rejected save preserve the connector draft until explicit retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L522).

- **Given** An admin is creating an HTTP connector while Cloudflare Access configurations are loading.
- **When** They enter a display name, prefix, and no-authentication choice, select the Corporate gateway after the lookup fails, and retry creation after the first save is rejected.
- **Then** The load failure is shown without losing the draft. The first save reports that the configuration changed and leaves the entered name and selected gateway in place; an explicit second save succeeds and closes the dialog.

## custom-connector-cloudflare-authoring-011

Original test `Resolve a http dependency through its settings link before a fresh network deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L595).

- **Given** A Corporate gateway has an HTTP connector dependency, and deletion is initially disabled while the Cloudflare Access feature is off.
- **When** The admin opens gateway settings, follows the connector link, removes the connector's network requirement, returns to the gateway, changes its scope to personal, then returns to the gateway again.
- **Then** Removing the dependency submits a null binding while preserving storage version 7. The scope change is selected, and the refreshed gateway page shows deletion enabled.

## custom-connector-cloudflare-authoring-012

Original test `Resolve a mcp dependency through its settings link before a fresh network deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-cloudflare-authoring.test.tsx#L595).

- **Given** A Corporate gateway has an MCP connector dependency, and deletion is initially disabled while the Cloudflare Access feature is off.
- **When** The admin opens gateway settings, follows the connector link, removes the connector's network requirement, returns to the gateway, changes its scope to personal, then returns to the gateway again.
- **Then** Removing the dependency submits a null binding while preserving storage version 7. The scope change is selected, and the refreshed gateway page shows deletion enabled.
