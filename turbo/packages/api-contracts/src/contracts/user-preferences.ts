import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import {
  type UserLocale,
  userLocaleSchema,
} from "../validators/user-preferences";
export {
  DEFAULT_USER_LOCALE,
  type UserLocale,
  userLocaleSchema,
  SUPPORTED_USER_LOCALES,
} from "../validators/user-preferences";

const c = initContract();

/**
 * User preferences schemas (shared across contracts)
 */
export const sendModeSchema = zEnum(["enter", "cmd-enter"]);
export type SendMode = zInfer<typeof sendModeSchema>;

export const themePreferenceSchema = zEnum(["light", "dark", "system"]);
export type ThemePreference = zInfer<typeof themePreferenceSchema>;

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
  "halloween",
] as const;
export const colorThemeSchema = zEnum(COLOR_THEMES);
export type ColorTheme = zInfer<typeof colorThemeSchema>;

export const userPreferencesResponseSchema = object({
  timezone: string().nullable(),
  locale: userLocaleSchema.nullable(),
  supportedLocales: array(userLocaleSchema),
  // Pinned agents are exposed as membership only. The API returns a stable
  // canonical order and ignores client-provided order on writes.
  pinnedAgentIds: array(string()),
  sendMode: sendModeSchema,
  cloudBrowserEnabledByDefault: boolean(),
  chatResourcesEnabledByDefault: boolean(),
  theme: themePreferenceSchema.nullable(),
  colorTheme: colorThemeSchema.nullable(),
  captureNetworkBodiesRemaining: number().int().min(0),
  // False until this member's memory storage has a HEAD. The Web App then
  // calls the idempotent initialize route before starting runs; run creation
  // fails for a member without memory.
  memoryInitialized: boolean(),
});

export type UserPreferencesResponse = zInfer<
  typeof userPreferencesResponseSchema
>;

export const USER_PREFERENCES_UNINITIALIZED =
  "USER_PREFERENCES_UNINITIALIZED" as const;

export type InitializedUserPreferencesResponse = Omit<
  UserPreferencesResponse,
  "timezone" | "locale"
> & { readonly timezone: string; readonly locale: UserLocale };

export const updateUserPreferencesRequestSchema = object({
  timezone: string().min(1).optional(),
  locale: userLocaleSchema.optional(),
  // Membership update only; request order is not used for display ordering.
  pinnedAgentIds: array(string()).optional(),
  sendMode: sendModeSchema.optional(),
  cloudBrowserEnabledByDefault: boolean().optional(),
  chatResourcesEnabledByDefault: boolean().optional(),
  theme: themePreferenceSchema.optional(),
  colorTheme: colorThemeSchema.optional(),
  captureNetworkBodiesRemaining: number().int().min(0).optional(),
}).refine(
  (data) => {
    return (
      data.timezone !== undefined ||
      data.locale !== undefined ||
      data.pinnedAgentIds !== undefined ||
      data.sendMode !== undefined ||
      data.cloudBrowserEnabledByDefault !== undefined ||
      data.chatResourcesEnabledByDefault !== undefined ||
      data.theme !== undefined ||
      data.colorTheme !== undefined ||
      data.captureNetworkBodiesRemaining !== undefined
    );
  },
  {
    message: "At least one preference must be provided",
  },
);

export type UpdateUserPreferencesRequest = zInfer<
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
    body: object({
      timezone: string().min(1).optional(),
      locale: userLocaleSchema,
    }),
    responses: {
      200: userPreferencesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Initialize missing timezone, locale and member memory",
  },
  get: {
    method: "GET",
    path: "/api/user-preferences",
    headers: authHeadersSchema,
    responses: {
      200: userPreferencesResponseSchema,
      409: object({
        error: object({
          code: literal(USER_PREFERENCES_UNINITIALIZED),
          message: string(),
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
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update user preferences",
  },
});

export type UserPreferencesContract = typeof userPreferencesContract;
