import { listAgents } from "../api/domains/agents";

// Existing API requests still require an executor ID on the wire.
export async function workspaceExecutorId(): Promise<string> {
  const agent = (await listAgents()).find((entry) => {
    return entry.isDefaultAgent;
  });
  if (!agent)
    throw new Error(
      "This workspace has no available Okou executor. Check workspace access before retrying.",
    );
  return agent.agentId;
}
