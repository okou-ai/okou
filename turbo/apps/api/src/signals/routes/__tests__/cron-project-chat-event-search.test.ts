import { randomUUID } from "node:crypto";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { cronProjectChatEventSearchContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

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

  it("cleans orphaned search projections after public Agent deletion", async () => {
    const app = await setupApp({
      context,
      routes: cronProjectChatEventSearchRoutes,
      isolatePg: true,
    });
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    context.mocks.s3.send.mockImplementation((request: unknown) => {
      return Promise.resolve(
        request instanceof ListObjectsV2Command
          ? { Contents: [], IsTruncated: false }
          : {},
      );
    });
    const owner = bdd.user();
    const deletedAgent = await bdd.createAgent(owner, {
      displayName: "Deleted search projection agent",
    });
    const survivorAgent = await bdd.createAgent(owner, {
      displayName: "Surviving search projection agent",
    });
    const markers = [
      { agentId: deletedAgent.agentId, text: `orphaned-${randomUUID()}` },
      { agentId: survivorAgent.agentId, text: `survivor-${randomUUID()}` },
    ];
    const threads: string[] = [];
    for (const marker of markers) {
      const sent = await chat.requestSendEvent(
        owner,
        { agentId: marker.agentId, model: null, prompt: marker.text },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the Auto input to be accepted");
      }
      threads.push(sent.body.threadId);
      await flushWaitUntilForTest();
      const history = await chat.listThreadEvents(owner, sent.body.threadId);
      expect(history.events).toContainEqual(
        expect.objectContaining({
          eventType: "input.prompt",
          userMessage: expect.objectContaining({
            parts: expect.arrayContaining([
              { type: "text", text: marker.text },
            ]),
          }),
        }),
      );
    }

    mockEnv("CRON_SECRET", CRON_SECRET);
    const operator = app(cronProjectChatEventSearchContract);
    const headers = { authorization: `Bearer ${CRON_SECRET}` };
    const projected = await accept(operator.project({ headers }), [200]);
    expect(projected.body.orphanedThreads).toBe(0);
    for (const [index, marker] of markers.entries()) {
      const search = await chat.searchChat(owner, marker.text);
      expect(search.results).toContainEqual(
        expect.objectContaining({
          chatThreadId: threads[index],
          matchedMessage: expect.objectContaining({ content: marker.text }),
        }),
      );
    }

    await bdd.deleteAgent(owner, deletedAgent.agentId);
    const cleaned = await accept(operator.project({ headers }), [200]);
    expect(cleaned.body.orphanedThreads).toBe(1);
    // Public search filters missing canonical owners, so this observation is
    // visibility evidence; the paired SQL establishes physical cleanup scope.
    expect(
      (await chat.searchChat(owner, markers[0]!.text)).results,
    ).toStrictEqual([]);
    expect(
      (await chat.searchChat(owner, markers[1]!.text)).results,
    ).toContainEqual(
      expect.objectContaining({
        chatThreadId: threads[1],
        matchedMessage: expect.objectContaining({ content: markers[1]!.text }),
      }),
    );
    const repeated = await accept(operator.project({ headers }), [200]);
    expect(repeated.body.orphanedThreads).toBe(0);
  }, 60_000);
});
