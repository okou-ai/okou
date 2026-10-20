import { Command } from "commander";
import chalk from "chalk";
import type { CustomConnectorReaderResponse as CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connector-readers";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  getAgent,
  getAgentCustomConnectorGrants,
} from "../../../lib/api/domains/agents";
import {
  getCustomConnector,
  listCustomConnectors,
} from "../../../lib/api/domains/connectors";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { resolveConnectorAgentId } from "../agent-context";
import { resolveCustomConnectorId } from "../custom-connector-selector";
import { createCustomConnectorCommand } from "./create";
import { updateCustomConnectorCommand } from "./update";
import { connectorInspectionType } from "../inspection";
import { customConnectorMetadata } from "../management";
import {
  memberConnectorAccountText,
  memberConnectorFacts,
  memberConnectorStatusText,
  customMemberAccountSummaries,
} from "../member-status";
import {
  showCustomConnectorCommand,
  deleteCustomConnectorCommand,
} from "./manage";

const LABEL_WIDTH = 18;

function customConnectorJson(
  connector: CustomConnectorResponse,
  agent: Awaited<ReturnType<typeof resolveCustomAgentContext>>,
  summaries: ReadonlyMap<string, ConnectorAccountSummary>,
) {
  const target = { kind: "custom", customConnectorId: connector.id } as const;
  return {
    ...customConnectorMetadata(connector),
    target,
    connectorType: connectorInspectionType(target, connector),
    ...memberConnectorFacts(connector, summaries),
    authorized: agent ? agent.authorizedIds.has(connector.id) : null,
  };
}

async function resolveCustomAgentContext(agentId: string | undefined): Promise<{
  readonly agentId: string;
  readonly displayName: string;
  readonly authorizedIds: Set<string>;
} | null> {
  if (!agentId) {
    return null;
  }
  const [agent, grants] = await Promise.all([
    getAgent(agentId),
    getAgentCustomConnectorGrants(agentId),
  ]);
  return {
    agentId: agent.agentId,
    displayName: agent.displayName ?? agent.agentId,
    authorizedIds: new Set(
      grants.map((grant) => {
        return grant.customConnectorId;
      }),
    ),
  };
}

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description(
    "List org custom HTTP/MCP definitions and member connection status",
  )
  .option(
    "--agent <id>",
    "Show per-agent authorization column (must match the current Agent inside a run)",
  )
  .option("--json", "Output current org custom connectors as JSON")
  .addHelpText(
    "after",
    `
Lists org definitions with the current member's connection status, including
inside a run. This is separate from the accounts admitted to the current run;
use connector list for that view. The ID column contains UUIDs for custom
status/update and custom:<uuid> diagnostic selectors.
Omit --agent inside a run to inspect the current Agent's access.`,
  )
  .action(
    withErrorHandler(async (options: { agent?: string; json?: boolean }) => {
      const agentId = resolveConnectorAgentId(options.agent);
      const [connectors, agentCtx] = await Promise.all([
        listCustomConnectors(),
        resolveCustomAgentContext(agentId),
      ]);
      const summaries = await customMemberAccountSummaries(connectors);
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
              connectors: connectors.map((connector) => {
                return customConnectorJson(connector, agentCtx, summaries);
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
        "STATUS",
      ];
      if (agentCtx) {
        header.push(`AUTHORIZED FOR ${agentCtx.displayName}`);
      }
      console.log(chalk.dim(header.join("  ")));
      for (const connector of connectors) {
        const row = [
          connector.id.padEnd(idWidth),
          connector.slug.padEnd(slugWidth),
          connector.displayName.padEnd(nameWidth),
          connector.kind,
          memberConnectorAccountText(
            connector,
            memberConnectorFacts(connector, summaries),
          ),
        ];
        if (agentCtx) {
          row.push(
            agentCtx.authorizedIds.has(connector.id)
              ? chalk.green("✓")
              : chalk.dim("-"),
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
  .option(
    "--agent <id>",
    "Show authorization state for the given Agent (must match the current Agent inside a run)",
  )
  .option("--json", "Output current org custom connector status as JSON")
  .addHelpText(
    "after",
    `
Accepts a custom connector full slug, UUID, or exact unique display name,
optionally prefixed with custom:. Use UUIDs for stable automation.
Shows current org definition/member status, including inside a run. For the
account admitted to a run, use connector status with its connector selector.
Omit --agent inside a run to inspect the current Agent's access.`,
  )
  .action(
    withErrorHandler(
      async (
        connectorSelector: string,
        options: { agent?: string; json?: boolean },
      ) => {
        const agentId = resolveConnectorAgentId(options.agent);
        const connectorId = await resolveCustomConnectorId(connectorSelector);
        const [connector, agentCtx] = await Promise.all([
          getCustomConnector(connectorId),
          resolveCustomAgentContext(agentId),
        ]);
        const summaries = await customMemberAccountSummaries(
          connector ? [connector] : [],
        );
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                context: "current",
                target: { kind: "custom", customConnectorId: connectorId },
                state: connector === null ? "unavailable" : "available",
                agent: agentCtx
                  ? {
                      agentId: agentCtx.agentId,
                      displayName: agentCtx.displayName,
                    }
                  : null,
                connector:
                  connector === null
                    ? null
                    : customConnectorJson(connector, agentCtx, summaries),
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
        const facts = memberConnectorFacts(connector, summaries);
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
        if (agentCtx) {
          console.log(
            `${"Authorized:".padEnd(LABEL_WIDTH)}${
              agentCtx.authorizedIds.has(connector.id)
                ? chalk.green("yes")
                : chalk.yellow("no")
            }`,
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
Types and authentication:
  HTTP: none, manual, oauth.
  MCP over Streamable HTTP: none, manual, oauth, automatic.
  The definition's authMode is required. Automatic is MCP-only and discovers
  the server's authentication requirements when a member connects.

Definitions and access:
  create/update manage org definitions; list/status show current-member metadata.
  JSON accountSummary/memberStatus report saved accounts and local status separately
  from existing connected/configuration metadata and Agent authorization.
  Creating a definition is separate from connecting a member account, granting
  Agent access, and selecting any fine-grained permissions. This also applies
  to none/automatic definitions. Members finish connection in the web flow.
  Custom HTTP connectors with a permission bundle use Connectors > agent access
  > Permissions. MCP connectors have Agent access but no HTTP permission bundle.
  Builtin permission-request approval links do not apply to custom connectors.

To add a custom connector:
  Run "okou connector custom create -h" and follow the definition-only creation workflow.`,
  );
