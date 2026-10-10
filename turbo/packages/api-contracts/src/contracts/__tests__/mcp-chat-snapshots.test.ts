import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chatThreadEventsContract, chatThreadsContract } from "../chat-threads";
import {
  mcpGetChatMessagesInputSchema,
  mcpGetChatMessagesOutputSchema,
  mcpGetChatThreadInputSchema,
  mcpGetChatThreadOutputSchema,
} from "../mcp-chat-snapshots";

describe("MCP snapshot combination contracts", () => {
  it("directly reuses the Web conversation-list continuation schema", () => {
    expect(mcpGetChatThreadInputSchema).toBe(chatThreadsContract.events.query);
    expect(
      mcpGetChatThreadInputSchema.parse({ sinceSeqId: "12" }),
    ).toStrictEqual({ sinceSeqId: 12 });
    expect(
      mcpGetChatThreadInputSchema.safeParse({ sinceSeqId: 0 }).success,
    ).toBe(false);
  });
  it("allows an initial message pointer request without inventing a cursor", () => {
    expect(
      mcpGetChatMessagesInputSchema.parse({ threadId: randomUUID() }),
    ).toMatchObject({ limit: 50 });
  });
  it.each([
    { sinceSeqId: 0 },
    { sinceSeqId: "0", limit: "1" },
    { sinceSeqId: 1, sinceEventId: randomUUID(), limit: 50 },
    { sinceSeqId: "20", sinceEventId: randomUUID(), limit: "2" },
  ])(
    "retains the Web raw-row continuation and limit semantics: %j",
    (query) => {
      const threadId = randomUUID();
      const parsed = mcpGetChatMessagesInputSchema.parse({
        threadId,
        ...query,
      });
      expect(parsed).toStrictEqual({
        threadId,
        ...chatThreadEventsContract.rows.query.parse(query),
      });
    },
  );
  it.each([
    { sinceSeqId: 1 },
    { sinceSeqId: 0, sinceEventId: randomUUID() },
    { sinceSeqId: -1 },
    { sinceEventId: randomUUID() },
    { sinceSeqId: 1, sinceEventId: "bad" },
    { limit: 0 },
    { limit: 51 },
  ])("rejects an invalid initial/paired cursor or page bound: %j", (query) => {
    expect(
      mcpGetChatMessagesInputSchema.safeParse({
        threadId: randomUUID(),
        ...query,
      }).success,
    ).toBe(false);
  });
  it("combines unchanged Web response schemas rather than projected messages or metadata", () => {
    const snapshot = {
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    };
    const events = { events: [], hasMore: false };
    expect(
      mcpGetChatThreadOutputSchema.parse({ snapshot, ...events }),
    ).toStrictEqual({
      snapshot: chatThreadsContract.snapshot.responses[200].parse(snapshot),
      ...chatThreadsContract.events.responses[200].parse(events),
    });
    const page = {
      rows: [],
      cursor: { lastEventId: null, lastSeqId: 0 },
      hasMore: false,
    };
    expect(
      mcpGetChatMessagesOutputSchema.parse({ snapshot: null, ...page }),
    ).toStrictEqual({
      snapshot: null,
      ...chatThreadEventsContract.rows.responses[200].parse(page),
    });
  });
});
