import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const agentCustomConnectorGrantSchema = z.object({
  customConnectorId: z.string().uuid(),
  permissionNames: z.array(z.string().min(1).max(128)).max(500),
});
export type AgentCustomConnectorGrant = z.infer<
  typeof agentCustomConnectorGrantSchema
>;

export const agentCustomConnectorGrantsSchema = z.object({
  grants: z.array(agentCustomConnectorGrantSchema),
});
export type AgentCustomConnectorGrants = z.infer<
  typeof agentCustomConnectorGrantsSchema
>;

export const agentCustomConnectorUpdateSchema = agentCustomConnectorGrantsSchema
  .extend({
    operation: z.enum(["replace", "add", "remove"]).optional(),
  })
  .strict();
export type AgentCustomConnectorUpdate = z.infer<
  typeof agentCustomConnectorUpdateSchema
>;

/**
 * Contract for GET/PUT /api/agents/:id/custom-connectors
 *
 * Mirrors {@link import("./user-connectors").userConnectorsContract} but
 * over org custom connector UUIDs (not official connector slugs).
 * A user's secret alone does not authorize an agent — they must also enable
 * the custom connector here for every agent that should use it.
 */
export const agentCustomConnectorsContract = c.router({
  get: {
    method: "GET",
    path: "/api/agents/:id/custom-connectors",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: agentCustomConnectorGrantsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get custom connector grants for user on agent",
  },
  update: {
    method: "PUT",
    path: "/api/agents/:id/custom-connectors",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: agentCustomConnectorUpdateSchema,
    responses: {
      200: agentCustomConnectorGrantsSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update custom connector grants for user on agent",
  },
});
export type AgentCustomConnectorsContract =
  typeof agentCustomConnectorsContract;
