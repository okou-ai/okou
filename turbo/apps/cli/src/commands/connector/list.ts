import { Command } from "commander";
import chalk from "chalk";
import {
  listConnectorCatalog,
  listConnectedConnectors,
  listCustomConnectors,
} from "../../lib/api/domains/connectors";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  resolveConnectorAgentId,
  resolveConnectorDiscoveryAgentContext,
} from "./agent-context";
import { padEndAnsi, stripAnsi } from "./connected-as";
import {
  connectorDiscoveryItems,
  connectorDiscoveryJson,
  isConnectorDiscoveryAuthorized,
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
  .option(
    "--agent <id>",
    "Show per-agent authorization outside a run (must match the current Agent inside a run)",
  )
  .option("--json", "Output connector status as JSON")
  .addHelpText(
    "after",
    `
Scope:
  Inside a run, lists builtin and custom HTTP/MCP targets from the current run's
  account context, with the exact selected account or its unavailable state.
  This is not the full connector catalog. Omit --agent or match the current
  Agent; the flag does not select another Agent's run or accounts.
  Outside a run, lists the builtin catalog and org custom definitions with the
  current member's saved-account directory and optional --agent authorization.
  JSON hasSavedAccounts describes directory membership, including accounts needing
  reconnect. It does not establish health, defaults, scopes, or runtime availability.
  Authorization is separate.

Examples:
  okou connector list --json
  okou connector search github`,
  )
  .action(
    withErrorHandler(async (options: { agent?: string; json?: boolean }) => {
      const agentId = resolveConnectorAgentId(options.agent);
      if (isRunBoundConnectorContext()) {
        await printRunConnectorList(options.json ?? false);
        return;
      }
      const [{ connectors }, customConnectors, agentCtx, directory] =
        await Promise.all([
          listConnectorCatalog(),
          listCustomConnectors(),
          resolveConnectorDiscoveryAgentContext(agentId),
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
              agent: agentCtx
                ? {
                    agentId: agentCtx.agentId,
                    displayName: agentCtx.displayName,
                  }
                : null,
              connectors: discoveredConnectors.map((connector) => {
                return connectorDiscoveryJson(connector, agentCtx, directory);
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

      const authorizedHeader = agentCtx
        ? `AUTHORIZED FOR ${agentCtx.displayName}`
        : null;

      // Print header
      const headerParts = [
        "SLUG".padEnd(connectorSlugWidth),
        connectedAsHeader.padEnd(connectedAsWidth),
      ];
      if (authorizedHeader) headerParts.push(authorizedHeader);
      console.log(chalk.dim(headerParts.join("  ")));

      // Print rows
      for (let i = 0; i < connectorSlugs.length; i++) {
        const connector = discoveredConnectors[i]!;
        const connectorSlug = connectorSlugs[i]!;
        const connectedCell = padEndAnsi(connectedCells[i]!, connectedAsWidth);
        const parts = [connectorSlug.padEnd(connectorSlugWidth), connectedCell];
        if (agentCtx) {
          parts.push(
            isConnectorDiscoveryAuthorized(connector, agentCtx)
              ? chalk.green("✓")
              : chalk.dim("-"),
          );
        }
        console.log(parts.join("  "));
      }
    }),
  );
