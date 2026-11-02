import { array, object, string, type infer as zInfer } from "zod";

import { permissionSchema } from "../validators/user-permission-grants";
import { authHeadersSchema, initContract } from "./base";
import {
  connectorAccountTargetQuerySchema,
  connectorAccountTargetSchema,
} from "./connector-accounts";
import { apiErrorSchema } from "./errors";
import {
  applyUserPermissionGrantSchema,
  userPermissionGrantActionSchema,
  userPermissionGrantApplyModeSchema,
} from "./user-permission-grants";

const c = initContract();
const connectorPermissionsSchema = object({
  target: connectorAccountTargetSchema,
  grants: array(
    object({
      permission: permissionSchema,
      action: userPermissionGrantActionSchema,
      expiresAt: string().nullable(),
    }).strict(),
  ),
}).strict();
const applyConnectorPermissionsSchema = object({
  target: connectorAccountTargetSchema,
  mode: userPermissionGrantApplyModeSchema,
  grants: array(applyUserPermissionGrantSchema)
    .max(1000)
    .refine(
      (grants) => {
        return (
          new Set(
            grants.map((grant) => {
              return grant.permission;
            }),
          ).size === grants.length
        );
      },
      { message: "Duplicate connector permission" },
    ),
}).strict();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
} as const;

/** One member connector permission overlay, independent of Chat/Agent/account. */
export const connectorPermissionsContract = c.router({
  get: {
    method: "GET",
    path: "/api/connector-permissions",
    headers: authHeadersSchema,
    query: connectorAccountTargetQuerySchema,
    responses: { 200: connectorPermissionsSchema, ...errors },
    summary: "Read shared connector rules when any owned account is saved",
  },
  apply: {
    method: "PUT",
    path: "/api/connector-permissions",
    headers: authHeadersSchema,
    body: applyConnectorPermissionsSchema,
    responses: { 200: connectorPermissionsSchema, ...errors },
    summary: "Configure member connector permissions shared by all Chats",
  },
});

export type ConnectorPermissions = zInfer<typeof connectorPermissionsSchema>;
export type ApplyConnectorPermissions = zInfer<
  typeof applyConnectorPermissionsSchema
>;
