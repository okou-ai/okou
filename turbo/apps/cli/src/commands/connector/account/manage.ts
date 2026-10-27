import { Command, Option } from "commander";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  showConnectorAccount,
  renameConnectorAccount,
  setDefaultConnectorAccount,
  connectorAccountDeletionImpact,
  deleteConnectorAccount,
} from "../../../lib/api/domains/connector-management";
import {
  parseAccountName,
  parseConnectionId,
  resolveManagementConnector,
} from "../management";

interface Options {
  readonly connectionId: string;
  readonly name?: string;
  readonly clearName?: boolean;
  readonly json?: boolean;
}

function accountCommand(name: string, description: string) {
  return new Command(name)
    .description(description)
    .argument(
      "<selector>",
      "Exact connector selector; builtin:/custom: prefixes accepted",
    )
    .requiredOption(
      "--connection-id <uuid>",
      "Exact account ID returned for this connector",
      parseConnectionId,
    )
    .option("--json", "Print whitelisted metadata as JSON");
}

async function selection(selector: string, options: Options) {
  const { target } = await resolveManagementConnector(selector);
  return { target, connectionId: options.connectionId };
}

function printResult(
  result: object,
  json: boolean | undefined,
  message: string,
) {
  if (!json) console.log(message);
  console.log(JSON.stringify(result, null, 2));
}

export const showConnectorAccountCommand = accountCommand(
  "show",
  "Show one exact member account",
).action(
  withErrorHandler(async (selector: string, options: Options) => {
    printResult(
      await showConnectorAccount(await selection(selector, options)),
      options.json,
      "Connector account:",
    );
  }),
);

export const updateConnectorAccountCommand = accountCommand(
  "update",
  "Rename one exact member account",
)
  .alias("rename")
  .addOption(
    new Option("--name <name>", "New account display name")
      .argParser(parseAccountName)
      .conflicts("clearName"),
  )
  .addOption(
    new Option("--clear-name", "Remove the account display name").conflicts(
      "name",
    ),
  )
  .action(
    withErrorHandler(async (selector: string, options: Options) => {
      if (options.name === undefined && !options.clearName)
        throw new Error("Specify --name <name> or --clear-name.");
      printResult(
        await renameConnectorAccount(
          await selection(selector, options),
          options.name ?? null,
        ),
        options.json,
        "Connector account renamed.",
      );
    }),
  );

export const setDefaultConnectorAccountCommand = accountCommand(
  "set-default",
  "Set the global member default for one exact connector account",
).action(
  withErrorHandler(async (selector: string, options: Options) => {
    printResult(
      await setDefaultConnectorAccount(await selection(selector, options)),
      options.json,
      "Default connector account updated; existing Run selections are unchanged.",
    );
  }),
);

export const connectorAccountImpactCommand = accountCommand(
  "impact",
  "Inspect deletion impact for one exact connector account",
).action(
  withErrorHandler(async (selector: string, options: Options) => {
    printResult(
      await connectorAccountDeletionImpact(await selection(selector, options)),
      options.json,
      "Connector account deletion impact:",
    );
  }),
);

export const disconnectConnectorAccountCommand = accountCommand(
  "disconnect",
  "Disconnect one exact member account without an approval step",
)
  .alias("delete")
  .addHelpText(
    "after",
    `
Disconnect removes this saved account for the user across all Agents, not just
this Agent's access. Use account impact to inspect affected references first.
Reconnecting may be difficult: the user may need to sign in to the target website
again. Do not disconnect as a routine troubleshooting step. To remove only this
Agent's access while keeping the saved account, use connector unauthorize.

Examples:
  okou connector account disconnect github --connection-id <uuid>
  okou connector account disconnect custom:<uuid> --connection-id <uuid> --json`,
  )
  .action(
    withErrorHandler(async (selector: string, options: Options) => {
      printResult(
        await deleteConnectorAccount(await selection(selector, options)),
        options.json,
        "Connector account disconnected. Reconnecting may require signing in to the target website again.",
      );
    }),
  );
