import { connectorAccountTargetKey } from "@okouai/api-contracts/contracts/connector-accounts";
import { Command } from "commander";
import chalk from "chalk";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  getCustomConnector,
  listCustomConnectors,
  listConnectedConnectors,
} from "../../../lib/api/domains/connectors";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { getAllowedChatConnectorTargetKeys } from "../../../lib/api/domains/run-connector-accounts";
import { isRunBoundConnectorContext } from "../run-account-context";
import { resolveCustomConnectorId } from "../custom-connector-selector";
import { createCustomConnectorCommand } from "./create";
import { updateCustomConnectorCommand } from "./update";
import { connectorInspectionType } from "../inspection";
import { customConnectorMetadata } from "../management";
import {
  memberConnectorAccountText,
  readMemberConnectorFacts,
  memberConnectorStatusText,
  type MemberConnectorFacts,
} from "../member-status";
import {
  showCustomConnectorCommand,
  deleteCustomConnectorCommand,
} from "./manage";

const LABEL_WIDTH = 18;

function customConnectorJson(
  connector: CustomConnectorResponse,
  allowedInChat: boolean | null,
  facts:
    | MemberConnectorFacts
    | {
        readonly hasSavedAccounts: boolean;
        readonly integrationManaged: boolean;
      },
) {
  const target = { kind: "custom", customConnectorId: connector.id } as const;
  return {
    ...customConnectorMetadata(connector),
    target,
    connectorType: connectorInspectionType(target, connector),
    ...facts,
    allowedInChat,
  };
}

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description(
    "List org custom HTTP/MCP definitions and member saved-account presence",
  )
  .option("--json", "Output current org custom connectors as JSON")
  .addHelpText(
    "after",
    `
Lists workspace definitions and your saved accounts. Inside a Run, the Chat
allowance column shows whether this Chat allows an account for each connector.
Use connector list for the exact accounts used by the Run. UUIDs identify
custom status and update targets.
`,
  )
  .action(
    withErrorHandler(async (options: { json?: boolean }) => {
      const [connectors, allowedTargets, connected] = await Promise.all([
        listCustomConnectors(),
        isRunBoundConnectorContext()
          ? getAllowedChatConnectorTargetKeys()
          : null,
        listConnectedConnectors(),
      ]);
      const isAllowedInChat = (id: string) => {
        return (
          allowedTargets?.has(
            connectorAccountTargetKey({
              kind: "custom",
              customConnectorId: id,
            }),
          ) ?? null
        );
      };
      const connectedIds = new Set(
        connected.customConnectors.map((connector) => {
          return connector.id;
        }),
      );
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              context: "current",
              connectors: connectors.map((connector) => {
                return customConnectorJson(
                  connector,
                  isAllowedInChat(connector.id),
                  {
                    hasSavedAccounts: connectedIds.has(connector.id),
                    integrationManaged:
                      isIntegrationManagedCustomConnector(connector),
                  },
                );
              }),
            },
            null,
            2,
          ),
        );
        return;
      }
      const idWidth = Math.max(
        2,
        ...connectors.map((connector) => {
          return connector.id.length;
        }),
      );
      const nameWidth = Math.max(
        4,
        ...connectors.map((connector) => {
          return connector.displayName.length;
        }),
      );
      const slugWidth = Math.max(
        4,
        ...connectors.map((connector) => {
          return connector.slug.length;
        }),
      );
      const header = [
        "ID".padEnd(idWidth),
        "SLUG".padEnd(slugWidth),
        "NAME".padEnd(nameWidth),
        "KIND",
        "SAVED ACCOUNTS",
      ];
      if (allowedTargets) header.push("ALLOWED IN THIS CHAT");
      console.log(chalk.dim(header.join("  ")));
      for (const connector of connectors) {
        const row = [
          connector.id.padEnd(idWidth),
          connector.slug.padEnd(slugWidth),
          connector.displayName.padEnd(nameWidth),
          connector.kind,
          connectedIds.has(connector.id)
            ? "saved accounts (inspect status)"
            : "no saved accounts",
        ];
        if (allowedTargets) {
          row.push(
            isAllowedInChat(connector.id)
              ? chalk.green("yes")
              : chalk.dim("no"),
          );
        }
        console.log(row.join("  "));
      }
    }),
  );

