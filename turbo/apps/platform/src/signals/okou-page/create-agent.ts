import {
  agentsMainContract,
  agentInstructionsContract,
} from "@okouai/api-contracts/client/agents";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import type { ApiClientFactory } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

interface CreateAgentParams {
  displayName: string;
  sound?: string;
  avatarUrl?: string;
  visibility?: "public" | "private";
}

/**
 * Create an agent and upload seed instructions.
 *
 * Shared between onboarding (lead agent) and sub-agent creation
 * to keep the two flows in sync.
 */
export async function createAgent(
  createClient: ApiClientFactory,
  params: CreateAgentParams,
  signal: AbortSignal,
): Promise<AgentResponse> {
  // Step 1: Create agent (compose). The API assigns a random composer avatar
  // when none is provided.
  const agentsClient = createClient(agentsMainContract);
  const createResult = await accept(
    agentsClient.create({
      body: {
        displayName: params.displayName,
        sound: params.sound,
        avatarUrl: params.avatarUrl,
        visibility: params.visibility,
      },
      fetchOptions: { signal },
    }),
    [201],
  );
  signal.throwIfAborted();

  const agent = (createResult as { body: AgentResponse }).body;

  // Step 2: Upload seed instructions
  const instrClient = createClient(agentInstructionsContract);
  await accept(
    instrClient.update({
      params: { id: agent.agentId },
      body: { content: SEED_INSTRUCTIONS },
      fetchOptions: { signal },
    }),
    [200],
  );
  signal.throwIfAborted();

  return agent;
}
