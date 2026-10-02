import { randomUUID } from "node:crypto";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { featureSwitchesRoutes } from "../feature-switches";
import { mcpServerRoutes } from "../mcp-server";
import { createRouteMocks } from "./helpers/route-test";
import {
  resource,
  issuer,
  readScope,
  orgScope,
  requiredScopes,
  defaultScopes,
  rpc,
  requestBody,
  protocolHeaders,
  createMcpServerTestApi,
} from "./helpers/mcp-server";

const context = testContext();
const { client, fixture } = createMcpServerTestApi(context);

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
    { iss: "https://other-clerk.example.test" },
    { aud: "https://different-resource.example.test/mcp" },
    { aud: undefined },
    { org_id: undefined },
    { client_id: undefined },
    { client_id: "   " },
    { client_id: "x".repeat(2049) },
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
    const token = auth.token({ scope: `${orgScope} okou:chat:manage` });
    for (const { method, name, args } of [
      { method: "tools/list", name: "list_chat_threads", args: {} },
      { method: "tools/call", name: "get_chat_indicators", args: {} },
      { method: "tools/call", name: "list_chat_threads", args: {} },
      {
        method: "tools/call",
        name: "get_chat_thread",
        args: { threadId: randomUUID() },
      },
      {
        method: "tools/call",
        name: "get_chat_status",
        args: { threadId: randomUUID() },
      },
      { method: "tools/call", name: "list_agents", args: {} },
      { method: "tools/call", name: "list_models", args: {} },
      {
        method: "tools/call",
        name: "create_chat_thread",
        args: {
          requestId: randomUUID(),
          agentId: randomUUID(),
          title: "Missing read grant",
          model: "claude-sonnet-5",
        },
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
});
