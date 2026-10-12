import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { db$ } from "../external/db";

export interface ExecutionMemberIdentity {
  readonly orgId: string;
  readonly userId: string;
}

export interface ExecutionUserProfile {
  readonly name: string | null;
  readonly email: string | null;
}

export interface ExecutionMemberPreferences {
  readonly timezone: string | null;
  readonly selectedImageModel: string | null;
  readonly selectedModel: string | null;
  readonly serviceTier: string | null;
  readonly modelSettings: ModelSettings;
  readonly cloudBrowserEnabledByDefault: boolean;
}

export interface ExecutionMemberMetadata {
  readonly profile: ExecutionUserProfile | null;
  readonly preferences: ExecutionMemberPreferences | null;
}

const kindDecoder = zodEnumDriverValueDecoder(
  z.enum(["profile", "preferences"]),
);
const nullableTextDecoder = nullableDriverValueDecoder(pgTextDecoder);

/** Read both independently optional records in one round trip. */
export const readExecutionMemberMetadata$ = command(
  async (
    { get },
    owner: ExecutionMemberIdentity,
  ): Promise<ExecutionMemberMetadata> => {
    const db = get(db$);
    const profileQuery = db
      .select({
        kind: sql`'profile'`.mapWith(kindDecoder).as("kind"),
        name: userCache.name,
        email: sql`${userCache.email}`.mapWith(nullableTextDecoder).as("email"),
        timezone: sql`NULL::text`.mapWith(nullableTextDecoder).as("timezone"),
        selectedImageModel: sql`NULL::text`
          .mapWith(nullableTextDecoder)
          .as("selected_image_model"),
        selectedModel: sql`NULL::text`
          .mapWith(nullableTextDecoder)
          .as("selected_model"),
        serviceTier: sql`NULL::text`
          .mapWith(nullableTextDecoder)
          .as("service_tier"),
        modelSettings: sql`NULL::jsonb`
          .mapWith(nullableDriverValueDecoder(orgMembersMetadata.modelSettings))
          .as("model_settings"),
        cloudBrowserEnabledByDefault: sql`NULL::boolean`
          .mapWith(
            nullableDriverValueDecoder(
              orgMembersMetadata.cloudBrowserEnabledByDefault,
            ),
          )
          .as("cloud_browser_enabled_by_default"),
      })
      .from(userCache)
      .where(eq(userCache.userId, owner.userId));
    const rows = await profileQuery.unionAll(
      db
        .select({
          kind: sql`'preferences'`.mapWith(kindDecoder).as("kind"),
          name: sql`NULL::text`.mapWith(nullableTextDecoder).as("name"),
          email: sql`NULL::text`.mapWith(nullableTextDecoder).as("email"),
          timezone: orgMembersMetadata.timezone,
          selectedImageModel: orgMembersMetadata.selectedImageModel,
          selectedModel: orgMembersMetadata.selectedModel,
          serviceTier: orgMembersMetadata.serviceTier,
          modelSettings: orgMembersMetadata.modelSettings,
          cloudBrowserEnabledByDefault:
            orgMembersMetadata.cloudBrowserEnabledByDefault,
        })
        .from(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.orgId, owner.orgId),
            eq(orgMembersMetadata.userId, owner.userId),
          ),
        ),
    );
    const profile = rows.find((row) => {
      return row.kind === "profile";
    });
    const preferences = rows.find((row) => {
      return row.kind === "preferences";
    });
    let capturedPreferences: ExecutionMemberPreferences | null = null;
    if (preferences) {
      const { modelSettings, cloudBrowserEnabledByDefault } = preferences;
      if (modelSettings === null || cloudBrowserEnabledByDefault === null) {
        throw new Error("Required execution member preferences are missing");
      }
      capturedPreferences = {
        timezone: preferences.timezone,
        selectedImageModel: preferences.selectedImageModel,
        selectedModel: preferences.selectedModel,
        serviceTier: preferences.serviceTier,
        modelSettings,
        cloudBrowserEnabledByDefault,
      };
    }
    return {
      profile: profile ? { name: profile.name, email: profile.email } : null,
      preferences: capturedPreferences,
    };
  },
);
