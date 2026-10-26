import {
  array,
  boolean,
  number,
  object,
  string,
  union,
  type infer as zInfer,
} from "zod";

export const MCP_TOOL_ERROR_MAX_ISSUES = 20;
export const MCP_TOOL_ERROR_MAX_PATH_SEGMENTS = 16;

export const mcpToolErrorIssueSchema = object({
  path: array(union([string().max(256), number().int().nonnegative()])).max(
    MCP_TOOL_ERROR_MAX_PATH_SEGMENTS,
  ),
  code: string()
    .regex(/^[a-z][a-z0-9_]*$/u)
    .max(64),
  message: string().min(1).max(1_000),
});

export const mcpToolErrorSchema = object({
  code: string()
    .regex(/^[a-z][a-z0-9_]*$/u)
    .max(64),
  message: string().min(1).max(4_096),
  retryable: boolean(),
  issues: array(mcpToolErrorIssueSchema)
    .max(MCP_TOOL_ERROR_MAX_ISSUES)
    .optional(),
});

export const mcpToolErrorContentSchema = object({
  error: mcpToolErrorSchema,
});

export type McpToolErrorIssue = zInfer<typeof mcpToolErrorIssueSchema>;
export type McpToolError = zInfer<typeof mcpToolErrorSchema>;
export type McpToolErrorContent = zInfer<typeof mcpToolErrorContentSchema>;
