import { computed } from "ccstate";
import { slackChannelsContract } from "@okouai/api-contracts/contracts/slack-channels";

import { listSharedSlackChannels } from "../../lib/slack-client";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { slackUserInstallation } from "../services/slack-data.service";
import type { RouteEntry } from "../route-entry";

const slackConnectionNotFound = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No Slack account connected for this user",
      code: "NOT_FOUND",
    }),
  }),
});

const slackInstallationInput$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return { orgId: auth.orgId, userId: auth.userId } as const;
});

const slackInstallation$ = slackUserInstallation(slackInstallationInput$);

const getSlackChannelsInner$ = computed(async (get) => {
  const installation = await get(slackInstallation$);
  if (installation.kind === "not-connected") {
    return slackConnectionNotFound;
  }
  const channels = await listSharedSlackChannels(
    installation.botToken,
    installation.slackUserId,
  );
  return {
    status: 200 as const,
    body: { channels },
  };
});

export const slackChannelsRoutes: readonly RouteEntry[] = [
  {
    route: slackChannelsContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getSlackChannelsInner$,
    ),
  },
];
