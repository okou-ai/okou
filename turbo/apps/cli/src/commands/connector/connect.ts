import { z } from "zod";
import { Command, Option } from "commander";
import chalk from "chalk";
import {
  connectBuiltinConnectorManualGrant,
  getBuiltinConnector,
  getCustomConnector,
} from "../../lib/api/domains/connectors";
import { connectCustomConnectorMember } from "../../lib/api/domains/connector-management";
import { readManagementInput } from "../../lib/management-input";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { resolveManualGrantAuthMethod } from "./public-catalog";
import { resolveCustomConnectorId } from "./custom-connector-selector";
import {
  accountMutation,
  addAccountMutationOptions,
  resolveManagementConnector,
  type AccountMutationOptions,
} from "./management";

interface ConnectOptions extends AccountMutationOptions {
  readonly authMethod?: string;
  readonly json?: boolean;
  readonly input?: string;
  readonly value?: readonly string[];
}

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const valuesSchema = z.record(z.string().min(1), z.string());

async function connectorValues(options: ConnectOptions) {
  if (options.input !== undefined)
    return readManagementInput(options.input, valuesSchema);
  const values: Record<string, string> = {};
  for (const raw of options.value ?? []) {
    const separator = raw.indexOf("=");
    if (separator <= 0 || !raw.slice(0, separator).trim())
      throw new Error("Invalid --value format. Use --value NAME=VALUE.");
    values[raw.slice(0, separator)] = raw.slice(separator + 1);
  }
  return values;
}

async function connectCustom(
  selector: string,
  options: ConnectOptions,
  values: Record<string, string>,
) {
  if (options.authMethod !== undefined)
    throw new Error("--auth-method applies only to builtin connectors.");
  const id = await resolveCustomConnectorId(selector);
  const connector = await getCustomConnector(id);
  if (!connector) throw new Error("Custom connector is unavailable.");
  if (connector.authMode !== "manual" && connector.authMode !== "none")
    throw new Error(
      "Use okou connector oauth start for OAuth or automatic connectors.",
    );
  const account = accountMutation(options);
  const inputValues = Object.entries(values).map(([key, value]) => {
    const field = connector.fields.find((item) => {
      return item.key === key;
    });
    if (!field)
      throw new Error(
        "Unknown custom connector input field. Inspect connector custom show for declared fields.",
      );
    if (!value)
      throw new Error("Custom connector field values must not be empty.");
    return { key, kind: field.kind, value };
  });
  const result = await connectCustomConnectorMember(id, {
    account,
    values: inputValues,
  });
  if (!options.json)
    console.log(chalk.green(`✓ ${connector.displayName} connected`));
  console.log(JSON.stringify(result, null, 2));
}

export const connectCommand = addAccountMutationOptions(
  new Command()
    .name("connect")
    .description(
      "Connect builtin manual grants or custom HTTP/MCP manual/no-auth member accounts",
    )
    .argument(
      "<selector>",
      "Builtin slug or custom UUID/slug/unique name; builtin:/custom: prefixes accepted",
    ),
)
  .option("--auth-method <method>", "Builtin manual-grant auth method")
  .addOption(
    new Option(
      "--input <file|->",
      "JSON object of field names to values; '-' reads stdin (preferred for secrets)",
    ).conflicts("value"),
  )
  .addOption(
    new Option(
      "--value <name=value>",
      "Compatibility input; prefer --input to keep secrets out of process arguments",
    )
      .argParser(collectValue)
      .default([])
      .conflicts("input"),
  )
  .option("--json", "Print whitelisted connection metadata as JSON")
  .addHelpText(
    "after",
    `
Input is a JSON object: {"apiKey":"..."}. Use a protected temporary file or stdin.
Custom connections require --add or --reconnect <connection-id>. none accepts an
empty object; HTTP non-secret variables use declared field names. Existing
builtin connect syntax still reconnects the current default, or adds if absent.
No agent grants or permissions are changed. OAuth uses connector oauth start.

Examples:
  okou connector connect openai --add --input ./credentials.json
  okou connector connect custom:<uuid> --reconnect <connection-id> --input -
  okou connector connect custom:<uuid> --add
  okou connector account list <selector> --json`,
  )
  .action(
    withErrorHandler(async (selector: string, options: ConnectOptions) => {
      if (options.accountName !== undefined && !options.add)
        throw new Error("--account-name requires --add");
      const values = await connectorValues(options);
      const { connector: discovered } =
        await resolveManagementConnector(selector);
      if (discovered.kind === "custom") {
        await connectCustom(discovered.customConnector.id, options, values);
        return;
      }
      const metadata = discovered.catalogConnector;
      if (Object.keys(values).length === 0)
        throw new Error(
          "At least one --value NAME=VALUE or --input field is required.",
        );
      const method = resolveManualGrantAuthMethod(metadata, options.authMethod);
      const existing =
        options.add || options.reconnect
          ? null
          : await getBuiltinConnector(metadata.slug);
      const account =
        options.add || options.reconnect
          ? accountMutation(options)
          : existing
            ? { intent: "reconnect" as const, connectionId: existing.id }
            : { intent: "add" as const };
      const connector = await connectBuiltinConnectorManualGrant(
        metadata.slug,
        method.id,
        account,
        values,
      );
      if (
        connector.slug !== metadata.slug ||
        (account.intent === "reconnect" &&
          connector.id !== account.connectionId)
      )
        throw new Error("Connector account response identity mismatch.");
      if (options.json) {
        console.log(JSON.stringify(connector, null, 2));
        return;
      }
      console.log(chalk.green(`✓ ${metadata.label} connected`));
      console.log(chalk.dim(`  Slug: ${connector.slug}`));
      console.log(chalk.dim(`  Auth Method: ${connector.authMethod}`));
      console.log(chalk.dim(`  Run: okou connector status ${connector.slug}`));
    }),
  );
