import {
  boolean,
  discriminatedUnion,
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

export const codexDeviceAuthScopeSchema = literal("personal");
export const codexDeviceAuthModeSchema = zEnum(["add", "reconnect"]);

const codexDeviceAuthStartResponseSchema = object({
  sessionToken: string(),
  type: literal("codex"),
  status: literal("pending"),
  scope: codexDeviceAuthScopeSchema,
  browserUrl: url(),
  verificationCode: string().min(1),
  expiresIn: number().int().positive(),
  interval: number().int().positive(),
});

const codexDeviceAuthCompleteResponseSchema = discriminatedUnion("status", [
  object({
    status: literal("pending"),
    errorMessage: string().nullable(),
  }),
  object({
    status: literal("complete"),
    provider: modelProviderResponseSchema,
    created: boolean(),
  }),
]);

const codexDeviceAuthCancelResponseSchema = object({
  status: literal("cancelled"),
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
    body: object({
      scope: codexDeviceAuthScopeSchema,
      mode: codexDeviceAuthModeSchema.optional(),
      modelProviderId: uuid().optional(),
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
    body: object({ sessionToken: string().min(1) }),
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
    body: object({ sessionToken: string().min(1) }),
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

export type CodexDeviceAuthScope = zInfer<typeof codexDeviceAuthScopeSchema>;
export type CodexDeviceAuthMode = zInfer<typeof codexDeviceAuthModeSchema>;
export type CodexDeviceAuthContract = typeof codexDeviceAuthContract;
