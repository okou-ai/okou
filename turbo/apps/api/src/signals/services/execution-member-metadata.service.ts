import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { computed, type Computed } from "ccstate";
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
export function createExecutionMemberMetadata(
  owner: ExecutionMemberIdentity,
): Computed<Promise<ExecutionMemberMetadata>> {
  return computed(async (get) => {
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
    return {
      profile: profile ? { name: profile.name, email: profile.email } : null,
      preferences: preferences
        ? {
            timezone: preferences.timezone,
            selectedImageModel: preferences.selectedImageModel,
          }
        : null,
    };
  });
}
