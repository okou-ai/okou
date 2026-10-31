import {
  array,
  discriminatedUnion,
  literal,
  object,
  string,
  enum as zEnum,
  never as zNever,
  type infer as zInfer,
} from "zod";

import {
  permissionSchema,
  userPermissionGrantBatchItemsSchema,
  userPermissionGrantExpiresInSchema,
  type userPermissionGrantBatchItemSchema,
} from "../validators/user-permission-grants";
import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

export {
  userPermissionGrantBatchItemSchema,
  userPermissionGrantBatchItemsSchema,
  userPermissionGrantExpiresInSchema,
} from "../validators/user-permission-grants";

const c = initContract();

const agentIdSchema = string().uuid();

export const userPermissionGrantActionSchema = zEnum(["allow", "deny"]);
export const userPermissionGrantApplyModeSchema = zEnum(["patch", "replace"]);

const agentPermissionGrantScopeSchema = object({
  agentId: agentIdSchema,
});

export const userPermissionGrantScopeSchema = agentPermissionGrantScopeSchema;

const userPermissionGrantResponseBaseSchema = object({
  connectorSlug: connectorSlugSchema,
  permission: permissionSchema,
  action: userPermissionGrantActionSchema,
  expiresAt: string().nullable(),
  createdAt: string(),
  updatedAt: string(),
});

export const userPermissionGrantResponseSchema =
  userPermissionGrantResponseBaseSchema.extend({
    agentId: agentIdSchema,
  });

const listUserPermissionGrantsQuerySchema = userPermissionGrantScopeSchema;

const applyUserPermissionGrantBaseSchema = object({
  permission: permissionSchema,
});

export const applyUserPermissionGrantSchema = discriminatedUnion("action", [
  applyUserPermissionGrantBaseSchema.extend({
    action: literal("allow"),
    expiresIn: userPermissionGrantExpiresInSchema.optional(),
  }),
  applyUserPermissionGrantBaseSchema.extend({
    action: literal("deny"),
    expiresIn: zNever().optional(),
  }),
]);

export const applyUserPermissionGrantsRequestSchema = object({
  agentId: agentIdSchema,
  connectorSlug: connectorSlugSchema,
  mode: userPermissionGrantApplyModeSchema,
  grants: array(applyUserPermissionGrantSchema),
}).strict();

export const applyUserPermissionGrantsBatchRequestSchema = object({
  agentId: agentIdSchema,
  groups: array(
    object({
      connectorSlug: connectorSlugSchema,
      grants: array(
        object({
          permission: permissionSchema,
          action: literal("allow"),
          expiresIn: userPermissionGrantExpiresInSchema.optional(),
        }).strict(),
      )
        .min(1)
        .max(20),
    }).strict(),
  )
    .min(1)
    .max(20),
})
  .strict()
  .superRefine((body, ctx) => {
    const items = body.groups.flatMap((group) => {
      return group.grants.map((grant) => {
        return {
          connectorSlug: group.connectorSlug,
          permission: grant.permission,
        };
      });
    });
    const result = userPermissionGrantBatchItemsSchema.safeParse(items);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: ["groups"],
        });
      }
    }
  });

export const userPermissionGrantsContract = c.router({
  applyBatch: {
    method: "PUT",
    path: "/api/user-permission-grants/apply-batch",
    headers: authHeadersSchema,
    body: applyUserPermissionGrantsBatchRequestSchema,
    responses: {
      200: array(userPermissionGrantResponseSchema),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Allow up to 20 connector permissions atomically for the current user's agent",
  },
  list: {
    method: "GET",
    path: "/api/user-permission-grants",
    headers: authHeadersSchema,
    query: listUserPermissionGrantsQuerySchema,
    responses: {
      200: array(userPermissionGrantResponseSchema),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List current user's active permission grants for an agent",
  },
  apply: {
    method: "PUT",
    path: "/api/user-permission-grants/apply",
    headers: authHeadersSchema,
    body: applyUserPermissionGrantsRequestSchema,
    responses: {
      200: array(userPermissionGrantResponseSchema),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Apply current user's explicit permission grant changes for one connector",
  },
});

export type UserPermissionGrantAction = zInfer<
  typeof userPermissionGrantActionSchema
>;
export type UserPermissionGrantApplyMode = zInfer<
  typeof userPermissionGrantApplyModeSchema
>;
export type UserPermissionGrantExpiresIn = zInfer<
  typeof userPermissionGrantExpiresInSchema
>;
export type UserPermissionGrantResponse = zInfer<
  typeof userPermissionGrantResponseSchema
>;
export type ListUserPermissionGrantsQuery = zInfer<
  typeof listUserPermissionGrantsQuerySchema
>;
export type ApplyUserPermissionGrant = zInfer<
  typeof applyUserPermissionGrantSchema
>;
export type ApplyUserPermissionGrantsRequest = zInfer<
  typeof applyUserPermissionGrantsRequestSchema
>;
export type UserPermissionGrantBatchItem = zInfer<
  typeof userPermissionGrantBatchItemSchema
>;
export type ApplyUserPermissionGrantsBatchRequest = zInfer<
  typeof applyUserPermissionGrantsBatchRequestSchema
>;
export type UserPermissionGrantsContract = typeof userPermissionGrantsContract;
