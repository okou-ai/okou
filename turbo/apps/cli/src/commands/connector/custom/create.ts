import { readFile } from "node:fs/promises";

import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import chalk from "chalk";
import { Command } from "commander";

import { createCustomConnector } from "../../../lib/api/domains/connectors";
import { decodeSandboxTokenPayload } from "../../../lib/api/sandbox-token";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { getOkouAgentId } from "../../../lib/okou-env";
import {
  connectorActionUrl,
  printCallbackActionUrlExample,
} from "../action-url";
import { getPlatformOrigin } from "../../../lib/platform-url";
import { createCustomConnectorDefinitionFileSchema } from "./definition";

interface CreateOptions {
  readonly file: string;
  readonly json?: boolean;
}

function requireCustomConnectorWriteCapability(): void {
  const payload = decodeSandboxTokenPayload();
  if (payload && !payload.capabilities.includes("connector:write")) {
    throw new Error(
      "Custom connector creation is not enabled for this agent run",
    );
  }
}

async function printCreateResult(
  connector: CustomConnectorResponse,
  json: boolean,
): Promise<void> {
  if (json) {
    console.log(JSON.stringify(connector, null, 2));
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
  const agentId = getOkouAgentId()?.trim() || undefined;
  const origin = await getPlatformOrigin();
  const url = connectorActionUrl({
    origin,
    path: `/connectors/${connector.slug}/connect`,
    ...(agentId ? { agentId } : {}),
  });
  console.log(`Connect it at: [Connect ${connector.displayName}](${url})`);
  printCallbackActionUrlExample(url, agentId);
}

export const createCustomConnectorCommand = new Command()
  .name("create")
  .description("Create a custom HTTP or MCP connector definition from JSON")
  .requiredOption("-f, --file <path>", "JSON connector definition file")
  .option("--json", "Print the created connector as JSON")
  .addHelpText(
    "after",
    `
Types and authentication:
  HTTP uses prefixTemplates and supports authMode: none, manual, oauth.
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

Definition file:
  Describe only the connector metadata, Header/Query injection templates, and
  OAuth app configuration when applicable. Never include an API token,
  end-user OAuth token, or values array. Creating the definition is separate
  from connecting a member account, including for none and automatic modes.

Agent workflow:
  1. For manual connectors, ask only for missing metadata: name, HTTPS API
     prefix for HTTP or endpoint for MCP, and the Header or Query injection
     template. Do not ask the user for the actual API token.
  2. Declare every credential input as a secret or variable field, then use
     references such as {{secrets.api_token}} or {{variables.account_id}} in
     Header and Query injection templates.
  3. For OAuth connectors, collect the same OAuth app configuration shown by
     the Connectors page, including the client ID and client secret. Never ask
     for an end-user access token or refresh token.
  4. Write a temporary JSON definition, run this command, then remove the file.
  5. Share the emitted Connect link so the user can finish the separate
     account connection flow, including for none and automatic modes.

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

Notes:
  - This command only creates the connector definition; it does not store a
    manual API token, start OAuth authorization, or authorize an agent.
  - Manual credentials and end-user OAuth grants are supplied later through
    the Connect dialog.
  - Connected accounts still need Agent access and any fine-grained permissions.
  - In the current web chat, a callback link example is printed when the action
    targets the current Agent. Use it only for a single connector/permission
    action, keeping the callback prompt free of secrets.
  - OAuth app client secrets are definition-time configuration, matching UI
    creation, and should be kept in a temporary file that is never committed.
  - Requires an organization admin.`,
  )
  .action(
    withErrorHandler(async (options: CreateOptions) => {
      requireCustomConnectorWriteCapability();
      const raw = await readFile(options.file, "utf8");
      const input: unknown = JSON.parse(raw);
      const definition = createCustomConnectorDefinitionFileSchema.parse(input);
      const connector = await createCustomConnector(definition);
      await printCreateResult(connector, options.json ?? false);
    }),
  );
