import { pgTable } from "drizzle-orm/pg-core";
import { chatThreadColumns } from "../columns/chat-thread";

/** Excludes the legacy allocator from implicit INSERT/SELECT/RETURNING lists. */
export const chatThreads = pgTable("chat_threads", chatThreadColumns());
