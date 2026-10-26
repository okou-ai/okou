import {
  boolean,
  literal,
  number,
  object,
  string,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { modelProviderResponseSchema } from "./model-providers";

const c = initContract();

export const claudeCodeDeviceAuthScopeSchema = literal("personal");
export const claudeCodeDeviceAuthModeSchema = zEnum(["add", "reconnect"]);

const claudeCodeDeviceAuthStartResponseSchema = object({
  sessionToken: string(),
  type: literal("claude-code"),
  status: literal("pending"),
  scope: claudeCodeDeviceAuthScopeSchema,
  browserUrl: url(),
  expiresIn: number().int().positive(),
});

const claudeCodeDeviceAuthCompleteResponseSchema = object({
  status: literal("complete"),
  provider: modelProviderResponseSchema,
  created: boolean(),
});

const claudeCodeDeviceAuthCancelResponseSchema = object({
  status: literal("cancelled"),
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
    body: object({
      scope: claudeCodeDeviceAuthScopeSchema,
      mode: claudeCodeDeviceAuthModeSchema.optional(),
      modelProviderId: uuid().optional(),
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
    body: object({
      sessionToken: string().min(1),
      authorizationCode: string().min(1),
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
    body: object({ sessionToken: string().min(1) }),
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

export type ClaudeCodeDeviceAuthScope = zInfer<
  typeof claudeCodeDeviceAuthScopeSchema
>;
export type ClaudeCodeDeviceAuthMode = zInfer<
  typeof claudeCodeDeviceAuthModeSchema
>;
export type ClaudeCodeDeviceAuthContract = typeof claudeCodeDeviceAuthContract;
