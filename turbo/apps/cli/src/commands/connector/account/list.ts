import {
  connectorAccountEffectiveLabel,
  connectorAccountExternalIdentity,
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import chalk from "chalk";
import { Command } from "commander";

import {
  listConnectorAccountConnections,
  listConnectorCatalogStatus,
  listCustomConnectors,
} from "../../../lib/api/domains/connectors";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { findConnectorBySelector } from "../connector-selector";
import { connectorAccountCliInventoryLabel } from "../account-label";
import {
  connectorDiscoveryItems,
  type ConnectorDiscoveryItem,
} from "../discovery";

interface ListConnectorAccountOptions {
  readonly json?: boolean;
  readonly search?: string;
}

function accountFallbackLabel(account: ConnectorAccountConnection): string {
  return `Account #${account.id.slice(0, 8)}`;
}

function resolveTarget(
  connector: ConnectorDiscoveryItem,
): ConnectorAccountTarget {
  return connector.kind === "catalog"
    ? { kind: "builtin", connectorSlug: connector.slug }
    : {
        kind: "custom",
        customConnectorId: connector.customConnector.id,
      };
}

function printTable(connections: readonly ConnectorAccountConnection[]): void {
  const headers = [
    "ACCOUNT",
    "DEFAULT",
    "STATUS",
    "AUTH METHOD",
    "CONNECTION ID",
  ];
  const rows = connections.map((connection) => {
    return [
      connectorAccountCliInventoryLabel({
        ...connection,
        connectionId: connection.id,
      }),
      connection.isDefault ? "yes" : "-",
      connection.connectionStatus,
      connection.authMethod,
      connection.id,
    ];
  });
  const widths = headers.map((header, columnIndex) => {
    return Math.max(
      header.length,
      ...rows.map((row) => {
        return row[columnIndex]?.length ?? 0;
      }),
    );
  });
  console.log(
    chalk.dim(
      headers
        .map((header, columnIndex) => {
          return header.padEnd(widths[columnIndex] ?? header.length);
        })
        .join("  "),
    ),
  );
  for (const row of rows) {
    console.log(
      row
        .map((cell, columnIndex) => {
          return cell.padEnd(widths[columnIndex] ?? cell.length);
        })
        .join("  "),
    );
  }
}

function printEmptyState(
  connector: ConnectorDiscoveryItem,
  search: string | undefined,
): void {
  if (search) {
    console.log(
      `No available accounts for ${connector.label} match "${search}".`,
    );
    return;
  }
  console.log(`No available accounts for ${connector.label}.`);
  const statusCommand =
    connector.kind === "catalog"
      ? `okou connector status ${connector.slug}`
      : `okou connector custom status ${connector.customConnector.id}`;
  console.log(chalk.dim(`Run: ${statusCommand}`));
}

function jsonOutput(
  connector: ConnectorDiscoveryItem,
  target: ConnectorAccountTarget,
  connections: readonly ConnectorAccountConnection[],
): object {
  return {
    context: "available",
    connector: {
      kind: target.kind,
      slug: connector.slug,
      label: connector.label,
      target,
    },
    accounts: connections.map((account) => {
      return {
        connectionId: account.id,
        effectiveLabel: connectorAccountEffectiveLabel(
          account,
          accountFallbackLabel(account),
        ),
        displayName: account.displayName,
        externalIdentity: connectorAccountExternalIdentity(account),
        isDefault: account.isDefault,
        authMethod: account.authMethod,
        connectionStatus: account.connectionStatus,
        reconnectReason: account.reconnectReason,
      };
    }),
  };
}

export const listConnectorAccountsCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List available accounts for one connector")
  .argument(
    "<selector>",
    "Connector slug, custom UUID, or unique display name; builtin:/custom: prefixes accepted",
  )
  .option("--search <text>", "Filter accounts by name or provider identity")
  .option("--json", "Output available accounts as JSON")
  .addHelpText(
    "after",
    `
Use only an exact connectionId returned for this connector; never invent an ID or reuse one from another connector. This is available-account inventory, not the account already admitted to the current Run. Inspect that selection with okou connector status <slug> --json. Requesting a switch changes only future runs in the current web chat.`,
  )
  .action(
    withErrorHandler(
      async (slug: string, options: ListConnectorAccountOptions) => {
        const search = options.search?.trim();
        if (options.search !== undefined && !search) {
          throw new Error("--search cannot be empty");
        }

        const [{ connectors }, customConnectors] = await Promise.all([
          listConnectorCatalogStatus(),
          listCustomConnectors(),
        ]);
        const discoveredConnectors = connectorDiscoveryItems(
          connectors,
          customConnectors,
        );
        const connector = findConnectorBySelector(
          discoveredConnectors,
          slug,
          (item) => {
            return item.kind === "custom"
              ? {
                  kind: "custom",
                  id: item.customConnector.id,
                  slug: item.slug,
                  label: item.label,
                }
              : { kind: "builtin", slug: item.slug, label: item.label };
          },
        );
        if (!connector) {
          throw new Error(`Unknown or unavailable connector: ${slug}`, {
            cause: new Error(
              `Available connectors: ${discoveredConnectors
                .map((item) => {
                  return item.slug;
                })
                .sort()
                .join(", ")}`,
            ),
          });
        }

        const target = resolveTarget(connector);
        const result = await listConnectorAccountConnections(target, search);
        if (result.state === "unavailable") {
          throw new Error(
            `Available account inventory is unavailable for ${connector.slug}`,
          );
        }

        if (options.json) {
          console.log(
            JSON.stringify(
              jsonOutput(connector, target, result.connections),
              null,
              2,
            ),
          );
          return;
        }

        console.log(
          `Available accounts for ${connector.label} (${connector.slug}):`,
        );
        if (result.connections.length === 0) {
          printEmptyState(connector, search);
          return;
        }
        printTable(result.connections);
      },
    ),
  );
