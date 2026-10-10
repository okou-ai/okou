import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  primaryKey,
  jsonb,
  varchar,
} from "drizzle-orm/pg-core";
import type { OrgMembersPinnedAgentIds } from "@okouai/db/jsonb-contracts/org-members-metadata";
import type { ModelSettings } from "@okouai/db/jsonb-contracts/chat-model-settings";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type {
  ColorTheme,
  ThemePreference,
} from "@okouai/api-contracts/contracts/user-preferences";

/**
 * org_members_metadata — source of truth for per-member preferences.
 * Replaces Clerk membership publicMetadata for preference storage.
 */
export const orgMembersMetadata = pgTable(
  "org_members_metadata",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    timezone: text("timezone"),
    locale: text("locale"),
    // Retired chat preference; keep the physical column and schema in sync
    // until API versions that select it have drained before a later migration.
    translationLanguage: text("translation_language"),
    onboardingRole: text("onboarding_role"),
    pinnedAgentIds: jsonb("pinned_agent_ids")
      .$type<OrgMembersPinnedAgentIds>()
      .default([]),
    sendMode: text("send_mode").notNull().default("enter"),
    cloudBrowserEnabledByDefault: boolean("cloud_browser_enabled_by_default")
      .notNull()
      .default(true),
    theme: text("theme").$type<ThemePreference>(),
    colorTheme: text("color_theme").$type<ColorTheme>(),
    selectedModel: varchar("selected_model", { length: 255 })
      .default("auto")
      .notNull(),
    /** Sparse defaults keyed by run model. */
    modelSettings: jsonb("model_settings")
      .$type<ModelSettings>()
      .default({})
      .notNull(),
    serviceTier: varchar("service_tier", {
      length: 32,
    }).$type<ChatThreadServiceTier>(),
    /** Member setting for built-in image generation; null uses the default. */
    selectedImageModel: varchar("selected_image_model", { length: 255 }),
    onboardingDone: boolean("onboarding_done").notNull().default(false),
    /**
     * When this member finished the source-first onboarding in this org.
     *
     * Only a non-admin member's own completion writes it; an admin's completion
     * stays organization-wide in `org_metadata.onboarding_complete`. Null means
     * this member has not finished it, not that they must: members who already
     * use the workspace are never sent through onboarding.
     */
    onboardingCompletedAt: timestamp("onboarding_completed_at"),
    /**
     * When Morning Brief collection ownership was revoked for this member.
     *
     * The first transaction every membership, user and organization cleanup
     * commits stamps this column on the member rows it revokes, so the decision
     * survives that COMMIT instead of living only in a lock. Claiming and
     * finalizing read it under the same member-row lock they already take,
     * which is what stops an admission resolved against a stale external
     * membership answer from inserting an occurrence afterwards — including
     * when revocation found no occurrence to delete. Only the row's own
     * deletion clears it, so a rejoining member starts from a fresh row.
     */
    morningBriefCollectionRevokedAt: timestamp(
      "morning_brief_collection_revoked_at",
    ),
    captureNetworkBodiesRemaining: integer(
      "capture_network_bodies_remaining",
    ).default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId] }),
      check(
        "org_members_metadata_canonical_selection_check",
        sql`${table.selectedModel} NOT IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') AND ${table.selectedModel} NOT LIKE '@preset/%'`,
      ),
      check(
        "org_members_metadata_selected_model_check",
        sql`char_length(${table.selectedModel}) > 0`,
      ),
      check(
        "org_members_metadata_explicit_model_settings_check",
        sql`jsonb_typeof(${table.modelSettings}) = 'object' AND NOT jsonb_path_exists(${table.modelSettings}, '$.keyvalue() ? (@.key == "auto" || @.key == "okou-1.0" || @.key == "okou-1.0-pro" || @.key == "okou-1.0-max" || @.key starts with "@preset/")')`,
      ),
      check(
        "chk_org_members_metadata_service_tier",
        sql`${table.serviceTier} IS NULL OR ${table.serviceTier} = 'priority'`,
      ),
    ];
  },
);
