import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type { OrgMembersPinnedAgentIds } from "@okouai/db/jsonb-contracts/org-members-metadata";
import type { ModelSettings } from "@okouai/db/jsonb-contracts/chat-model-settings";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type {
  ColorTheme,
  ThemePreference,
} from "@okouai/api-contracts/contracts/user-preferences";

/** Per-member preferences and their database constraints. */
export const orgMembersMetadata = pgTable(
  "org_members_metadata",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    timezone: text("timezone"),
    /** User intent; execution availability never overwrites this preference. */
    proactiveSuggestionsEnabled: boolean("proactive_suggestions_enabled"),
    // Shared opt-in for Planning and action; keep its physical column.
    proactiveJobsEnabled: boolean("proactive_action_enabled"),
    proactiveLearningEnabled: boolean("proactive_learning_enabled"),
    // Retired preference; keep the column until outgoing APIs have drained.
    proactivePlanningEnabled: boolean("proactive_planning_enabled"),
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
    chatResourcesEnabledByDefault: boolean("chat_resources_enabled_by_default")
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
