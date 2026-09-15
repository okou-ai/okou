import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { CANONICAL_WORKING_DIR } from "./runner-primitives";

const c = initContract();

export const MOUNT_PATH_TEMPLATE = "${{ working_dir }}";

export function expandMountPath(mountPath: string | undefined): string {
  if (mountPath === undefined || mountPath === MOUNT_PATH_TEMPLATE) {
    return CANONICAL_WORKING_DIR;
  }
  return mountPath;
}

export const AGENT_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/;

export const agentNameSchema = z
  .string()
  .min(3, "Agent name must be at least 3 characters")
  .max(64, "Agent name must be 64 characters or less")
  .regex(
    AGENT_NAME_REGEX,
    "Agent name must start and end with letter or number, and contain only letters, numbers, and hyphens",
  );

export const agentVisibilitySchema = z.enum(["public", "private"]);
export type AgentVisibility = z.infer<typeof agentVisibilitySchema>;

/**
 * Agent response schema
 */
export const agentResponseSchema = z.object({
  agentId: z.string(),
  isDefaultAgent: z.boolean(),
  ownerId: z.string(),
  description: z.string().nullable(),
  displayName: z.string().nullable(),
  sound: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  modelProviderId: z.string().uuid().nullable().default(null),
  selectedModel: z.string().nullable().default(null),
  preferPersonalProvider: z.boolean().default(false),
  visibility: agentVisibilitySchema,
});

/**
 * Create/update agent request schema
 */
export const agentRequestSchema = z.object({
  description: z.string().optional(),
  displayName: z.string().optional(),
  sound: z.string().optional(),
  avatarUrl: z.string().optional(),
  visibility: agentVisibilitySchema.optional(),
});

/**
 * Partial metadata update request schema (for PATCH)
 */
export const agentMetadataRequestSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  sound: z.string().optional(),
  avatarUrl: z.string().nullable().optional(),
  visibility: agentVisibilitySchema.optional(),
});

/**
 * Agent instructions response schema
 */
export const agentInstructionsResponseSchema = z.object({
  content: z.string().nullable(),
  filename: z.string().nullable(),
});

/**
 * Agent instructions update request schema
 */
export const agentInstructionsRequestSchema = z.object({
  content: z.string(),
});

/**
 * Contract for GET/POST /api/agents (list/create agents)
 */
export const agentsMainContract = c.router({
  create: {
    method: "POST",
    path: "/api/agents",
    headers: authHeadersSchema,
    body: agentRequestSchema,
    responses: {
      201: agentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      422: apiErrorSchema,
    },
    summary: "Create agent",
  },
  list: {
    method: "GET",
    path: "/api/agents",
    headers: authHeadersSchema,
    responses: {
      200: z.array(agentResponseSchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List agents",
  },
});

/**
 * Contract for GET/PUT/PATCH/DELETE /api/agents/:id
 */
export const agentsByIdContract = c.router({
  get: {
    method: "GET",
    path: "/api/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: agentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent by id",
  },
  update: {
    method: "PUT",
    path: "/api/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: agentRequestSchema,
    responses: {
      200: agentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      422: apiErrorSchema,
    },
    summary: "Update agent",
  },
  updateMetadata: {
    method: "PATCH",
    path: "/api/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: agentMetadataRequestSchema,
    responses: {
      200: agentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Update agent metadata",
  },
  delete: {
    method: "DELETE",
    path: "/api/agents/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Delete agent by id",
  },
});

/**
 * Contract for GET/PUT /api/agents/:id/instructions
 */
export const agentInstructionsContract = c.router({
  get: {
    method: "GET",
    path: "/api/agents/:id/instructions",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: agentInstructionsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent instructions",
  },
  update: {
    method: "PUT",
    path: "/api/agents/:id/instructions",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: agentInstructionsRequestSchema,
    responses: {
      200: agentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      422: apiErrorSchema,
    },
    summary: "Update agent instructions",
  },
});

// Export types
export type AgentResponse = z.infer<typeof agentResponseSchema>;
export type AgentRequest = z.infer<typeof agentRequestSchema>;
export type AgentMetadataRequest = z.infer<typeof agentMetadataRequestSchema>;
export type AgentInstructionsResponse = z.infer<
  typeof agentInstructionsResponseSchema
>;
export type AgentInstructionsRequest = z.infer<
  typeof agentInstructionsRequestSchema
>;

export type AgentsMainContract = typeof agentsMainContract;
export type AgentsByIdContract = typeof agentsByIdContract;
export type AgentInstructionsContract = typeof agentInstructionsContract;
