import { boolean, object, string, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const slackOrgStatusSchema = object({
  isConnected: boolean(),
  isInstalled: boolean().optional(),
  workspaceName: string().nullable().optional(),
  isAdmin: boolean(),
  installUrl: string().nullable().optional(),
  connectUrl: string().nullable().optional(),
  defaultAgentName: string().nullable().optional(),
  /** True when the installation's granted scopes are outdated (admin-only). */
  scopeMismatch: boolean().optional(),
  /** OAuth install URL for re-authorization (admin-only, when scopeMismatch). */
  reinstallUrl: string().nullable().optional(),
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
    query: object({
      action: string().optional(),
    }),
    responses: {
      200: object({ ok: boolean() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect or uninstall Slack workspace",
  },
});

export type IntegrationsSlackContract = typeof integrationsSlackContract;
export type SlackOrgStatus = zInfer<typeof slackOrgStatusSchema>;
export { slackOrgStatusSchema };
