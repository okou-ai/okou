import chalk from "chalk";
import { Command, Option } from "commander";
import {
  getAgent,
  getAgentCustomConnectorGrants,
  getAgentUserBuiltinConnectors,
  removeAgentCustomConnectorGrant,
  removeAgentUserBuiltinConnector,
} from "../../lib/api/domains/agents";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getOkouAgentId } from "../../lib/okou-env";
import { resolveManagementConnector } from "./management";

type UnauthorizeTarget =
  | { readonly kind: "builtin"; readonly slug: string; readonly label: string }
  | {
      readonly kind: "custom";
      readonly customConnectorId: string;
      readonly slug: string;
      readonly label: string;
    };

async function isAuthorized(
  agentId: string,
  target: UnauthorizeTarget,
): Promise<boolean> {
  if (target.kind === "builtin") {
    const slugs = await getAgentUserBuiltinConnectors(agentId);
    return slugs.includes(target.slug);
  }
  const grants = await getAgentCustomConnectorGrants(agentId);
  return grants.some((grant) => {
    return grant.customConnectorId === target.customConnectorId;
  });
}

async function removeAuthorization(
  agentId: string,
  target: UnauthorizeTarget,
): Promise<boolean> {
  if (target.kind === "builtin") {
    const slugs = await removeAgentUserBuiltinConnector(agentId, target.slug);
    return !slugs.includes(target.slug);
  }
  const grants = await removeAgentCustomConnectorGrant(
    agentId,
    target.customConnectorId,
  );
  return !grants.some((grant) => {
    return grant.customConnectorId === target.customConnectorId;
  });
}

export const unauthorizeCommand = new Command()
  .name("unauthorize")
  .description("Remove one connector from an Agent's access (no approval)")
  .argument(
    "<selector>",
    "Connector slug, custom UUID, or unique display name; builtin:/custom: prefixes accepted",
  )
  .addOption(
    new Option(
      "--agent <id>",
      "Target Agent ID (defaults to the current Agent; required outside a run)",
    ),
  )
  .option("--json", "Print the result as JSON")
  .addHelpText(
    "after",
    `
Examples:
  okou connector unauthorize querit
  okou connector unauthorize custom:<uuid> --json
  okou connector unauthorize github --agent <agent-id>

Notes:
  - Unauthorizing only narrows access, so it applies immediately without an
    approval link. Use connector permission-request to widen access.
  - Only the current user's grant of this connector to the Agent is removed.
    The saved connector account, other Agents, and other members are unchanged.
  - Runs that already started may keep their admitted access; new runs of the
    Agent no longer receive this connector.
  - A connector that is not authorized for the Agent is reported unchanged.
  - Use --agent <id> to revoke your grant from another visible Agent in the
    current organization, including inside a run. Omit it to use OKOU_AGENT_ID.
    Outside a run, --agent is required.
  - To restore access, re-enable the connector in Connectors > agent access.
  - To disconnect a saved account for every Agent, use connector account disconnect
    --connection-id <uuid> instead. Reconnecting may require signing in again.`,
  )
  .action(
    withErrorHandler(
      async (selector: string, opts: { agent?: string; json?: boolean }) => {
        const agentId = opts.agent ?? getOkouAgentId();
        if (!agentId) {
          throw new Error(
            "Specify the Agent with --agent <id>. Run: okou agent list",
          );
        }
        const [{ connector }, agent] = await Promise.all([
          resolveManagementConnector(selector),
          getAgent(agentId),
        ]);
        const target: UnauthorizeTarget =
          connector.kind === "custom"
            ? {
                kind: "custom",
                customConnectorId: connector.customConnector.id,
                slug: connector.slug,
                label: connector.label,
              }
            : { kind: "builtin", slug: connector.slug, label: connector.label };

        const authorized = await isAuthorized(agentId, target);
        if (authorized && !(await removeAuthorization(agentId, target))) {
          throw new Error(
            `${target.label} is still authorized for Agent ${agentId}. Inspect its access in Connectors > agent access.`,
          );
        }

        const agentLabel = agent.displayName ?? agentId;
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                agentId,
                connector:
                  target.kind === "custom"
                    ? {
                        kind: "custom",
                        customConnectorId: target.customConnectorId,
                        slug: target.slug,
                      }
                    : { kind: "builtin", slug: target.slug },
                result: authorized ? "unauthorized" : "not-authorized",
              },
              null,
              2,
            ),
          );
          return;
        }
        if (!authorized) {
          console.log(
            `${target.label} (${target.slug}) is not authorized for Agent ${agentLabel}. Nothing changed.`,
          );
          return;
        }
        console.log(
          chalk.green(
            `✓ Unauthorized ${target.label} (${target.slug}) for Agent ${agentLabel}`,
          ),
        );
        console.log(
          chalk.dim(
            "  New runs no longer receive this connector; runs that already started may keep their admitted access.",
          ),
        );
        console.log(
          chalk.dim(
            "  To restore access, re-enable it in Connectors > agent access.",
          ),
        );
      },
    ),
  );
