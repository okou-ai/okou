import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

const agentIdSchema = z.string().uuid();
const permissionSchema = z.string().min(1).max(128);

export const userPermissionGrantActionSchema = z.enum(["allow", "deny"]);
export const userPermissionGrantApplyModeSchema = z.enum(["patch", "replace"]);
export const userPermissionGrantExpiresInSchema = z.enum([
  "1h",
  "24h",
  "7d",
  "always",
]);

const agentPermissionGrantScopeSchema = z.object({
  agentId: agentIdSchema,
});

export const userPermissionGrantScopeSchema = agentPermissionGrantScopeSchema;

const userPermissionGrantResponseBaseSchema = z.object({
  connectorSlug: connectorSlugSchema,
  permission: permissionSchema,
  action: userPermissionGrantActionSchema,
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const userPermissionGrantResponseSchema =
  userPermissionGrantResponseBaseSchema.extend({
    agentId: agentIdSchema,
  });

const listUserPermissionGrantsQuerySchema = userPermissionGrantScopeSchema;

const applyUserPermissionGrantBaseSchema = z.object({
  permission: permissionSchema,
});

export const applyUserPermissionGrantSchema = z.discriminatedUnion("action", [
  applyUserPermissionGrantBaseSchema.extend({
    action: z.literal("allow"),
    expiresIn: userPermissionGrantExpiresInSchema.optional(),
  }),
  applyUserPermissionGrantBaseSchema.extend({
    action: z.literal("deny"),
    expiresIn: z.never().optional(),
  }),
]);

export const applyUserPermissionGrantsRequestSchema = z
  .object({
    agentId: agentIdSchema,
    connectorSlug: connectorSlugSchema,
    mode: userPermissionGrantApplyModeSchema,
    grants: z.array(applyUserPermissionGrantSchema),
  })
  .strict();

export const userPermissionGrantBatchItemSchema = z
  .object({ connectorSlug: connectorSlugSchema, permission: permissionSchema })
  .strict();

export const userPermissionGrantBatchItemsSchema = z
  .array(userPermissionGrantBatchItemSchema)
  .min(1)
  .max(20)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      const key = `${item.connectorSlug}\0${item.permission}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: "Duplicate connector permission",
          path: [index],
        });
      }
      seen.add(key);
    }
  });

export const applyUserPermissionGrantsBatchRequestSchema = z
  .object({
    agentId: agentIdSchema,
    groups: z
      .array(
        z
          .object({
            connectorSlug: connectorSlugSchema,
            grants: z
              .array(
                z
                  .object({
                    permission: permissionSchema,
                    action: z.literal("allow"),
                    expiresIn: userPermissionGrantExpiresInSchema.optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(20),
          })
          .strict(),
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
      200: z.array(userPermissionGrantResponseSchema),
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
      200: z.array(userPermissionGrantResponseSchema),
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
      200: z.array(userPermissionGrantResponseSchema),
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

export type UserPermissionGrantAction = z.infer<
  typeof userPermissionGrantActionSchema
>;
export type UserPermissionGrantApplyMode = z.infer<
  typeof userPermissionGrantApplyModeSchema
>;
export type UserPermissionGrantExpiresIn = z.infer<
  typeof userPermissionGrantExpiresInSchema
>;
export type UserPermissionGrantResponse = z.infer<
  typeof userPermissionGrantResponseSchema
>;
export type ListUserPermissionGrantsQuery = z.infer<
  typeof listUserPermissionGrantsQuerySchema
>;
export type ApplyUserPermissionGrant = z.infer<
  typeof applyUserPermissionGrantSchema
>;
export type ApplyUserPermissionGrantsRequest = z.infer<
  typeof applyUserPermissionGrantsRequestSchema
>;
export type UserPermissionGrantBatchItem = z.infer<
  typeof userPermissionGrantBatchItemSchema
>;
export type ApplyUserPermissionGrantsBatchRequest = z.infer<
  typeof applyUserPermissionGrantsBatchRequestSchema
>;
export type UserPermissionGrantsContract = typeof userPermissionGrantsContract;
