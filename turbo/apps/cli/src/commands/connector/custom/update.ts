import { readManagementInput } from "../../../lib/management-input";
import { customConnectorMetadata } from "../management";

import chalk from "chalk";
import { Command } from "commander";

import { updateCustomConnector } from "../../../lib/api/domains/connectors";
import { decodeSandboxTokenPayload } from "../../../lib/api/sandbox-token";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { resolveCustomConnectorId } from "../custom-connector-selector";
import { updateCustomConnectorDefinitionFileSchema } from "./definition";

interface UpdateOptions {
  readonly file: string;
  readonly json?: boolean;
}

function requireCustomConnectorWriteCapability(): void {
  const payload = decodeSandboxTokenPayload();
  if (payload && !payload.capabilities.includes("connector:write")) {
    throw new Error(
      "Custom connector update is not enabled for this agent run",
    );
  }
}

export const updateCustomConnectorCommand = new Command()
  .name("update")
  .description("Update a custom HTTP or MCP connector definition from JSON")
  .argument(
    "<selector>",
    "Custom connector slug, UUID, or unique display name (custom: prefix accepted)",
  )
  .requiredOption(
    "-f, --file <path|->",
    "JSON connector definition file, or '-' for stdin",
  )
  .option("--json", "Print the updated connector as JSON")
  .addHelpText(
    "after",
    `
The file uses the same complete HTTP or MCP definition shape as create.
HTTP supports authMode: none, manual, oauth; MCP also supports automatic.
authMode is required. See connector custom create --help for mode restrictions
and valid examples. The connector argument accepts a full slug, UUID, or exact
unique display name, optionally prefixed with custom:. Use UUIDs for stable automation.
OAuth updates may omit oauthConfig.clientSecret to preserve the encrypted
current client secret. Never include an end-user token or values array.

Examples:
  okou connector custom update _acme-mcp --file ./connector.json
  okou connector custom update <connector-id> --file ./connector.json
  okou connector custom update <connector-id> --file ./connector.json --json`,
  )
  .action(
    withErrorHandler(async (selector: string, options: UpdateOptions) => {
      requireCustomConnectorWriteCapability();
      const definition = await readManagementInput(
        options.file,
        updateCustomConnectorDefinitionFileSchema,
      );
      const connectorId = await resolveCustomConnectorId(selector);
      const connector = await updateCustomConnector(connectorId, definition);
      if (options.json) {
        console.log(
          JSON.stringify(customConnectorMetadata(connector), null, 2),
        );
        return;
      }
      console.log(
        chalk.green(`✓ Custom connector "${connector.displayName}" updated`),
      );
      console.log(chalk.dim(`  ID:   ${connector.id}`));
      console.log(chalk.dim(`  Slug: ${connector.slug}`));
      console.log(chalk.dim(`  Kind: ${connector.kind}`));
    }),
  );
