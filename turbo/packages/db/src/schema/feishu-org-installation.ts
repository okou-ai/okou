import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agents } from "./agent";
import { orgCustomConnectors } from "./org-custom-connector";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import type { FeishuPlatform } from "@okouai/api-contracts/contracts/feishu-platform";

export const feishuOrgInstallations = pgTable(
  "feishu_org_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    customConnectorId: uuid("custom_connector_id"),
    ownerUserId: text("owner_user_id"),
    platform: text("platform")
      .$type<FeishuPlatform>()
      .default("feishu")
      .notNull(),
    appId: varchar("app_id", { length: 255 }).notNull(),
    botOpenId: varchar("bot_open_id", { length: 255 }),
    botName: varchar("bot_name", { length: 255 }),
    botAvatarUrl: text("bot_avatar_url"),
    publicBrand: text("public_brand")
      .$type<PublicBrand>()
      .default("vm0")
      .notNull(),
    encryptedAppSecret: text("encrypted_app_secret").notNull(),
    encryptedVerificationToken: text("encrypted_verification_token").notNull(),
    encryptedEncryptKey: text("encrypted_encrypt_key").notNull(),
    defaultAgentId: uuid("default_agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "cascade" },
    ),
    feishuTenantKey: varchar("feishu_tenant_key", { length: 255 }),
    feishuTenantName: varchar("feishu_tenant_name", { length: 255 }),
    encryptedTenantAccessToken: text("encrypted_tenant_access_token"),
    tenantAccessTokenExpiresAt: timestamp("tenant_access_token_expires_at"),
    callbackVerifiedAt: timestamp("callback_verified_at"),
    setupCompletedAt: timestamp("setup_completed_at"),
    messageReceivedAt: timestamp("message_received_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_feishu_org_installations_org").on(table.orgId),
      uniqueIndex("idx_feishu_org_installations_custom_connector").on(
        table.customConnectorId,
      ),
      uniqueIndex("idx_feishu_org_installations_app").on(table.appId),
      index("idx_feishu_org_installations_tenant").on(table.feishuTenantKey),
      foreignKey({
        name: "fk_feishu_org_installations_custom_connector",
        columns: [table.customConnectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("restrict"),
    ];
  },
);
