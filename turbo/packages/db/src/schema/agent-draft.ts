import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  AgentDraftAttachments,
  AgentDraftUserMessage,
} from "@okouai/db/jsonb-contracts/agent-draft";

export const agentDrafts = pgTable(
  "agent_drafts",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    /** Canonical rich document for the agent composer's saved draft. */
    draftUserMessage:
      jsonb("draft_user_message").$type<AgentDraftUserMessage>(),
    draftAttachments: jsonb("draft_attachments").$type<AgentDraftAttachments>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      userOrgIdx: uniqueIndex("idx_agent_drafts_user_org").on(
        table.userId,
        table.orgId,
      ),
      draftUserMessageCheck: check(
        "agent_drafts_draft_user_message_check",
        sql`${table.draftUserMessage} IS NOT NULL
          OR COALESCE(${table.draftAttachments}, '[]'::jsonb) = '[]'::jsonb`,
      ),
    };
  },
);
