import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { voiceInputModelIdSchema } from "./voice-input-models";

const c = initContract();

/**
 * User preferences schemas (shared across contracts)
 */
export const sendModeSchema = z.enum(["enter", "cmd-enter"]);
export type SendMode = z.infer<typeof sendModeSchema>;

export const themePreferenceSchema = z.enum(["light", "dark", "system"]);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;

export const COLOR_THEMES = [
  "golden-hour",
  "citrus-spark",
  "berry-blush",
  "cotton-sky",
  "blue-horizon",
  "daydream",
  "deep-lagoon",
  "limelight",
] as const;
export const colorThemeSchema = z.enum(COLOR_THEMES);
export type ColorTheme = z.infer<typeof colorThemeSchema>;

export const SUPPORTED_USER_LOCALES = [
  "en-US",
  "pt-BR",
  "ja-JP",
  "ko-KR",
  "id-ID",
  "de-DE",
  "es-ES",
  "it-IT",
  "fr-FR",
  "hi-IN",
] as const;
export const userLocaleSchema = z.enum(SUPPORTED_USER_LOCALES);
export type UserLocale = z.infer<typeof userLocaleSchema>;

export const CHAT_TRANSLATION_LANGUAGES = [
  "en",
  "zh-CN",
  "zh-TW",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "pt-BR",
  "it",
  "id",
  "hi",
] as const;
export const chatTranslationLanguageSchema = z.enum(CHAT_TRANSLATION_LANGUAGES);
export type ChatTranslationLanguage = z.infer<
  typeof chatTranslationLanguageSchema
>;

export const CHAT_TRANSLATION_LANGUAGE_BY_USER_LOCALE = {
  "en-US": "en",
  "pt-BR": "pt-BR",
  "ja-JP": "ja",
  "ko-KR": "ko",
  "id-ID": "id",
  "de-DE": "de",
  "es-ES": "es",
  "it-IT": "it",
  "fr-FR": "fr",
  "hi-IN": "hi",
} as const satisfies Record<UserLocale, ChatTranslationLanguage>;

export const userPreferencesResponseSchema = z.object({
  timezone: z.string().nullable(),
  locale: userLocaleSchema.nullable(),
  translationLanguage: chatTranslationLanguageSchema.nullable(),
  supportedLocales: z.array(userLocaleSchema),
  // Pinned agents are exposed as membership only. The API returns a stable
  // canonical order and ignores client-provided order on writes.
  pinnedAgentIds: z.array(z.string()),
  sendMode: sendModeSchema,
  cloudBrowserEnabledByDefault: z.boolean(),
  theme: themePreferenceSchema.nullable(),
  colorTheme: colorThemeSchema.nullable(),
  captureNetworkBodiesRemaining: z.number().int().min(0),
  voiceInputModel: z.string().nullable(),
});

export type UserPreferencesResponse = z.infer<
  typeof userPreferencesResponseSchema
>;

export const updateUserPreferencesRequestSchema = z
  .object({
    timezone: z.string().min(1).optional(),
    locale: userLocaleSchema.optional(),
    translationLanguage: chatTranslationLanguageSchema.optional(),
    // Membership update only; request order is not used for display ordering.
    pinnedAgentIds: z.array(z.string()).optional(),
    sendMode: sendModeSchema.optional(),
    cloudBrowserEnabledByDefault: z.boolean().optional(),
    theme: themePreferenceSchema.optional(),
    colorTheme: colorThemeSchema.optional(),
    captureNetworkBodiesRemaining: z.number().int().min(0).optional(),
    voiceInputModel: voiceInputModelIdSchema.nullable().optional(),
  })
  .refine(
    (data) => {
      return (
        data.timezone !== undefined ||
        data.locale !== undefined ||
        data.translationLanguage !== undefined ||
        data.pinnedAgentIds !== undefined ||
        data.sendMode !== undefined ||
        data.cloudBrowserEnabledByDefault !== undefined ||
        data.theme !== undefined ||
        data.colorTheme !== undefined ||
        data.captureNetworkBodiesRemaining !== undefined ||
        data.voiceInputModel !== undefined
      );
    },
    {
      message: "At least one preference must be provided",
    },
  );

export type UpdateUserPreferencesRequest = z.infer<
  typeof updateUserPreferencesRequestSchema
>;

/**
 * User preferences contract for /api/user-preferences
 *
 * GET: Get current user's preferences
 * POST: Update user preferences
 */
export const userPreferencesContract = c.router({
  initialize: {
    method: "POST",
    path: "/api/user-preferences/initialize",
    headers: authHeadersSchema,
    body: z.object({ timezone: z.string().min(1).optional() }),
    responses: {
      200: userPreferencesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Initialize missing member preferences and Morning Brief enrollment",
  },
  get: {
    method: "GET",
    path: "/api/user-preferences",
    headers: authHeadersSchema,
    responses: {
      200: userPreferencesResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get user preferences",
  },
  update: {
    method: "POST",
    path: "/api/user-preferences",
    headers: authHeadersSchema,
    body: updateUserPreferencesRequestSchema,
    responses: {
      200: userPreferencesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update user preferences",
  },
});

export type UserPreferencesContract = typeof userPreferencesContract;
