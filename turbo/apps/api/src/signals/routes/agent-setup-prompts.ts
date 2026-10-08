import { agentSetupPromptsContract } from "@okouai/api-contracts/contracts/agent-setup-prompts";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { createAgentSetupPrompt$ } from "../services/agent-setup-prompt.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";

const agentSetupPromptBody$ = bodyResultOf(agentSetupPromptsContract.create);

const postAgentSetupPrompt$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(FeatureSwitchKey.AgentResponsibilitySetup, {
        userId: auth.userId,
        orgId: auth.orgId,
        overrides,
      })
    ) {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN",
            message: "Agent responsibility setup is not enabled",
          },
        },
      };
    }
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
