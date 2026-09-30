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
  setModelCatalogSystemDefaultFixture,
  stageLegacyChatThreadSelectedModelFixture,
  stageModelReplacementFixture,
} from "../../../test-fixtures/model-catalog";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mcpServerRoutes } from "../mcp-server";
import { userModelPreferenceRoutes } from "../user-model-preference";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { modelPoliciesRoutes } from "../model-policies";
import { createRouteMocks } from "./helpers/route-test";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { modelCatalogRoutes } from "../model-catalog";

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const {
  api,
  chat,
  chatCallbacks,
  entitledChatActor,
  entitledNativeChatActor,
  sendChatRun,
  waitForThreadMessages,
  cancelChatRun,
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

function signIn(): void {
  const actor = authOrgApi.user({ orgRole: "org:member" });
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
}

function policiesApi() {
  return setupApp({ context, routes: modelPoliciesRoutes })(
    modelPoliciesMainContract,
  );
}

// Tests that mutate the global catalog row live only in this file (its tests
// run sequentially) and restore the row in the same test.
describe("GET /api/model-catalog", () => {
  it("returns the global catalog with replacements resolved", async () => {
    signIn();
    const response = await accept(
      apiClient().get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const { models, routes, systemDefaultModel } = response.body;
    expect(systemDefaultModel).toBe("okou-1.0");
    expect(
      models.filter((row) => {
        return row.isSystemDefault;
      }),
    ).toStrictEqual([
      {
        model: "okou-1.0",
        displayName: "Auto",
        sortOrder: 10,
        isSystemDefault: true,
        replacedBy: null,
        resolvedModel: "okou-1.0",
        priceTier: "$",
      },
    ]);
    expect(
      models.find((row) => {
        return row.model === "claude-fable-5";
      }),
    ).toStrictEqual({
      model: "claude-fable-5",
      displayName: "Claude Fable 5",
      sortOrder: 30,
      isSystemDefault: false,
      replacedBy: "claude-fable-5-1",
      resolvedModel: "claude-fable-5-1",
      priceTier: null,
    });
    expect(
      models.find((row) => {
        return row.model === "claude-fable-5-1";
      })?.resolvedModel,
    ).toBe("claude-fable-5-1");
    // Retired models keep their row and resolve to the approved replacement,
    // including the cross-provider DeepSeek V4 Pro -> GPT 6 Luna.
    expect(
      models
        .filter((row) => {
          return row.replacedBy !== null;
        })
        .map((row) => {
          return [row.model, row.resolvedModel];
        }),
    ).toStrictEqual([
      ["claude-fable-5", "claude-fable-5-1"],
      ["claude-opus-4-8", "claude-opus-5-5"],
      ["claude-sonnet-4-6", "claude-sonnet-5-5"],
      ["gpt-5.5", "gpt-6-luna"],
      ["deepseek-v4-pro", "gpt-6-luna"],
    ]);
    const sortOrders = models.map((row) => {
      return row.sortOrder;
    });
    expect(sortOrders).toStrictEqual(
      [...sortOrders].sort((left, right) => {
        return left - right;
      }),
    );

    expect(
      routes.filter((route) => {
        return route.model === "okou-1.0";
      }),
    ).toStrictEqual([
      {
        model: "okou-1.0",
        providerType: "built-in",
        concreteProviderType: "openrouter-codex",
        subscriptionType: null,
        upstreamModel: "@preset/okou-1-0",
        enabled: true,
        priority: 0,
        serviceTiers: [],
        defaultServiceTier: null,
        efforts: [],
        defaultEffort: null,
        priceTier: "$",
      },
    ]);
    expect(
      routes.filter((route) => {
        return (
          route.model === "gpt-6-astra" &&
          route.providerType === "codex-oauth-token"
        );
      }),
    ).toStrictEqual([
      expect.objectContaining({ subscriptionType: null }),
      expect.objectContaining({
        subscriptionType: "codex-oauth-token",
        serviceTiers: ["priority"],
      }),
    ]);
  });

  it("changes every organization's default when the database default changes", async () => {
    signIn();
    const restore = await setModelCatalogSystemDefaultFixture("gpt-6-luna");
    onTestFinished(restore);

    const catalog = await accept(
      apiClient().get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(catalog.body.systemDefaultModel).toBe("gpt-6-luna");

    const policies = (
      await accept(
        policiesApi().list({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      )
    ).body;
    expect(
      policies.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["gpt-6-luna"]);
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
      model: "claude-fable-5-1",
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
    await cancelChatRun(actor, run.runId);
  }, 90_000);

  it("runs a queued input with the replacement of a model replaced before pick", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(
      actor,
      (["claude-sonnet-5-5", "claude-opus-5-5"] as const).map((model) => {
        return {
          model,
          preferred: model === "claude-sonnet-5-5",
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        };
      }),
    );
    const active = await sendChatRun(actor, {
      agentId,
      prompt: "keep the thread busy",
    });
    const clientEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "run with the model captured at enqueue",
        model: "claude-sonnet-5-5",
        clientEventId,
      },
      [201],
    );
    await flushWaitUntilForTest();

    const restore = await stageModelReplacementFixture(
      "claude-sonnet-5-5",
      "claude-opus-5-5",
    );
    onTestFinished(restore);

    await cancelChatRun(actor, active.runId);
    const runId = await pickedRunId(actor, active.threadId, clientEventId);
    const picked = await api.readRun(actor, runId);
    expect(picked.source.model).toBe("claude-opus-5-5");
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
    const { actor, agentId, providerId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-5-5",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const headers = { authorization: "Bearer clerk-session" };
    mocks.clerk.session(actor.userId, requireOrgId(actor), actor.orgRole);

    const catalog = await accept(apiClient().get({ headers }), [200]);
    expect(
      catalog.body.models.find((row) => {
        return row.model === "test-chain-hop-a";
      }),
    ).toStrictEqual({
      model: "test-chain-hop-a",
      displayName: "Test Chain Hop A",
      sortOrder: 9001,
      isSystemDefault: false,
      replacedBy: "test-chain-hop-b",
      resolvedModel: "claude-opus-5-5",
      priceTier: null,
    });

    const preference = await accept(
      setupApp({ context, routes: userModelPreferenceRoutes })(
        userModelPreferenceContract,
      ).update({
        headers,
        body: { selectedModel: "test-chain-hop-a", serviceTier: null },
      }),
      [200],
    );
    expect(preference.body.selectedModel).toBe("claude-opus-5-5");

    const run = await sendChatRun(actor, {
      agentId,
      model: "test-chain-hop-a",
      prompt: "run through the replacement chain",
    });
    const read = await api.readRun(actor, run.runId);
    expect(read.source.model).toBe("claude-opus-5-5");
    await cancelChatRun(actor, run.runId);
  }, 90_000);
});
