import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mcpGetChatThreadOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { http, HttpResponse } from "msw";
import { z } from "zod";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mcpServerRoutes } from "../mcp-server";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { modelCatalogRoutes } from "../model-catalog";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { signSandboxJwtForTests } from "../../auth/tokens";

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const {
  api,
  chat,
  chatCallbacks,
  misc,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  cancelChatRun,
  seedBuiltInModelKey,
  configureSubscriptionPiModel,
} = createChatEventsFixture(context);

const MCP_RESOURCE = "https://api.mcp.example.test/mcp";
const MCP_ISSUER = "https://clerk.mcp.example.test";
const MCP_PROTOCOL_VERSION = "2026-07-28";

/** A signed MCP access token for an existing chat actor. */
function mcpAccessToken(actor: ApiTestUser): string {
  const orgId = requireOrgId(actor);
  mockEnv("MCP_RESOURCE_URL", MCP_RESOURCE);
  mockEnv("MCP_OAUTH_ISSUER", MCP_ISSUER);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomUUID();
  server.use(
    http.get("https://api.clerk.com/v1/jwks", () => {
      return HttpResponse.json({
        keys: [
          {
            ...keys.publicKey.export({ format: "jwk" }),
            kid,
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    }),
  );
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      { id: randomUUID(), role: "org:member", organization: { id: orgId } },
    ],
    totalCount: 1,
  });
  const seconds = Math.floor(now() / 1000);
  const encode = (value: Record<string, unknown>) => {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  };
  const input = `${encode({ alg: "RS256", kid, typ: "at+jwt" })}.${encode({
    iss: MCP_ISSUER,
    aud: MCP_RESOURCE,
    sub: actor.userId,
    org_id: orgId,
    client_id: "mcp_test_client",
    scope: "user:org:read okou:chat:read",
    iat: seconds,
    nbf: seconds - 1,
    exp: seconds + 3600,
  })}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}

/** The thread as projected by the MCP `get_chat_thread` tool. */
async function mcpThread(actor: ApiTestUser, threadId: string) {
  const token = mcpAccessToken(actor);
  const response = await accept(
    setupApp({ context, routes: mcpServerRoutes })(mcpServerContract).request({
      extraHeaders: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "MCP-Method": "tools/call",
        "MCP-Name": "get_chat_thread",
      },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_chat_thread",
          arguments: { threadId },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "okou-test",
              version: "1",
            },
          },
        },
      },
    }),
    [200],
  );
  const body: unknown = response.body;
  const frame =
    typeof body === "string"
      ? body.split("\n").find((line) => {
          return line.startsWith("data: ");
        })
      : undefined;
  const rpc: unknown =
    frame === undefined ? body : JSON.parse(frame.slice("data: ".length));
  const { result } = z
    .object({ result: z.object({ structuredContent: z.unknown() }) })
    .parse(rpc);
  return mcpGetChatThreadOutputSchema.parse(result.structuredContent).thread;
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  return actor.orgId;
}

/** Wait for the pick of a queued input and return the run it launched. */
async function pickedRunId(
  actor: ApiTestUser,
  threadId: string,
  clientEventId: string,
): Promise<string> {
  await flushWaitUntilForTest();
  const page = await waitForThreadMessages(actor, threadId, (events) => {
    return userMessages(events).some((message) => {
      return (
        message.revokesEventId === clientEventId && message.runId !== undefined
      );
    });
  });
  const runId = userMessages(page.events).find((message) => {
    return message.revokesEventId === clientEventId;
  })?.runId;
  if (runId === undefined) {
    throw new Error("Expected the queued input to launch a run");
  }
  return runId;
}

/** The thread snapshot and its one model event name the final successor. */
async function expectThreadRewrittenTo(
  actor: ApiTestUser,
  threadId: string,
  successor: string,
): Promise<void> {
  await expect(chat.readThreadMetadata(actor, threadId)).resolves.toMatchObject(
    { selectedModel: successor },
  );
  const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
  if (threadEvents.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }
  expect(
    threadEvents.body.events.filter((event) => {
      return (
        event.chatThreadId === threadId &&
        event.kind === "model_selection_updated"
      );
    }),
  ).toStrictEqual([expect.objectContaining({ selectedModel: successor })]);
}

/** The member's stored default model selection, read through its endpoint. */
async function memberModelPreference(actor: ApiTestUser) {
  const response = await accept(
    setupApp({ context, routes: userModelPreferenceRoutes })(
      userModelPreferenceContract,
    ).get({ headers: authOrgApi.authenticate(actor) }),
    [200],
  );
  return response.body;
}

/** The thread's public events of one kind, in stream order. */
async function threadEventsOfKind(
  actor: ApiTestUser,
  threadId: string,
  kind: "model_selection_updated" | "service_tier_updated",
) {
  const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
  if (threadEvents.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }
  return threadEvents.body.events.filter((event) => {
    return event.chatThreadId === threadId && event.kind === kind;
  });
}

function apiClient() {
  return setupApp({ context, routes: modelCatalogRoutes })(
    modelCatalogContract,
  );
}

describe("GET /api/model-catalog", () => {
  it("returns only fixed Auto without a personal subscription", async () => {
    const actor = authOrgApi.user();
    mocks.clerk.session(actor.userId, actor.orgId ?? null);
    const response = await accept(
      setupApp({ context, routes: modelCatalogRoutes })(
        modelCatalogContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(response.body.systemDefaultModel).toBe("okou-1.0");
    expect(response.body.models).toContainEqual(
      expect.objectContaining({ model: "okou-1.0", displayName: "Auto" }),
    );
    expect(
      response.body.routes.filter((route) => {
        return route.providerType === "built-in";
      }),
    ).toStrictEqual([
      expect.objectContaining({
        model: "okou-1.0",
        providerType: "built-in",
        concreteProviderType: "openrouter-codex",
        upstreamModel: "@preset/okou-1-0",
      }),
    ]);
  });

  it.each(["okou", "sandbox"] as const)(
    "allows authenticated %s tokens to read the catalog without a dedicated capability",
    async (scope) => {
      const actor = authOrgApi.user({ orgRole: "org:member" });
      authOrgApi.mockClerkOrg(actor);
      const seconds = Math.floor(now() / 1000);
      const token = signSandboxJwtForTests({
        scope,
        userId: actor.userId,
        orgId: requireOrgId(actor),
        runId: randomUUID(),
        capabilities: [],
        iat: seconds,
        exp: seconds + 60,
      });

      const response = await accept(
        apiClient().get({ headers: { authorization: `Bearer ${token}` } }),
        [200],
      );

      expect(response.body.models).toContainEqual(
        expect.objectContaining({
          model: response.body.systemDefaultModel,
          displayName: "Auto",
        }),
      );
      expect(response.body.routes.length).toBeGreaterThan(0);
    },
  );

  it("rejects an expired agent token", async () => {
    const actor = authOrgApi.user({ orgRole: "org:member" });
    authOrgApi.mockClerkOrg(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: requireOrgId(actor),
      runId: randomUUID(),
      capabilities: [],
      iat: seconds - 120,
      exp: seconds - 60,
    });

    const response = await apiClient().get({
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
  });

  it("rejects an agent token whose user is no longer an organization member", async () => {
    const actor = authOrgApi.user({ orgRole: "org:member" });
    authOrgApi.mockClerkOrg(actor, { members: [] });
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: requireOrgId(actor),
      runId: randomUUID(),
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await apiClient().get({
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
  });

  it("requires an authenticated organization session", async () => {
    const unauthenticated = await apiClient().get({ headers: {} });
    expect(unauthenticated.status).toBe(401);

    const actor = authOrgApi.user();
    mocks.clerk.session(actor.userId, null);
    const withoutOrganization = await apiClient().get({
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(withoutOrganization.status).toBe(401);
  });
});

describe("public selections of replaced models", () => {
  it("normalizes a requested retired model when creating a thread and runs its successor", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5",
    });

    const projected = await mcpThread(actor, thread.id);
    expect(projected.model).toStrictEqual({
      selectedModel: "claude-fable-5-1",
      effectiveModel: "claude-fable-5-1",
      source: "thread",
      admission: "checked_on_send",
    });

    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "continue the legacy Fable thread",
    });
    const read = await api.readRun(actor, run.runId);
    expect(read.source.model).toBe("claude-fable-5-1");
    expect(read.source.providerType).toBe("claude-code-oauth-token");
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      selectedModel: "claude-fable-5-1",
    });
    expect((await mcpThread(actor, thread.id)).model).toMatchObject({
      selectedModel: "claude-fable-5-1",
      effectiveModel: "claude-fable-5-1",
    });
    await cancelChatRun(actor, run.runId);
  }, 90_000);

  it("rejects an explicitly requested replacement whose subscription was never connected", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const thread = await chat.createThread(actor, { agentId, model: null });
    const before = await chat.listThreadEvents(actor, thread.id);
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt: "request a retired Codex model without a Codex account",
        model: "gpt-5.5",
        clientEventId: randomUUID(),
      },
      [400],
    );
    expect(sent.body).toMatchObject({
      error: {
        message:
          "GPT 5.5 was replaced by GPT 6 Luna, which requires a Codex subscription. Select Auto or connect your Codex subscription.",
      },
    });
    await flushWaitUntilForTest();
    expect(
      (await chat.listThreadEvents(actor, thread.id)).events,
    ).toStrictEqual(before.events);
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({ selectedModel: null });
  }, 90_000);

  it("accepts a pinned model whose retained subscription was disconnected and reports the reconnect error", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const active = await sendChatRun(actor, {
      agentId,
      prompt: "keep the subscription account in use",
      model: "claude-fable-5-1",
    });
    const activeClaim = await claimChatRun(runnerGroup, active.runId);
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    // The running run retains the disconnected account.
    await misc.deletePersonalModelProvider(
      actor,
      "claude-code-oauth-token",
      [204],
    );

    const clientEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt: "continue through my disconnected subscription",
        clientEventId,
      },
      [201],
    );
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      selectedModel: "claude-fable-5-1",
    });
    await cancelChatRun(actor, active.runId, activeClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const page = await waitForThreadMessages(actor, thread.id, (events) => {
      return events.some((event) => {
        return event.eventType === "output.error";
      });
    });
    expect(page.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: clientEventId,
        error: "conflict",
      }),
    );
    expect(page.events).toContainEqual(
      expect.objectContaining({
        eventType: "output.error",
        error: "conflict",
        content:
          "The selected subscription account is unavailable. Reconnect it before starting another run.",
      }),
    );
  }, 90_000);

  it("projects a publicly pinned model as unavailable after its provider is disconnected", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-fable-5-1",
    });
    await misc.deletePersonalModelProvider(
      actor,
      "claude-code-oauth-token",
      [204],
    );
    const projected = await mcpThread(actor, thread.id);
    expect(projected.model).toStrictEqual({
      selectedModel: "claude-fable-5-1",
      effectiveModel: null,
      source: null,
      admission: "checked_on_send",
    });
  }, 90_000);

  it("keeps the queued Auto selection when the active run releases its slot", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    await seedBuiltInModelKey("okou-1.0");
    const active = await sendChatRun(actor, {
      agentId,
      model: null,
      prompt: "keep the thread busy",
    });
    const clientEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        model: null,
        prompt: "queued Auto",
        clientEventId,
      },
      [201],
    );
    await flushWaitUntilForTest();
    await cancelChatRun(actor, active.runId);
    const runId = await pickedRunId(actor, active.threadId, clientEventId);
    expect((await api.readRun(actor, runId)).source.model).toBe("okou-1.0");
    await cancelChatRun(actor, runId);
  }, 90_000);

  it("stores an explicitly requested replaced model as its successor on the thread and member preference", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const thread = await chat.createThread(actor, {
      agentId,
      model: null,
    });

    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "continue on the retired Fable name",
      model: "claude-fable-5",
    });

    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.modelUsageProvider).toBe("claude-fable-5-1");
    expect((await api.readRun(actor, run.runId)).source.model).toBe(
      "claude-fable-5-1",
    );
    await expectThreadRewrittenTo(actor, thread.id, "claude-fable-5-1");
    await expect(memberModelPreference(actor)).resolves.toMatchObject({
      selectedModel: "claude-fable-5-1",
    });
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("clears Fast when an explicitly requested replacement does not offer it", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    await configureSubscriptionPiModel(actor);
    const thread = await chat.createThread(actor, {
      agentId,
      model: "gpt-6-astra",
    });
    await chat.updateThreadModelSelection(actor, thread.id, "gpt-6-astra", {
      codexServiceTier: "fast",
    });
    const tierEvents = await threadEventsOfKind(
      actor,
      thread.id,
      "service_tier_updated",
    );
    const modelEvents = await threadEventsOfKind(
      actor,
      thread.id,
      "model_selection_updated",
    );

    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "continue without Fast",
      model: "claude-fable-5",
    });

    expect((await api.readRun(actor, run.runId)).source.model).toBe(
      "claude-fable-5-1",
    );
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      selectedModel: "claude-fable-5-1",
      serviceTier: null,
    });
    await expect(
      threadEventsOfKind(actor, thread.id, "model_selection_updated"),
    ).resolves.toStrictEqual([
      ...modelEvents,
      expect.objectContaining({ selectedModel: "claude-fable-5-1" }),
    ]);
    await expect(
      threadEventsOfKind(actor, thread.id, "service_tier_updated"),
    ).resolves.toStrictEqual([
      ...tierEvents,
      expect.objectContaining({ serviceTier: null }),
    ]);
    await cancelChatRun(actor, run.runId);
  }, 90_000);
});
