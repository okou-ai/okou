import { command, computed, type Computed } from "ccstate";
import {
  chatTranslationLanguageSchema,
  type ChatTranslationLanguage,
  colorThemeSchema,
  type ColorTheme,
  SUPPORTED_USER_LOCALES,
  type SendMode,
  themePreferenceSchema,
  type ThemePreference,
  type UserLocale,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import type {
  UpdateUserModelPreferenceRequest,
  UserModelPreferenceResponse,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { isActiveRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { isVideoModelId } from "@okouai/api-contracts/contracts/video-models";
import {
  modelSettingsSchema,
  withModelReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type {
  SecretResponse,
  SecretType,
} from "@okouai/api-contracts/contracts/secrets";
import type { VariableListResponse } from "@okouai/api-contracts/contracts/variables";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { isValidTimeZone } from "../utils";

interface UserScopedQuery {
  readonly orgId: string;
  readonly userId: string;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => {
    return typeof item === "string";
  });
}

/** Dedupe while keeping caller order — pinned order is user-controlled. */
function normalizePinnedAgentIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function parseSendMode(value: unknown): SendMode {
  return value === "cmd-enter" ? "cmd-enter" : "enter";
}

function parseThemePreference(value: unknown): ThemePreference | null {
  if (value === null) {
    return null;
  }
  return themePreferenceSchema.parse(value);
}

function parseColorTheme(value: unknown): ColorTheme | null {
  if (value === null) {
    return null;
  }
  return colorThemeSchema.parse(value);
}

function parseUserLocale(value: unknown): UserLocale | null {
  if (
    value === null ||
    value === "en-US" ||
    value === "pt-BR" ||
    value === "ja-JP" ||
    value === "ko-KR" ||
    value === "id-ID" ||
    value === "de-DE" ||
    value === "es-ES" ||
    value === "it-IT" ||
    value === "fr-FR" ||
    value === "hi-IN"
  ) {
    return value;
  }
  throw new Error(`Unexpected user locale: ${String(value)}`);
}

function parseChatTranslationLanguage(
  value: unknown,
): ChatTranslationLanguage | null {
  if (value === null) {
    return null;
  }
  return chatTranslationLanguageSchema.parse(value);
}

function parseSecretType(value: string): SecretType {
  if (value === "user" || value === "model-provider" || value === "connector") {
    return value;
  }
  throw new Error(`Unexpected secret type: ${value}`);
}

export function userPreferences({
  orgId,
  userId,
}: UserScopedQuery): Computed<Promise<UserPreferencesResponse>> {
  return computed(async (get): Promise<UserPreferencesResponse> => {
    const db = get(db$);
    const [row] = await db
      .select({
        timezone: orgMembersMetadata.timezone,
        locale: orgMembersMetadata.locale,
        translationLanguage: orgMembersMetadata.translationLanguage,
        pinnedAgentIds: orgMembersMetadata.pinnedAgentIds,
        sendMode: orgMembersMetadata.sendMode,
        cloudBrowserEnabledByDefault:
          orgMembersMetadata.cloudBrowserEnabledByDefault,
        theme: orgMembersMetadata.theme,
        colorTheme: orgMembersMetadata.colorTheme,
        voiceInputModel: orgMembersMetadata.voiceInputModel,
        captureNetworkBodiesRemaining:
          orgMembersMetadata.captureNetworkBodiesRemaining,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        timezone: null,
        locale: null,
        translationLanguage: null,
        supportedLocales: [...SUPPORTED_USER_LOCALES],
        pinnedAgentIds: [],
        sendMode: "enter",
        cloudBrowserEnabledByDefault: true,
        theme: null,
        colorTheme: null,
        voiceInputModel: null,
        captureNetworkBodiesRemaining: 0,
      };
    }

    return {
      timezone: row.timezone,
      locale: parseUserLocale(row.locale),
      translationLanguage: parseChatTranslationLanguage(
        row.translationLanguage,
      ),
      supportedLocales: [...SUPPORTED_USER_LOCALES],
      pinnedAgentIds: normalizePinnedAgentIds(
        toStringArray(row.pinnedAgentIds),
      ),
      sendMode: parseSendMode(row.sendMode),
      cloudBrowserEnabledByDefault: row.cloudBrowserEnabledByDefault,
      theme: parseThemePreference(row.theme),
      colorTheme: parseColorTheme(row.colorTheme),
      voiceInputModel: row.voiceInputModel,
      captureNetworkBodiesRemaining: row.captureNetworkBodiesRemaining ?? 0,
    };
  });
}

export function userModelPreference({
  orgId,
  userId,
}: UserScopedQuery): Computed<Promise<UserModelPreferenceResponse>> {
  return computed(async (get): Promise<UserModelPreferenceResponse> => {
    const db = get(db$);
    const [row] = await db
      .select({
        selectedModel: orgMembersMetadata.selectedModel,
        modelSettings: orgMembersMetadata.modelSettings,
        serviceTier: orgMembersMetadata.serviceTier,
        selectedVideoModel: orgMembersMetadata.selectedVideoModel,
        selectedImageModel: orgMembersMetadata.selectedImageModel,
        updatedAt: orgMembersMetadata.updatedAt,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);

    const selectedModel = isActiveRunModel(row?.selectedModel)
      ? row.selectedModel
      : null;
    const serviceTier: ChatThreadServiceTier | null =
      selectedModel && row?.serviceTier === "priority" ? "priority" : null;
    // A model retired from the catalog reads as unset rather than throwing:
    // the column is not re-validated when the catalog changes.
    const selectedVideoModel = isVideoModelId(row?.selectedVideoModel)
      ? row.selectedVideoModel
      : null;
    const selectedImageModel = isImageModelId(row?.selectedImageModel)
      ? row.selectedImageModel
      : null;
    const modelSettings = modelSettingsSchema.parse(row?.modelSettings ?? {});
    return {
      selectedModel,
      modelSettings,
      serviceTier,
      selectedVideoModel,
      selectedImageModel,
      updatedAt:
        selectedModel ||
        selectedVideoModel ||
        selectedImageModel ||
        Object.keys(modelSettings).length > 0
          ? (row?.updatedAt.toISOString() ?? null)
          : null,
    };
  });
}

interface UpdateUserPreferencesArgs extends UserScopedQuery {
  readonly preferences: UpdateUserPreferencesRequest;
}

type UpdateUserPreferencesResult =
  | { readonly ok: true; readonly data: UserPreferencesResponse }
  | { readonly ok: false; readonly message: string };

type StoredUserPreferences = Omit<
  UserPreferencesResponse,
  "theme" | "colorTheme" | "translationLanguage"
> & {
  readonly theme: ThemePreference | null;
  readonly colorTheme: ColorTheme | null;
  readonly translationLanguage: ChatTranslationLanguage | null;
};

function mergeUserPreferences(
  existing: UserPreferencesResponse,
  preferences: UpdateUserPreferencesRequest,
): StoredUserPreferences {
  return {
    timezone: preferences.timezone ?? existing.timezone,
    locale: preferences.locale ?? existing.locale,
    translationLanguage:
      preferences.translationLanguage ?? existing.translationLanguage ?? null,
    supportedLocales: [...SUPPORTED_USER_LOCALES],
    pinnedAgentIds:
      preferences.pinnedAgentIds === undefined
        ? existing.pinnedAgentIds
        : normalizePinnedAgentIds(preferences.pinnedAgentIds),
    sendMode: preferences.sendMode ?? existing.sendMode,
    cloudBrowserEnabledByDefault:
      preferences.cloudBrowserEnabledByDefault ??
      existing.cloudBrowserEnabledByDefault,
    theme: preferences.theme ?? existing.theme ?? null,
    colorTheme: preferences.colorTheme ?? existing.colorTheme ?? null,
    voiceInputModel:
      preferences.voiceInputModel === undefined
        ? existing.voiceInputModel
        : preferences.voiceInputModel,
    captureNetworkBodiesRemaining:
      preferences.captureNetworkBodiesRemaining ??
      existing.captureNetworkBodiesRemaining,
  };
}

function userPreferenceUpdateColumns(
  preferences: UpdateUserPreferencesRequest,
): Partial<typeof orgMembersMetadata.$inferInsert> {
  return {
    ...(preferences.timezone !== undefined && {
      timezone: preferences.timezone,
    }),
    ...(preferences.locale !== undefined && { locale: preferences.locale }),
    ...(preferences.translationLanguage !== undefined && {
      translationLanguage: preferences.translationLanguage,
    }),
    ...(preferences.pinnedAgentIds !== undefined && {
      pinnedAgentIds: normalizePinnedAgentIds(preferences.pinnedAgentIds),
    }),
    ...(preferences.sendMode !== undefined && {
      sendMode: preferences.sendMode,
    }),
    ...(preferences.cloudBrowserEnabledByDefault !== undefined && {
      cloudBrowserEnabledByDefault: preferences.cloudBrowserEnabledByDefault,
    }),
    ...(preferences.theme !== undefined && { theme: preferences.theme }),
    ...(preferences.colorTheme !== undefined && {
      colorTheme: preferences.colorTheme,
    }),
    ...(preferences.voiceInputModel !== undefined && {
      voiceInputModel: preferences.voiceInputModel,
    }),
    ...(preferences.captureNetworkBodiesRemaining !== undefined && {
      captureNetworkBodiesRemaining: preferences.captureNetworkBodiesRemaining,
    }),
  };
}

export const updateUserPreferences$ = command(
  async (
    { get, set },
    args: UpdateUserPreferencesArgs,
    signal: AbortSignal,
  ): Promise<UpdateUserPreferencesResult> => {
    const preferences = args.preferences;
    if (
      preferences.timezone !== undefined &&
      !isValidTimeZone(preferences.timezone)
    ) {
      return {
        ok: false,
        message: "Invalid request",
      };
    }

    const existing = await get(
      userPreferences({ orgId: args.orgId, userId: args.userId }),
    );
    signal.throwIfAborted();

    const merged = mergeUserPreferences(existing, preferences);

    const updatedAt = nowDate();
    const writeDb = set(writeDb$);
    await writeDb
      .insert(orgMembersMetadata)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        timezone: merged.timezone,
        locale: merged.locale,
        translationLanguage: merged.translationLanguage,
        pinnedAgentIds: merged.pinnedAgentIds,
        sendMode: merged.sendMode,
        cloudBrowserEnabledByDefault: merged.cloudBrowserEnabledByDefault,
        theme: merged.theme,
        colorTheme: merged.colorTheme,
        voiceInputModel: merged.voiceInputModel,
        captureNetworkBodiesRemaining: merged.captureNetworkBodiesRemaining,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: {
          ...userPreferenceUpdateColumns(preferences),
          updatedAt,
        },
      });
    signal.throwIfAborted();

    return {
      ok: true,
      data: merged,
    };
  },
);

/**
 * Columns the request writes. Each preference maps to its own columns, so one
 * being cleared can never blank another that the same request also set.
 */
function userModelPreferenceColumns(
  preference: UpdateUserModelPreferenceRequest,
): Partial<typeof orgMembersMetadata.$inferInsert> {
  return {
    // A null run model clears its tier too: the tier only qualifies a model.
    ...(preference.selectedModel === null
      ? { selectedModel: null, serviceTier: null }
      : {
          selectedModel: preference.selectedModel,
          serviceTier: preference.serviceTier,
        }),
    ...(preference.modelSettingsPatch === undefined
      ? {}
      : {
          modelSettings: withModelReasoningEffort(
            {},
            preference.modelSettingsPatch,
          ),
        }),
    // Absent means "leave it alone", so an older bundle that knows only the run
    // model keeps its stored media defaults. Null clears one explicitly.
    ...("selectedVideoModel" in preference
      ? { selectedVideoModel: preference.selectedVideoModel ?? null }
      : {}),
    ...("selectedImageModel" in preference
      ? { selectedImageModel: preference.selectedImageModel ?? null }
      : {}),
  };
}

export const updateUserModelPreference$ = command(
  async (
    { get, set },
    args: UserScopedQuery & {
      readonly preference: UpdateUserModelPreferenceRequest;
    },
    signal: AbortSignal,
  ): Promise<UserModelPreferenceResponse> => {
    const writeDb = set(writeDb$);
    const updatedAt = nowDate();
    const columns = userModelPreferenceColumns(args.preference);
    const modelSettingsPatch = args.preference.modelSettingsPatch;
    await writeDb
      .insert(orgMembersMetadata)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        ...columns,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: {
          ...columns,
          ...(modelSettingsPatch === undefined
            ? {}
            : {
                modelSettings: sql`${orgMembersMetadata.modelSettings} || jsonb_build_object(
                  cast(${modelSettingsPatch.model} as text),
                  COALESCE(${orgMembersMetadata.modelSettings} -> cast(${modelSettingsPatch.model} as text), '{}'::jsonb)
                    || jsonb_build_object('effort', cast(${modelSettingsPatch.effort} as text))
                )`,
              }),
          updatedAt,
        },
      });
    signal.throwIfAborted();

    return get(userModelPreference({ orgId: args.orgId, userId: args.userId }));
  },
);

