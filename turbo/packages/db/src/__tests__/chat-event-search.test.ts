import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../index";
import {
  chatEventSearchMessages,
  chatEventSearchMessageWatermarks,
} from "../schema/chat-event-search";
import { chatThreads } from "../schema/chat-thread";

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
      "chat_event_search_messages_user_tsv_gin_idx",
    ]);
    expect(
      config.indexes.find((index) => {
        return (
          index.config.name === "chat_event_search_messages_user_tsv_gin_idx"
        );
      })?.config.with,
    ).toStrictEqual({ fastupdate: false });
    expect(config.foreignKeys).toHaveLength(1);
    const [threadReference] = config.foreignKeys;
    expect(threadReference?.onDelete).toBe("cascade");
    expect(threadReference?.reference().columns).toStrictEqual([
      chatEventSearchMessages.chatThreadId,
    ]);
    expect(threadReference?.reference().foreignTable).toBe(chatThreads);
    expect(threadReference?.reference().foreignColumns).toStrictEqual([
      chatThreads.id,
    ]);
  });

  it("keeps a durable watermark for the owning thread's lifetime", () => {
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
    expect(config.foreignKeys).toHaveLength(1);
    const [threadReference] = config.foreignKeys;
    expect(threadReference?.onDelete).toBe("cascade");
    expect(threadReference?.reference().columns).toStrictEqual([
      chatEventSearchMessageWatermarks.chatThreadId,
    ]);
    expect(threadReference?.reference().foreignTable).toBe(chatThreads);
    expect(threadReference?.reference().foreignColumns).toStrictEqual([
      chatThreads.id,
    ]);
  });
});
