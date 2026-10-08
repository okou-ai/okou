import { agentSetupPromptsContract } from "@okouai/api-contracts/contracts/agent-setup-prompts";
import { command } from "ccstate";

import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { createAgentSetupPrompt$ } from "../services/agent-setup-prompt.service";

const agentSetupPromptBody$ = bodyResultOf(agentSetupPromptsContract.create);

const postAgentSetupPrompt$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(agentSetupPromptBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(createAgentSetupPrompt$, bodyResult.data, signal);
  },
);

export const agentSetupPromptRoutes: readonly RouteEntry[] = [
  {
    route: agentSetupPromptsContract.create,
    handler: authRoute(
      {
        accept: ["session"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      postAgentSetupPrompt$,
    ),
  },
];
