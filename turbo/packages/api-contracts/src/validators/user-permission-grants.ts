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

import { connectorSlugSchema } from "../contracts/connector-identity";

export const permissionSchema = string().min(1).max(128);

export const userPermissionGrantExpiresInSchema = zEnum([
  "1h",
  "24h",
  "7d",
  "always",
]);

export const userPermissionGrantActionSchema = zEnum(["allow", "deny"]);
export const userPermissionGrantApplyModeSchema = zEnum(["patch", "replace"]);

export const applyUserPermissionGrantSchema = discriminatedUnion("action", [
  object({
    permission: permissionSchema,
    action: literal("allow"),
    expiresIn: userPermissionGrantExpiresInSchema.optional(),
  }),
  object({
    permission: permissionSchema,
    action: literal("deny"),
    expiresIn: zNever().optional(),
  }),
]);

export const userPermissionGrantBatchItemSchema = object({
  connectorSlug: connectorSlugSchema,
  permission: permissionSchema,
}).strict();

export const userPermissionGrantBatchItemsSchema = array(
  userPermissionGrantBatchItemSchema,
)
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

export type UserPermissionGrantBatchItem = zInfer<
  typeof userPermissionGrantBatchItemSchema
>;

export type ApplyUserPermissionGrant = zInfer<
  typeof applyUserPermissionGrantSchema
>;
export type UserPermissionGrantAction = zInfer<
  typeof userPermissionGrantActionSchema
>;
export type UserPermissionGrantApplyMode = zInfer<
  typeof userPermissionGrantApplyModeSchema
>;
export type UserPermissionGrantExpiresIn = zInfer<
  typeof userPermissionGrantExpiresInSchema
>;
