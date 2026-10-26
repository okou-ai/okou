import { array, object, uuid, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const agentConnectorAccessSchema = object({
  enabledConnectorSlugs: array(connectorSlugSchema),
  customConnectorIds: array(uuid()),
});

export type AgentConnectorAccess = zInfer<typeof agentConnectorAccessSchema>;

export const agentConnectorAccessContract = c.router({
  agent: {
    method: "GET",
    path: "/api/agents/:id/connector-access",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses: {
      200: agentConnectorAccessSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get connector authorization for one Agent",
  },
});
