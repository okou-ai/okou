import { z } from "zod";

import { authHeadersSchema,initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { modelProviderResponseSchema } from "./model-providers";

const c = initContract();

export const claudeCodeDeviceAuthScopeSchema = z.literal("personal");
export const claudeCodeDeviceAuthModeSchema = z.enum(["add", "reconnect"]);

const claudeCodeDeviceAuthStartResponseSchema = z.object({
  sessionToken: z.string(),
  type: z.literal("claude-code"),
  status: z.literal("pending"),
  scope: claudeCodeDeviceAuthScopeSchema,
  browserUrl: z.url(),
  expiresIn: z.number().int().positive(),
});

const claudeCodeDeviceAuthCompleteResponseSchema = z.object({
  status: z.literal("complete"),
  provider: modelProviderResponseSchema,
  created: z.boolean(),
});

const claudeCodeDeviceAuthCancelResponseSchema = z.object({
  status: z.literal("cancelled"),
});

/**
 * Contract for Claude Code device-style OAuth.
 * Runs the same PKCE OAuth path as `claude setup-token` and imports the
 * resulting long-lived Claude Code token.
 */
export const claudeCodeDeviceAuthContract = c.router({
  start: {
    method: "POST",
    path: "/api/model-providers/claude-code/device-auth/sessions",
    headers: authHeadersSchema,
    body: z.object({
      scope: claudeCodeDeviceAuthScopeSchema,
      mode: claudeCodeDeviceAuthModeSchema.optional(),
      modelProviderId: z.uuid().optional(),
    }),
    responses: {
      200: claudeCodeDeviceAuthStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start Claude Code device auth",
  },
  complete: {
    method: "POST",
    path: "/api/model-providers/claude-code/device-auth/sessions/complete",
    headers: authHeadersSchema,
    body: z.object({
      sessionToken: z.string().min(1),
      authorizationCode: z.string().min(1),
    }),
    responses: {
      200: claudeCodeDeviceAuthCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Complete Claude Code device auth and import OAuth token",
  },
  cancel: {
    method: "POST",
    path: "/api/model-providers/claude-code/device-auth/sessions/cancel",
    headers: authHeadersSchema,
    body: z.object({ sessionToken: z.string().min(1) }),
    responses: {
      200: claudeCodeDeviceAuthCancelResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Cancel Claude Code device auth",
  },
});

export type ClaudeCodeDeviceAuthScope = z.infer<
  typeof claudeCodeDeviceAuthScopeSchema
>;
export type ClaudeCodeDeviceAuthMode = z.infer<
  typeof claudeCodeDeviceAuthModeSchema
>;
export type ClaudeCodeDeviceAuthContract = typeof claudeCodeDeviceAuthContract;
