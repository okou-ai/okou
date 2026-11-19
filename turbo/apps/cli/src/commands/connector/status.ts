import { Command } from "commander";
import chalk from "chalk";
import {
  listConnectorCatalog,
  getConnectorCatalogDetail,
} from "../../lib/api/domains/connectors";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { findConnectorBySelector } from "./connector-selector";
import { getPlatformOrigin } from "../../lib/platform-url";
import {
  availableConnectorSlugs,
  findConnectorStatusItem,
  type PublicConnectorStatus,
} from "./public-catalog";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountView,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountEntry,
} from "./run-account-context";
import {
  memberConnectorAccountText,
  readMemberConnectorFacts,
  memberConnectorStatusText,
  type MemberConnectorFacts,
} from "./member-status";

const LABEL_WIDTH = 16;

function printConnectorDetails(
  connector: PublicConnectorStatus,
  facts: MemberConnectorFacts,
): void {
  console.log(
    `${"Status:".padEnd(LABEL_WIDTH)}${
      facts.memberStatus === "connected"
        ? chalk.green(memberConnectorStatusText(facts))
        : chalk.yellow(memberConnectorStatusText(facts))
    }`,
  );
  console.log(
    `${"Account:".padEnd(LABEL_WIDTH)}${memberConnectorAccountText(connector, facts)}`,
  );
  const account = facts.accountSummary?.defaultConnection;
  if (account) {
    console.log(`${"Connection ID:".padEnd(LABEL_WIDTH)}${account.id}`);
    console.log(`${"Auth Method:".padEnd(LABEL_WIDTH)}${account.authMethod}`);
  }
  if (facts.scopeMismatch) {
    console.log(
      `${"Permissions:".padEnd(LABEL_WIDTH)}${chalk.yellow("update available")}`,
    );
  }
  if (account?.tokenExpiresAt) {
    console.log(
      `${"Token Expires:".padEnd(LABEL_WIDTH)}${account.tokenExpiresAt}`,
    );
  }
}

async function printMemberAction(
  connector: PublicConnectorStatus,
  facts: MemberConnectorFacts,
): Promise<void> {
  const connectorSlug = connector.slug;
  if (facts.memberStatus === "connected") {
    return;
  }

  const origin = await getPlatformOrigin();
  console.log();
  if (facts.memberStatus === "reconnect-required") {
    const url = `${origin}/connectors`;
    console.log(
      `The ${connectorSlug} connector is connected but needs to be reconnected.`,
    );
    console.log(`Reconnect it at: [Reconnect ${connectorSlug}](${url})`);
  } else if (facts.memberStatus !== "not-connected") {
    console.log(
      `Review the ${connectorSlug} accounts: [Manage ${connectorSlug} accounts](${origin}/connectors)`,
    );
  } else {
    const url = `${origin}/connectors/${connectorSlug}/connect`;
    console.log(`Connect it at: [Connect ${connectorSlug}](${url})`);
  }
}

function printRunConnectorDetails(connector: RunConnectorAccountEntry): void {
  console.log(`Connector: ${chalk.cyan(connector.slug)}`);
  console.log();
  if (connector.account.state === "not-admitted") {
    console.log(
      `${"Account Used:".padEnd(LABEL_WIDTH)}${chalk.dim("unavailable for this run")}`,
    );
    console.log();
    console.log(
      "Reconnect or change the thread selection, then start a new run.",
    );
    return;
  }
  console.log(
    `${"Account Used:".padEnd(LABEL_WIDTH)}${
      connector.account.state === "available"
        ? connector.account.label
        : chalk.dim("metadata unavailable or deleted")
    }`,
  );
  console.log(
    `${"Connection ID:".padEnd(LABEL_WIDTH)}${connector.account.connectionId}`,
  );
  if (connector.account.state === "metadata-unavailable") {
    console.log(
      `${"Current Status:".padEnd(LABEL_WIDTH)}${chalk.dim("unavailable")}`,
    );
    return;
  }
  console.log(
    `${"Current Status:".padEnd(LABEL_WIDTH)}${connector.account.metadata.connectionStatus}`,
  );
  if (connector.account.metadata.missingRequiredFields.length > 0) {
    console.log(
      `${"Missing Fields:".padEnd(LABEL_WIDTH)}${connector.account.metadata.missingRequiredFields.join(", ")}`,
    );
  }
  console.log(
    `${"Auth Method:".padEnd(LABEL_WIDTH)}${connector.account.metadata.authMethod}`,
  );
  if (connector.account.metadata.reconnectReason) {
    console.log(
      `${"Reconnect Reason:".padEnd(LABEL_WIDTH)}${connector.account.metadata.reconnectReason}`,
    );
  }
}

