import { chatSearchContract } from "@okouai/api-contracts/contracts/chat-threads";
import { computed } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { chatSearch } from "../services/chat-search.service";

const searchChatInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(chatSearchContract.search));
  const result = await get(
    chatSearch({
      userId: auth.userId,
      orgId: auth.orgId,
      keyword: query.keyword,
      agentId: query.agentId,
      since: query.since,
    }),
  );

  return {
    status: 200 as const,
    body: { results: [...result.results] },
  };
});

export const chatSearchRoutes: readonly RouteEntry[] = [
  {
    route: chatSearchContract.search,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
        oauthScope: "okou:chat:read",
      },
      searchChatInner$,
    ),
  },
];
