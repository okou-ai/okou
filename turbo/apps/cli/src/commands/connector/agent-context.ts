import {
  getAgent,
  getAgentCustomConnectorGrants,
  getAgentUserBuiltinConnectors,
} from "../../lib/api/domains/agents";
import { getOkouAgentId } from "../../lib/okou-env";

interface AgentContext {
  agentId: string;
  displayName: string;
  authorizedConnectorSlugs: Set<string>;
}

export interface ConnectorDiscoveryAgentContext extends AgentContext {
  authorizedCustomConnectorIds: Set<string>;
}

export function resolveConnectorAgentId(
  flagAgentId: string | undefined,
): string | undefined {
  const runAgentId = getOkouAgentId();
  if (
    runAgentId !== undefined &&
    flagAgentId !== undefined &&
    flagAgentId !== runAgentId
  ) {
    throw new Error(
      `--agent ${flagAgentId} conflicts with the current run's Agent ${runAgentId}. Remove --agent or use --agent ${runAgentId}.`,
    );
  }
  return runAgentId ?? flagAgentId;
}

export async function resolveAgentContext(
  agentId: string | undefined,
): Promise<AgentContext | null> {
  if (!agentId) return null;

  const [agent, enabledConnectorSlugs] = await Promise.all([
    getAgent(agentId),
    getAgentUserBuiltinConnectors(agentId),
  ]);

  return {
    agentId: agent.agentId,
    displayName: agent.displayName ?? agent.agentId,
    authorizedConnectorSlugs: new Set(enabledConnectorSlugs),
  };
}

export async function resolveConnectorDiscoveryAgentContext(
  agentId: string | undefined,
): Promise<ConnectorDiscoveryAgentContext | null> {
  if (!agentId) return null;

  const [agent, enabledConnectorSlugs, customConnectorGrants] =
    await Promise.all([
      getAgent(agentId),
      getAgentUserBuiltinConnectors(agentId),
      getAgentCustomConnectorGrants(agentId),
    ]);

  return {
    agentId: agent.agentId,
    displayName: agent.displayName ?? agent.agentId,
    authorizedConnectorSlugs: new Set(enabledConnectorSlugs),
    authorizedCustomConnectorIds: new Set(
      customConnectorGrants.map((grant) => {
        return grant.customConnectorId;
      }),
    ),
  };
}