async function printRunConnectorStatus(
  connectorSlug: string,
  json: boolean,
): Promise<void> {
  const view = await resolveRunConnectorAccountView();
  if (view.state === "unavailable") {
    if (json) {
      console.log(
        JSON.stringify(
          {
            context: "run",
            state: "unavailable",
            reason: view.reason,
            connector: null,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(runConnectorAccountUnavailableMessage(view.reason));
    }
    return;
  }
  const connector = findConnectorBySelector(
    view.connectors,
    connectorSlug,
    (candidate) => {
      return candidate.target.kind === "custom"
        ? {
            kind: "custom",
            id: candidate.target.customConnectorId,
            slug: candidate.slug,
            label: candidate.connectorLabel,
          }
        : {
            kind: "builtin",
            slug: candidate.slug,
            label: candidate.connectorLabel,
          };
    },
  );
  if (!connector) {
    throw new Error(
      `Connector is not available in this run: ${connectorSlug}`,
      {
        cause: new Error(
          `Available connectors: ${view.connectors
            .map((candidate) => {
              return candidate.slug;
            })
            .join(", ")}`,
        ),
      },
    );
  }
  if (json) {
    console.log(
      JSON.stringify(
        { context: "run", state: "available", connector },
        null,
        2,
      ),
    );
    return;
  }
  printRunConnectorDetails(connector);
}

export const statusCommand = new Command()
  .name("status")
  .description("Show run account status, or builtin status outside a run")
  .argument(
    "<selector>",
    "Connector slug or unique display name (builtin only outside a run)",
  )
  .option("--json", "Output connector status as JSON")
  .addHelpText(
    "after",
    `
Inside a Run, inspect the exact account used by builtin or custom HTTP/MCP
connectors. Resolve alternatives with connector account list <selector> --json.
Use account switch for an enabled account and switch-request for owner approval
of a disabled account in this Chat.

Outside a Run, inspect builtin saved-account status. For custom connector
definitions and saved accounts, use connector custom status <selector>.
Use --json for account details, including the exact connectionId.

Examples
  okou connector status github --json
  okou connector status custom:<uuid>
`,
  )
  .action(
    withErrorHandler(
      async (connectorSlug: string, options: { json?: boolean }) => {
        if (isRunBoundConnectorContext()) {
          await printRunConnectorStatus(connectorSlug, options.json ?? false);
          return;
        }
        const catalog = await listConnectorCatalog();
        const definition = findConnectorStatusItem(
          catalog.connectors,
          connectorSlug,
        );
        if (!definition) {
          throw new Error(
            `Unknown or unavailable connector: ${connectorSlug}`,
            {
              cause: new Error(
                `Available connectors: ${availableConnectorSlugs(catalog.connectors)}`,
              ),
            },
          );
        }

        const connector = await getConnectorCatalogDetail(definition.slug);
        if (!connector)
          throw new Error(`Connector is unavailable: ${definition.slug}`);
        const facts = await readMemberConnectorFacts(connector);
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                context: "current",
                connector: {
                  ...connector,
                  ...facts,
                  target: { kind: "builtin", connectorSlug: connector.slug },
                  connectorType: "builtin",
                },
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log(`Connector: ${chalk.cyan(connector.slug)}`);
        console.log();

        printConnectorDetails(connector, facts);

        await printMemberAction(connector, facts);
      },
    ),
  );
