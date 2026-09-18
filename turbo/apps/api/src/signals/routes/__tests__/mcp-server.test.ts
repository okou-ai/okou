import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
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
import { featureSwitchesRoutes } from "../feature-switches";
import { mcpServerRoutes } from "../mcp-server";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";

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

function protocolHeaders(token: string, method: string, modern = true) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": modern ? modernVersion : "2025-11-25",
    ...(modern ? { "MCP-Method": method } : {}),
    ...(modern && method === "tools/call"
      ? { "MCP-Name": "get_indicators" }
      : {}),
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
    "discovers and calls indicators with modern=$modern and scopes=$scopes",
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
            { name: "get_indicators", annotations: { readOnlyHint: true } },
          ],
        },
      });
      const result = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/call", modern),
          body: requestBody("tools/call", modern, {
            name: "get_indicators",
            arguments: {},
          }),
        }),
        [200],
      );
      expect(rpc(result.body)).toMatchObject({
        result: {
          structuredContent: { agents: {}, threads: {} },
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
      ).toStrictEqual(["get_indicators"]);
      const result = await sdk.callTool({
        name: "get_indicators",
        arguments: {},
      });
      expect(result).toMatchObject({
        structuredContent: { agents: {}, threads: {} },
      });
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
    for (const method of ["tools/list", "tools/call"]) {
      const result = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, method),
          body: requestBody(method, true, {
            name: "get_indicators",
            arguments: {},
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
        name: "get_indicators",
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

  it("rejects unknown tools through the SDK", async () => {
    const auth = await fixture();
    const response = await client().request({
      extraHeaders: {
        ...protocolHeaders(auth.token(), "tools/call"),
        "MCP-Name": "unknown_tool",
      },
      body: requestBody("tools/call", true, {
        name: "unknown_tool",
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
          name: "get_indicators",
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

  it("returns canonical indicators isolated to each signed organization", async () => {
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
    const expected = [];
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
      expected.push(projection);
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
              name: "get_indicators",
              arguments: {},
            }),
          }),
          [200],
        );
      }),
    );
    expect(
      results.map((result) => {
        return z
          .object({ result: z.object({ structuredContent: z.unknown() }) })
          .parse(rpc(result.body)).result.structuredContent;
      }),
    ).toStrictEqual(expected);
  });
});
