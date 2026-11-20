import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  agentsMainContract,
  agentsByIdContract,
  agentInstructionsContract,
  type AgentResponse,
  type AgentRequest,
  type AgentInstructionsResponse,
} from "@okouai/api-contracts/contracts/agents";
import { getClientConfig, handleError } from "../core/client-factory";

export async function createAgent(body: AgentRequest): Promise<AgentResponse> {
  const config = await getClientConfig();
  const client = initClient(agentsMainContract, config);
  const result = await client.create({ body });
  if (result.status === 201) return result.body;
  handleError(result, "Failed to create agent");
}

export async function listAgents(): Promise<AgentResponse[]> {
  const config = await getClientConfig();
  const client = initClient(agentsMainContract, config);
  const result = await client.list({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list agents");
}

export async function getAgent(id: string): Promise<AgentResponse> {
  const config = await getClientConfig();
  const client = initClient(agentsByIdContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Agent "${id}" not found`);
}

export async function updateAgent(
  id: string,
  body: AgentRequest,
): Promise<AgentResponse> {
  const config = await getClientConfig();
  const client = initClient(agentsByIdContract, config);
  const result = await client.update({ params: { id }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update agent "${id}"`);
}

export async function deleteAgent(id: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(agentsByIdContract, config);
  const result = await client.delete({ params: { id } });
  if (result.status === 204) return;
  handleError(result, `Agent "${id}" not found`);
}

export async function getAgentInstructions(
  id: string,
): Promise<AgentInstructionsResponse> {
  const config = await getClientConfig();
  const client = initClient(agentInstructionsContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to get instructions for agent "${id}"`);
}

export async function updateAgentInstructions(
  id: string,
  content: string,
): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(agentInstructionsContract, config);
  const result = await client.update({
    params: { id },
    body: { content },
  });
  if (result.status === 200) return;
  handleError(result, `Failed to update instructions for agent "${id}"`);
}
