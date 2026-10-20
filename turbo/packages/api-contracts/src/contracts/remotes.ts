import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { remoteHostDefaultSchema } from "./chat-remote-access";
import { computerUseHostBriefSchema } from "./connector-overview";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const remotesOverviewSchema = z.object({
  // Computer Use is a resource list only; selection belongs to a thread.
  computerUseHosts: z.array(computerUseHostBriefSchema),
  // Entitlement availability, not a reservation or a provider health check.
  cloudBrowserAvailable: z.boolean(),
  cloudBrowserEnabledByDefault: z.boolean(),
  // Each host has an independent default; these are not thread overrides.
  sshHosts: z.array(remoteHostDefaultSchema),
  vncHosts: z.array(remoteHostDefaultSchema),
});

export type RemotesOverview = z.infer<typeof remotesOverviewSchema>;

export const remotesContract = c.router({
  overview: {
    method: "GET",
    path: "/api/remotes/overview",
    headers: authHeadersSchema,
    responses: {
      200: remotesOverviewSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "Get the user's remote hosts and defaults without thread overrides",
  },
});
