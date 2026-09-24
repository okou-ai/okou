import {
  index,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import { chatThreads } from "./chat-thread";

export const chatGithubContext = pgTable(
  "chat_github_context",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    repo: text("repo").notNull(),
    subjectNumber: integer("subject_number").notNull(),
    subjectKind: text("subject_kind")
      .$type<"issue" | "pull_request">()
      .notNull(),
    triggerCommentId: text("trigger_comment_id"),
    /**
     * Server-private GitHub launch material retained with the trigger context.
     * Raw third-party content is intentionally retained permanently; read paths
     * must continue to project only the explicitly required columns.
     */
    issueContext: text("issue_context"),
    messageText: text("message_text"),
    triggerReactionId: text("trigger_reaction_id"),
    triggerCommentBody: text("trigger_comment_body"),
    publicBrand: text("public_brand")
      .$type<PublicBrand>()
      .default("vm0")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("chat_github_context_thread_idx").on(table.chatThreadId),
      check(
        "chat_github_context_subject_kind_check",
        sql`${table.subjectKind} IN ('issue', 'pull_request')`,
      ),
    ];
  },
);
