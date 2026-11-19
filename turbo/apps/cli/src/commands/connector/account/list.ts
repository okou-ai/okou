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
  listConnectorCatalog,
  listCustomConnectors,
} from "../../../lib/api/domains/connectors";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { findConnectorBySelector } from "../connector-selector";
import { listRunConnectorAccounts } from "../../../lib/api/domains/run-connector-accounts";
import { isRunBoundConnectorContext } from "../run-account-context";
import { connectorAccountCliInventoryLabel } from "../account-label";
import {
  connectorDiscoveryItems,
  connectorDiscoveryTarget,
  type ConnectorDiscoveryItem,
} from "../discovery";

interface ListConnectorAccountOptions {
  readonly json?: boolean;
  readonly search?: string;
}

function accountFallbackLabel(account: ConnectorAccountConnection): string {
  return `Account #${account.id.slice(0, 8)}`;
}

function printTable(connections: readonly ConnectorAccountConnection[]): void {
  const headers = [
    "ACCOUNT",
    "DEFAULT",
    "CONNECTION",
    "RECONNECT REASON",
    "MISSING FIELDS",
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
      connection.reconnectReason ?? "-",
      connection.missingRequiredFields.join(", ") || "-",
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
  defaultConnection: ConnectorAccountConnection | null,
  access?: Awaited<ReturnType<typeof listRunConnectorAccounts>>,
): object {
  return {
    context: "available",
    connector: {
      kind: target.kind,
      slug: connector.slug,
      label: connector.label,
      target,
    },
    defaultConnectionId: defaultConnection?.id ?? null,
    accounts: connections.map((account) => {
      const chatAccount = access?.accounts.find((entry) => {
        return entry.connectionId === account.id;
      });
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
        missingRequiredFields: account.missingRequiredFields,
        configuredFieldKeys: account.configuredFieldKeys,
        reconnectReason: account.reconnectReason,
        ...(access
          ? {
              enabled: chatAccount?.enabled === true,
              isCurrent: chatAccount?.isCurrent === true,
            }
          : {}),
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
Lists saved accounts for the connector. Inside a Run, JSON includes enabled and
isCurrent for this Chat. Use connector status <selector> --json to inspect the
account already admitted to the current Run.

Use the exact connectionId returned for the connector. Use that ID only with its
listed connector. Switch an enabled account with connector account switch.
Request owner approval for a disabled account with connector account switch-request.`,
  )
  .action(
    withErrorHandler(
      async (slug: string, options: ListConnectorAccountOptions) => {
        const search = options.search?.trim();
        if (options.search !== undefined && !search) {
          throw new Error("--search cannot be empty");
        }

        const [{ connectors }, customConnectors] = await Promise.all([
          listConnectorCatalog(),
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

        const target = connectorDiscoveryTarget(connector);
        const result = await listConnectorAccountConnections(target, search);
        if (result.state === "unavailable") {
          throw new Error(
            `Available account inventory is unavailable for ${connector.slug}`,
          );
        }

        if (options.json) {
          const access = isRunBoundConnectorContext()
            ? await listRunConnectorAccounts()
            : undefined;
          console.log(
            JSON.stringify(
              jsonOutput(
                connector,
                target,
                result.connections,
                result.defaultConnection,
                access,
              ),
              null,
              2,
            ),
          );
          return;
        }

        console.log(
          `Available accounts for ${connector.label} (${connector.slug}):`,
        );
        if (
          result.defaultConnection &&
          !result.connections.some((account) => {
            return account.id === result.defaultConnection?.id;
          })
        ) {
          console.log(
            `Default account: ${connectorAccountCliInventoryLabel({ ...result.defaultConnection, connectionId: result.defaultConnection.id })} (${result.defaultConnection.id})`,
          );
        }
        if (result.connections.length === 0) {
          printEmptyState(connector, search);
          return;
        }
        printTable(result.connections);
      },
    ),
  );
