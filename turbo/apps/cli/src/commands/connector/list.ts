import { Command } from "commander";
import chalk from "chalk";
import {
  listConnectorCatalog,
  listConnectedConnectors,
  listCustomConnectors,
} from "../../lib/api/domains/connectors";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { padEndAnsi, stripAnsi } from "./connected-as";
import {
  connectorDiscoveryItems,
  connectorDiscoveryJson,
  renderConnectorDiscoveryConnectedAsCell,
} from "./discovery";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountView,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountEntry,
} from "./run-account-context";

function runAccountCell(connector: RunConnectorAccountEntry): string {
  if (connector.account.state === "available") {
    return `${connector.account.label} (${connector.account.connectionId})`;
  }
  if (connector.account.state === "metadata-unavailable") {
    return `${connector.account.connectionId} (metadata unavailable or deleted)`;
  }
  return "(unavailable for this run)";
}

async function printRunConnectorList(json: boolean): Promise<void> {
  const view = await resolveRunConnectorAccountView();
  if (json) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  if (view.state === "unavailable") {
    console.log(runConnectorAccountUnavailableMessage(view.reason));
    return;
  }
  const slugWidth = Math.max(
    4,
    ...view.connectors.map((connector) => {
      return connector.slug.length;
    }),
  );
  console.log(
    chalk.dim(
      ["SLUG".padEnd(slugWidth), "ACCOUNT USED BY THIS RUN"].join("  "),
    ),
  );
  for (const connector of view.connectors) {
    console.log(
      [connector.slug.padEnd(slugWidth), runAccountCell(connector)].join("  "),
    );
  }
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List connector status in the current run or member context")
  .option("--json", "Output connector status as JSON")
  .addHelpText(
    "after",
    `
Inside a Run, lists builtin and custom HTTP/MCP targets with the exact
account used by this Run and any unavailable account state.
Outside a Run, lists the catalog, workspace custom definitions and your saved
accounts. Use connector status or connector account list for account details.

Examples
  okou connector list --json
  okou connector search github
`,
  )
  .action(
    withErrorHandler(async (options: { json?: boolean }) => {
      if (isRunBoundConnectorContext()) {
        await printRunConnectorList(options.json ?? false);
        return;
      }
      const [{ connectors }, customConnectors, directory] = await Promise.all([
        listConnectorCatalog(),
        listCustomConnectors(),
        listConnectedConnectors(),
      ]);
      const discoveredConnectors = connectorDiscoveryItems(
        connectors,
        customConnectors,
      );

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              context: "current",
              connectors: discoveredConnectors.map((connector) => {
                return connectorDiscoveryJson(connector, directory);
              }),
            },
            null,
            2,
          ),
        );
        return;
      }

      const connectorSlugs = discoveredConnectors.map((connector) => {
        return connector.slug;
      });

      const connectorSlugWidth = Math.max(
        4,
        ...connectorSlugs.map((connectorSlug) => {
          return connectorSlug.length;
        }),
      );

      const connectedAsHeader = "SAVED ACCOUNTS";
      const connectedCells = discoveredConnectors.map((connector) => {
        return renderConnectorDiscoveryConnectedAsCell(connector, directory);
      });
      const connectedAsWidth = Math.max(
        connectedAsHeader.length,
        ...connectedCells.map((c) => {
          return stripAnsi(c).length;
        }),
      );

      const headerParts = [
        "SLUG".padEnd(connectorSlugWidth),
        connectedAsHeader.padEnd(connectedAsWidth),
      ];
      console.log(chalk.dim(headerParts.join("  ")));

      // Print rows
      for (let i = 0; i < connectorSlugs.length; i++) {
        const connectorSlug = connectorSlugs[i]!;
        const connectedCell = padEndAnsi(connectedCells[i]!, connectedAsWidth);
        const parts = [connectorSlug.padEnd(connectorSlugWidth), connectedCell];
        console.log(parts.join("  "));
      }
    }),
  );
