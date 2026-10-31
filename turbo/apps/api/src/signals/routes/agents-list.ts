import { computed } from "ccstate";
import {
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { agentList } from "../services/agent-data.service";
import type { RouteEntry } from "../route-entry";

const agentListResponse$ = computed(
  async (
    get,
  ): Promise<{ readonly status: 200; readonly body: AgentResponse[] }> => {
    const auth = get(organizationAuthContext$);
    const agents = await get(agentList(auth.orgId, auth.userId));
    return { status: 200 as const, body: [...agents] };
  },
);

export const agentListRoutes: readonly RouteEntry[] = [
  {
    route: agentsMainContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent:read",
        oauthScope: "okou:chat:read",
      },
      agentListResponse$,
    ),
  },
];
