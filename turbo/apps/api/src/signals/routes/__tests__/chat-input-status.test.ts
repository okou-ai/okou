import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  CHAT_INPUT_STATUS_MAX_RESPONSE_BYTES,
  chatInputStatusContract,
  chatInputStatusResponseSchema,
} from "@okouai/api-contracts/contracts/chat-input-status";
import { mcpSendChatMessageOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-tools";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatInputStatusRoutes } from "../chat-input-status";
import { mcpServerRoutes } from "../mcp-server";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createMcpWebApi } from "./helpers/mcp-web-api";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createPublicChatAdmissionFixture } from "./helpers/public-chat-admission-fixture";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const lifecycle = createChatEventsFixture(context);
const mcp = createMcpWebApi(context);

function toolBody(result: Awaited<ReturnType<typeof mcp.call>>): unknown {
  expect(result.isError).not.toBeTruthy();
  return result.structuredContent;
}

function statusPath(threadId: string, eventId: string): string {
  return `/api/chat-threads/${threadId}/inputs/${eventId}/status`;
}

async function fixture() {
  const f = await publicChatActor(context, {
    stripeTransport: "http",
  });
  return { ...f, token: mcp.authorize(f.actor) };
}

async function read(token: string, threadId: string, eventId: string) {
  const response = await accept(
    setupApp({ context, routes: chatInputStatusRoutes })(
      chatInputStatusContract,
    ).get({
      headers: { authorization: `Bearer ${token}` },
      params: { threadId, eventId },
    }),
    [200],
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const result = chatInputStatusResponseSchema.parse(response.body);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    CHAT_INPUT_STATUS_MAX_RESPONSE_BYTES,
  );
  return result;
}

async function tools(token: string) {
  return z
    .object({
      result: z.object({
        tools: z.array(
          z.object({
            name: z.string(),
            annotations: z.object({ readOnlyHint: z.boolean() }).optional(),
          }),
        ),
      }),
    })
    .parse(await mcp.rpc(token, "tools/list")).result.tools;
}

