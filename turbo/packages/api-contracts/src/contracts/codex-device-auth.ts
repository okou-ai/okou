import { z } from "zod";

import { authHeadersSchema,initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { modelProviderResponseSchema } from "./model-providers";

const c = initContract();

export const codexDeviceAuthScopeSchema = z.literal("personal");
export const codexDeviceAuthModeSchema = z.enum(["add", "reconnect"]);

const codexDeviceAuthStartResponseSchema = z.object({
  sessionToken: z.string(),
  type: z.literal("codex"),
  status: z.literal("pending"),
  scope: codexDeviceAuthScopeSchema,
  browserUrl: z.url(),
  verificationCode: z.string().min(1),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});

const codexDeviceAuthCompleteResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    errorMessage: z.string().nullable(),
  }),
  z.object({
    status: z.literal("complete"),
    provider: modelProviderResponseSchema,
    created: z.boolean(),
  }),
]);

const codexDeviceAuthCancelResponseSchema = z.object({
  status: z.literal("cancelled"),
});

/**
 * Contract for Codex device auth.
 * Runs the official Codex device authorization flow through OpenAI auth and
 * imports the resulting ChatGPT tokens.
 */
export const codexDeviceAuthContract = c.router({
  start: {
    method: "POST",
    path: "/api/model-providers/codex/device-auth/sessions",
    headers: authHeadersSchema,
    body: z.object({
      scope: codexDeviceAuthScopeSchema,
      mode: codexDeviceAuthModeSchema.optional(),
      modelProviderId: z.uuid().optional(),
    }),
    responses: {
      200: codexDeviceAuthStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start Codex device auth",
  },
  complete: {
    method: "POST",
    path: "/api/model-providers/codex/device-auth/sessions/complete",
    headers: authHeadersSchema,
    body: z.object({ sessionToken: z.string().min(1) }),
    responses: {
      200: codexDeviceAuthCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Complete Codex device auth and import ChatGPT credentials",
  },
  cancel: {
    method: "POST",
    path: "/api/model-providers/codex/device-auth/sessions/cancel",
    headers: authHeadersSchema,
    body: z.object({ sessionToken: z.string().min(1) }),
    responses: {
      200: codexDeviceAuthCancelResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Cancel Codex device auth",
  },
});

export type CodexDeviceAuthScope = z.infer<typeof codexDeviceAuthScopeSchema>;
export type CodexDeviceAuthMode = z.infer<typeof codexDeviceAuthModeSchema>;
export type CodexDeviceAuthContract = typeof codexDeviceAuthContract;
