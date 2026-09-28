import { text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { FeishuPlatform } from "@okouai/api-contracts/contracts/feishu-platform";

/** Active installation fields shared by physical and runtime mappings. */
export function feishuOrgInstallationColumns() {
  return {
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
    encryptedAppSecret: text("encrypted_app_secret").notNull(),
    encryptedVerificationToken: text("encrypted_verification_token").notNull(),
    encryptedEncryptKey: text("encrypted_encrypt_key").notNull(),
    feishuTenantKey: varchar("feishu_tenant_key", { length: 255 }),
    feishuTenantName: varchar("feishu_tenant_name", { length: 255 }),
    encryptedTenantAccessToken: text("encrypted_tenant_access_token"),
    tenantAccessTokenExpiresAt: timestamp("tenant_access_token_expires_at"),
    callbackVerifiedAt: timestamp("callback_verified_at"),
    setupCompletedAt: timestamp("setup_completed_at"),
    messageReceivedAt: timestamp("message_received_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
