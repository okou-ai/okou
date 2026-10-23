import * as z from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const agentConnectorAccessSchema = z.object({
  enabledConnectorSlugs: z.array(connectorSlugSchema),
  customConnectorIds: z.array(z.uuid()),
});

export type AgentConnectorAccess = z.infer<typeof agentConnectorAccessSchema>;

export const agentConnectorAccessContract = c.router({
  agent: {
    method: "GET",
    path: "/api/agents/:id/connector-access",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: agentConnectorAccessSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get connector authorization for one Agent",
  },
});
