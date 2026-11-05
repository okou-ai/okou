import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import {
  personalExecutorId,
  resolveCommandMode,
} from "../../lib/command/single-agent";
import {
  getAgent,
  getAgentCustomConnectorGrants,
  getAgentUserBuiltinConnectors,
} from "../../lib/api/domains/agents";
import { getOkouAgentId } from "../../lib/okou-env";
import {
  chatConnectorAccountsEnabled,
  listRunConnectorAccounts,
} from "../../lib/api/domains/run-connector-accounts";

interface AgentContext {
  personal: boolean;
  agentId: string;
  displayName: string;
  authorizedConnectorSlugs: Set<string>;
}

export interface ConnectorDiscoveryAgentContext extends AgentContext {
  authorizedCustomConnectorIds: Set<string>;
}

export async function resolveConnectorAgentId(
  flagAgentId: string | undefined,
): Promise<string | undefined> {
  if (await resolveCommandMode()) {
    if (flagAgentId !== undefined)
      throw new Error(
        "Agent selection is unavailable in My Okou. Remove --agent to use your own workspace access.",
      );
    if (decodeSandboxTokenPayload()) {
      const executorId = getOkouAgentId();
      if (!executorId)
        throw new Error(
          "The current Run execution context is unavailable. Do not substitute another executor.",
        );
      return executorId;
    }
    return personalExecutorId();
  }
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
  const personal = await resolveCommandMode();

  if (chatConnectorAccountsEnabled()) {
    const [agent, inventory] = await Promise.all([
      getAgent(agentId),
      listRunConnectorAccounts(),
    ]);
    return {
      personal,
      agentId: agent.agentId,
      displayName: agent.displayName ?? agent.agentId,
      authorizedConnectorSlugs: new Set(
        inventory.accounts.flatMap((account) => {
          return account.enabled && account.target.kind === "builtin"
            ? [account.target.connectorSlug]
            : [];
        }),
      ),
    };
  }

  const [agent, enabledConnectorSlugs] = await Promise.all([
    getAgent(agentId),
    getAgentUserBuiltinConnectors(agentId),
  ]);

  return {
    personal,
    agentId: agent.agentId,
    displayName: agent.displayName ?? agent.agentId,
    authorizedConnectorSlugs: new Set(enabledConnectorSlugs),
  };
}

export async function resolveConnectorDiscoveryAgentContext(
  agentId: string | undefined,
): Promise<ConnectorDiscoveryAgentContext | null> {
  if (!agentId) return null;
  const personal = await resolveCommandMode();

  if (chatConnectorAccountsEnabled()) {
    const [agent, inventory] = await Promise.all([
      getAgent(agentId),
      listRunConnectorAccounts(),
    ]);
    return {
      personal,
      agentId: agent.agentId,
      displayName: agent.displayName ?? agent.agentId,
      authorizedConnectorSlugs: new Set(
        inventory.accounts.flatMap((account) => {
          return account.enabled && account.target.kind === "builtin"
            ? [account.target.connectorSlug]
            : [];
        }),
      ),
      authorizedCustomConnectorIds: new Set(
        inventory.accounts.flatMap((account) => {
          return account.enabled && account.target.kind === "custom"
            ? [account.target.customConnectorId]
            : [];
        }),
      ),
    };
  }

  const [agent, enabledConnectorSlugs, customConnectorGrants] =
    await Promise.all([
      getAgent(agentId),
      getAgentUserBuiltinConnectors(agentId),
      getAgentCustomConnectorGrants(agentId),
    ]);

  return {
    personal,
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
