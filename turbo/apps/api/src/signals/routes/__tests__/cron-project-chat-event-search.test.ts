import { randomUUID } from "node:crypto";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { cronProjectChatEventSearchContract } from "@okouai/api-contracts/contracts/cron";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { mcpChatSearchContract } from "@okouai/api-contracts/contracts/mcp-chat-search";
import { mcpGetChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-snapshots";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createMcpWebApi } from "./helpers/mcp-web-api";

const context = testContext();
const CRON_SECRET = "durable-chat-search-projection-secret";

function cronClient() {
  mockEnv("CRON_SECRET", CRON_SECRET);
  return setupApp({
    context,
    routes: cronProjectChatEventSearchRoutes,
  })(cronProjectChatEventSearchContract);
}

describe("GET /api/cron/project-chat-event-search", () => {
  it("requires the cron secret", async () => {
    const response = await accept(cronClient().project({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("withdraws a previously indexed queued message after its public recall", async () => {
    const app = await setupApp({
      context,
      routes: cronProjectChatEventSearchRoutes,
      isolatePg: true,
    });
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    createRunsApi(context).configureRunnerGroup();
    bdd.acceptAgentStorageWrites();
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    await bdd.readOnboardingStatus(owner);
    await bdd.completeOnboarding(owner);
    const agent = await bdd.createAgent(owner, {
      displayName: "Recalled search publication",
      visibility: "private",
    });
    const opened = await chat.requestSendEvent(
      owner,
      { agentId: agent.agentId, model: null, prompt: "Start the conversation" },
      [201],
    );
    if (opened.status !== 201) {
      throw new Error("Expected a publicly accepted conversation");
    }
    await flushWaitUntilForTest();
    const keyword = `recalledsearch${randomUUID().replaceAll("-", "")}`;
    const clientEventId = randomUUID();
    const threadId = opened.body.threadId;
    await chat.requestSendEvent(
      owner,
      { agentId: agent.agentId, threadId, clientEventId, prompt: keyword },
      [201],
    );
    await flushWaitUntilForTest();
    mockEnv("CRON_SECRET", CRON_SECRET);
    const operator = app(cronProjectChatEventSearchContract);
    const headers = { authorization: `Bearer ${CRON_SECRET}` };
    await accept(operator.project({ headers }), [200]);
    expect((await chat.searchChat(owner, keyword)).results).toContainEqual(
      expect.objectContaining({
        chatThreadId: threadId,
        matchedMessage: expect.objectContaining({ content: keyword }),
      }),
    );

    await chat.requestSendEvent(
      owner,
      { agentId: agent.agentId, threadId, revokesEventId: clientEventId },
      [201],
    );
    await flushWaitUntilForTest();
    await accept(operator.project({ headers }), [200]);
    expect((await chat.searchChat(owner, keyword)).results).toStrictEqual([]);
  });

  it("publishes scoped MCP and Web search hits and respects revoked sharing", async () => {
    // This is the operator index-publication boundary, not a user fixture that
    // privately drives indexing. All business data and observations use APIs.
    const app = await setupApp({
      context,
      routes: cronProjectChatEventSearchRoutes,
      isolatePg: true,
    });
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const mcp = createMcpWebApi(context);
    createRunsApi(context).configureRunnerGroup();
    bdd.acceptAgentStorageWrites();
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      return Promise.resolve(
        request instanceof ListObjectsV2Command
          ? { Contents: [], IsTruncated: false }
          : { ContentLength: 1024 },
      );
    });
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    await bdd.readOnboardingStatus(owner);
    await bdd.completeOnboarding(owner);
    const named = await bdd.createAgent(owner, {
      displayName: "MCP Research",
      visibility: "private",
    });
    const peer = bdd.user({ orgId: owner.orgId });
    await bdd.readOnboardingStatus(peer);
    await bdd.completeOnboarding(peer);
    const shared = await bdd.createAgent(peer, {
      displayName: "Shared research",
    });
    const otherOrg = bdd.user({
      userId: owner.userId,
      orgId: `org_${randomUUID()}`,
    });
    await bdd.readOnboardingStatus(otherOrg);
    await bdd.completeOnboarding(otherOrg);
    const foreign = await bdd.createAgent(otherOrg, {
      displayName: "Other organization",
      visibility: "private",
    });
    const keyword = `mcpidentity${randomUUID().replaceAll("-", "")}`;
    const ownerInputs: {
      readonly threadId: string;
      readonly agentId: string;
    }[] = [];
    for (const agentId of [named.agentId, shared.agentId]) {
      const sent = await chat.requestSendEvent(
        owner,
        { agentId, model: null, prompt: `${keyword} owner ${agentId}` },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected public input acceptance");
      }
      ownerInputs.push({ threadId: sent.body.threadId, agentId });
      await flushWaitUntilForTest();
    }
    for (const [actor, agentId] of [
      [peer, shared.agentId],
      [otherOrg, foreign.agentId],
    ] as const) {
      await chat.requestSendEvent(
        actor,
        { agentId, model: null, prompt: `${keyword} isolated ${agentId}` },
        [201],
      );
      await flushWaitUntilForTest();
    }
    mockEnv("CRON_SECRET", CRON_SECRET);
    await accept(
      app(cronProjectChatEventSearchContract).project({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    const native = await chat.searchChat(owner, keyword);
    expect(native.results.length).toBeGreaterThan(0);
    const token = mcp.authorize(owner);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [owner.orgId, otherOrg.orgId].map((orgId) => {
        return {
          id: randomUUID(),
          role: "org:member",
          organization: { id: orgId },
        };
      }),
      totalCount: 2,
    });
    async function call(
      accessToken: string,
      name: string,
      args: Record<string, unknown> = {},
    ) {
      const response = await mcp.call(accessToken, name, args);
      expect(response.isError).not.toBeTruthy();
      const raw: unknown =
        response.structuredContent ??
        JSON.parse(response.content[0]?.text ?? "null");
      return raw;
    }
    const listed = agentsMainContract.list.responses[200].parse(
      await call(token(), "list_agents"),
    );
    async function search(accessToken: string, agentId?: string) {
      const raw = await call(accessToken, "search_chat_messages", {
        keyword,
        ...(agentId ? { agentId } : {}),
      });
      return { raw, ...mcpChatSearchContract.search.responses[200].parse(raw) };
    }
    const result = await search(token());
    const hit = result.results[0];
    if (!hit) {
      throw new Error("Expected an indexed MCP hit");
    }
    expect(hit.matchedMessage.threadId).toBe(hit.threadId);
    const history = mcpGetChatMessagesOutputSchema.parse(
      await call(token(), "get_chat_messages", {
        threadId: hit.threadId,
        sinceSeqId: 0,
      }),
    );
    expect(history.rows).toContainEqual(
      expect.objectContaining({
        threadId: hit.threadId,
        payload: expect.objectContaining({
          userMessage: expect.objectContaining({
            parts: expect.arrayContaining([
              { type: "text", text: hit.matchedMessage.content },
            ]),
          }),
        }),
      }),
    );
    expect(result.raw).toStrictEqual({
      results: native.results.map(
        ({ agentName: _name, chatThreadId, matchedMessage, ...hit }) => {
          const input = ownerInputs.find((item) => {
            return item.threadId === chatThreadId;
          });
          const agent = listed.find((item) => {
            return item.agentId === input?.agentId;
          });
          if (!agent) {
            throw new Error("Expected the indexed input's visible Agent");
          }
          const { chatThreadId: messageThreadId, ...message } = matchedMessage;
          return {
            ...hit,
            agentId: agent.agentId,
            displayName: agent.displayName,
            threadId: chatThreadId,
            matchedMessage: { ...message, threadId: messageThreadId },
          };
        },
      ),
    });
    expect(
      new Set(
        result.results.map((hit) => {
          return hit.agentId;
        }),
      ),
    ).toStrictEqual(
      new Set(
        ownerInputs.map((input) => {
          return input.agentId;
        }),
      ),
    );
    const filtered = await search(token(), named.agentId);
    expect(filtered.results.length).toBeGreaterThan(0);
    expect(
      filtered.results.every((hit) => {
        return hit.agentId === named.agentId;
      }),
    ).toBeTruthy();
    expect(
      new Set(
        (await search(token({ sub: peer.userId }))).results.map((hit) => {
          return hit.agentId;
        }),
      ),
    ).toStrictEqual(new Set([shared.agentId]));
    expect(
      new Set(
        (await search(token({ org_id: otherOrg.orgId }))).results.map((hit) => {
          return hit.agentId;
        }),
      ),
    ).toStrictEqual(new Set([foreign.agentId]));

    await bdd.updateAgentMetadata(peer, shared.agentId, {
      visibility: "private",
    });
    expect(
      (await search(token())).results.some((hit) => {
        return hit.agentId === shared.agentId;
      }),
    ).toBeFalsy();
    expect((await search(token({ sub: peer.userId }))).results).toContainEqual(
      expect.objectContaining({
        agentId: shared.agentId,
        displayName: "Shared research",
      }),
    );
  }, 60_000);

  it.each(["UTF-16 ranges", "the documented token policy"] as const)(
    "publishes Unicode search hits with %s",
    async (contract) => {
      const app = await setupApp({
        context,
        routes: cronProjectChatEventSearchRoutes,
        isolatePg: true,
      });
      const bdd = createBddApi(context);
      const chat = createChatFilesBddApi(context);
      const mcp = createMcpWebApi(context);
      createRunsApi(context).configureRunnerGroup();
      bdd.acceptAgentStorageWrites();
      const owner = bdd.user({ orgId: `org_${randomUUID()}` });
      await bdd.readOnboardingStatus(owner);
      await bdd.completeOnboarding(owner);
      const agent = await bdd.createAgent(owner, {
        displayName: "Unicode research",
        visibility: "private",
      });
      const examples = [
        {
          contract: "UTF-16 ranges",
          content: "ACK-QA-A1-🧪-中文",
          keyword: "中文",
          ranges: [{ start: 13, end: 15 }],
          highlighted: "中文",
        },
        {
          contract: "UTF-16 ranges",
          content: "𠀀-代理",
          keyword: "代理",
          ranges: [{ start: 3, end: 5 }],
          highlighted: "代理",
        },
        {
          contract: "UTF-16 ranges",
          content: "e\u0301-组合",
          keyword: "组合",
          ranges: [{ start: 3, end: 5 }],
          highlighted: "组合",
        },
        {
          contract: "UTF-16 ranges",
          content: "👩‍💻-连接",
          keyword: "连接",
          ranges: [{ start: 6, end: 8 }],
          highlighted: "连接",
        },
        {
          contract: "the documented token policy",
          content: "Prefix FoObAr suffix",
          keyword: "foobar",
          ranges: [{ start: 7, end: 13 }],
          highlighted: "FoObAr",
        },
        {
          contract: "the documented token policy",
          content: "1️⃣ 数字",
          keyword: "1️⃣",
          ranges: [{ start: 0, end: 1 }],
          highlighted: "1",
        },
        {
          contract: "the documented token policy",
          content: "X-分词测试",
          keyword: "词测试",
          ranges: [{ start: 3, end: 6 }],
          highlighted: "词测试",
        },
      ].filter((example) => {
        return example.contract === contract;
      });
      const inputs = await Promise.all(
        examples.map(async (example) => {
          const sent = await chat.requestSendEvent(
            owner,
            { agentId: agent.agentId, model: null, prompt: example.content },
            [201],
          );
          if (sent.status !== 201) {
            throw new Error("Expected public input acceptance");
          }
          return { threadId: sent.body.threadId, example };
        }),
      );
      await flushWaitUntilForTest();
      mockEnv("CRON_SECRET", CRON_SECRET);
      await accept(
        app(cronProjectChatEventSearchContract).project({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
      const token = mcp.authorize(owner);
      async function search(keyword: string) {
        const response = await mcp.call(token(), "search_chat_messages", {
          keyword,
          agentId: agent.agentId,
        });
        expect(response.isError).not.toBeTruthy();
        const result = mcpChatSearchContract.search.responses[200].parse(
          response.structuredContent,
        );
        const native = await chat.searchChat(owner, keyword, {
          agentId: agent.agentId,
        });
        expect(
          result.results.map((hit) => {
            return {
              content: hit.matchedMessage.content,
              ranges: hit.matchedRanges,
            };
          }),
        ).toStrictEqual(
          native.results.map((hit) => {
            return {
              content: hit.matchedMessage.content,
              ranges: hit.matchedRanges,
            };
          }),
        );
        return result.results;
      }
      await Promise.all(
        inputs.map(async ({ threadId, example }) => {
          const results = await search(example.keyword);
          expect(results).toHaveLength(1);
          const hit = results[0];
          if (!hit) {
            throw new Error("Expected an indexed Unicode hit");
          }
          expect(hit.threadId).toBe(threadId);
          expect(hit.matchedMessage.content).toBe(example.content);
          expect(hit.matchedRanges).toStrictEqual(example.ranges);
          expect(
            hit.matchedRanges.map(({ start, end }) => {
              return hit.matchedMessage.content.slice(start, end);
            }),
          ).toStrictEqual([example.highlighted]);
        }),
      );
      if (contract === "UTF-16 ranges") {
        await Promise.all([
          expect(search("中文 🧪")).resolves.toMatchObject([
            {
              matchedMessage: { content: "ACK-QA-A1-🧪-中文" },
              matchedRanges: [{ start: 13, end: 15 }],
            },
          ]),
          expect(search("e\u0301")).resolves.toMatchObject([
            {
              matchedMessage: { content: "e\u0301-组合" },
              matchedRanges: [{ start: 0, end: 1 }],
            },
          ]),
        ]);
      } else {
        await expect(search("prefix suffix")).resolves.toMatchObject([
          {
            matchedMessage: { content: "Prefix FoObAr suffix" },
            matchedRanges: [
              { start: 0, end: 6 },
              { start: 14, end: 20 },
            ],
          },
        ]);
      }
      const absentKeywords =
        contract === "UTF-16 ranges"
          ? ["🧪", "👩‍💻", "!!!", "中", "𠀀", "é"]
          : ["foobar 中", "foo", "prefix nonexistent"];
      await Promise.all(
        absentKeywords.map(async (keyword) => {
          await expect(search(keyword)).resolves.toStrictEqual([]);
        }),
      );
    },
  );

  it("publishes messages searchable with inclusive MCP ISO time filters and unchanged Web milliseconds", async () => {
    // Authenticated operator publication is the system boundary in this case;
    // message construction and all search observations use normal public APIs.
    const app = await setupApp({
      context,
      routes: cronProjectChatEventSearchRoutes,
      isolatePg: true,
    });
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const mcp = createMcpWebApi(context);
    createRunsApi(context).configureRunnerGroup();
    bdd.acceptAgentStorageWrites();
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      return Promise.resolve(
        request instanceof ListObjectsV2Command
          ? { Contents: [], IsTruncated: false }
          : { ContentLength: 1024 },
      );
    });
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "MCP time filtering",
      visibility: "private",
    });
    const keyword = `mcptime${randomUUID().replaceAll("-", "")}`;
    const threadId = await withMockNowForTest(
      new Date("2026-10-12T08:00:00Z"),
      async () => {
        const opened = await chat.requestSendEvent(
          owner,
          { agentId: agent.agentId, model: null, prompt: "Time-filter setup" },
          [201],
        );
        if (opened.status !== 201) {
          throw new Error("Expected public conversation creation");
        }
        await flushWaitUntilForTest();
        return opened.body.threadId;
      },
    );
    const markers = [
      { label: "before", createdAt: "2026-10-12T08:02:49.990Z" },
      { label: "equal", createdAt: "2026-10-12T08:02:50.000Z" },
      { label: "after", createdAt: "2026-10-12T08:02:50.010Z" },
    ];
    for (const marker of markers) {
      await withMockNowForTest(new Date(marker.createdAt), async () => {
        await chat.requestSendEvent(
          owner,
          {
            agentId: agent.agentId,
            threadId,
            prompt: `${keyword} ${marker.label}`,
          },
          [201],
        );
        await flushWaitUntilForTest();
      });
    }
    mockEnv("CRON_SECRET", CRON_SECRET);
    await accept(
      app(cronProjectChatEventSearchContract).project({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    const token = mcp.authorize(owner);
    async function search(since?: string) {
      const response = await mcp.call(token(), "search_chat_messages", {
        keyword,
        agentId: agent.agentId,
        ...(since === undefined ? {} : { since }),
      });
      expect(response.isError).not.toBeTruthy();
      return mcpChatSearchContract.search.responses[200].parse(
        response.structuredContent,
      ).results;
    }
    const unfiltered = await search();
    expect(
      unfiltered.map((hit) => {
        return hit.matchedMessage.content;
      }),
    ).toStrictEqual([
      `${keyword} after`,
      `${keyword} equal`,
      `${keyword} before`,
    ]);
    const equal = unfiltered.find((hit) => {
      return hit.matchedMessage.content === `${keyword} equal`;
    });
    if (!equal) {
      throw new Error("Expected indexed public message timestamps");
    }
    // Native ingress can sequence related events beyond the request clock.
    // Reuse the public timestamp, just as a caller can, without pinning that policy.
    const since = equal.matchedMessage.createdAt;
    const filtered = await search(since);
    expect(
      filtered.map((hit) => {
        return hit.matchedMessage.content;
      }),
    ).toStrictEqual([`${keyword} after`, `${keyword} equal`]);
    expect(filtered).toContainEqual(equal);
    const offsetSince = new Date(Date.parse(since) + 8 * 3_600_000)
      .toISOString()
      .replace("Z", "+08:00");
    await expect(search(offsetSince)).resolves.toStrictEqual(filtered);
    const native = await chat.searchChat(owner, keyword, {
      agentId: agent.agentId,
      since: Date.parse(since),
    });
    expect(
      native.results.map((hit) => {
        return hit.matchedMessage.content;
      }),
    ).toStrictEqual([`${keyword} after`, `${keyword} equal`]);
    expect(
      native.results.map((hit) => {
        return hit.matchedMessage.createdAt;
      }),
    ).toStrictEqual(
      filtered.map((hit) => {
        return hit.matchedMessage.createdAt;
      }),
    );
  }, 60_000);

  it.each([
    {
      scenario: "candidates across the head/tail boundary",
      pending: [7, 8, 11],
    },
    {
      scenario: "a full head at the source-window boundary",
      pending: [6, 7, 8, 11],
    },
  ])("publishes $scenario in global thread-ID order", async ({ pending }) => {
    const app = await setupApp({
      context,
      routes: cronProjectChatEventSearchRoutes,
      isolatePg: true,
    });
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    createRunsApi(context).configureRunnerGroup();
    bdd.acceptAgentStorageWrites();
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      return Promise.resolve(
        request instanceof ListObjectsV2Command
          ? { Contents: [], IsTruncated: false }
          : { ContentLength: 1024 },
      );
    });
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Ordered background search publication",
      visibility: "private",
    });
    // Empty conversations are normal source threads but have no pending input.
    // With batch=2, the first eight source IDs form the head's probe window.
    const sourceIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const thread = await chat.createThread(owner, {
        agentId: agent.agentId,
        model: null,
      });
      sourceIds.push(thread.id);
    }
    sourceIds.sort();
    const keyword = `hybridpublication${randomUUID().replaceAll("-", "")}`;
    const pendingIds = pending.map((index) => {
      const threadId = sourceIds[index];
      if (!threadId) {
        throw new Error("Expected a publicly created source thread");
      }
      return threadId;
    });
    for (const threadId of pendingIds) {
      await chat.requestSendEvent(
        owner,
        { agentId: agent.agentId, threadId, prompt: `${keyword} ${threadId}` },
        [201],
      );
      await flushWaitUntilForTest();
    }
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockOptionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE", "2");
    const operator = app(cronProjectChatEventSearchContract);
    const headers = { authorization: `Bearer ${CRON_SECRET}` };
    const first = await accept(operator.project({ headers }), [200]);
    expect(first.body.threads).toBe(2);
    expect(first.body.convergence).toStrictEqual({
      eligibleThreads: pendingIds.length,
      durableCaughtUpThreads: 2,
    });
    const published = await chat.searchChat(owner, keyword);
    expect(
      published.results
        .map((hit) => {
          return hit.chatThreadId;
        })
        .sort(),
    ).toStrictEqual(pendingIds.slice(0, 2));
    for (const threadId of pendingIds.slice(0, 2)) {
      expect(published.results).toContainEqual(
        expect.objectContaining({
          chatThreadId: threadId,
          matchedMessage: expect.objectContaining({
            content: `${keyword} ${threadId}`,
          }),
        }),
      );
    }
    const next = await accept(operator.project({ headers }), [200]);
    expect(next.body.convergence).toStrictEqual({
      eligibleThreads: pendingIds.length,
      durableCaughtUpThreads: pendingIds.length,
    });
    expect(
      (await chat.searchChat(owner, keyword)).results
        .map((hit) => {
          return hit.chatThreadId;
        })
        .sort(),
    ).toStrictEqual(pendingIds);
  });
});