export function userVariables({
  orgId,
  userId,
}: UserScopedQuery): Computed<Promise<VariableListResponse>> {
  return computed(async (get): Promise<VariableListResponse> => {
    const db = get(db$);
    const rows = await db
      .select({
        id: variables.id,
        name: variables.name,
        value: variables.value,
        description: variables.description,
        createdAt: variables.createdAt,
        updatedAt: variables.updatedAt,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, orgId),
          eq(variables.userId, userId),
          eq(variables.type, "user"),
        ),
      )
      .orderBy(variables.name);

    return {
      variables: rows.map((row) => {
        return {
          id: row.id,
          name: row.name,
          value: row.value,
          description: row.description,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    };
  });
}

export function userSecrets({ orgId, userId }: UserScopedQuery): Computed<
  Promise<{
    readonly secrets: SecretResponse[];
    readonly connectorOwnerBySecretId: ReadonlyMap<string, string | null>;
  }>
> {
  return computed(async (get) => {
    const db = get(db$);
    const rows = await db
      .select({
        id: secrets.id,
        name: secrets.name,
        description: secrets.description,
        connectorId: secrets.connectorId,
        type: secrets.type,
        createdAt: secrets.createdAt,
        updatedAt: secrets.updatedAt,
      })
      .from(secrets)
      .where(and(eq(secrets.orgId, orgId), eq(secrets.userId, userId)))
      .orderBy(secrets.name);

    return {
      connectorOwnerBySecretId: new Map(
        rows.map((row) => {
          return [row.id, row.connectorId] as const;
        }),
      ),
      secrets: rows.map((row) => {
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          type: parseSecretType(row.type),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    };
  });
}
