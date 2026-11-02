import { array, object, string, enum as zEnum } from "zod";

import { connectorSlugSchema } from "../contracts/connector-identity";

export const permissionSchema = string().min(1).max(128);

export const userPermissionGrantExpiresInSchema = zEnum([
  "1h",
  "24h",
  "7d",
  "always",
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
