import { pgTable } from "drizzle-orm/pg-core";
import { chatThreadColumns } from "../columns/chat-thread";

/** Application mapping. Omits DDL declarations and retired thread provenance. */
export const chatThreads = pgTable("chat_threads", chatThreadColumns());
