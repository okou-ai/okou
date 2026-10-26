import { array, object, string, uuid, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const connectorAgentAccessSchema = object({
  visibleAgentIds: array(uuid()),
  builtin: array(
    object({
      connectorSlug: connectorSlugSchema,
      agentId: uuid(),
    }),
  ),
  custom: array(
    object({
      connectorId: uuid(),
      agentId: uuid(),
      permissionNames: array(string()),
    }),
  ),
});

export type ConnectorAgentAccess = zInfer<typeof connectorAgentAccessSchema>;

export const connectorAgentAccessContract = c.router({
  get: {
    method: "GET",
    path: "/api/connectors/agent-access",
    headers: authHeadersSchema,
    query: object({
      builtinSlug: connectorSlugSchema.optional(),
      customConnectorId: uuid().optional(),
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
