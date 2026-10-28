import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  MailDraftStatus,
  MailProvider,
} from "@okouai/api-contracts/contracts/mail";
import { chatThreads } from "./chat-thread";
import { connectors } from "./connector";

export const mailDrafts = pgTable(
  "mail_drafts",
  {
    id: uuid("id").primaryKey(),
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "cascade" },
    ),
    connectorId: uuid("connector_id").references(
      () => {
        return connectors.id;
      },
      { onDelete: "set null" },
    ),
    provider: text("provider").$type<MailProvider>().default("gmail").notNull(),
    outlookMessageId: text("outlook_message_id"),
    outlookConversationId: text("outlook_conversation_id"),
    outlookWebLink: text("outlook_web_link"),
    gmailDraftId: text("gmail_draft_id"),
    gmailThreadId: text("gmail_thread_id"),
    gmailMessageId: text("gmail_message_id"),
    sentGmailMessageId: text("sent_gmail_message_id"),
    status: text("status").$type<MailDraftStatus>(),
    senderName: text("sender_name"),
    senderAddress: text("sender_address"),
    subject: text("subject"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    sentAt: timestamp("sent_at"),
  },
  (table) => {
    return [
      uniqueIndex("mail_drafts_connector_outlook_message_unique").on(
        table.connectorId,
        table.outlookMessageId,
      ),
      index("idx_mail_drafts_chat_thread").on(table.chatThreadId),
      uniqueIndex("mail_drafts_connector_gmail_draft_unique").on(
        table.connectorId,
        table.gmailDraftId,
      ),
    ];
  },
);
