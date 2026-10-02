import { randomUUID } from "node:crypto";
import { mcpSearchChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-search";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { now, withMockNowForTest } from "../../../lib/time";
import { setChatSearchEventTimestampPrecisionFixture } from "../../../test-fixtures/chat-event-search";
import { createMcpServerTestApi } from "./helpers/mcp-server";
import { createMcpServerFixtures } from "./helpers/mcp-server-fixtures";
import { chatEventDisplayText } from "./helpers/chat-event";

const context = testContext();
const { fixture, callTool, structuredToolError, getMessages, searchMessages } =
  createMcpServerTestApi(context);
const { projectSearchMessages, messageFixture, assistantMessagesFixture } =
  createMcpServerFixtures(context);

describe("MCP message search", () => {
  it("pages beyond 25 matches without losing or repeating canonical references", async () => {
    const query = "mcpsearchpaging";
    const f = await assistantMessagesFixture(
      "Search the assistant output",
      Array.from({ length: 29 }, (_, index) => {
        return `${query} ${index}`;
      }),
    );
    const token = f.auth.token();
    await projectSearchMessages([f.threadId]);
    const canonical = await f.chat.listThreadEvents(f.actor, f.threadId);
    const source = canonical.events
      .filter((event) => {
        return event.eventType === "output.message";
      })
      .map((event) => {
        return {
          ref: { threadId: f.threadId, eventId: event.id, seqId: event.seqId },
          createdAt: event.createdAt,
        };
      });
    source.sort((left, right) => {
      return (
        right.createdAt.localeCompare(left.createdAt) ||
        right.ref.seqId - left.ref.seqId
      );
    });
    const args = { query, limit: 7 };
    let page = await searchMessages(token, args);
    expect(page.matches).toHaveLength(7);
    expect(page.scanLimited).toBeFalsy();
    const matches = [...page.matches];
    while (page.nextCursor !== null) {
      expect(matches.length).toBeLessThan(29);
      const result = await callTool(token, "search_chat_messages", {
        ...args,
        cursor: page.nextCursor,
      });
      expect(result.isError).not.toBeTruthy();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        512 * 1024,
      );
      page = mcpSearchChatMessagesOutputSchema.parse(result.structuredContent);
      expect(page.scanLimited).toBeFalsy();
      matches.push(...page.matches);
    }
    expect(
      matches.map(({ ref, sourceEventAt }) => {
        return { ref, createdAt: new Date(sourceEventAt).toISOString() };
      }),
    ).toStrictEqual(source);
    expect(matches).toHaveLength(29);
    expect(
      new Set(
        matches.map(({ ref }) => {
          return ref.eventId;
        }),
      ).size,
    ).toBe(29);
  });

  it("resolves rejected search references across threads without changing their state", async () => {
    const f = await messageFixture();
    const query = "mcpsearchreferences";
    const first = await withMockNowForTest(now(), async () => {
      const sent = await f.send(`${query} 0`);
      for (let index = 1; index < 3; index++) {
        await f.send(`${query} ${index}`, sent.threadId);
      }
      const second = await f.send(`${query} another thread`);
      return {
        threadId: sent.threadId,
        threadIds: [sent.threadId, second.threadId],
      };
    });
    await f.chat.renameThread(f.actor, first.threadId, "Current search title");
    const token = f.auth.token();
    expect((await searchMessages(token, { query })).matches).toStrictEqual([]);
    await projectSearchMessages(first.threadIds);
    const before = await Promise.all(
      first.threadIds.map(async (threadId) => {
        return await f.chat.readThread(f.actor, threadId);
      }),
    );
    const source = (
      await Promise.all(
        first.threadIds.map(async (threadId) => {
          const history = await f.chat.listThreadEvents(f.actor, threadId);
          return history.events
            .filter((event) => {
              return event.eventType === "input.rejected";
            })
            .map((event) => {
              return {
                ref: { threadId, eventId: event.id, seqId: event.seqId },
                createdAt: event.createdAt,
              };
            });
        }),
      )
    ).flat();
    source.sort((left, right) => {
      return (
        right.createdAt.localeCompare(left.createdAt) ||
        right.ref.threadId.localeCompare(left.ref.threadId) ||
        right.ref.seqId - left.ref.seqId
      );
    });
    const args = { query, limit: 2 };
    let page = await searchMessages(token, args);
    expect(page.matches).toHaveLength(2);
    expect(page.scanLimited).toBeFalsy();
    const matches = [...page.matches];
    while (page.nextCursor !== null) {
      expect(matches.length).toBeLessThan(4);
      const result = await callTool(token, "search_chat_messages", {
        ...args,
        cursor: page.nextCursor,
      });
      expect(result.isError).not.toBeTruthy();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        512 * 1024,
      );
      page = mcpSearchChatMessagesOutputSchema.parse(result.structuredContent);
      expect(page.scanLimited).toBeFalsy();
      matches.push(...page.matches);
    }
    expect(
      matches.map(({ ref, sourceEventAt }) => {
        return { ref, createdAt: new Date(sourceEventAt).toISOString() };
      }),
    ).toStrictEqual(source);
    expect(matches).toHaveLength(4);
    expect(
      new Set(
        matches.map(({ ref }) => {
          return ref.eventId;
        }),
      ).size,
    ).toBe(4);
    for (const match of matches) {
      expect(match.agent.agentId).toBe(f.agent.agentId);
      expect(match.excerpt).toMatchObject({
        offset: 0,
        hasBefore: false,
        hasAfter: false,
      });
      expect(new URL(match.url).pathname).toBe(`/chats/${match.ref.threadId}`);
    }
    const hit = matches.find(({ ref }) => {
      return ref.threadId === first.threadIds[0];
    });
    if (!hit) {
      throw new Error("Expected a hit in the renamed thread");
    }
    expect(hit.threadTitle).toBe("Current search title");
    expect(hit.titleTruncated).toBeFalsy();
    const around = await getMessages(token, {
      threadId: hit.ref.threadId,
      around: { eventId: hit.ref.eventId, seqId: hit.ref.seqId },
      limit: 1,
    });
    expect(around.messages).toMatchObject([
      { ref: hit.ref, text: hit.excerpt.text },
    ]);
    await expect(
      Promise.all(
        first.threadIds.map(async (threadId) => {
          return await f.chat.readThread(f.actor, threadId);
        }),
      ),
    ).resolves.toStrictEqual(before);
  });

  it("preserves stored microseconds and sequence ties in cursors and date bounds", async () => {
    const f = await messageFixture();
    const sent = await f.send("precisionneedle oldest");
    for (const suffix of ["newest", "first tie", "second tie"]) {
      await f.send(`precisionneedle ${suffix}`, sent.threadId);
    }
    await projectSearchMessages([sent.threadId]);
    const token = f.auth.token();
    const source = await getMessages(token, { threadId: sent.threadId });
    const timestamps = [
      "2026-09-18T01:02:03.456001Z",
      "2026-09-18T01:02:03.456003Z",
      "2026-09-18T01:02:03.456002Z",
      "2026-09-18T01:02:03.456002Z",
    ];
    const expected: {
      ref: (typeof source.messages)[number]["ref"];
      sourceEventAt: string;
    }[] = [];
    for (const [index, message] of source.messages.entries()) {
      const createdAt = timestamps[index];
      if (!createdAt) {
        throw new Error(
          "Expected one timestamp for each precision fixture event",
        );
      }
      // Infrastructure exception: product writes cannot choose exact stored
      // sub-millisecond times. Model already-indexed historical SQL timestamps
      // without relying on the current projector's Date normalization.
      await setChatSearchEventTimestampPrecisionFixture({
        eventId: message.ref.eventId,
        createdAt,
      });
      expected.push({ ref: message.ref, sourceEventAt: createdAt });
    }
    expected.sort((left, right) => {
      return (
        right.sourceEventAt.localeCompare(left.sourceEventAt) ||
        right.ref.seqId - left.ref.seqId
      );
    });
    const args = { query: "precisionneedle", limit: 1 };
    let page = await searchMessages(token, args);
    const actual = [...page.matches];
    while (page.nextCursor !== null) {
      expect(actual.length).toBeLessThan(4);
      page = await searchMessages(token, { ...args, cursor: page.nextCursor });
      actual.push(...page.matches);
    }
    expect(
      actual.map(({ ref, sourceEventAt }) => {
        return { ref, sourceEventAt };
      }),
    ).toStrictEqual(expected);
    const bounded = await searchMessages(token, {
      query: "precisionneedle",
      since: "2026-09-18T01:02:03.456002Z",
      before: "2026-09-18T01:02:03.456003Z",
    });
    expect(
      bounded.matches.map(({ excerpt }) => {
        return excerpt.text;
      }),
    ).toStrictEqual([
      "precisionneedle second tie",
      "precisionneedle first tie",
    ]);
  });

  it("keeps escaped excerpts within page and wire byte limits without skipping a match", async () => {
    const text = `escapedsearchneedle ${"\u0001".repeat(1200)}`;
    // The byte envelope is independent of admission. Keep one real user input
    // and batch 29 assistant outputs instead of preparing 30 separate sends.
    const f = await assistantMessagesFixture(
      `${text} 0`,
      Array.from({ length: 29 }, (_, index) => {
        return `${text} ${index + 1}`;
      }),
    );
    await projectSearchMessages([f.threadId]);
    const canonical = await f.chat.listThreadEvents(f.actor, f.threadId);
    const sourceEventIds = canonical.events
      .filter((event) => {
        return (
          (event.eventType === "input.prompt" ||
            event.eventType === "output.message") &&
          event.runId === f.runId &&
          chatEventDisplayText(event)?.startsWith("escapedsearchneedle ")
        );
      })
      .map((event) => {
        return event.id;
      });
    expect(sourceEventIds).toHaveLength(30);
    const token = f.auth.token();
    const args = { query: "escapedsearchneedle", limit: 50 };
    let response = await callTool(token, "search_chat_messages", args);
    expect(response.isError).not.toBeTruthy();
    let page = mcpSearchChatMessagesOutputSchema.parse(
      response.structuredContent,
    );
    expect(page.matches.length).toBeGreaterThan(0);
    expect(page.matches.length).toBeLessThan(30);
    const eventIds: string[] = [];
    do {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        160 * 1024,
      );
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(
        512 * 1024,
      );
      expect(page.scanLimited).toBeFalsy();
      eventIds.push(
        ...page.matches.map(({ ref }) => {
          return ref.eventId;
        }),
      );
      expect(eventIds.length).toBeLessThanOrEqual(30);
      if (page.nextCursor === null) {
        break;
      }
      response = await callTool(token, "search_chat_messages", {
        ...args,
        cursor: page.nextCursor,
      });
      expect(response.isError).not.toBeTruthy();
      page = mcpSearchChatMessagesOutputSchema.parse(
        response.structuredContent,
      );
    } while (page.matches.length > 0);
    expect(page.nextCursor).toBeNull();
    expect(eventIds).toHaveLength(30);
    expect(new Set(eventIds).size).toBe(30);
    expect([...eventIds].sort()).toStrictEqual([...sourceEventIds].sort());
  });

  it("binds search cursors to all filters and expires them without extending their lifetime", async () => {
    const f = await messageFixture();
    const first = await f.send("searchcursor first");
    await f.send("searchcursor second", first.threadId);
    await projectSearchMessages([first.threadId]);
    const token = f.auth.token();
    const args = { query: "searchcursor", limit: 1 };
    const page = await searchMessages(token, args);
    const cursor = page.nextCursor;
    if (!cursor) {
      throw new Error("Expected a signed search continuation");
    }
    for (const invalid of [
      { cursor: `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}` },
      { cursor, query: "differentquery" },
      { cursor, limit: 2 },
      { cursor, threadId: first.threadId },
      { cursor, agentId: f.agent.agentId },
      { cursor, role: "user" },
      { cursor, since: new Date(0).toISOString() },
      { cursor, before: new Date(now() + 60_000).toISOString() },
    ]) {
      const result = await callTool(token, "search_chat_messages", {
        ...args,
        ...invalid,
      });
      expect(result.isError).toBeTruthy();
      structuredToolError(result);
    }
    expect(
      (await searchMessages(token, { ...args, cursor })).matches[0]?.excerpt
        .text,
    ).toBe("searchcursor first");
    const longToken = f.auth.token({
      exp: Math.floor((now() + 2 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      expect(
        (await callTool(longToken, "search_chat_messages", { ...args, cursor }))
          .isError,
      ).toBeTruthy();
      expect((await searchMessages(longToken, args)).matches).toHaveLength(1);
    });
  });

  it("does not disclose foreign or deleted threads or accept a cursor from another principal", async () => {
    const f = await messageFixture();
    const sent = await f.send("ownersearchneedle first");
    await f.send("ownersearchneedle second", sent.threadId);
    await projectSearchMessages([sent.threadId]);
    const args = { query: "ownersearchneedle", limit: 1 };
    const cursor = (await searchMessages(f.auth.token(), args)).nextCursor;
    expect(cursor).not.toBeNull();
    for (const actor of [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ]) {
      if (!actor.orgId) {
        throw new Error("Expected the other principal's organization");
      }
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [f.auth.orgId, actor.orgId].map((orgId) => {
            return {
              id: randomUUID(),
              role: "org:member",
              organization: { id: orgId },
            };
          }),
          totalCount: 2,
        },
      );
      const token = f.auth.token({ sub: actor.userId, org_id: actor.orgId });
      expect((await searchMessages(token, args)).matches).toStrictEqual([]);
      expect(
        (await searchMessages(token, { ...args, threadId: sent.threadId }))
          .matches,
      ).toStrictEqual([]);
      const result = await callTool(token, "search_chat_messages", {
        ...args,
        cursor,
      });
      expect(result.isError).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain("ownersearchneedle first");
    }
    await f.chat.deleteThread(f.actor, sent.threadId);
    expect((await searchMessages(f.auth.token(), args)).matches).toStrictEqual(
      [],
    );
  });

  it.each([
    { query: "" },
    { query: "x".repeat(201) },
    { query: "中文", limit: 0 },
    { query: "中文", limit: 51 },
    { query: "中文", cursor: "x".repeat(4097) },
    { query: "中文", role: "system" },
    { query: "中文", since: "not-a-date" },
    {
      query: "中文",
      since: "2026-01-02T00:00:00.000Z",
      before: "2026-01-01T00:00:00.000Z",
    },
    { query: "!!!" },
    { query: "中" },
  ])(
    "rejects malformed or unsupported lexical search arguments %j",
    async (args) => {
      const auth = await fixture();
      const result = await callTool(auth.token(), "search_chat_messages", args);
      expect(result.isError).toBeTruthy();
      structuredToolError(result);
    },
  );
});
