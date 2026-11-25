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

export const antigravityDeviceAuthModeSchema = zEnum(["add", "reconnect"]);

const antigravityDeviceAuthStartResponseSchema = object({
  sessionToken: string(),
  type: literal("antigravity"),
  status: literal("pending"),
  browserUrl: url(),
  expiresIn: number().int().positive(),
});

const antigravityDeviceAuthCompleteResponseSchema = object({
  status: literal("complete"),
  provider: modelProviderResponseSchema,
  created: boolean(),
});

const antigravityDeviceAuthCancelResponseSchema = object({
  status: literal("cancelled"),
});

/**
 * Personal Google AI (Antigravity) sign-in for the internal staff pilot.
 *
 * Google redirects the official Antigravity client to a loopback address that
 * no hosted service can receive, so the member pastes the final redirect URL
 * (or its bare `code`) back to `complete`.
 */
export const antigravityDeviceAuthContract = c.router({
  start: {
    method: "POST",
    path: "/api/model-providers/antigravity/device-auth/sessions",
    headers: authHeadersSchema,
    body: object({
      mode: antigravityDeviceAuthModeSchema.optional(),
      modelProviderId: uuid().optional(),
    }),
    responses: {
      200: antigravityDeviceAuthStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start personal Google AI (Antigravity) sign-in",
  },
  complete: {
    method: "POST",
    path: "/api/model-providers/antigravity/device-auth/sessions/complete",
    headers: authHeadersSchema,
    body: object({
      sessionToken: string().min(1),
      authorizationCode: string().min(1),
    }),
    responses: {
      200: antigravityDeviceAuthCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Complete Google AI (Antigravity) sign-in from the pasted redirect URL",
  },
  cancel: {
    method: "POST",
    path: "/api/model-providers/antigravity/device-auth/sessions/cancel",
    headers: authHeadersSchema,
    body: object({ sessionToken: string().min(1) }),
    responses: {
      200: antigravityDeviceAuthCancelResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Cancel Google AI (Antigravity) sign-in",
  },
});

export type AntigravityDeviceAuthMode = zInfer<
  typeof antigravityDeviceAuthModeSchema
>;
