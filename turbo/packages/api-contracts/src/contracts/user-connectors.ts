import { array, object, uuid, enum as zEnum, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * User connector enabled slugs schema
 * Sparse model: only connector slugs explicitly enabled by the user for this
 * agent.
 */
export const userBuiltinConnectorEnabledSlugsSchema = object({
  enabledConnectorSlugs: array(connectorSlugSchema),
});
export type UserBuiltinConnectorEnabledSlugs = zInfer<
  typeof userBuiltinConnectorEnabledSlugsSchema
>;

export const userBuiltinConnectorUpdateSchema = object({
  enabledConnectorSlugs: array(connectorSlugSchema),
  operation: zEnum(["replace", "add", "remove"]).optional(),
}).strict();
export type UserBuiltinConnectorUpdate = zInfer<
  typeof userBuiltinConnectorUpdateSchema
>;

/**
 * Contract for the Drive export authorization write
 */
export const userBuiltinConnectorsContract = c.router({
  update: {
    method: "PUT",
    path: "/api/agents/:id/user-connectors",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    body: userBuiltinConnectorUpdateSchema,
    responses: {
      200: userBuiltinConnectorEnabledSlugsSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update enabled connector slugs for user on agent",
  },
});
export type UserBuiltinConnectorsContract =
  typeof userBuiltinConnectorsContract;
