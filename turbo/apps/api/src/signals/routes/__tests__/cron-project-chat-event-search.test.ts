import { randomUUID } from "node:crypto";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { cronProjectChatEventSearchContract } from "@okouai/api-contracts/contracts/cron";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { projectRoutes } from "../projects";
import { mcpProjectChatSearchContract } from "@okouai/api-contracts/contracts/mcp-chat-search";
import { mcpGetChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-snapshots";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
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

describe("chat search publication", () => {
  it("requires the cron secret", async () => {
    const response = await accept(cronClient().project({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("withdraws recalled queued messages while another input is published", async () => {
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    await createRunsApi(context).configureRunnerGroup();
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
    expect((await chat.searchChat(owner, keyword)).results).toStrictEqual([]);

    const racingEventId = randomUUID();
    const survivingKeyword = `survivingsearch${randomUUID().replaceAll("-", "")}`;
    await chat.requestSendEvent(
      owner,
      {
        agentId: agent.agentId,
        threadId,
        clientEventId: racingEventId,
        prompt: keyword,
      },
      [201],
    );
    // These requests may overlap the accepted input's background publication.
    // Observe the final caller contract without driving or pausing the indexer.
    await Promise.all([
      chat.requestSendEvent(
        owner,
        { agentId: agent.agentId, threadId, revokesEventId: racingEventId },
        [201],
      ),
      chat.requestSendEvent(
        owner,
        { agentId: agent.agentId, threadId, prompt: survivingKeyword },
        [201],
      ),
    ]);
    await flushWaitUntilForTest();
    expect((await chat.searchChat(owner, keyword)).results).toStrictEqual([]);
    expect(
      (await chat.searchChat(owner, survivingKeyword)).results,
    ).toContainEqual(
      expect.objectContaining({
        chatThreadId: threadId,
        matchedMessage: expect.objectContaining({ content: survivingKeyword }),
      }),
    );
  });

  it("publishes scoped MCP and Web search hits and respects revoked sharing", async () => {
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const mcp = createMcpWebApi(context);
    await createRunsApi(context).configureRunnerGroup();
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
    const native = await chat.searchChat(owner, keyword);
    expect(
      new Set(
        native.results.map(({ chatThreadId }) => {
          return chatThreadId;
        }),
      ),
    ).toStrictEqual(
      new Set(
        ownerInputs.map(({ threadId }) => {
          return threadId;
        }),
      ),
    );
    await expect(
      chat.searchChat(owner, keyword, { agentId: foreign.agentId }),
    ).resolves.toStrictEqual(native);
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
    async function search(accessToken: string, projectId?: string) {
      const raw = await call(accessToken, "search_chat_messages", {
        keyword,
        projectId,
      });
      return mcpProjectChatSearchContract.search.responses[200].parse(raw)
        .results;
    }
    const result = await search(token());
    const hit = result[0];
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
    expect(result).toStrictEqual(
      native.results.map(
        ({ agentName: _name, chatThreadId, matchedMessage, matchedRanges }) => {
          const { chatThreadId: messageThreadId, ...message } = matchedMessage;
          return {
            threadId: chatThreadId,
            projectId: null,
            projectName: null,
            matchedRanges,
            matchedMessage: { ...message, threadId: messageThreadId },
          };
        },
      ),
    );

    createRouteMocks(context).clerk.session(
      owner.userId,
      owner.orgId,
      owner.orgRole,
    );
    const projects = setupApp({ context, routes: projectRoutes })(
      projectsContract,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const thread = ownerInputs.find((input) => {
      return input.agentId === named.agentId;
    });
    if (!thread) {
      throw new Error("Expected indexed owner thread");
    }
    const first = createProjectOperationId(now(), randomUUID());
    const second = createProjectOperationId(now(), randomUUID());
    for (const [id, name] of [
      [first, "First Project"],
      [second, "Second Project"],
    ] as const) {
      await accept(
        projects.create({ headers, body: { id, eventId: id, name } }),
        [201],
      );
      await accept(
        projects.membership({
          headers,
          params: { id: thread.threadId },
          body: {
            projectId: id,
            eventId: createProjectOperationId(now(), randomUUID()),
          },
        }),
        [200],
      );
      await expect(search(token(), id)).resolves.toStrictEqual([
        expect.objectContaining({
          threadId: thread.threadId,
          projectId: id,
          projectName: name,
        }),
      ]);
    }
    await expect(search(token(), first)).resolves.toStrictEqual([]);
    await expect(
      search(token({ sub: peer.userId }), second),
    ).resolves.toStrictEqual([]);
    await expect(
      search(token({ org_id: otherOrg.orgId }), second),
    ).resolves.toStrictEqual([]);
    await bdd.updateAgentMetadata(peer, shared.agentId, {
      visibility: "private",
    });
    expect(
      (await search(token())).map(({ threadId }) => {
        return threadId;
      }),
    ).toStrictEqual([thread.threadId]);
    await expect(search(token({ sub: peer.userId }))).resolves.toHaveLength(1);
  }, 60_000);

  it.each(["UTF-16 ranges", "the documented token policy"] as const)(
    "publishes Unicode search hits with %s",
    async (contract) => {
      const bdd = createBddApi(context);
      const chat = createChatFilesBddApi(context);
      const mcp = createMcpWebApi(context);
      await createRunsApi(context).configureRunnerGroup();
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
      const token = mcp.authorize(owner);
      async function search(keyword: string) {
        const response = await mcp.call(token(), "search_chat_messages", {
          keyword,
        });
        expect(response.isError).not.toBeTruthy();
        const result = mcpProjectChatSearchContract.search.responses[200].parse(
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

  it("returns published MCP and Web search hits newest first", async () => {
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const mcp = createMcpWebApi(context);
    await createRunsApi(context).configureRunnerGroup();
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
      displayName: "Search ordering",
      visibility: "private",
    });
    const keyword = `ordering${randomUUID().replaceAll("-", "")}`;
    const threadId = await withMockNowForTest(
      new Date("2026-10-12T08:00:00Z"),
      async () => {
        const opened = await chat.requestSendEvent(
          owner,
          { agentId: agent.agentId, model: null, prompt: "Ordering setup" },
          [201],
        );
        if (opened.status !== 201) {
          throw new Error("Expected public conversation creation");
        }
        await flushWaitUntilForTest();
        return opened.body.threadId;
      },
    );
    for (const marker of [
      { label: "oldest", createdAt: "2026-10-12T08:02:49.990Z" },
      { label: "middle", createdAt: "2026-10-12T08:02:50.000Z" },
      { label: "newest", createdAt: "2026-10-12T08:02:50.010Z" },
    ]) {
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

    const token = mcp.authorize(owner);
    const response = await mcp.call(token(), "search_chat_messages", {
      keyword,
    });
    expect(response.isError).not.toBeTruthy();
    const viaMcp = mcpProjectChatSearchContract.search.responses[200].parse(
      response.structuredContent,
    ).results;
    expect(
      viaMcp.map((hit) => {
        return hit.matchedMessage.content;
      }),
    ).toStrictEqual([
      `${keyword} newest`,
      `${keyword} middle`,
      `${keyword} oldest`,
    ]);
    const viaWeb = await chat.searchChat(owner, keyword, {
      agentId: agent.agentId,
    });
    expect(
      viaWeb.results.map((hit) => {
        return [hit.matchedMessage.content, hit.matchedMessage.createdAt];
      }),
    ).toStrictEqual(
      viaMcp.map((hit) => {
        return [hit.matchedMessage.content, hit.matchedMessage.createdAt];
      }),
    );
  }, 60_000);
});
