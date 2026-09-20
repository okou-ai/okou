import { z } from "zod";

export const MCP_TOOL_ERROR_MAX_ISSUES = 20;
export const MCP_TOOL_ERROR_MAX_PATH_SEGMENTS = 16;

export const mcpToolErrorIssueSchema = z.object({
  path: z
    .array(z.union([z.string().max(256), z.number().int().nonnegative()]))
    .max(MCP_TOOL_ERROR_MAX_PATH_SEGMENTS),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/u)
    .max(64),
  message: z.string().min(1).max(1_000),
});

export const mcpToolErrorSchema = z.object({
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/u)
    .max(64),
  message: z.string().min(1).max(4_096),
  retryable: z.boolean(),
  issues: z
    .array(mcpToolErrorIssueSchema)
    .max(MCP_TOOL_ERROR_MAX_ISSUES)
    .optional(),
});

export const mcpToolErrorContentSchema = z.object({
  error: mcpToolErrorSchema,
});

export type McpToolErrorIssue = z.infer<typeof mcpToolErrorIssueSchema>;
export type McpToolError = z.infer<typeof mcpToolErrorSchema>;
export type McpToolErrorContent = z.infer<typeof mcpToolErrorContentSchema>;
