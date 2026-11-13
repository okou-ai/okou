import { personalCommandMode } from "../../../lib/command/single-agent";
import { readManagementInput } from "../../../lib/management-input";
import { customConnectorMetadata } from "../management";

import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import chalk from "chalk";
import { Command } from "commander";

import { createCustomConnector } from "../../../lib/api/domains/connectors";
import { decodeSandboxTokenPayload } from "../../../lib/api/sandbox-token";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { getOkouAgentId } from "../../../lib/okou-env";
import {
  CALLBACK_PROMPT_GUIDANCE,
  CALLBACK_PROMPT_MAX_LENGTH,
  connectorActionUrl,
  finalizeActionUrl,
  printCallbackActionUrlExample,
  printCallbackTurnInstruction,
} from "../action-url";
import { getPlatformOrigin } from "../../../lib/platform-url";
import { createCustomConnectorDefinitionFileSchema } from "./definition";

interface CreateOptions {
  readonly file: string;
  readonly json?: boolean;
  readonly callbackPrompt?: string;
}

function requireCustomConnectorWriteCapability(): void {
  const payload = decodeSandboxTokenPayload();
  if (payload && !payload.capabilities.includes("connector:write")) {
    throw new Error(
      `Custom connector creation is not enabled for this ${payload.singleAgent ? "Run" : "agent run"}`,
    );
  }
}

