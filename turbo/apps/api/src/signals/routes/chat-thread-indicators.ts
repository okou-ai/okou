import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { computed } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { chatIndicators } from "../services/chat-thread.service";

const listChatIndicatorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const indicators = await get(
    chatIndicators({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  return { status: 200 as const, body: indicators };
});

export const chatThreadIndicatorRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.indicators,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:read",
        oauthScope: "okou:chat:read",
      },
      listChatIndicatorsInner$,
    ),
  },
];
