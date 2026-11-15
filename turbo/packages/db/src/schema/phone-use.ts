import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PhoneUseObject } from "../jsonb-contracts/phone-use";
import { chatThreads } from "./chat-thread";
export const phoneUseDevices = pgTable(
  "phone_use_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    sessionId: text("session_id").notNull(),
    generation: integer("generation").notNull().default(1),
    displayName: text("display_name").notNull(),
    osVersion: text("os_version").notNull(),
    appVersion: text("app_version").notNull(),
    ready: boolean("ready").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      uniqueIndex("phone_use_device_installation").on(
        table.orgId,
        table.userId,
        table.installationId,
      ),
    ];
  },
);
export const phoneUseGrants = pgTable(
  "phone_use_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    deviceId: uuid("device_id")
      .notNull()
      .references(
        () => {
          return phoneUseDevices.id;
        },
        { onDelete: "cascade" },
      ),
    deviceGeneration: integer("device_generation").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      uniqueIndex("phone_use_grant_chat_owner").on(
        table.orgId,
        table.userId,
        table.threadId,
      ),
    ];
  },
);
export const phoneUseOperations = pgTable(
  "phone_use_operations",
  {
    id: uuid("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: uuid("run_id").notNull(),
    grantId: uuid("grant_id").notNull(),
    deviceId: uuid("device_id")
      .notNull()
      .references(
        () => {
          return phoneUseDevices.id;
        },
        { onDelete: "cascade" },
      ),
    action: jsonb("action").$type<PhoneUseObject>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull().default("queued"),
    claimedGeneration: integer("claimed_generation"),
    result: jsonb("result").$type<PhoneUseObject>(),
    error: text("error"),
    screenshotKey: text("screenshot_key"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      index("phone_use_operations_device_status").on(
        table.deviceId,
        table.status,
      ),
      uniqueIndex("phone_use_running_operation")
        .on(table.deviceId)
        .where(sql`status = 'running'`),
    ];
  },
);
