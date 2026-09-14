import { z } from "zod";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "@okouai/api-contracts/contracts/connector-identity";

/** Public list parser from af933c2c, before the MCP collection contract.
 * Keep this independent of the current collection schema: open HTTP-only
 * clients remain supported after MCP catalog publication.
 */
export function parseHttpOnlyCatalogList(value: unknown) {
  return z
    .object({
      connectors: z.array(
        z.object({
          slug: connectorSlugSchema,
          label: z.string(),
          description: z.string(),
          icon: z.object({
            url: z.url({ protocol: /^https$/u }).max(2048),
            invertInDarkMode: z.boolean(),
            scale: z.number().min(1).max(3).optional(),
          }),
          category: z.string(),
          popularityRank: z.number().int().nonnegative().optional(),
          generation: z.array(z.string()),
          tags: z.array(z.string()),
          authMethods: z.array(
            z.object({
              id: connectorAuthMethodIdSchema,
              label: z.string(),
              description: z.string().nullable(),
              grantKind: z.enum([
                "none",
                "manual",
                "auth-code",
                "openid-auth",
                "external-code",
                "device-auth",
                "managed",
              ]),
            }),
          ),
          permissionSummary: z.object({
            hasPermissions: z.boolean(),
            permissionCount: z.number().int().nonnegative(),
            hasCategories: z.boolean(),
            hasDefaultPolicyOverrides: z.boolean(),
          }),
        }),
      ),
      categoryMetadata: z
        .object({
          categories: z.array(
            z.object({
              id: z.string(),
              label: z.string(),
              menuLabel: z.string(),
              groupId: z.string().nullable(),
            }),
          ),
          groups: z.array(
            z.object({
              id: z.string(),
              label: z.string(),
              menuLabel: z.string(),
            }),
          ),
        })
        .optional(),
    })
    .parse(value);
}
