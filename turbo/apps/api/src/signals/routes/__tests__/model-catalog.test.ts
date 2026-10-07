import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mcpGetChatThreadOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { http, HttpResponse } from "msw";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  insertRetiredCatalogRowsFixture,
  stageLegacyChatThreadSelectedModelFixture,
} from "../../../test-fixtures/model-catalog";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mcpServerRoutes } from "../mcp-server";
import { userModelPreferenceRoutes } from "../user-model-preference";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { modelCatalogRoutes } from "../model-catalog";
import { signSandboxJwtForTests } from "../../auth/tokens";

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const {
  api,
  chat,
  chatCallbacks,
  entitledNativeChatActor,
  sendChatRun,
  waitForThreadMessages,
  cancelChatRun,
  seedBuiltInModelKey,
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

describe("stored selections of replaced models", () => {
  it("shows and runs a thread stored with claude-fable-5 as claude-fable-5-1", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const thread = await chat.createThread(actor, {
      agentId,
      model: "okou-1.0",
    });
    await stageLegacyChatThreadSelectedModelFixture({
      threadId: thread.id,
      model: "claude-fable-5",
    });

    const projected = await mcpThread(actor, thread.id);
    expect(projected.model).toStrictEqual({
      selectedModel: "claude-fable-5",
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
    await cancelChatRun(actor, run.runId);
  }, 90_000);

  it("projects a legacy Codex selection without a Codex account as unavailable", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const thread = await chat.createThread(actor, {
      agentId,
      model: "okou-1.0",
    });
    await stageLegacyChatThreadSelectedModelFixture({
      threadId: thread.id,
      model: "gpt-5.6-terra",
    });

    const projected = await mcpThread(actor, thread.id);
    expect(projected.model).toStrictEqual({
      selectedModel: "gpt-5.6-terra",
      effectiveModel: null,
      source: null,
      admission: "checked_on_send",
    });
  }, 90_000);

  it("stores a member preference for okou-1.0-pro as okou-1.0", async () => {
    const { actor } = await entitledNativeChatActor();
    const headers = { authorization: "Bearer clerk-session" };
    mocks.clerk.session(actor.userId, requireOrgId(actor), actor.orgRole);

    const preference = await accept(
      setupApp({ context, routes: userModelPreferenceRoutes })(
        userModelPreferenceContract,
      ).update({
        headers,
        body: { selectedModel: "okou-1.0-pro", serviceTier: null },
      }),
      [200],
    );
    expect(preference.body.selectedModel).toBe("okou-1.0");
  }, 90_000);

  it("keeps the queued Auto selection when the active run releases its slot", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    await seedBuiltInModelKey("okou-1.0");
    const active = await sendChatRun(actor, {
      agentId,
      model: "okou-1.0",
      prompt: "keep the thread busy",
    });
    const clientEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        model: "okou-1.0",
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

  it("resolves a multi-hop replacement chain to the final model", async () => {
    const restore = await insertRetiredCatalogRowsFixture([
      {
        model: "test-chain-hop-b",
        displayName: "Test Chain Hop B",
        sortOrder: 9002,
        lineageRank: 20,
        replacedBy: "claude-opus-5-5",
      },
      {
        model: "test-chain-hop-a",
        displayName: "Test Chain Hop A",
        sortOrder: 9001,
        lineageRank: 10,
        replacedBy: "test-chain-hop-b",
      },
    ]);
    onTestFinished(restore);
    const { actor, agentId } = await entitledNativeChatActor();
    const thread = await chat.createThread(actor, {
      agentId,
      model: "okou-1.0",
    });
    await stageLegacyChatThreadSelectedModelFixture({
      threadId: thread.id,
      model: "test-chain-hop-a",
    });
    const projected = await mcpThread(actor, thread.id);
    expect(projected.model).toMatchObject({
      selectedModel: "test-chain-hop-a",
      effectiveModel: "claude-opus-5-5",
    });
    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "normalize stored retired choices",
    });
    expect((await api.readRun(actor, run.runId)).source.model).toBe(
      "claude-opus-5-5",
    );
    await cancelChatRun(actor, run.runId);
  }, 90_000);
});
