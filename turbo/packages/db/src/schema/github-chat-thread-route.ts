import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { githubInstallations } from "./github-installation";

/**
 * Stable mapping from one linked GitHub user's view of an issue or pull
 * request to the canonical Okou chat thread that owns its queue and session.
 */
export const githubChatThreadRoutes = pgTable(
  "github_chat_thread_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(
        () => {
          return githubInstallations.id;
        },
        { onDelete: "cascade" },
      ),
    repo: varchar("repo", { length: 255 }).notNull(),
    subjectKind: varchar("subject_kind", { length: 32 }).$type<
      "issue" | "pull_request"
    >(),
    subjectNumber: integer("subject_number").notNull(),
    userId: text("user_id").notNull(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    lastCommentId: varchar("last_comment_id", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_github_chat_thread_routes_thread").on(table.chatThreadId),
      uniqueIndex("idx_github_chat_thread_routes_install_repo_subject_user").on(
        table.installationId,
        table.repo,
        table.subjectNumber,
        table.userId,
      ),
    ];
  },
);