const statusCommand = new Command()
  .name("status")
  .description("Show a custom HTTP/MCP definition and member connection status")
  .argument(
    "<selector>",
    "Custom connector slug, UUID, or unique display name (custom: prefix accepted)",
  )
  .option("--json", "Output current org custom connector status as JSON")
  .addHelpText(
    "after",
    `
Accepts a custom connector full slug, UUID or exact unique display name.
Shows the workspace definition and your saved-account status, plus this Chat's
account allowance inside a Run. Use connector status for the exact Run account.
`,
  )
  .action(
    withErrorHandler(
      async (connectorSelector: string, options: { json?: boolean }) => {
        const connectorId = await resolveCustomConnectorId(connectorSelector);
        const target = {
          kind: "custom",
          customConnectorId: connectorId,
        } as const;
        const [connector, allowedTargets] = await Promise.all([
          getCustomConnector(connectorId),
          isRunBoundConnectorContext()
            ? getAllowedChatConnectorTargetKeys()
            : null,
        ]);
        const allowedInChat =
          allowedTargets?.has(connectorAccountTargetKey(target)) ?? null;
        const facts = connector
          ? await readMemberConnectorFacts(connector)
          : null;
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                context: "current",
                target,
                state: connector === null ? "unavailable" : "available",
                connector:
                  connector === null || facts === null
                    ? null
                    : customConnectorJson(connector, allowedInChat, facts),
              },
              null,
              2,
            ),
          );
          if (connector === null) {
            process.exitCode = 1;
          }
          return;
        }
        if (!connector) {
          throw new Error(
            `Custom connector not found: ${connectorId}\nRun: okou connector custom list`,
          );
        }
        console.log(`Custom connector: ${chalk.cyan(connector.displayName)}`);
        console.log();
        console.log(`${"ID:".padEnd(LABEL_WIDTH)}${connector.id}`);
        console.log(`${"Slug:".padEnd(LABEL_WIDTH)}${connector.slug}`);
        console.log(`${"Kind:".padEnd(LABEL_WIDTH)}${connector.kind}`);
        if (!facts)
          throw new Error("Custom connector account status is unavailable.");
        console.log(
          `${"Status:".padEnd(LABEL_WIDTH)}${memberConnectorStatusText(facts)}`,
        );
        console.log(
          `${"Account:".padEnd(LABEL_WIDTH)}${memberConnectorAccountText(connector, facts)}`,
        );
        if (facts.connectionId)
          console.log(
            `${"Connection ID:".padEnd(LABEL_WIDTH)}${facts.connectionId}`,
          );
        if (connector.kind === "mcp") {
          console.log(
            `${"Transport:".padEnd(LABEL_WIDTH)}${connector.transport}`,
          );
          console.log(
            `${"Endpoint:".padEnd(LABEL_WIDTH)}${connector.endpoint}`,
          );
        } else {
          console.log(
            `${"Prefixes:".padEnd(LABEL_WIDTH)}${connector.prefixTemplates.join(", ")}`,
          );
        }
        console.log(
          `${"Fields:".padEnd(LABEL_WIDTH)}${connector.fields
            .map((field) => {
              return `${field.kind}:${field.key}${field.required ? "" : "?"}`;
            })
            .join(", ")}`,
        );
        if (connector.headerInjections.length > 0) {
          console.log(
            `${"Headers:".padEnd(LABEL_WIDTH)}${connector.headerInjections
              .map((header) => {
                return header.name;
              })
              .join(", ")}`,
          );
        }
        if (connector.queryInjections.length > 0) {
          console.log(
            `${"Query params:".padEnd(LABEL_WIDTH)}${connector.queryInjections
              .map((query) => {
                return query.name;
              })
              .join(", ")}`,
          );
        }
        if (allowedInChat !== null) {
          console.log(
            `${"Chat access:".padEnd(LABEL_WIDTH)}${allowedInChat ? chalk.green("yes") : chalk.yellow("no")}`,
          );
        }
      },
    ),
  );

export const customConnectorCommand = new Command()
  .name("custom")
  .description("Create, update, and inspect org custom connectors")
  .addCommand(createCustomConnectorCommand)
  .addCommand(updateCustomConnectorCommand)
  .addCommand(showCustomConnectorCommand)
  .addCommand(deleteCustomConnectorCommand)
  .addCommand(listCommand)
  .addCommand(statusCommand)
  .addHelpText(
    "after",
    `
Types and authentication
  HTTP supports none, manual, and OAuth. MCP over Streamable HTTP also
  supports automatic authentication. Each definition declares authMode.

Definitions and access
  create/update manage workspace definitions. list/status show saved accounts
  and current Chat allowance. Use connector list/status for Run account identity.
  Connect a member account and allow it for the Chat. Review shared HTTP
  permissions in Connectors settings.

Run okou connector custom create -h for definition schemas and examples.
`,
  );
