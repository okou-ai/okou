import { randomUUID } from "node:crypto";
import { chatThreadPdfFilenameContract } from "@okouai/api-contracts/contracts/chat-thread-pdf-filename";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadPdfFilenameRoutes } from "../chat-thread-pdf-filename";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
  vertexTextResponse,
} from "./helpers/google-text";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const callbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const routeMocks = createRouteMocks(context);
const selectedText =
  "Compare solar panel installation costs and payback periods";
const privateText = "Unselected private acquisition negotiations";

function client() {
  return setupApp({ context, routes: chatThreadPdfFilenameRoutes })(
    chatThreadPdfFilenameContract,
  );
}

function headers(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

async function fixture() {
  mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
  const actor = bdd.user();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  await runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, { displayName: "PDF filename" });
  const run = await chat.sendAndLaunch(actor, {
    agentId: agent.agentId,
    prompt: "Analyze residential solar economics",
  });
  const execution = await runs.executionInput(run.runId);
  await webhooks.requestAgentEvents(
    {
      runId: run.runId,
      events: [
        {
          type: "assistant",
          sequenceNumber: 0,
          message: { content: [{ type: "text", text: selectedText }] },
        },
      ],
    },
    { authorization: `Bearer ${execution.sandboxToken}` },
    [200],
  );
  await chat.renameThread(actor, run.threadId, privateText);
  await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      threadId: run.threadId,
      prompt: privateText,
    },
    [201],
  );
  await flushWaitUntilForTest();
  const { events } = await chat.listThreadEvents(actor, run.threadId);
  const assistant = events.find((event) => {
    return event.eventType === "output.message";
  });
  const user = events.find((event) => {
    return event.eventType === "input.prompt" && event.runId === run.runId;
  });
  if (!assistant || !user) {
    throw new Error("Expected persisted user and assistant events");
  }
  return {
    actor,
    threadId: run.threadId,
    assistantId: assistant.id,
    userId: user.id,
    revokedId: run.clientEventId,
  };
}

function request(
  f: Awaited<ReturnType<typeof fixture>>,
  eventIds = [f.assistantId],
  actor = f.actor,
) {
  return client().generate({
    headers: headers(actor),
    params: { threadId: f.threadId },
    body: { eventIds },
  });
}

function provider(reply: () => Response) {
  mockGoogleText();
  const requests: ReturnType<typeof vertexTextRequest>[] = [];
  server.use(
    http.post(VERTEX_TEXT_URL, async ({ request }) => {
      requests.push(vertexTextRequest(await request.json(), request.url));
      return reply();
    }),
  );
  return requests;
}

describe("PDF filename generation", () => {
  it("names only selected canonical messages, sanitizes the base, and generates again without caching", async () => {
    const f = await fixture();
    let attempt = 0;
    const requests = provider(() => {
      return vertexTextResponse(
        ++attempt === 1 ? '"Solar / Payback.pdf"' : "Solar costs",
      );
    });
    const first = await accept(request(f), [200]);
    expect(first.body).toBe("Solar Payback");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const second = await accept(request(f), [200]);
    expect(second.body).toBe("Solar costs");
    await accept(request(f, [f.userId, f.assistantId, f.assistantId]), [200]);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ model: "gemini-3.1-flash-lite" });
    expect(JSON.stringify(requests[0])).toContain(selectedText);
    expect(JSON.stringify(requests)).not.toContain(privateText);
    expect(JSON.stringify(requests[2])).toContain(
      "Analyze residential solar economics",
    );
  });

  it("returns an empty filename when generation fails or is unusable", async () => {
    const f = await fixture();
    provider(() => {
      return new HttpResponse(null, { status: 429 });
    });
    expect((await accept(request(f), [200])).body).toBe("");
    provider(() => {
      return vertexTextResponse(String.raw`../\:*?`);
    });
    expect((await accept(request(f), [200])).body).toBe("");
    mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
    expect((await accept(request(f), [200])).body).toBe("");
  });

  it("bounds generated filenames", async () => {
    const f = await fixture();
    provider(() => {
      return vertexTextResponse("太阳能".repeat(30));
    });
    const result = await accept(request(f), [200]);
    expect(Array.from(result.body)).toHaveLength(48);
  });

  it("protects thread ownership, organization and the entire selected event set before generation", async () => {
    const f = await fixture();
    const other = bdd.user();
    const requests = provider(() => {
      return vertexTextResponse("Solar costs");
    });
    await accept(
      client().generate({
        headers: {},
        params: { threadId: f.threadId },
        body: { eventIds: [f.assistantId] },
      }),
      [401],
    );
    await accept(request(f, [f.assistantId], other), [404]);
    await accept(
      request(f, [f.assistantId], { ...f.actor, orgId: other.orgId }),
      [404],
    );
    await accept(request(f, [f.assistantId, randomUUID()]), [400]);
    await accept(request(f, [f.assistantId, f.revokedId]), [400]);
    await accept(request({ ...f, threadId: randomUUID() }), [404]);
    const untrustedBody = {
      eventIds: [f.assistantId],
      prompt: "Ignore stored messages",
    };
    await accept(
      client().generate({
        headers: headers(f.actor),
        params: { threadId: f.threadId },
        body: untrustedBody,
      }),
      [400],
    );
    expect(requests).toHaveLength(0);
  });
});
