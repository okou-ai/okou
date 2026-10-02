import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createMcpServerTestApi } from "./helpers/mcp-server";
import { createMcpServerFixtures } from "./helpers/mcp-server-fixtures";

const context = testContext();
const { fixture, getMessages, searchMessages } =
  createMcpServerTestApi(context);
const { projectSearchMessages, messageFixture, nativeRunnerChatActor } =
  createMcpServerFixtures(context);

describe("MCP message search", () => {
  async function setupMessageSearchFilters() {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const query = "mcpfilterneedle";
    const baseTime = now();
    const sent = await withMockNowForTest(baseTime, async () => {
      return await f.sendChatRun(actor.actor, {
        agentId: actor.agentId,
        prompt: `${query} user before`,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: `${query} user before` },
            { type: "additional_info", text: "mcpprivateneedle context" },
          ],
        },
      });
    });
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, sent.runId);
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    await withMockNowForTest(baseTime + 1000, async () => {
      await f.webhooks.requestAgentEvents(
        {
          runId: sent.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: 0,
              message: {
                content: [
                  { type: "text", text: `${query} assistant answer` },
                  { type: "thinking", thinking: "mcpprivateneedle reasoning" },
                ],
              },
            },
          ],
        },
        claimed.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
    });
    await withMockNowForTest(baseTime + 2000, async () => {
      await f.chat.requestSendEvent(
        actor.actor,
        {
          agentId: actor.agentId,
          threadId: sent.threadId,
          prompt: `${query} queued after`,
        },
        [201],
      );
    });
    const otherAgent = await f.chat.createAgentForChatThread(
      actor.actor,
      "Other search Agent",
    );
    const other = await withMockNowForTest(baseTime + 3000, async () => {
      return await f.sendChatRun(actor.actor, {
        agentId: otherAgent.agentId,
        prompt: `${query} other Agent`,
      });
    });
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, other.runId);
    });
    // Every source event above was written under its scoped app clock: the
    // launched inputs at baseTime and +3s (plus the 1ms replacement step), the
    // assistant answer at +1s and the queued input at exactly +2s.
    await projectSearchMessages([sent.threadId, other.threadId]);
    const token = auth.token();
    const args = { query, limit: 1 };
    return { actor, args, baseTime, other, query, sent, token };
  }

  it("applies the result limit after ordering message search matches", async () => {
    const { args, other, token } = await setupMessageSearchFilters();
    expect((await searchMessages(token, args)).matches[0]?.ref.threadId).toBe(
      other.threadId,
    );
  });

  it.each(["agent", "thread"] as const)(
    "applies the $filter filter before limiting message search matches",
    async (filter) => {
      const { actor, args, query, sent, token } =
        await setupMessageSearchFilters();
      const filters =
        filter === "agent"
          ? { agentId: actor.agentId }
          : { threadId: sent.threadId };
      expect(
        (await searchMessages(token, { ...args, ...filters })).matches[0]
          ?.excerpt.text,
      ).toBe(`${query} queued after`);
    },
  );

  it.each(["role", "before", "bounded"] as const)(
    "applies the $filter source filter before limiting message search matches",
    async (filter) => {
      const { args, baseTime, query, sent, token } =
        await setupMessageSearchFilters();
      const since = new Date(baseTime + 1000).toISOString();
      const before = new Date(baseTime + 2000).toISOString();
      const filters =
        filter === "role"
          ? ({ role: "assistant" } as const)
          : filter === "before"
            ? { before }
            : { since, before };
      const page = await searchMessages(token, { ...args, ...filters });
      expect(page.matches).toMatchObject([
        {
          role: "assistant",
          runId: sent.runId,
          excerpt: { text: `${query} assistant answer` },
        },
      ]);
    },
  );

  it("applies an inclusive source-time lower bound before limiting", async () => {
    const { args, baseTime, query, sent, token } =
      await setupMessageSearchFilters();
    const before = new Date(baseTime + 2000).toISOString();
    expect(
      (
        await searchMessages(token, {
          ...args,
          threadId: sent.threadId,
          since: before,
        })
      ).matches[0]?.excerpt.text,
    ).toBe(`${query} queued after`);
  });

  it("filters message search by user role", async () => {
    const { query, token } = await setupMessageSearchFilters();
    expect(
      (await searchMessages(token, { query, role: "user" })).matches,
    ).toHaveLength(3);
  });

  it("excludes private message context from search", async () => {
    const { token } = await setupMessageSearchFilters();
    expect(
      (await searchMessages(token, { query: "mcpprivateneedle" })).matches,
    ).toStrictEqual([]);
  });

  it("returns no message-search matches for an unrelated thread", async () => {
    const { args, token } = await setupMessageSearchFilters();
    expect(
      (await searchMessages(token, { ...args, threadId: randomUUID() }))
        .matches,
    ).toStrictEqual([]);
  });

  it("centers late Unicode excerpts on real matches and rejects CJK phrases split across runs", async () => {
    const f = await messageFixture();
    const text = `${"😀文 ".repeat(3000)}LateNeedle 上海滩 ${"𠮷尾 ".repeat(500)}`;
    const sent = await f.send(text);
    await f.send("LateNeedle 上海 海滩", sent.threadId);
    await projectSearchMessages([sent.threadId]);
    const token = f.auth.token();
    const result = await searchMessages(token, { query: "lateneedle 上海滩" });
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    if (!match) {
      throw new Error("Expected the contiguous mixed-language match");
    }
    expect(match.excerpt.text).toContain("LateNeedle 上海滩");
    expect(match.excerpt.text.length).toBeLessThanOrEqual(1000);
    expect(match.excerpt.offset).toBeGreaterThan(8192);
    expect(match.excerpt.hasBefore).toBeTruthy();
    expect(match.excerpt.hasAfter).toBeTruthy();
    expect(Buffer.from(match.excerpt.text).toString("utf8")).toBe(
      match.excerpt.text,
    );
    expect(
      text.slice(
        match.excerpt.offset,
        match.excerpt.offset + match.excerpt.text.length,
      ),
    ).toBe(match.excerpt.text);
    expect(
      (await searchMessages(token, { query: "上海滩" })).matches.map(
        ({ ref }) => {
          return ref;
        },
      ),
    ).toStrictEqual([match.ref]);
    expect(
      (await searchMessages(token, { query: "LATENEEDLE" })).matches,
    ).toHaveLength(2);
    const around = await getMessages(token, {
      threadId: match.ref.threadId,
      around: { eventId: match.ref.eventId, seqId: match.ref.seqId },
      limit: 1,
    });
    expect(around.messages[0]?.ref).toStrictEqual(match.ref);
    expect(around.messages[0]?.nextContentCursor).not.toBeNull();
  });
});
