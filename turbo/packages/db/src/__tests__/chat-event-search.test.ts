import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../index";
import {
  chatEventSearchMessages,
  chatEventSearchMessageWatermarks,
} from "../schema/chat-event-search";

describe("chat event search projection schema", () => {
  it("uses thread sequence identity for durable searchable messages", () => {
    const config = getTableConfig(chatEventSearchMessages);

    expect(schema.chatEventSearchMessages).toBe(chatEventSearchMessages);
    expect(
      config.columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual([
      "chat_thread_id",
      "seq_id",
      "run_id",
      "user_id",
      "org_id",
      "agent_id",
      "role",
      "created_at",
      "text",
      "text_bigram",
      "tsv",
    ]);
    expect(config.primaryKeys).toHaveLength(1);
    expect(
      config.primaryKeys[0]?.columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["chat_thread_id", "seq_id"]);
    expect(chatEventSearchMessages.runId.notNull).toBeFalsy();
    expect(
      config.indexes.map((index) => {
        return index.config.name;
      }),
    ).toStrictEqual([
      "chat_event_search_messages_user_org_created_idx",
      "chat_event_search_messages_user_org_agent_id_created_idx",
      "chat_event_search_messages_user_tsv_gin_idx",
    ]);
    expect(config.foreignKeys).toStrictEqual([]);
  });

  it("keeps an independent per-thread durable watermark", () => {
    const config = getTableConfig(chatEventSearchMessageWatermarks);

    expect(schema.chatEventSearchMessageWatermarks).toBe(
      chatEventSearchMessageWatermarks,
    );
    expect(
      config.columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["chat_thread_id", "indexed_seq_id"]);
    expect(chatEventSearchMessageWatermarks.chatThreadId.primary).toBeTruthy();
    expect(config.foreignKeys).toStrictEqual([]);
  });
});
