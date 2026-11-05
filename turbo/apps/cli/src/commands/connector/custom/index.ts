import {
  resolveCommandMode,
  modeHelp,
} from "../../../lib/command/single-agent";
import { Command } from "commander";
import chalk from "chalk";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  getAgent,
  getAgentCustomConnectorGrants,
} from "../../../lib/api/domains/agents";
import {
  getCustomConnector,
  listCustomConnectors,
  listConnectedConnectors,
} from "../../../lib/api/domains/connectors";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  resolveConnectorAgentId,
  resolveConnectorDiscoveryAgentContext,
} from "../agent-context";
import { chatConnectorAccountsEnabled } from "../../../lib/api/domains/run-connector-accounts";
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
  agent: Awaited<ReturnType<typeof resolveCustomAgentContext>>,
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
    authorized: agent ? agent.authorizedIds.has(connector.id) : null,
  };
}

async function resolveCustomAgentContext(agentId: string | undefined): Promise<{
  readonly agentId: string;
  readonly displayName: string;
  readonly authorizedIds: Set<string>;
  readonly personal: boolean;
} | null> {
  if (!agentId) {
    return null;
  }
  if (chatConnectorAccountsEnabled()) {
    const context = await resolveConnectorDiscoveryAgentContext(agentId);
    return context
      ? {
          personal: context.personal,
          agentId: context.agentId,
          displayName: context.displayName,
          authorizedIds: context.authorizedCustomConnectorIds,
        }
      : null;
  }
  const [agent, grants] = await Promise.all([
    getAgent(agentId),
    getAgentCustomConnectorGrants(agentId),
  ]);
  return {
    personal: await resolveCommandMode(),
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
    "List org custom HTTP/MCP definitions and member saved-account presence",
  )
  .option(
    "--agent <id>",
    "Show per-agent authorization column (must match the current Agent inside a run)",
  )
  .option("--json", "Output current org custom connectors as JSON")
  .addHelpText(
    "after",
    modeHelp(
      `
Lists org definitions with the current member's saved-account directory, including
inside a run. This is separate from the accounts admitted to the current run;
use connector list for that view. The ID column contains UUIDs for custom
status/update and custom:<uuid> diagnostic selectors.
Saved-account presence does not establish health, defaults, or runtime availability.
Omit --agent inside a run to inspect the current Agent's access.`,
      `
Lists workspace definitions and your current saved-account directory, including
inside a Run. This view is separate from the accounts admitted to the current Run;
use connector list for that view. UUIDs identify custom status/update targets and
custom:<uuid> diagnostic selectors. Saved-account presence does not establish
health, defaults or runtime availability. Okou access still requires authorization.
`,
    ),
  )
  .action(
    withErrorHandler(async (options: { agent?: string; json?: boolean }) => {
      const agentId = await resolveConnectorAgentId(options.agent);
      const [connectors, agentCtx, connected] = await Promise.all([
        listCustomConnectors(),
        resolveCustomAgentContext(agentId),
        listConnectedConnectors(),
      ]);
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
              agent: agentCtx
                ? {
                    agentId: agentCtx.agentId,
                    displayName: agentCtx.displayName,
                  }
                : null,
              connectors: connectors.map((connector) => {
                return customConnectorJson(connector, agentCtx, {
                  hasSavedAccounts: connectedIds.has(connector.id),
                  integrationManaged:
                    isIntegrationManagedCustomConnector(connector),
                });
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
      if (agentCtx) {
        header.push(
          chatConnectorAccountsEnabled()
            ? "ALLOWED IN THIS CHAT"
            : agentCtx.personal
              ? "YOUR OKOU ACCESS"
              : `AUTHORIZED FOR ${agentCtx.displayName}`,
        );
      }
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
    modeHelp(
      `
Accepts a custom connector full slug, UUID, or exact unique display name,
optionally prefixed with custom:. Use UUIDs for stable automation.
Shows current org definition/member status, including inside a run. For the
account admitted to a run, use connector status with its connector selector.
Omit --agent inside a run to inspect the current Agent's access.`,
      `
Accepts a custom connector full slug, UUID, or exact unique display name,
optionally prefixed with custom:. Use UUIDs for stable automation.
Shows the current workspace definition and your saved-account status, including
inside a Run. For the account admitted to a Run, use connector status with its
connector selector. A saved account alone does not grant Okou access.
`,
    ),
  )
  .action(
    withErrorHandler(
      async (
        connectorSelector: string,
        options: { agent?: string; json?: boolean },
      ) => {
        const agentId = await resolveConnectorAgentId(options.agent);
        const connectorId = await resolveCustomConnectorId(connectorSelector);
        const [connector, agentCtx] = await Promise.all([
          getCustomConnector(connectorId),
          resolveCustomAgentContext(agentId),
        ]);
        const facts = connector
          ? await readMemberConnectorFacts(connector)
          : null;
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
                  connector === null || facts === null
                    ? null
                    : customConnectorJson(connector, agentCtx, facts),
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
        if (agentCtx) {
          console.log(
            `${(chatConnectorAccountsEnabled() ? "Chat access:" : "Authorized:").padEnd(LABEL_WIDTH)}${
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
    modeHelp(
      `
Types and authentication:
  HTTP: none, manual, oauth.
  MCP over Streamable HTTP: none, manual, oauth, automatic.
  The definition's authMode is required. Automatic is MCP-only and discovers
  the server's authentication requirements when a member connects.

Definitions and access:
  create/update manage org definitions; list/status show current-member metadata.
  List JSON hasSavedAccounts reports directory membership only.
  Status/show JSON accountSummary/memberStatus report target account details and
  local status separately from definition metadata and Agent authorization.
  ${
    chatConnectorAccountsEnabled()
      ? "Connect a member account, then allow it for this Chat. Shared firewall permissions apply across Chats and accounts. A definition alone does not grant execution access."
      : `Creating a definition is separate from connecting a member account, granting
  Agent access, and selecting any fine-grained permissions. This also applies
  to none/automatic definitions. Members finish connection in the web flow.
  Custom HTTP connectors with a permission bundle use Connectors > agent access
  > Permissions. MCP connectors have Agent access but no HTTP permission bundle.`
  }
  Builtin permission-request approval links do not apply to custom connectors.

To add a custom connector:
  Run "okou connector custom create -h" and follow the definition-only creation workflow.`,
      `
Types and authentication:
  HTTP: none, manual, oauth.
  MCP over Streamable HTTP: none, manual, oauth, automatic.
  The definition's authMode is required. Automatic is MCP-only and discovers
  the server's authentication requirements when you connect.

Definitions and access:
  create/update manage workspace definitions; list/status show your current
  saved-account metadata, including inside a Run. These commands do not report
  only the accounts admitted to that Run; use connector list/status for that view.
  List JSON hasSavedAccounts reports directory membership only.
  Status/show JSON accountSummary/memberStatus report account details and local
  status separately from definition metadata and Okou access authorization.
  A definition does not connect an account, complete OAuth or grant Okou access.
  Connect an account, then authorize access under the current permission model.
  Fine-grained HTTP permissions use Connectors settings; MCP access is connector-level.
  Chat allowances apply only when that capability is enabled; this command does
  not enable it. Switching accounts does not reset shared firewall permissions.
  Builtin permission-request approval links do not apply to custom connectors.

To add a custom connector:
  Run "okou connector custom create -h" for definition schemas and examples.
`,
    ),
  );
