import { pgTable } from "drizzle-orm/pg-core";
import { chatThreadColumns } from "../columns/chat-thread";

/** Application mapping. Omits physical DDL declarations. */
export const chatThreads = pgTable("chat_threads", chatThreadColumns());
