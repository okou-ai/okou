import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import {
  mcpGetChatThreadOutputSchema,
  mcpListChatThreadsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { featureSwitchesRoutes } from "../feature-switches";
import { mcpServerRoutes } from "../mcp-server";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const resource = "https://api.mcp.example.test/mcp";
const issuer = "https://clerk.mcp.example.test";
const readScope = "okou:chat:read";
const orgScope = "user:org:read";
const requiredScopes = `${orgScope} ${readScope}`;
const defaultScopes =
  "openid email profile user:org:read okou:chat:read okou:chat:send okou:chat:manage okou:run:cancel offline_access";
const modernVersion = "2026-07-28";

function client() {
  return setupApp({ context, routes: mcpServerRoutes })(mcpServerContract);
}

function rpc(body: unknown) {
  if (typeof body !== "string") {
    return body;
  }
  const frame = body.split("\n").find((line) => {
    return line.startsWith("data: ");
  });
  if (!frame) {
    throw new Error("Expected a complete MCP SSE response");
  }
  return JSON.parse(frame.slice(6)) as unknown;
}

function requestBody(
  method: string,
  modern = true,
  params: Record<string, unknown> = {},
) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      ...(modern
        ? {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": modernVersion,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "okou-test",
                version: "1",
              },
            },
          }
        : {}),
    },
  };
}

function protocolHeaders(
  token: string,
  method: string,
  modern = true,
  toolName = "list_chat_threads",
) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": modern ? modernVersion : "2025-11-25",
    ...(modern ? { "MCP-Method": method } : {}),
    ...(modern && method === "tools/call" ? { "MCP-Name": toolName } : {}),
  };
}

async function fixture(enabled = true) {
  mockEnv("MCP_RESOURCE_URL", resource);
  mockEnv("MCP_OAUTH_ISSUER", issuer);
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
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
  createRouteMocks(context).clerk.session(userId, orgId);
  if (enabled) {
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).update({
        headers: { authorization: "Bearer clerk-session" },
        body: { switches: { [FeatureSwitchKey.McpServer]: true } },
      }),
      [200],
    );
  }
  function token(overrides: Record<string, unknown> = {}, typ = "at+jwt") {
    const seconds = Math.floor(now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid, typ }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: resource,
        sub: userId,
        org_id: orgId,
        client_id: "mcp_test_client",
        scope: requiredScopes,
        iat: seconds,
        nbf: seconds - 1,
        exp: seconds + 3600,
        ...overrides,
      }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  }
  return { token, userId, orgId };
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await accept(
    client().request({
      extraHeaders: protocolHeaders(token, "tools/call", true, name),
      body: requestBody("tools/call", true, { name, arguments: args }),
    }),
    [200],
  );
  return z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        content: z.array(
          z.object({ type: z.literal("text"), text: z.string() }),
        ),
        structuredContent: z.unknown().optional(),
      }),
    })
    .parse(rpc(response.body)).result;
}

async function listThreads(token: string, args: Record<string, unknown> = {}) {
  const result = await callTool(token, "list_chat_threads", args);
  expect(result.isError).not.toBeTruthy();
  return mcpListChatThreadsOutputSchema.parse(result.structuredContent);
}

async function getThread(token: string, threadId: string) {
  const result = await callTool(token, "get_chat_thread", { threadId });
  expect(result.isError).not.toBeTruthy();
  return mcpGetChatThreadOutputSchema.parse(result.structuredContent);
}

async function threadFixture() {
  const auth = await fixture();
  const bdd = createBddApi(context);
  const chat = createChatFilesBddApi(context);
  const actor = bdd.user({ userId: auth.userId, orgId: auth.orgId });
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "MCP discovery agent",
    visibility: "private",
  });
  return { auth, actor, agent, bdd, chat };
}

async function chatRunFixture() {
  const auth = await fixture();
  const bdd = createBddApi(context);
  const chat = createChatFilesBddApi(context);
  const actor = bdd.user({ userId: auth.userId, orgId: auth.orgId });
  const runs = createRunsApi(context);
  const callbacks = createChatCallbacksApi(context);
  runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "MCP activity agent",
    visibility: "private",
  });
  return { auth, actor, chat, agent, runs };
}