describe("retained chat input observation", () => {
  it.each([true, false])(
    "supports SDK discovery and calls (modern=%s)",
    async (modern) => {
      const f = await fixture();
      await f.run(async () => {
        const thread = await chat.createThread(f.actor, { agentId: f.agentId });
        const eventId = randomUUID();
        const app = createAppWithRoutes({
          routes: mcpServerRoutes,
          signal: context.signal,
        });
        const sdk = new Client(
          { name: "input-observation", version: "1" },
          {
            versionNegotiation: {
              mode: modern ? { pin: "2026-07-28" } : "legacy",
            },
          },
        );
        onTestFinished(() => {
          return sdk.close();
        });
        await sdk.connect(
          new StreamableHTTPClientTransport(
            new URL("https://api.mcp.example.test/mcp"),
            {
              authProvider: {
                token: () => {
                  return Promise.resolve(f.token());
                },
              },
              fetch: async (input, init) => {
                return await app.request(new Request(input, init));
              },
            },
          ),
        );
        const listed = await sdk.listTools();
        expect(
          listed.tools.some((tool) => {
            return tool.name === "get_chat_input_status";
          }),
        ).toBeTruthy();
        const result = await sdk.callTool({
          name: "get_chat_input_status",
          arguments: { threadId: thread.id, eventId },
        });
        expect(result.isError).not.toBeTruthy();
        expect(
          chatInputStatusResponseSchema.parse(result.structuredContent),
        ).toStrictEqual(await read(f.token(), thread.id, eventId));
      });
    },
  );

  it("correlates MCP inputs sharing a Run and returns bounded, body-free terminal outcomes", async () => {
    const f = await fixture();
    await f.run(async () => {
      await runs.heartbeatRunner(f.runnerGroup);
      const first = mcpSendChatMessageOutputSchema.parse(
        toolBody(
          await mcp.call(f.token(), "send_chat_message", {
            agentId: f.agentId,
            prompt: "Observe this accepted input",
          }),
        ),
      );
      await flushWaitUntilForTest();
      const assigned = await read(f.token(), first.threadId, first.eventId);
      expect(assigned).toMatchObject({
        eventId: first.eventId,
        input: { eventId: first.eventId },
        status: "consumed",
        terminal: null,
      });
      if (assigned.status !== "consumed") {
        throw new Error("Expected the accepted input to identify its Run");
      }
      const before = await chat.readThread(f.actor, first.threadId);
      const claimed = await f.claimChatRun(f.runnerGroup, assigned.runId);
      const prompt = "x".repeat(32_001);
      const second = mcpSendChatMessageOutputSchema.parse(
        toolBody(
          await mcp.call(f.token(), "send_chat_message", {
            agentId: f.agentId,
            threadId: first.threadId,
            prompt,
          }),
        ),
      );
      await expect(
        read(f.token(), second.threadId, second.eventId),
      ).resolves.toMatchObject({
        status: "queued",
        runId: null,
        terminal: null,
      });
      await runs.nextSteerableInput(claimed.claim.sandboxToken, assigned.runId);
      await runs.declareSteeredInput(
        claimed.claim.sandboxToken,
        assigned.runId,
        second.eventId,
      );
      const short = await read(f.token(), first.threadId, first.eventId);
      const long = await read(f.token(), second.threadId, second.eventId);
      expect(long).toMatchObject({
        eventId: second.eventId,
        input: { eventId: second.eventId },
        status: "consumed",
        runId: assigned.runId,
        terminal: null,
      });
      expect(long.replacement?.eventId).not.toBe(second.eventId);
      expect(Buffer.byteLength(JSON.stringify(long))).toBe(
        Buffer.byteLength(JSON.stringify(short)),
      );
      expect(JSON.stringify(long)).not.toContain(prompt);
      const toolResult = await mcp.call(f.token(), "get_chat_input_status", {
        threadId: second.threadId,
        eventId: second.eventId,
      });
      expect(toolBody(toolResult)).toStrictEqual(long);
      expect(Buffer.byteLength(JSON.stringify(toolResult))).toBeLessThanOrEqual(
        CHAT_INPUT_STATUS_MAX_RESPONSE_BYTES,
      );
      await lifecycle.completeChatRunOk(assigned.runId, claimed.sandboxHeaders);
      await flushWaitUntilForTest();
      const events = await chat.listThreadEventRows(f.actor, first.threadId);
      const terminal = events.find((event) => {
        return (
          event.runId === assigned.runId && event.eventType === "run.completed"
        );
      });
      if (!terminal) {
        throw new Error("Expected the public Chat completion event");
      }
      for (const eventId of [first.eventId, second.eventId]) {
        await expect(
          read(f.token(), first.threadId, eventId),
        ).resolves.toMatchObject({
          eventId,
          status: "completed",
          runId: assigned.runId,
          terminal: {
            eventId: terminal.id,
            seqId: terminal.seqId,
            createdAt: terminal.createdAt,
          },
        });
      }
      expect(
        toolBody(
          await mcp.call(f.token(), "get_chat_input_status", {
            threadId: first.threadId,
            eventId: second.eventId,
          }),
        ),
      ).toMatchObject({
        status: "completed",
        runId: assigned.runId,
        terminal: { eventId: terminal.id },
      });
      expect((await chat.readThread(f.actor, first.threadId)).lastReadAt).toBe(
        before.lastReadAt,
      );
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "returns the matching Chat %s event without its error body",
    async (status) => {
      const f = await fixture();
      await f.run(async () => {
        const eventId = randomUUID();
        const run = await f.sendChatRun(f.actor, {
          agentId: f.agentId,
          prompt: "Observe the terminal outcome",
          clientEventId: eventId,
        });
        const claim = await f.claimChatRun(f.runnerGroup, run.runId);
        if (status === "failed") {
          await webhooks.requestAgentComplete(
            { runId: run.runId, exitCode: 1, error: "private failure detail" },
            claim.sandboxHeaders,
            [200],
          );
        } else {
          await runs.requestCancelRun(f.actor, run.runId, [200]);
          await expect(
            read(f.token(), run.threadId, eventId),
          ).resolves.toMatchObject({
            status: "consumed",
            runId: run.runId,
            terminal: null,
          });
          await lifecycle.failChatRun(
            run.runId,
            claim.sandboxHeaders,
            "private failure detail",
          );
        }
        await flushWaitUntilForTest();
        const result = await read(f.token(), run.threadId, eventId);
        expect(result).toMatchObject({
          eventId,
          status,
          runId: run.runId,
          terminal: {
            eventId: expect.any(String),
            seqId: expect.any(Number),
            createdAt: expect.any(String),
          },
        });
        expect(JSON.stringify(result)).not.toContain("private failure detail");
      });
    },
  );

  it("keeps each input's Chat outcome when a later execution uses the same thread", async () => {
    const f = await fixture();
    await f.run(async () => {
      const firstEventId = randomUUID();
      const first = await f.sendChatRun(f.actor, {
        agentId: f.agentId,
        prompt: "Complete the first request",
        clientEventId: firstEventId,
      });
      const firstClaim = await f.claimChatRun(f.runnerGroup, first.runId);
      await lifecycle.completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
      await flushWaitUntilForTest();
      const completed = await read(f.token(), first.threadId, firstEventId);
      expect(completed).toMatchObject({
        status: "completed",
        runId: first.runId,
        terminal: { eventId: expect.any(String) },
      });

      const nextEventId = randomUUID();
      const next = await f.sendChatRun(f.actor, {
        agentId: f.agentId,
        threadId: first.threadId,
        prompt: "Start a separate execution",
        clientEventId: nextEventId,
      });
      expect(next.runId).not.toBe(first.runId);
      await expect(
        read(f.token(), first.threadId, nextEventId),
      ).resolves.toMatchObject({
        status: "consumed",
        runId: next.runId,
        terminal: null,
      });
      await expect(
        read(f.token(), first.threadId, firstEventId),
      ).resolves.toStrictEqual(completed);

      const nextClaim = await f.claimChatRun(f.runnerGroup, next.runId);
      await lifecycle.failChatRun(
        next.runId,
        nextClaim.sandboxHeaders,
        "The later request failed",
      );
      await flushWaitUntilForTest();
      await expect(
        read(f.token(), first.threadId, nextEventId),
      ).resolves.toMatchObject({
        status: "failed",
        runId: next.runId,
        terminal: { eventId: expect.any(String) },
      });

      context.mocks.s3.send.mockRejectedValue(
        new Error("Snapshot provider is unavailable"),
      );
      await expect(
        read(f.token(), first.threadId, firstEventId),
      ).resolves.toStrictEqual(completed);
      await expect(
        read(f.token(), first.threadId, randomUUID()),
      ).resolves.toMatchObject({
        status: "unavailable",
        input: null,
        replacement: null,
        runId: null,
        terminal: null,
      });
    });
  });

  it("distinguishes an unassigned queued input, its recall and unavailable evidence", async () => {
    const f = await fixture();
    await f.run(async () => {
      const active = await f.sendChatRun(f.actor, {
        agentId: f.agentId,
        prompt: "Wait for additional inputs",
      });
      await f.claimChatRun(f.runnerGroup, active.runId);
      const eventId = randomUUID();
      await f.requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          threadId: active.threadId,
          prompt: "Wait for the Runner to consume this input",
          clientEventId: eventId,
        },
        [201],
      );
      await expect(
        read(f.token(), active.threadId, eventId),
      ).resolves.toMatchObject({
        status: "queued",
        input: { eventId },
        replacement: null,
        runId: null,
        terminal: null,
      });
      toolBody(
        await mcp.call(f.token(), "revoke_queued_message", {
          agentId: f.agentId,
          threadId: active.threadId,
          eventId,
        }),
      );
      await expect(
        read(f.token(), active.threadId, eventId),
      ).resolves.toMatchObject({
        status: "revoked",
        runId: null,
        terminal: null,
        replacement: { eventId: expect.any(String) },
      });
      await expect(
        read(f.token(), active.threadId, randomUUID()),
      ).resolves.toMatchObject({
        status: "unavailable",
        input: null,
        replacement: null,
        runId: null,
        terminal: null,
      });
    });
  });

  it("reports pre-Run rejection from the canonical replacement", async () => {
    const f = createPublicChatAdmissionFixture(context);
    await f.run(async () => {
      bdd.acceptAgentStorageWrites();
      f.captureStorageMocks();
      await bdd.completeOnboarding(f.actor);
      const agent = await bdd.createAgent(f.actor, {
        displayName: "Rejected input",
      });
      await f.activateWithoutCredits();
      await f.suspend(0);
      const eventId = randomUUID();
      const sent = await chat.requestSendEvent(
        f.actor,
        {
          agentId: agent.agentId,
          prompt: "Rejected before a Run",
          model: null,
          clientEventId: eventId,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the accepted input before its rejection");
      }
      await flushWaitUntilForTest();
      const token = mcp.authorize(f.actor);
      await expect(
        read(token(), sent.body.threadId, eventId),
      ).resolves.toMatchObject({
        status: "rejected",
        input: { eventId },
        replacement: { eventId: expect.any(String) },
        runId: null,
        terminal: null,
      });
    });
  });

  it("exposes observation by default and enforces the read scope and validation", async () => {
    const f = await fixture();
    await f.run(async () => {
      const thread = await chat.createThread(f.actor, { agentId: f.agentId });
      const eventId = randomUUID();
      expect(
        (await tools(f.token())).find((tool) => {
          return tool.name === "get_chat_input_status";
        }),
      ).toMatchObject({
        annotations: { readOnlyHint: true },
      });
      expect(
        (
          await mcp.web(
            f.token({ scope: "user:org:read okou:chat:send" }),
            statusPath(thread.id, eventId),
          )
        ).status,
      ).toBe(403);
      await expect(read(f.token(), thread.id, eventId)).resolves.toMatchObject({
        status: "unavailable",
      });
      expect(
        toolBody(
          await mcp.call(f.token(), "get_chat_input_status", {
            threadId: thread.id,
            eventId,
          }),
        ),
      ).toMatchObject({ status: "unavailable" });
    });
  });

  it("preserves user and organization isolation and requires original input identity", async () => {
    const f = await fixture();
    await f.run(async () => {
      const eventId = randomUUID();
      const run = await f.sendChatRun(f.actor, {
        agentId: f.agentId,
        prompt: "Owned input",
        clientEventId: eventId,
      });
      const known = await read(f.token(), run.threadId, eventId);
      if (!known.replacement) {
        throw new Error("Expected a consuming event coordinate");
      }
      const otherThread = await chat.createThread(f.actor, {
        agentId: f.agentId,
      });
      await expect(
        read(f.token(), otherThread.id, eventId),
      ).resolves.toMatchObject({
        status: "unavailable",
        input: null,
        replacement: null,
        runId: null,
        terminal: null,
      });
      expect(
        (
          await mcp.web(
            f.token(),
            statusPath(run.threadId, known.replacement.eventId),
          )
        ).status,
      ).toBe(400);
      expect(
        (await mcp.web(f.token(), statusPath(randomUUID(), eventId))).status,
      ).toBe(404);
      if (!f.actor.orgId) {
        throw new Error("Expected an owned workspace");
      }
      const orgId = f.actor.orgId;
      for (const actor of [
        { ...f.actor, userId: `user_${randomUUID()}`, orgId },
        { ...f.actor, orgId: `org_${randomUUID()}` },
      ]) {
        context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
          {
            data: [
              {
                id: randomUUID(),
                role: "org:member",
                organization: { id: actor.orgId },
              },
            ],
            totalCount: 1,
          },
        );
        const token = f.token({ sub: actor.userId, org_id: actor.orgId });
        const response = await mcp.web(
          token,
          statusPath(run.threadId, eventId),
        );
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
        expect(
          (
            await mcp.call(token, "get_chat_input_status", {
              threadId: run.threadId,
              eventId,
            })
          ).isError,
        ).toBeTruthy();
      }
    });
  });
});
