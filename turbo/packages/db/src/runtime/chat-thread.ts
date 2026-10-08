import { pgTable } from "drizzle-orm/pg-core";
import { chatThreadColumns } from "../columns/chat-thread";

/** Application mapping. Shares the physical schema column factory; omits DDL declarations. */
export const chatThreads = pgTable("chat_threads", chatThreadColumns());
