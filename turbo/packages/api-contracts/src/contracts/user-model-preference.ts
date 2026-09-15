import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { imageModelIdSchema } from "./image-models";
import { supportedRunModelSchema } from "./model-providers";
import { videoModelIdSchema } from "./video-models";
import { chatThreadServiceTierSchema } from "./chat-threads";
import {
  modelSettingsPatchSchema,
  modelSettingsSchema,
} from "./model-reasoning-effort";

const c = initContract();

export const userModelPreferenceResponseSchema = z.object({
  selectedModel: supportedRunModelSchema.nullable(),
  serviceTier: chatThreadServiceTierSchema.nullable(),
  modelSettings: modelSettingsSchema.default({}),
  selectedVideoModel: videoModelIdSchema.nullable(),
  selectedImageModel: imageModelIdSchema.nullable(),
  updatedAt: z.string().nullable(),
});

export type UserModelPreferenceResponse = z.infer<
  typeof userModelPreferenceResponseSchema
>;

export const updateUserModelPreferenceRequestSchema = z.object({
  selectedModel: supportedRunModelSchema.nullable(),
  serviceTier: chatThreadServiceTierSchema.nullable(),
  /** Patch only the named model; omitted preserves every stored model setting. */
  modelSettingsPatch: modelSettingsPatchSchema.optional(),
  /**
   * Partial-update semantics, not a rollout fallback: the preferences are
   * independent, so absent means "leave it alone" and null clears it. This is
   * permanent — a caller that only changes the run model must never blank the
   * media defaults — and it matches how `updateUserPreferences$` already treats
   * its own optional fields. An older bundle keeping its stored defaults falls
   * out of the same rule rather than needing its own branch.
   */
  selectedVideoModel: videoModelIdSchema.nullable().optional(),
  /** Omitted preserves the image default; explicit null clears it. */
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
