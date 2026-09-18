import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * User connector enabled slugs schema
 * Sparse model: only connector slugs explicitly enabled by the user for this
 * agent.
 */
export const userConnectorEnabledSlugsSchema = z.object({
  enabledConnectorSlugs: z.array(connectorSlugSchema),
});
export type UserConnectorEnabledSlugs = z.infer<
  typeof userConnectorEnabledSlugsSchema
>;

export const userConnectorUpdateSchema = z
  .object({
    enabledConnectorSlugs: z.array(connectorSlugSchema),
    operation: z.enum(["replace", "add", "remove"]).optional(),
  })
  .strict();
export type UserConnectorUpdate = z.infer<typeof userConnectorUpdateSchema>;

/**
 * Contract for GET/PUT /api/agents/:id/user-connectors
 */
export const userConnectorsContract = c.router({
  get: {
    method: "GET",
    path: "/api/agents/:id/user-connectors",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: userConnectorEnabledSlugsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get enabled connector slugs for user on agent",
  },
  update: {
    method: "PUT",
    path: "/api/agents/:id/user-connectors",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: userConnectorUpdateSchema,
    responses: {
      200: userConnectorEnabledSlugsSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update enabled connector slugs for user on agent",
  },
});
export type UserConnectorsContract = typeof userConnectorsContract;
