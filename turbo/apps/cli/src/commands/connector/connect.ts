import {
  connectorAccountDisplayNameSchema,
  connectorAccountSelectionSchema,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { Command, InvalidArgumentError, Option } from "commander";
import chalk from "chalk";
import {
  connectBuiltinConnectorManualGrant,
  getBuiltinConnector,
  listConnectorCatalogStatus,
  type BuiltinConnectorManualGrantAccountMutation,
} from "../../lib/api/domains/connectors";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  availableConnectorSlugs,
  findConnectorStatusItem,
  resolveManualGrantAuthMethod,
} from "./public-catalog";

interface ConnectOptions {
  readonly accountName?: string;
  readonly add?: boolean;
  readonly authMethod?: string;
  readonly json?: boolean;
  readonly reconnect?: string;
  readonly value?: readonly string[];
}

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseAccountName(value: string): string {
  const result = connectorAccountDisplayNameSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    result.error.issues[0]?.message ?? "account name is invalid",
  );
}

function parseReconnectConnectionId(value: string): string {
  const result =
    connectorAccountSelectionSchema.shape.connectionId.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    result.error.issues[0]?.message ?? "connection ID is invalid",
  );
}

function resolveAccountMutation(
  options: ConnectOptions,
): BuiltinConnectorManualGrantAccountMutation | null {
  if (options.accountName !== undefined && !options.add) {
    throw new Error("--account-name requires --add");
  }
  if (options.add) {
    return {
      intent: "add",
      ...(options.accountName === undefined
        ? {}
        : { displayName: options.accountName }),
    };
  }
  if (options.reconnect !== undefined) {
    return { intent: "reconnect", connectionId: options.reconnect };
  }
  return null;
}

function parseConnectorValues(rawValues: readonly string[] | undefined) {
  if (!rawValues || rawValues.length === 0) {
    throw new Error("At least one --value NAME=VALUE is required", {
      cause: new Error(
        "Example: okou connector connect zendesk --value apiToken=token",
      ),
    });
  }

  const values: Record<string, string> = {};
  for (const rawValue of rawValues) {
    const separatorIndex = rawValue.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error("Invalid --value format", {
        cause: new Error("Use --value NAME=VALUE"),
      });
    }

    const name = rawValue.slice(0, separatorIndex);
    if (!name.trim()) {
      throw new Error("Invalid --value format", {
        cause: new Error("Field name cannot be empty"),
      });
    }

    values[name] = rawValue.slice(separatorIndex + 1);
  }

  return values;
}

export const connectCommand = new Command()
  .name("connect")
  .description("Connect a builtin connector with manual grant values")
  .argument(
    "<selector>",
    "Builtin connector slug or unique display name; builtin: prefix accepted",
  )
  .addOption(
    new Option("--add", "Create a new connector account").conflicts(
      "reconnect",
    ),
  )
  .addOption(
    new Option(
      "--reconnect <connection-id>",
      "Reconnect the account with this connection ID",
    )
      .conflicts("add")
      .argParser(parseReconnectConnectionId),
  )
  .addOption(
    new Option("--account-name <name>", "Name the account created with --add")
      .conflicts("reconnect")
      .argParser(parseAccountName),
  )
  .option("--auth-method <method>", "Builtin manual-grant auth method to use")
  .option(
    "--value <name=value>",
    "Connector field value; repeat for multiple fields",
    collectValue,
    [],
  )
  .option("--json", "Print the connector response as JSON")
  .addHelpText(
    "after",
    `
Scope:
  Supports builtin catalog connectors with a manual-grant authentication method.
  OAuth authorization and custom HTTP/MCP account connections use the web
  connection flow. Use connector search <slug> --limit 1 for connection guidance.
  This command manages member connections. Use connector list/status to inspect
  the account admitted to the current run.

Examples:
  okou connector connect openai --value apiKey=...
  okou connector connect openai --add --account-name Work --value apiKey=...
  okou connector connect openai --reconnect <connection-id> --value apiKey=...

Find connection IDs:
  okou connector account list openai`,
  )
  .action(
    withErrorHandler(async (connectorSlug: string, options: ConnectOptions) => {
      const requestedAccount = resolveAccountMutation(options);
      const values = parseConnectorValues(options.value);
      const catalog = await listConnectorCatalogStatus();
      const connectorMetadata = findConnectorStatusItem(
        catalog.connectors,
        connectorSlug,
      );
      if (!connectorMetadata) {
        throw new Error(`Unknown or unavailable connector: ${connectorSlug}`, {
          cause: new Error(
            `Available connectors: ${availableConnectorSlugs(catalog.connectors)}`,
          ),
        });
      }

      const authMethod = resolveManualGrantAuthMethod(
        connectorMetadata,
        options.authMethod,
      );
      const existingConnector = requestedAccount
        ? null
        : await getBuiltinConnector(connectorMetadata.slug);
      const account: BuiltinConnectorManualGrantAccountMutation =
        requestedAccount ??
        (existingConnector
          ? {
              intent: "reconnect",
              connectionId: existingConnector.id,
            }
          : { intent: "add" });
      const connector = await connectBuiltinConnectorManualGrant(
        connectorMetadata.slug,
        authMethod.id,
        account,
        values,
      );

      if (options.json) {
        console.log(JSON.stringify(connector, null, 2));
        return;
      }

      console.log(chalk.green(`✓ ${connectorMetadata.label} connected`));
      console.log(chalk.dim(`  Slug: ${connector.slug}`));
      console.log(chalk.dim(`  Auth Method: ${connector.authMethod}`));
      console.log(chalk.dim(`  Run: okou connector status ${connector.slug}`));
    }),
  );
