import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { imageModelIdSchema } from "./image-models";
import { runModelIdSchema } from "./model-providers";
import { chatThreadServiceTierSchema } from "./chat-threads";
import {
  modelSettingsPatchSchema,
  modelSettingsSchema,
} from "./model-reasoning-effort";

const c = initContract();

export const userModelPreferenceResponseSchema = z.object({
  selectedModel: runModelIdSchema.nullable(),
  serviceTier: chatThreadServiceTierSchema.nullable(),
  modelSettings: modelSettingsSchema.default({}),
  selectedImageModel: imageModelIdSchema.nullable(),
  updatedAt: z.string().nullable(),
});

export type UserModelPreferenceResponse = z.infer<
  typeof userModelPreferenceResponseSchema
>;

export const updateUserModelPreferenceRequestSchema = z.object({
  selectedModel: runModelIdSchema.nullable(),
  serviceTier: chatThreadServiceTierSchema.nullable(),
  /** Patch only the named model; omitted preserves every stored model setting. */
  modelSettingsPatch: modelSettingsPatchSchema.optional(),
  /**
   * Partial-update semantics, not a rollout fallback: absent means "leave it
   * alone" and null clears it, so a caller that only changes the run model
   * never blanks the image default.
   */
  selectedImageModel: imageModelIdSchema.nullable().optional(),
});

export type UpdateUserModelPreferenceRequest = z.infer<
  typeof updateUserModelPreferenceRequestSchema
>;

export const userModelPreferenceContract = c.router({
  get: {
    method: "GET",
    path: "/api/user-model-preference",
    headers: authHeadersSchema,
    responses: {
      200: userModelPreferenceResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get current user's model-first preference",
  },
  update: {
    method: "PUT",
    path: "/api/user-model-preference",
    headers: authHeadersSchema,
    body: updateUserModelPreferenceRequestSchema,
    responses: {
      200: userModelPreferenceResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update current user's model-first preference",
  },
});

export type UserModelPreferenceContract = typeof userModelPreferenceContract;
