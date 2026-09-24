import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * User preferences schemas (shared across contracts)
 */
export const sendModeSchema = z.enum(["enter", "cmd-enter"]);
export type SendMode = z.infer<typeof sendModeSchema>;

export const themePreferenceSchema = z.enum(["light", "dark", "system"]);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;

export const COLOR_THEMES = [
  // The product's own palette. It is the absence of a preset rather than
  // another one: the App clears both palette attributes while it is selected,
  // so every token resolves to the shared values the interface carried before
  // the gradient color themes shipped.
  "default",
  "golden-hour",
  "citrus-spark",
  "berry-blush",
  "cotton-sky",
  "blue-horizon",
  "daydream",
  "deep-lagoon",
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
  // Chinese is split by script rather than by region: Simplified and
  // Traditional are not interchangeable for a reader, and a zh-TW browser must
  // not resolve to the Simplified bundle.
  "zh-Hans",
  "zh-Hant",
] as const;
export const userLocaleSchema = z.enum(SUPPORTED_USER_LOCALES);
export type UserLocale = z.infer<typeof userLocaleSchema>;
export const DEFAULT_USER_LOCALE = "en-US" satisfies UserLocale;

export const userPreferencesResponseSchema = z.object({
  timezone: z.string().nullable(),
  locale: userLocaleSchema.nullable(),
  supportedLocales: z.array(userLocaleSchema),
  // Pinned agents are exposed as membership only. The API returns a stable
  // canonical order and ignores client-provided order on writes.
  pinnedAgentIds: z.array(z.string()),
  sendMode: sendModeSchema,
  cloudBrowserEnabledByDefault: z.boolean(),
  theme: themePreferenceSchema.nullable(),
  colorTheme: colorThemeSchema.nullable(),
  captureNetworkBodiesRemaining: z.number().int().min(0),
  // Retired: voice input always uses Gemini 3.1 Flash-Lite on Vertex. The API
  // always returns null for App bundles that still render the Debug model
  // picker. Remove after those bundles drain.
  voiceInputModel: z.string().nullable(),
});

export type UserPreferencesResponse = z.infer<
  typeof userPreferencesResponseSchema
>;

export const USER_PREFERENCES_UNINITIALIZED =
  "USER_PREFERENCES_UNINITIALIZED" as const;

export type InitializedUserPreferencesResponse = Omit<
  UserPreferencesResponse,
  "timezone" | "locale"
> & { readonly timezone: string; readonly locale: UserLocale };

export const updateUserPreferencesRequestSchema = z
  .object({
    timezone: z.string().min(1).optional(),
    locale: userLocaleSchema.optional(),
    // Membership update only; request order is not used for display ordering.
    pinnedAgentIds: z.array(z.string()).optional(),
    sendMode: sendModeSchema.optional(),
    cloudBrowserEnabledByDefault: z.boolean().optional(),
    theme: themePreferenceSchema.optional(),
    colorTheme: colorThemeSchema.optional(),
    captureNetworkBodiesRemaining: z.number().int().min(0).optional(),
    // Retired and ignored; still accepted from App bundles that can send it.
    // Remove with the response field.
    voiceInputModel: z.string().max(255).nullable().optional(),
  })
  .refine(
    (data) => {
      return (
        data.timezone !== undefined ||
        data.locale !== undefined ||
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
    body: z.object({
      timezone: z.string().min(1).optional(),
      locale: userLocaleSchema.optional(),
    }),
    responses: {
      200: userPreferencesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Initialize missing timezone and locale and enroll Morning Brief",
  },
  get: {
    method: "GET",
    path: "/api/user-preferences",
    headers: authHeadersSchema,
    responses: {
      200: userPreferencesResponseSchema,
      409: z.object({
        error: z.object({
          code: z.literal(USER_PREFERENCES_UNINITIALIZED),
          message: z.string(),
        }),
      }),
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