describe("external MCP entry", () => {
  it("publishes public cross-origin metadata without authentication", async () => {
    mockEnv("MCP_RESOURCE_URL", resource);
    mockEnv("MCP_OAUTH_ISSUER", issuer);
    const response = await accept(
      client().metadata({
        extraHeaders: { Origin: "https://client.example.test" },
      }),
      [200],
    );
    expect(response.body).toMatchObject({
      resource,
      authorization_servers: [issuer],
      scopes_supported: defaultScopes.split(" "),
      bearer_methods_supported: ["header"],
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("isolates absent MCP configuration from first-party feature access", async () => {
    mockEnv("MCP_RESOURCE_URL", undefined);
    mockEnv("MCP_OAUTH_ISSUER", undefined);
    await expect(client().metadata()).resolves.toMatchObject({ status: 503 });
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });

  it("challenges unauthenticated calls and ignores a session cookie", async () => {
    await fixture();
    const response = await accept(
      client().request({
        body: requestBody("tools/list"),
        extraHeaders: { cookie: "__session=clerk-session" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({ error: "unauthorized" });
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="https://api.mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="${defaultScopes}"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    { modern: true, scopes: requiredScopes },
    { modern: false, scopes: requiredScopes },
    { modern: true, scopes: defaultScopes },
    { modern: false, scopes: defaultScopes },
  ])(
    "discovers and calls chat discovery with modern=$modern and scopes=$scopes",
    async ({ modern, scopes }) => {
      const auth = await fixture();
      const token = auth.token({ scope: scopes });
      if (!modern) {
        const initialized = await accept(
          client().request({
            extraHeaders: protocolHeaders(token, "initialize", false),
            body: {
              jsonrpc: "2.0",
              id: 0,
              method: "initialize",
              params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "okou-test", version: "1" },
              },
            },
          }),
          [200],
        );
        expect(rpc(initialized.body)).toMatchObject({
          result: { protocolVersion: "2025-11-25" },
        });
      }
      const listed = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/list", modern),
          body: requestBody("tools/list", modern),
        }),
        [200],
      );
      expect(rpc(listed.body)).toMatchObject({
        result: {
          tools: [
            { name: "list_chat_threads", annotations: { readOnlyHint: true } },
            { name: "get_chat_thread", annotations: { readOnlyHint: true } },
          ],
        },
      });
      const result = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/call", modern),
          body: requestBody("tools/call", modern, {
            name: "list_chat_threads",
            arguments: {},
          }),
        }),
        [200],
      );
      expect(rpc(result.body)).toMatchObject({
        result: {
          structuredContent: {
            threads: [],
            nextCursor: null,
            unreadCoverage: "retained_terminal_events_and_native_deliveries",
          },
          content: [{ type: "text" }],
        },
      });
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(result.headers.get("content-type")).toContain(
        modern ? "application/json" : "text/event-stream",
      );
      if (!modern) {
        expect(typeof result.body).toBe("string");
      }
    },
  );

  it.each([true, false])(
    "works with the generic MCP SDK client with modern=%s",
    async (modern) => {
      const auth = await fixture();
      const app = createAppWithRoutes({
        routes: mcpServerRoutes,
        signal: context.signal,
      });
      const transport = new StreamableHTTPClientTransport(new URL(resource), {
        authProvider: {
          token: () => {
            return Promise.resolve(auth.token());
          },
        },
        fetch: async (input, init) => {
          return await app.request(new Request(input, init));
        },
      });
      const sdk = new Client(
        { name: "okou-interoperability-test", version: "1" },
        {
          versionNegotiation: {
            mode: modern ? { pin: modernVersion } : "legacy",
          },
        },
      );
      onTestFinished(() => {
        return sdk.close();
      });
      await sdk.connect(transport);
      expect(sdk.getDiscoverResult() !== undefined).toBe(modern);
      const tools = await sdk.listTools();
      expect(
        tools.tools.map((tool) => {
          return tool.name;
        }),
      ).toStrictEqual(["list_chat_threads", "get_chat_thread"]);
      const result = await sdk.callTool({
        name: "list_chat_threads",
        arguments: {},
      });
      expect(result).toMatchObject({
        structuredContent: { threads: [], nextCursor: null },
      });
      const missing = await sdk.callTool({
        name: "get_chat_thread",
        arguments: { threadId: randomUUID() },
      });
      expect(missing.isError).toBeTruthy();
    },
  );

  it.each([
    { iss: "https://other-clerk.example.test" },
    { aud: "https://different-resource.example.test/mcp" },
    { aud: undefined },
    { org_id: undefined },
    { client_id: undefined },
    { sub: "machine_client" },
    { exp: 1 },
    { nbf: 9_000_000_000 },
  ])("rejects invalid access claims %j", async (claims) => {
    const auth = await fixture();
    const result = await accept(
      client().request({
        extraHeaders: protocolHeaders(auth.token(claims), "tools/list"),
        body: requestBody("tools/list"),
      }),
      [401],
    );
    expect(result.body).toStrictEqual({ error: "invalid_token" });
  });

  it.each(["JWT", "id+jwt"])(
    "rejects the signed %s token type",
    async (type) => {
      const auth = await fixture();
      const response = await accept(
        client().request({
          extraHeaders: protocolHeaders(auth.token({}, type), "tools/list"),
          body: requestBody("tools/list"),
        }),
        [401],
      );
      expect(response.body).toStrictEqual({ error: "invalid_token" });
    },
  );

  it("rejects a tampered signature", async () => {
    const auth = await fixture();
    const pieces = auth.token().split(".");
    const token = `${pieces[0]}.${pieces[1]}.${Buffer.alloc(256).toString("base64url")}`;
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(token, "tools/list"),
        body: requestBody("tools/list"),
      }),
      [401],
    );
    expect(response.body).toStrictEqual({ error: "invalid_token" });
    expect(response.headers.get("www-authenticate")).toContain(
      `scope="${defaultScopes}"`,
    );
  });

  it("denies discovery and manual invocation without the read grant", async () => {
    const auth = await fixture();
    const token = auth.token({ scope: "okou:chat:manage" });
    for (const { method, name, args } of [
      { method: "tools/list", name: "list_chat_threads", args: {} },
      { method: "tools/call", name: "list_chat_threads", args: {} },
      {
        method: "tools/call",
        name: "get_chat_thread",
        args: { threadId: randomUUID() },
      },
    ]) {
      const result = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, method, true, name),
          body: requestBody(method, true, {
            name,
            arguments: args,
          }),
        }),
        [403],
      );
      expect(result.body).toStrictEqual({ error: "insufficient_scope" });
    }
  });

  it("requests organization consent when only the application read scope is granted", async () => {
    const auth = await fixture();
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(
          auth.token({ scope: readScope }),
          "tools/list",
        ),
        body: requestBody("tools/list"),
      }),
      [403],
    );
    expect(response.body).toStrictEqual({ error: "insufficient_scope" });
    expect(response.headers.get("www-authenticate")).toContain(
      `scope="${requiredScopes}"`,
    );
  });

  it("requires the feature override in the selected organization", async () => {
    const auth = await fixture(false);
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list"),
      }),
      [403],
    );
    expect(response.body).toMatchObject({ error: "access_denied" });
  });

  it("does not share feature authority across concurrent principals", async () => {
    const auth = await fixture();
    const otherUser = `user_${randomUUID()}`;
    const responses = await Promise.all([
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list"),
      }),
      client().request({
        extraHeaders: protocolHeaders(
          auth.token({ sub: otherUser }),
          "tools/list",
        ),
        body: requestBody("tools/list"),
      }),
    ]);
    expect(
      responses.map((item) => {
        return item.status;
      }),
    ).toStrictEqual([200, 403]);
  });

  it("rejects an organization outside current membership", async () => {
    const auth = await fixture();
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(
          auth.token({ org_id: `org_${randomUUID()}` }),
          "tools/list",
        ),
        body: requestBody("tools/list"),
      }),
      [401],
    );
    expect(response.body).toStrictEqual({ error: "invalid_token" });
  });

  it("keeps membership outages distinct from invalid credentials", async () => {
    const auth = await fixture();
    context.mocks.clerk.users.getOrganizationMembershipList.mockRejectedValue(
      new Error("Provider unavailable"),
    );
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list"),
      }),
      [503],
    );
    expect(response.body).toMatchObject({ error: "temporarily_unavailable" });
  });

  it("rejects a removed member after the bounded membership cache expires", async () => {
    const auth = await fixture();
    const token = auth.token();
    const read = () => {
      return client().request({
        extraHeaders: protocolHeaders(token, "tools/list"),
        body: requestBody("tools/list"),
      });
    };
    await expect(read()).resolves.toMatchObject({ status: 200 });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
      totalCount: 0,
    });
    const response = await withMockNowForTest(now() + 61_000, read);
    expect(response).toMatchObject({
      status: 401,
      body: { error: "invalid_token" },
    });
  });

  it.each([
    { scope: undefined, scp: [orgScope, readScope] },
    { scope: requiredScopes, scp: [orgScope, readScope] },
    { aud: ["https://another.example.test", resource] },
  ])("accepts the supported signed claim representation %j", async (claims) => {
    const auth = await fixture();
    await expect(
      client().request({
        extraHeaders: protocolHeaders(auth.token(claims), "tools/list"),
        body: requestBody("tools/list"),
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it.each([
    { scope: requiredScopes, scp: ["okou:chat:manage"] },
    {
      scope: `${requiredScopes} ${readScope}`,
      scp: [orgScope, readScope, "okou:chat:manage"],
    },
  ])("rejects disagreeing signed scope claims %j", async (claims) => {
    const auth = await fixture();
    await expect(
      client().request({
        extraHeaders: protocolHeaders(auth.token(claims), "tools/list"),
        body: requestBody("tools/list"),
      }),
    ).resolves.toMatchObject({ status: 401, body: { error: "invalid_token" } });
  });

  it("acknowledges legacy initialization notifications without caching them", async () => {
    const auth = await fixture();
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(
          auth.token(),
          "notifications/initialized",
          false,
        ),
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      }),
      [202],
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps signing-key outages distinct from invalid credentials", async () => {
    const auth = await fixture();
    server.use(
      http.get("https://api.clerk.com/v1/jwks", () => {
        return HttpResponse.json({ error: "unavailable" }, { status: 503 });
      }),
    );
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list"),
      }),
      [503],
    );
    expect(response.body).toMatchObject({ error: "temporarily_unavailable" });
  });

  it("rejects organization overrides in tool arguments", async () => {
    const auth = await fixture();
    const response = await client().request({
      extraHeaders: protocolHeaders(auth.token(), "tools/call"),
      body: requestBody("tools/call", true, {
        name: "list_chat_threads",
        arguments: { orgId: "org_foreign" },
      }),
    });
    expect(rpc(response.body)).toMatchObject({
      result: {
        isError: true,
        content: [
          { type: "text", text: expect.stringContaining("Unrecognized key") },
        ],
      },
    });
  });

  it("rejects an unknown tool through the SDK", async () => {
    const name = "unknown_tool";
    const auth = await fixture();
    const response = await client().request({
      extraHeaders: {
        ...protocolHeaders(auth.token(), "tools/call"),
        "MCP-Name": name,
      },
      body: requestBody("tools/call", true, {
        name,
        arguments: {},
      }),
    });
    expect(
      z
        .object({ error: z.object({ code: z.number() }) })
        .parse(rpc(response.body)).error.code,
    ).toBeLessThan(0);
  });

  it("rejects standalone stateless sessions", async () => {
    const auth = await fixture();
    const extraHeaders = protocolHeaders(auth.token(), "tools/list", false);
    await expect(client().get({ extraHeaders })).resolves.toMatchObject({
      status: 405,
    });
    await expect(client().delete({ extraHeaders })).resolves.toMatchObject({
      status: 405,
    });
  });

  it.each(["https://untrusted.example.test", "null", ""])(
    "rejects Origin %s before authorization",
    async (origin) => {
      await fixture();
      const response = await accept(
        client().request({
          extraHeaders: { Origin: origin },
          body: requestBody("tools/list"),
        }),
        [403],
      );
      expect(response.body).toStrictEqual({ error: "Forbidden Origin" });
    },
  );

  it("rejects an unlisted browser origin's preflight and authorized request", async () => {
    const auth = await fixture();
    const origin = "https://client.example.test";
    const raw = setupRawAppRequest({ context, routes: mcpServerRoutes });
    const preflight = await raw("/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,mcp-protocol-version,mcp-method",
      },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.body).toStrictEqual({ error: "Forbidden Origin" });
    const result = await accept(
      client().request({
        extraHeaders: {
          ...protocolHeaders(auth.token(), "tools/list"),
          Origin: origin,
        },
        body: requestBody("tools/list"),
      }),
      [403],
    );
    expect(result.body).toStrictEqual({ error: "Forbidden Origin" });
    expect(result.headers.get("access-control-allow-origin")).toBeNull();
    expect(result.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("bounds the request body before SDK dispatch", async () => {
    const auth = await fixture();
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list", true, {
          padding: "x".repeat(64 * 1024),
        }),
      }),
      [413],
    );
    expect(response.status).toBe(413);
  });

  it("allows an SSE consumer to cancel without affecting the next request", async () => {
    const auth = await fixture();
    const app = createAppWithRoutes({
      routes: mcpServerRoutes,
      signal: context.signal,
    });
    const response = await app.request(resource, {
      method: "POST",
      headers: {
        ...protocolHeaders(auth.token(), "tools/call", false),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        requestBody("tools/call", false, {
          name: "list_chat_threads",
          arguments: {},
        }),
      ),
    });
    expect(response.status).toBe(200);
    if (!response.body) {
      throw new Error("Expected an SSE body");
    }
    await response.body.cancel();
    await expect(
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list"),
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("filters before pagination and treats title wildcards literally", async () => {
    const f = await threadFixture();
    const first = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Launch 100%_DONE first",
    });
    const second = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Launch 100%_DONE second",
    });
    await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Launch 100XX_DONE wildcard decoy",
    });
    await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Most recent unrelated thread",
    });
    const otherAgent = await f.bdd.createAgent(f.actor, {
      displayName: "Other discovery agent",
      visibility: "private",
    });
    await f.chat.createThread(f.actor, {
      agentId: otherAgent.agentId,
      title: "Launch 100%_DONE different Agent",
    });
    const token = f.auth.token();
    const filters = {
      agentId: f.agent.agentId,
      title: "100%_done",
      activity: "idle",
      unread: false,
      limit: 1,
    };
    const page = await listThreads(token, filters);
    expect(
      page.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([second.id]);
    expect(page.nextCursor).not.toBeNull();
    const next = await listThreads(token, {
      ...filters,
      cursor: page.nextCursor,
    });
    expect(
      next.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([first.id]);
    expect(next.nextCursor).toBeNull();
    expect(next.unreadCoverage).toBe(
      "retained_terminal_events_and_native_deliveries",
    );

    const current = await getThread(token, second.id);
    const instant = Date.parse(current.thread.lastMessageAt);
    const windowed = await listThreads(token, {
      ...filters,
      title: "second",
      since: new Date(instant - 1).toISOString(),
      before: new Date(instant + 1).toISOString(),
    });
    expect(
      windowed.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([second.id]);
    const outside = await listThreads(token, {
      ...filters,
      since: new Date(instant + 1).toISOString(),
    });
    expect(outside.threads).toStrictEqual([]);
  });

  it("reads empty threads and current metadata without changing read, pin or lifecycle state", async () => {
    const f = await threadFixture();
    const created = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Original discovery title",
    });
    await f.chat.pinThread(f.actor, created.id);
    const before = {
      metadata: await f.chat.readThreadMetadata(f.actor, created.id),
      detail: await f.chat.readThread(f.actor, created.id),
      events: (await f.chat.requestThreadEvents(f.actor, {}, [200])).body,
      draft: await f.chat.readThreadDraft(f.actor, created.id),
    };
    const token = f.auth.token();
    const detail = await getThread(token, created.id);
    expect(detail.thread).toMatchObject({
      threadId: created.id,
      title: "Original discovery title",
      titleTruncated: false,
      agent: { agentId: f.agent.agentId, name: "MCP discovery agent" },
      activity: { queued: false, pending: false, running: false },
      unread: false,
      model: {
        selectedModel: before.metadata.selectedModel,
        effectiveModel: before.metadata.selectedModel,
        source: "thread",
        admission: "checked_on_send",
      },
    });
    expect(new URL(detail.thread.url).pathname).toBe(`/chats/${created.id}`);
    expect((await listThreads(token)).threads).toStrictEqual([detail.thread]);
    await expect(getThread(token, created.id)).resolves.toStrictEqual(detail);
    expect({
      metadata: await f.chat.readThreadMetadata(f.actor, created.id),
      detail: await f.chat.readThread(f.actor, created.id),
      events: (await f.chat.requestThreadEvents(f.actor, {}, [200])).body,
      draft: await f.chat.readThreadDraft(f.actor, created.id),
    }).toStrictEqual(before);

    await f.chat.renameThread(f.actor, created.id, "Renamed discovery title");
    expect(
      (await listThreads(token, { title: "Original discovery title" })).threads,
    ).toStrictEqual([]);
    expect((await getThread(token, created.id)).thread.title).toBe(
      "Renamed discovery title",
    );
    await f.chat.deleteThread(f.actor, created.id);
    expect((await listThreads(token)).threads).toStrictEqual([]);
    const deleted = await callTool(token, "get_chat_thread", {
      threadId: created.id,
    });
    const missing = await callTool(token, "get_chat_thread", {
      threadId: randomUUID(),
    });
    expect(deleted.isError).toBeTruthy();
    expect(deleted).toStrictEqual(missing);
  });

  it("reflects a changed model pin and resolves a cleared pin without rewriting it", async () => {
    const f = await threadFixture();
    const runs = createRunsApi(context);
    const { providerId } = await runs.ensureOrgModelProvider(f.actor);
    await runs.updateOrgModelPolicies(
      f.actor,
      (["claude-sonnet-5", "claude-sonnet-4-6"] as const).map((model) => {
        return {
          model,
          isDefault: model === "claude-sonnet-5",
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        };
      }),
    );
    const created = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Current model",
      model: "claude-sonnet-5",
    });
    const token = f.auth.token();
    await f.chat.updateThreadModelSelection(
      f.actor,
      created.id,
      "claude-sonnet-4-6",
    );
    expect((await getThread(token, created.id)).thread.model).toStrictEqual({
      selectedModel: "claude-sonnet-4-6",
      effectiveModel: "claude-sonnet-4-6",
      source: "thread",
      admission: "checked_on_send",
    });
    await f.chat.updateThreadModelSelection(f.actor, created.id, null);
    const before = await f.chat.readThreadMetadata(f.actor, created.id);
    const model = (await getThread(token, created.id)).thread.model;
    expect(model).toMatchObject({
      selectedModel: null,
      effectiveModel: "claude-sonnet-5",
      admission: "checked_on_send",
    });
    expect(["member_default", "org_default"]).toContain(model.source);
    await expect(
      f.chat.readThreadMetadata(f.actor, created.id),
    ).resolves.toStrictEqual(before);
  });

  it("rejects tampered, changed-filter and expired cursors with a fresh-traversal path", async () => {
    const f = await threadFixture();
    for (const title of ["Cursor first", "Cursor second", "Cursor third"]) {
      await f.chat.createThread(f.actor, { agentId: f.agent.agentId, title });
    }
    const filters = { title: "Cursor", limit: 1 };
    const first = await listThreads(f.auth.token(), filters);
    if (!first.nextCursor) {
      throw new Error("Expected a continuation cursor");
    }
    const cursor = first.nextCursor;
    const tampered = `${cursor.startsWith("A") ? "B" : "A"}${cursor.slice(1)}`;
    for (const args of [
      { ...filters, cursor: tampered },
      { ...filters, cursor, title: "different" },
      { ...filters, cursor, activity: "idle" },
    ]) {
      const result = await callTool(f.auth.token(), "list_chat_threads", args);
      expect(result.isError).toBeTruthy();
      expect(result.structuredContent).toBeUndefined();
    }
    const second = await listThreads(f.auth.token(), { ...filters, cursor });
    const ids = [...first.threads, ...second.threads].map((thread) => {
      return thread.threadId;
    });
    expect(new Set(ids).size).toBe(2);
    const expiryToken = f.auth.token({
      exp: Math.floor((now() + 2 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      const expired = await callTool(expiryToken, "list_chat_threads", {
        ...filters,
        cursor,
      });
      expect(expired.isError).toBeTruthy();
      expect((await listThreads(expiryToken, filters)).threads).toHaveLength(1);
    });
  });

  it("never discloses a peer's or another organization's thread through list or detail", async () => {
    const f = await threadFixture();
    const own = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Owned thread",
    });
    const ownSecond = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Owned second thread",
    });
    const strangers = [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ];
    const token = f.auth.token();
    const first = await listThreads(token, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const missing = await callTool(token, "get_chat_thread", {
      threadId: randomUUID(),
    });
    for (const actor of strangers) {
      const agent = await f.bdd.createAgent(actor, {
        displayName: "Hidden Agent",
        visibility: "private",
      });
      const thread = await f.chat.createThread(actor, {
        agentId: agent.agentId,
        title: "Hidden thread",
      });
      await expect(
        callTool(token, "get_chat_thread", { threadId: thread.id }),
      ).resolves.toStrictEqual(missing);
      expect(
        (await listThreads(token, { agentId: agent.agentId })).threads,
      ).toStrictEqual([]);
      if (!actor.orgId) {
        throw new Error("Expected an organization for a peer fixture");
      }
      await updateFeatureSwitchesForUser(
        context,
        { userId: actor.userId, orgId: actor.orgId },
        {
          [FeatureSwitchKey.McpServer]: true,
        },
      );
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [f.auth.orgId, actor.orgId].map((orgId) => {
            return {
              id: randomUUID(),
              role: "org:member",
              organization: { id: orgId },
            };
          }),
          totalCount: 2,
        },
      );
      const foreignCursor = await callTool(
        f.auth.token({ sub: actor.userId, org_id: actor.orgId }),
        "list_chat_threads",
        { limit: 1, cursor: first.nextCursor },
      );
      expect(foreignCursor.isError).toBeTruthy();
    }
    expect(missing.isError).toBeTruthy();
    expect(
      (await listThreads(token)).threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([ownSecond.id, own.id]);
  });

  it("bounds Unicode titles and preserves an allowed Unicode Agent name", async () => {
    const f = await threadFixture();
    const longName = "😀".repeat(256);
    const longTitle = "🚀".repeat(700);
    const agent = await f.bdd.createAgent(f.actor, {
      displayName: longName,
      visibility: "private",
    });
    const created = await f.chat.createThread(f.actor, {
      agentId: agent.agentId,
      title: longTitle,
    });
    const detail = await getThread(f.auth.token(), created.id);
    expect(detail.thread.titleTruncated).toBeTruthy();
    expect(detail.thread.agent.name).toBe(longName);
    expect(detail.thread.title?.length).toBeLessThanOrEqual(1000);
    expect(detail.thread.agent.name).toHaveLength(512);
    expect(detail.thread.title?.endsWith("🚀")).toBeTruthy();
    expect(detail.thread.agent.name.endsWith("😀")).toBeTruthy();
  });

  it("projects canonical run activity and unread without the sparse seven-day cap", async () => {
    const f = await chatRunFixture();
    const sent = await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        prompt: "Track canonical activity",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a started run");
    }
    const threadId = sent.body.threadId;
    await flushWaitUntilForTest();
    const active = await listThreads(f.auth.token(), { activity: "active" });
    expect(
      active.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([threadId]);
    expect(active.threads[0]?.activity).toStrictEqual({
      queued: false,
      pending: true,
      running: false,
    });
    expect(
      (await listThreads(f.auth.token(), { unread: true })).threads,
    ).toStrictEqual([]);

    await f.runs.requestCancelRun(f.actor, sent.body.runId, [200]);
    await flushWaitUntilForTest();
    await expect
      .poll(async () => {
        return (await f.chat.listThreadEvents(f.actor, threadId)).events.some(
          (event) => {
            return (
              event.eventType === "run.cancelled" &&
              event.runId === sent.body.runId
            );
          },
        );
      })
      .toBe(true);
    await f.chat.markThreadUnread(f.actor, threadId);
    const before = await f.chat.readThread(f.actor, threadId);
    const unread = await listThreads(f.auth.token(), {
      unread: true,
      activity: "idle",
    });
    expect(
      unread.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([threadId]);
    expect(
      (await getThread(f.auth.token(), threadId)).thread.unread,
    ).toBeTruthy();
    await expect(f.chat.readThread(f.actor, threadId)).resolves.toStrictEqual(
      before,
    );
    const retainedToken = f.auth.token({
      exp: Math.floor((now() + 9 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 8 * 24 * 60 * 60 * 1000, async () => {
      expect((await f.chat.listIndicators(f.actor)).threads).toStrictEqual({});
      expect(
        (await listThreads(retainedToken, { unread: true })).threads.map(
          (thread) => {
            return thread.threadId;
          },
        ),
      ).toStrictEqual([threadId]);
    });
    await f.chat.markThreadRead(f.actor, threadId);
    expect(
      (await listThreads(f.auth.token(), { unread: true })).threads,
    ).toStrictEqual([]);
    expect(
      (await getThread(f.auth.token(), threadId)).thread.unread,
    ).toBeFalsy();
  });

  it("continues pagination through intervening rename and deletion", async () => {
    const f = await threadFixture();
    const threads: { id: string }[] = [];
    for (const title of ["Page first", "Page second", "Page third"]) {
      const thread = await f.chat.createThread(f.actor, {
        agentId: f.agent.agentId,
        title,
      });
      threads.push(thread);
    }
    const token = f.auth.token();
    const expected = threads
      .map((thread) => {
        return thread.id;
      })
      .reverse();
    const first = await listThreads(token, {
      agentId: f.agent.agentId,
      limit: 1,
    });
    expect(
      first.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual(expected.slice(0, 1));
    const renamedId = expected[1];
    const deletedId = expected[2];
    if (!first.nextCursor || !renamedId || !deletedId) {
      throw new Error("Expected three threads and a continuation cursor");
    }
    await f.chat.renameThread(f.actor, renamedId, "Renamed between pages");
    await f.chat.deleteThread(f.actor, deletedId);
    const next = await listThreads(token, {
      agentId: f.agent.agentId,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(
      next.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([renamedId]);
    expect(next.threads[0]?.title).toBe("Renamed between pages");
    expect(next.nextCursor).toBeNull();
    const fresh = await listThreads(token, { agentId: f.agent.agentId });
    expect(
      fresh.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual(expected.slice(0, 2));
  });

  it("accepts a nonempty timestamp range smaller than one millisecond", async () => {
    const auth = await fixture();
    const page = await listThreads(auth.token(), {
      since: "2026-09-18T00:00:00.000001Z",
      before: "2026-09-18T00:00:00.000002Z",
    });
    expect(page.threads).toStrictEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    { limit: 0 },
    { limit: 51 },
    { since: "2026-09-18T00:00:00Z", before: "2026-09-17T00:00:00Z" },
    { activity: "completed" },
    { cursor: "x".repeat(4097) },
  ])("rejects invalid list arguments %j", async (args) => {
    const auth = await fixture();
    expect(
      (await callTool(auth.token(), "list_chat_threads", args)).isError,
    ).toBeTruthy();
  });

  it("returns canonical activity isolated to each signed organization", async () => {
    const auth = await fixture();
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const chat = createChatFilesBddApi(context);
    const callbacks = createChatCallbacksApi(context);
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    callbacks.acceptChatObjectStorage();
    callbacks.disableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const actors = [
      bdd.user({ userId: auth.userId, orgId: auth.orgId }),
      bdd.user({ userId: auth.userId, orgId: `org_${randomUUID()}` }),
    ];
    const expected: { threadId: string; agentId: string }[] = [];
    for (const actor of actors) {
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "MCP indicators",
        visibility: "private",
      });
      const sent = await chat.requestSendEvent(
        actor,
        { agentId: agent.agentId, prompt: "Read my indicators" },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected an active chat thread");
      }
      createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
      await accept(
        setupApp({ context, routes: featureSwitchesRoutes })(
          featureSwitchesContract,
        ).update({
          headers: { authorization: "Bearer clerk-session" },
          body: { switches: { [FeatureSwitchKey.McpServer]: true } },
        }),
        [200],
      );
      const projection = await chat.listIndicators(actor);
      expect(projection).toStrictEqual({
        agents: { [agent.agentId]: "active" },
        threads: { [sent.body.threadId]: "active" },
      });
      expected.push({ threadId: sent.body.threadId, agentId: agent.agentId });
    }
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: actors.map((actor) => {
        return {
          id: randomUUID(),
          role: "org:member",
          organization: { id: actor.orgId },
        };
      }),
      totalCount: 2,
    });
    const results = await Promise.all(
      actors.map((actor) => {
        return accept(
          client().request({
            extraHeaders: protocolHeaders(
              auth.token({ org_id: actor.orgId }),
              "tools/call",
            ),
            body: requestBody("tools/call", true, {
              name: "list_chat_threads",
              arguments: {},
            }),
          }),
          [200],
        );
      }),
    );
    expect(
      results.map((result) => {
        const output = z
          .object({ result: z.object({ structuredContent: z.unknown() }) })
          .parse(rpc(result.body)).result.structuredContent;
        const page = mcpListChatThreadsOutputSchema.parse(output);
        expect(page.threads).toHaveLength(1);
        const thread = page.threads[0];
        if (!thread) {
          throw new Error("Expected one owned active thread");
        }
        expect(Object.values(thread.activity).some(Boolean)).toBeTruthy();
        expect(thread.unread).toBeFalsy();
        return { threadId: thread.threadId, agentId: thread.agent.agentId };
      }),
    ).toStrictEqual(expected);
  });
});
