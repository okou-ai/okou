import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const slackOrgStatusSchema = z.object({
  isConnected: z.boolean(),
  isInstalled: z.boolean().optional(),
  workspaceName: z.string().nullable().optional(),
  isAdmin: z.boolean(),
  installUrl: z.string().nullable().optional(),
  connectUrl: z.string().nullable().optional(),
  defaultAgentName: z.string().nullable().optional(),
  /** True when the installation's granted scopes are outdated (admin-only). */
  scopeMismatch: z.boolean().optional(),
  /** OAuth install URL for re-authorization (admin-only, when scopeMismatch). */
  reinstallUrl: z.string().nullable().optional(),
});

/**
 * Integrations Slack contract (GET/DELETE /api/integrations/slack)
 * Manages org-scoped Slack workspace info.
 */
export const integrationsSlackContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/integrations/slack",
    headers: authHeadersSchema,
    responses: {
      200: slackOrgStatusSchema,
      401: apiErrorSchema,
    },
    summary: "Get org-scoped Slack workspace info",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/integrations/slack",
    headers: authHeadersSchema,
    body: c.noBody(),
    query: z.object({
      action: z.string().optional(),
    }),
    responses: {
      200: z.object({ ok: z.boolean() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect or uninstall Slack workspace",
  },
});

export type IntegrationsSlackContract = typeof integrationsSlackContract;
export type SlackOrgStatus = z.infer<typeof slackOrgStatusSchema>;
export { slackOrgStatusSchema };
