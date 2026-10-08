import chalk from "chalk";
import { Command } from "commander";

import { getConnectorCatalogStatus } from "../../lib/api/domains/connectors";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { resolveAgentContext } from "../connector/agent-context";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountView,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountEntry,
} from "../connector/run-account-context";
import { MAIL_CONNECTOR_SLUG_BY_PROVIDER, currentAgentId } from "./shared";

interface MailListRow {
  readonly provider: string;
  readonly sender: string;
  readonly status: string;
}

function printMailRows(rows: readonly MailListRow[]): void {
  const providerWidth = Math.max(
    "PROVIDER".length,
    ...rows.map((row) => {
      return row.provider.length;
    }),
  );
  const senderWidth = Math.max(
    "SENDER".length,
    ...rows.map((row) => {
      return row.sender.length;
    }),
  );
  console.log(
    chalk.dim(
      [
        "PROVIDER".padEnd(providerWidth),
        "SENDER".padEnd(senderWidth),
        "STATUS",
      ].join("  "),
    ),
  );
  for (const row of rows) {
    console.log(
      [
        row.provider.padEnd(providerWidth),
        row.sender.padEnd(senderWidth),
        row.status,
      ].join("  "),
    );
  }
  console.log();
  console.log(chalk.dim("  Run: okou mail connect gmail|outlook when needed"));
}

function runMailRow(
  provider: string,
  connector: RunConnectorAccountEntry | undefined,
): MailListRow {
  if (connector?.account.state !== "available") {
    return {
      provider,
      sender: "-",
      status: chalk.dim("unavailable"),
    };
  }
  return {
    provider,
    sender: connector.account.metadata.externalEmail ?? "-",
    status:
      connector.account.metadata.connectionStatus === "connected"
        ? chalk.green("ready")
        : chalk.yellow("reconnect"),
  };
}

async function printRunMailList(): Promise<void> {
  const view = await resolveRunConnectorAccountView();
  if (view.state === "unavailable") {
    console.log(runConnectorAccountUnavailableMessage(view.reason));
    return;
  }
  printMailRows(
    Object.entries(MAIL_CONNECTOR_SLUG_BY_PROVIDER).map(
      ([provider, connectorSlug]) => {
        const connector = view.connectors.find((candidate) => {
          return candidate.slug === connectorSlug;
        });
        return runMailRow(provider, connector);
      },
    ),
  );
}

async function printCurrentMailList(): Promise<void> {
  const agentId = currentAgentId();
  const mailConnectors = Object.entries(MAIL_CONNECTOR_SLUG_BY_PROVIDER);
  const [connectors, agent] = await Promise.all([
    Promise.all(
      mailConnectors.map(([, connectorSlug]) => {
        return getConnectorCatalogStatus(connectorSlug);
      }),
    ),
    resolveAgentContext(agentId),
  ]);
  if (!agent) {
    throw new Error("Agent context could not be loaded");
  }

  printMailRows(
    mailConnectors.map(([provider, connectorSlug], index) => {
      const connector = connectors[index];
      const authorized = agent.authorizedConnectorSlugs.has(connectorSlug);
      const ready =
        authorized &&
        connector?.connected === true &&
        connector.connectionStatus === "connected";
      const sender = authorized
        ? (connector?.connection?.externalEmail ?? "-")
        : "-";
      const status = ready
        ? chalk.green("ready")
        : connector?.connectionStatus === "reconnect-required" ||
            connector?.connectionStatus === "scope-mismatch"
          ? chalk.yellow("reconnect")
          : connector?.connected
            ? chalk.yellow("authorize")
            : chalk.dim("connect");
      return { provider, sender, status };
    }),
  );
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List Gmail and Outlook Mail availability for the current agent")
  .action(
    withErrorHandler(async () => {
      if (isRunBoundConnectorContext()) {
        await printRunMailList();
        return;
      }
      await printCurrentMailList();
    }),
  );
