import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  SharedThreadMessages,
  SharedThreadMessageAttachments,
} from "@okouai/db/jsonb-contracts/shared-thread";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import { chatThreads } from "./chat-thread";

/** Immutable public snapshots created from an explicit chat-event selection. */
export const sharedThreads = pgTable(
  "shared_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    // DB/API rollout: old API writers and existing GA shares omit org_id.
    // Keep nullable until old rollback targets drain and surviving rows can be
    // backfilled; the removal is tracked by #32492.
    orgId: text("org_id"),
    // DB/API rollout: old API writers omit this marker after the migration.
    // Keep the default through their rollback window; tracked by #32492.
    hasArtifactSnapshot: boolean("has_artifact_snapshot")
      .notNull()
      .default(false),
    sourceChatThreadId: uuid("source_chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    messages: jsonb("messages").$type<SharedThreadMessages>().notNull(),
    messageAttachments: jsonb("message_attachments")
      .$type<SharedThreadMessageAttachments>()
      .default({})
      .notNull(),
    publicBrand: text("public_brand")
      .$type<PublicBrand>()
      .default("vm0")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("shared_threads_org_idx").on(table.orgId),
      index("shared_threads_user_created_idx").on(
        table.userId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
      index("shared_threads_source_created_idx").on(
        table.sourceChatThreadId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    ];
  },
);
