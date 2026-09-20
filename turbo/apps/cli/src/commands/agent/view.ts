import { Command } from "commander";
import chalk from "chalk";
import {
  getAgent,
  getAgentInstructions,
  getAgentUserBuiltinConnectors,
  listUserPermissionGrants,
} from "../../lib/api/domains/agents";
import { listBuiltinConnectors } from "../../lib/api/domains/connectors";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import type { BuiltinConnector } from "../../lib/api/domains/connectors";
import { policyIcon } from "../../lib/utils/format-utils";
import { formatAvatar } from "./avatar";
import {
  loadConnectorPermissionInfos,
  connectorPermissionGrantsToFirewallPolicies,
  type ConnectorPermissionInfo,
} from "../shared/firewall-permissions";

function printDetailedPermissions(info: ConnectorPermissionInfo): void {
  if (!info.policies) {
    const icon = policyIcon(info.unknownPolicy);
    console.log(`    ${icon} unknown endpoints`);
    return;
  }

  const nameWidth = Math.max(
    "unknown endpoints".length,
    ...info.permissions.map((p) => {
      return p.name.length;
    }),
  );

  for (const perm of info.permissions) {
    const policy = info.policies[perm.name] ?? "deny";
    const desc = perm.description ?? "";
    console.log(
      `    ${policyIcon(policy)} ${perm.name.padEnd(nameWidth)}  ${desc}`,
    );
  }

  const unknownIcon = policyIcon(info.unknownPolicy);
  console.log(
    `    ${unknownIcon} ${"unknown endpoints".padEnd(nameWidth)}  Endpoints not matching any rule`,
  );
}

function formatConnectorIdentity(
  connector: BuiltinConnector | undefined,
): string {
  if (!connector) return "";
  if (connector.externalUsername) return `@${connector.externalUsername}`;
  if (connector.externalEmail) return connector.externalEmail;
  return "";
}

function formatConnectorSummary(
  info: ConnectorPermissionInfo,
  identity?: BuiltinConnector,
): string {
  const id = formatConnectorIdentity(identity);
  const idStr = id ? ` ${id}` : "";
  if (!info.hasPermissions) return `${info.connectorSlug}${idStr}`;
  if (!info.policies) return `${info.connectorSlug}${idStr} (full access)`;
  return `${info.connectorSlug}${idStr} (${info.allowed}/${info.total} allowed)`;
}

function formatDetailIdentity(connector: BuiltinConnector | undefined): string {
  if (!connector) return "";
  let identity = "";
  if (connector.externalUsername && connector.externalEmail) {
    identity = `@${connector.externalUsername} (${connector.externalEmail})`;
  } else if (connector.externalUsername) {
    identity = `@${connector.externalUsername}`;
  } else if (connector.externalEmail) {
    identity = connector.externalEmail;
  }
  if (!identity) return "";
  if (connector.connectionStatus === "reconnect-required") {
    identity += ` ${chalk.yellow("(needs reconnect)")}`;
  }
  return identity;
}

export const viewCommand = new Command()
  .name("view")
  .description("View an agent")
  .argument("<agent-id>", "Agent ID")
  .option("--instructions", "Also show instructions content")
  .option("--permissions", "Show full permission details for each connector")
  .addHelpText(
    "after",
    `
Examples:
  View basic info:         okou agent view <agent-id>
  Include instructions:    okou agent view <agent-id> --instructions
  Show permissions:        okou agent view <agent-id> --permissions
  View yourself:           okou agent view $OKOU_AGENT_ID --instructions`,
  )
  .action(
    withErrorHandler(
      async (
        agentId: string,
        options: { instructions?: boolean; permissions?: boolean },
      ) => {
        const [agent, connectorSlugs, connectorIdentities] = await Promise.all([
          getAgent(agentId),
          getAgentUserBuiltinConnectors(agentId),
          listBuiltinConnectors().catch(() => {
            return { connectors: [] as BuiltinConnector[] };
          }),
        ]);

        const identityMap = new Map<string, BuiltinConnector>(
          connectorIdentities.connectors.map((c) => {
            return [c.slug, c];
          }),
        );

        console.log(chalk.bold(agent.agentId));
        if (agent.displayName) console.log(chalk.dim(agent.displayName));
        console.log();
        console.log(`Agent ID:     ${agent.agentId}`);
        console.log(`Visibility:   ${agent.visibility}`);

        const storedPolicies = options.permissions
          ? connectorPermissionGrantsToFirewallPolicies(
              await listUserPermissionGrants(agent.agentId),
            )
          : null;
        const connectorInfos = await loadConnectorPermissionInfos({
          displayConnectorSlugs: connectorSlugs,
          defaultPolicyConnectorSlugs: connectorSlugs,
          storedPolicies,
        });

        if (connectorInfos.length > 0) {
          const summaries = connectorInfos.map((info) => {
            return formatConnectorSummary(
              info,
              identityMap.get(info.connectorSlug),
            );
          });
          console.log(`Connectors:   ${summaries.join(", ")}`);
        }

        if (agent.description)
          console.log(`Description:  ${agent.description}`);
        if (agent.sound) console.log(`Sound:        ${agent.sound}`);
        const avatar = formatAvatar(agent.avatarUrl);
        if (avatar) console.log(`Avatar:       ${avatar}`);

        if (options.permissions && connectorInfos.length > 0) {
          console.log();
          console.log(chalk.bold("Connectors:"));
          for (const info of connectorInfos) {
            const identity = formatDetailIdentity(
              identityMap.get(info.connectorSlug),
            );
            console.log(`  ${info.connectorSlug.padEnd(14)}${identity}`);
            if (info.hasPermissions) {
              printDetailedPermissions(info);
            }
          }
        }

        if (options.instructions) {
          console.log();
          const result = await getAgentInstructions(agentId);
          if (result.content) {
            console.log(chalk.dim("── Instructions ──"));
            console.log(result.content);
          } else {
            console.log(chalk.dim("No instructions set"));
          }
        }
      },
    ),
  );
