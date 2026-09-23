import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const connectorAgentAccessSchema = z.object({
  builtin: z.array(
    z.object({
      connectorSlug: connectorSlugSchema,
      agentId: z.uuid(),
    }),
  ),
  custom: z.array(
    z.object({
      connectorId: z.uuid(),
      agentId: z.uuid(),
      permissionNames: z.array(z.string()),
    }),
  ),
});

export type ConnectorAgentAccess = z.infer<typeof connectorAgentAccessSchema>;

export const connectorAgentAccessContract = c.router({
  get: {
    method: "GET",
    path: "/api/connectors/agent-access",
    headers: authHeadersSchema,
    query: z.object({
      builtinSlug: connectorSlugSchema.optional(),
      customConnectorId: z.uuid().optional(),
    }),
    responses: {
      200: connectorAgentAccessSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List visible agents authorized for connectors",
  },
});
