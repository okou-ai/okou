import { z } from "zod";

export const mcpListAgentsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(4096).optional(),
});

export const mcpListAgentsOutputSchema = z.strictObject({
  agents: z
    .array(
      z.strictObject({
        agentId: z.uuid(),
        name: z.string().max(512),
        description: z.string().max(1000).nullable(),
        descriptionTruncated: z.boolean(),
        isDefault: z.boolean(),
      }),
    )
    .max(50),
  nextCursor: z.string().max(4096).nullable(),
});

export const mcpListModelsInputSchema = z.strictObject({});

export const mcpListModelsOutputSchema = z.strictObject({
  models: z.array(
    z.strictObject({
      id: z.string().max(255),
      name: z.string().max(512),
      selectable: z.boolean(),
      availability: z.enum([
        "available",
        "reconnect_required",
        "connection_required",
        "plan_restricted",
        "unavailable",
      ]),
      reason: z.string().max(1000).nullable(),
    }),
  ),
  defaultModel: z.strictObject({
    model: z.string().max(255).nullable(),
    source: z.enum(["member_default", "org_default"]).nullable(),
  }),
  admission: z.literal("checked_on_send"),
});

export type McpListAgentsInput = z.infer<typeof mcpListAgentsInputSchema>;
export type McpListAgentsOutput = z.infer<typeof mcpListAgentsOutputSchema>;
export type McpListModelsOutput = z.infer<typeof mcpListModelsOutputSchema>;

export type McpDiscoveryResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | {
      readonly kind: "invalid_cursor" | "unavailable";
      readonly message: string;
    };
