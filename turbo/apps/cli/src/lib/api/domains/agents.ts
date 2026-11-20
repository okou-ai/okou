import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listAgents(): Promise<AgentResponse[]> {
  const config = await getClientConfig();
  const client = initClient(agentsMainContract, config);
  const result = await client.list({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list agents");
}
