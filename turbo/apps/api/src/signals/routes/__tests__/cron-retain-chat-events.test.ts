import { randomUUID } from "node:crypto";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { cronRetainChatEventsContract } from "@okouai/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { cronRetainChatEventsRoutes } from "../cron-retain-chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const CRON_SECRET = "test-chat-event-retention-secret";

function cronClient() {
  return setupApp({ context, routes: cronRetainChatEventsRoutes })(
    cronRetainChatEventsContract,
  );
}

describe("chat event retention cron", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  it("requires the cron secret", async () => {
    const response = await accept(cronClient().retain({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("preserves a recent conversation across authenticated retention sweeps", async () => {
    const app = await setupApp({
      context,
      routes: [...cronRetainChatEventsRoutes, ...chatThreadRoutes],
      isolatePg: true,
    });
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const chat = createChatFilesBddApi(context);
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Retention conversation",
    });
    const marker = `recent-conversation-${randomUUID()}`;
    const sent = await chat.requestSendEvent(
      owner,
      { agentId: agent.agentId, model: null, prompt: marker },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the no-credit message to be accepted");
    }
    await flushWaitUntilForTest();
    createRouteMocks(context).clerk.session(
      owner.userId,
      owner.orgId,
      owner.orgRole,
    );
    const readRequest = {
      headers: { authorization: "Bearer clerk-session" },
      params: { threadId: sent.body.threadId },
      query: { sinceSeqId: 0 },
    };
    const events = app(chatThreadEventsContract);
    const before = await accept(events.rows(readRequest), [200]);
    expect(before.body.rows.map(chatEventFromRow)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "input.prompt",
          userMessage: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: marker }),
            ]),
          }),
        }),
      ]),
    );
    for (let sweep = 0; sweep < 2; sweep += 1) {
      const retained = await accept(
        app(cronRetainChatEventsContract).retain({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
      expect(retained.body.success).toBeTruthy();
      const after = await accept(events.rows(readRequest), [200]);
      expect(after.body).toStrictEqual(before.body);
    }
  });
});
