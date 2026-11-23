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
  colorThemeSchema,
  type UserLocale,
  userLocaleSchema,
} from "../validators/user-preferences";
export {
  COLOR_THEMES,
  colorThemeSchema,
  type ColorTheme,
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

export const userPreferencesResponseSchema = object({
  timezone: string().nullable(),
  locale: userLocaleSchema.nullable(),
  supportedLocales: array(userLocaleSchema),
  sendMode: sendModeSchema,
  cloudBrowserEnabledByDefault: boolean(),
  // Retired: always false. The web client floor excludes the Apps that read
  // it, but installed iOS and Android readers still decode this response.
  chatResourcesEnabledByDefault: boolean(),
  theme: themePreferenceSchema.nullable(),
  colorTheme: colorThemeSchema.nullable(),
  forYouCoverId: string().min(1).max(64).nullable(),
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
  sendMode: sendModeSchema.optional(),
  cloudBrowserEnabledByDefault: boolean().optional(),
  theme: themePreferenceSchema.optional(),
  colorTheme: colorThemeSchema.optional(),
  forYouCoverId: string().min(1).max(64).nullable().optional(),
  captureNetworkBodiesRemaining: number().int().min(0).optional(),
}).refine(
  (data) => {
    return (
      data.timezone !== undefined ||
      data.locale !== undefined ||
      data.sendMode !== undefined ||
      data.cloudBrowserEnabledByDefault !== undefined ||
      data.theme !== undefined ||
      data.colorTheme !== undefined ||
      data.forYouCoverId !== undefined ||
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