function printCreateResult(
  connector: CustomConnectorResponse,
  options: CreateOptions,
  connectUrl: string,
  agentId: string | undefined,
): void {
  if (options.json) {
    console.log(
      JSON.stringify(
        { ...customConnectorMetadata(connector), connectUrl },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    chalk.green(`✓ Custom connector "${connector.displayName}" created`),
  );
  console.log(chalk.dim(`  ID:             ${connector.id}`));
  console.log(chalk.dim(`  Slug:           ${connector.slug}`));
  console.log(chalk.dim(`  Authentication: ${connector.authMode}`));
  console.log(chalk.dim("  Status:         awaiting connection"));
  console.log();
  console.log(
    `Connect it at: [Connect ${connector.displayName}](${connectUrl})`,
  );
  if (options.callbackPrompt !== undefined) {
    printCallbackTurnInstruction();
  } else {
    printCallbackActionUrlExample(connectUrl, agentId);
  }
}

export const createCustomConnectorCommand = new Command()
  .name("create")
  .description("Create a custom HTTP or MCP connector definition from JSON")
  .requiredOption(
    "-f, --file <path|->",
    "JSON connector definition file, or '-' for stdin",
  )
  .option("--json", "Print the created connector and connectUrl as JSON")
  .option(
    "--callback-prompt <prompt>",
    `Start the next web chat round with this prompt after connection (max ${CALLBACK_PROMPT_MAX_LENGTH} characters)`,
  )
  .addHelpText("after", ({ command }) => {
    const personal = personalCommandMode(command);
    return `
Types and authentication:
  HTTP definitions may include a firewall with permissions containing name,
  description, defaultPolicy (allow/deny), and rules such as "POST /grants".
  Rules are relative to each API prefix; unlisted endpoints are denied.
  Use defaultPolicy: "deny" for actions requiring explicit owner authorization.
  Do not combine a firewall with a builtin permissionBundleRef. MCP does not
  support HTTP firewall rules.

  HTTP uses prefixTemplates and supports authMode: none, manual, oauth.
  HTTP API prefixes accept http:// or https://.
  MCP requires kind: "mcp", endpoint, transport: "streamable-http" and supports
  authMode: none, manual, oauth, automatic. Omit prefixTemplates for MCP.
  Always supply authMode explicitly.

  none: No authentication injections or OAuth configuration. HTTP may declare
    non-secret variable fields; MCP requires empty fields.
  manual: Declare credential fields and Header/Query injection templates.
  oauth: Use empty fields, OAuth token injection, and standard OAuth app config.
    Creation requires the app client secret; members authorize their accounts later.
  automatic: MCP-only discovery of no-auth or OAuth during connection/reconnect.
    Use empty fields and injections, without static OAuth configuration.

Cloudflare Access (when enabled):
  Add "networkBinding": {"type":"cloudflare_access","configId":"<configuration-uuid>"}
  to use an existing organization-scoped configuration from the same organization.
  Every allowed request matching the connector firewall uses this network layer,
  independently of application authentication. Targets must use HTTPS.
  Cloudflare Access owns CF-Access-Client-Id and CF-Access-Client-Secret; do not
  add those headers as application injections or copy the service token into JSON.
  Omit networkBinding for no Cloudflare requirement when creating a connector.

Definition file:
  Describe only the connector metadata, Header/Query injection templates, and
  OAuth app configuration and an optional network configuration reference.
  Never include an API token,
  end-user OAuth token, or values array. Creating the definition is separate
  from connecting a member account, including for none and automatic modes.

${personal ? "Okou setup sequence" : "Agent workflow"}:
  1. For manual connectors, ask only for missing metadata: name, HTTP or HTTPS
     API prefix for HTTP or HTTPS endpoint for MCP, and the Header or Query
     injection template. Do not ask the user for the actual API token.
  2. Declare every credential input as a secret or variable field, then use
     references such as {{secrets.api_token}} or {{variables.account_id}} in
     Header and Query injection templates.
  3. For OAuth connectors, collect the same OAuth app configuration shown by
     the Connectors page, including the client ID and client secret. Never ask
     for an end-user access token or refresh token.
  4. Write a temporary JSON definition, run this command, then remove the file.
  5. Return the emitted Connect link (connectUrl in JSON) verbatim, including
     all query parameters. In the current web chat it renders a connection
     card for this connector. Do not replace it with the Connectors list URL.
     The user finishes the separate account connection flow, including for
     none and automatic modes.
  6. When this connection is the only access action needed, add --callback-prompt
     with a brief task and next step. Share connectUrl and end the turn; Okou
     continues after the user completes the connection and ${personal ? "Okou access" : "Agent"} authorization.

No-auth HTTP connector example:
  {
    "displayName": "Acme Public API",
    "prefixTemplates": ["https://api.acme.example/v1/"],
    "fields": [],
    "headerInjections": [],
    "queryInjections": [],
    "authMode": "none"
  }

Manual API connector example:
  {
    "displayName": "Acme API",
    "prefixTemplates": ["https://api.acme.example/v1/"],
    "fields": [
      {
        "key": "secret",
        "label": "API Token",
        "kind": "secret",
        "required": true,
        "description": "API credential"
      }
    ],
    "headerInjections": [
      {
        "name": "Authorization",
        "valueTemplate": "Bearer {{secrets.secret}}"
      }
    ],
    "queryInjections": [],
    "authMode": "manual"
  }

OAuth HTTP connector example:
  {
    "displayName": "Acme OAuth API",
    "prefixTemplates": ["https://api.acme.example/v1/"],
    "fields": [],
    "headerInjections": [
      {
        "name": "Authorization",
        "valueTemplate": "Bearer {{oauth.access_token}}"
      }
    ],
    "queryInjections": [],
    "authMode": "oauth",
    "oauthConfig": {
      "providerAdapter": "standard",
      "clientId": "<oauth-client-id>",
      "clientSecret": "<oauth-client-secret>",
      "authorizationUrl": "https://acme.example/oauth/authorize",
      "tokenUrl": "https://acme.example/oauth/token",
      "tokenEndpointAuthMethod": "client_secret_post",
      "pkceMethod": "S256",
      "scopes": ["read", "write"],
      "authorizationParams": {}
    }
  }

Manual Streamable HTTP MCP connector example:
  {
    "kind": "mcp",
    "displayName": "Acme MCP",
    "endpoint": "https://mcp.acme.example/mcp",
    "transport": "streamable-http",
    "fields": [
      {
        "key": "secret",
        "label": "API Token",
        "kind": "secret",
        "required": true
      }
    ],
    "headerInjections": [
      {
        "name": "Authorization",
        "valueTemplate": "Bearer {{secrets.secret}}"
      }
    ],
    "queryInjections": [],
    "authMode": "manual"
  }

Automatic Streamable HTTP MCP connector example:
  {
    "kind": "mcp",
    "displayName": "Acme Automatic MCP",
    "endpoint": "https://mcp.acme.example/mcp",
    "transport": "streamable-http",
    "fields": [],
    "headerInjections": [],
    "queryInjections": [],
    "authMode": "automatic"
  }

For a fixed no-auth MCP server, use the same MCP shape with authMode: "none".
For an MCP OAuth app, use the OAuth HTTP example's fields, injections and
oauthConfig, replacing prefixTemplates with kind, endpoint and transport from
the MCP example. Set authMode: "oauth".

Examples:
  okou connector custom create --file ./connector.json
  okou connector custom create --file ./connector.json --json
  okou connector custom create --file ./connector.json --json --callback-prompt "Verify the newly connected MCP tools"

Notes:
  - This command only creates the connector definition; it does not store a
    manual API token, start OAuth authorization, or authorize ${personal ? "your Okou" : "an agent"}.
  - Manual credentials and end-user OAuth grants are supplied later through
    the Connect dialog.
  - Connected accounts still need ${personal ? "Okou" : "Agent"} access and any fine-grained permissions.
  - In the current web chat, a callback link example is printed when the action
    targets the ${personal ? "current execution context" : "current Agent"}. Use it only for a single connector/permission
    action, keeping the callback prompt free of secrets.
  - --callback-prompt requires the current web chat and ${personal ? "execution" : "Agent"} context.
    ${CALLBACK_PROMPT_GUIDANCE}
  - OAuth app client secrets are definition-time configuration, matching UI
    creation, and should be kept in a temporary file that is never committed.
  - Requires an organization admin.`;
  })
  .action(
    withErrorHandler(async (options: CreateOptions) => {
      requireCustomConnectorWriteCapability();
      const definition = await readManagementInput(
        options.file,
        createCustomConnectorDefinitionFileSchema,
      );
      const agentId = getOkouAgentId()?.trim() || undefined;
      const actionUrl = new URL(
        connectorActionUrl({
          origin: await getPlatformOrigin(),
          path: "/connectors",
          agentId,
        }),
      );
      // Validate the callback before creating a definition that needs connection.
      const connectUrl = new URL(
        finalizeActionUrl(actionUrl, options.callbackPrompt, agentId),
      );
      const connector = await createCustomConnector(definition);
      connectUrl.pathname = `/connectors/${connector.slug}/connect`;
      printCreateResult(connector, options, connectUrl.toString(), agentId);
    }),
  );
