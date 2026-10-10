import {
  text,
  boolean,
  integer,
  timestamp,
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

/** Shared by physical DDL and the application member preference mapping. */
export function orgMembersMetadataColumns() {
  return {
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
    captureNetworkBodiesRemaining: integer(
      "capture_network_bodies_remaining",
    ).default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
