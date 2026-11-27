import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { mcpServerRoutes } from "../mcp-server";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const store = createStore();
const client = setupApp({ context, routes: mcpServerRoutes })(
  mcpServerContract,
);

const ISSUER = "https://clerk.mcp.example.test";
const RESOURCE = "https://api.mcp.example.test/mcp";
const METADATA_URL =
  "https://api.mcp.example.test/.well-known/oauth-protected-resource/mcp";
const DEFAULT_SCOPES =
  "openid email profile user:org:read okou:chat:read okou:project:read okou:chat:send okou:chat:manage okou:run:cancel offline_access";
const FULL_GRANT =
  "user:org:read okou:chat:read okou:project:read okou:chat:send okou:chat:manage okou:run:cancel";
const LEGACY_VERSION = "2025-11-25";

const issuerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const issuerKeyId = randomUUID();

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

/** Configures the MCP resource and publishes the issuer's signing key. */
function configureMcp(): void {
  mockEnv("MCP_RESOURCE_URL", RESOURCE);
  mockEnv("MCP_OAUTH_ISSUER", ISSUER);
  server.use(
    http.get("https://api.clerk.com/v1/jwks", () => {
      return HttpResponse.json({
        keys: [
          {
            ...issuerKeys.publicKey.export({ format: "jwk" }),
            kid: issuerKeyId,
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    }),
  );
}

/**
 * A signed-in member of a fresh workspace on the configured MCP resource; the
 * token checks read the membership seeded here.
 */
async function member(): Promise<Member> {
  configureMcp();
  const identity = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  await store.set(
    seedOrgMembership$,
    { ...identity, role: "member" },
    context.signal,
  );
  createRouteMocks(context).clerk.session(
    identity.userId,
    identity.orgId,
    "org:member",
  );
  return identity;
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function accessToken(
  identity: Member,
  options: {
    readonly claims?: Record<string, unknown>;
    readonly type?: string;
  } = {},
): string {
  const seconds = Math.floor(now() / 1000);
  const input = `${encode({
    alg: "RS256",
    kid: issuerKeyId,
    typ: options.type ?? "at+jwt",
  })}.${encode({
    iss: ISSUER,
    aud: RESOURCE,
    sub: identity.userId,
    org_id: identity.orgId,
    client_id: "mcp_test_client",
    scope: FULL_GRANT,
    iat: seconds,
    nbf: seconds - 1,
    exp: seconds + 3600,
    ...options.claims,
  })}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(input),
    issuerKeys.privateKey,
  ).toString("base64url");
  return `${input}.${signature}`;
}

function legacyHeaders(token?: string) {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": LEGACY_VERSION,
  };
}

async function listTools(token?: string) {
  return await client.request({
    extraHeaders: legacyHeaders(token),
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
}

async function callTool(token: string, name: string) {
  return await client.request({
    extraHeaders: legacyHeaders(token),
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    },
  });
}

/** Calls tools/list and reports the status with its body. */
async function listToolsOutcome(token: string) {
  const response = await accept(listTools(token), [200, 401, 403]);
  return { status: response.status, body: response.body };
}

const invalidToken = Object.freeze({
  status: 401,
  body: { error: "invalid_token" },
});

describe("external MCP authentication and transport", () => {
  it("mcp-server-002 rejects a token issued for another resource", async () => {
    const identity = await member();

    await expect(
      listToolsOutcome(
        accessToken(identity, {
          claims: { aud: "https://different-resource.example.test/mcp" },
        }),
      ),
    ).resolves.toStrictEqual(invalidToken);
  });

  it("mcp-server-001 advertises native-client scopes without adding them to the default consent", async () => {
    configureMcp();

    const [metadata, unauthenticated] = await Promise.all([
      accept(client.metadata(), [200]),
      accept(listTools(), [401]),
    ]);

    expect(metadata.body).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: [...DEFAULT_SCOPES.split(" "), "okou:voice:transcribe"],
    });
    expect(unauthenticated.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${METADATA_URL}", scope="${DEFAULT_SCOPES}"`,
    );
  });

  it("mcp-server-007 rejects a token whose subject is not a user", async () => {
    const identity = await member();

    await expect(
      listToolsOutcome(
        accessToken(identity, { claims: { sub: "machine_client" } }),
      ),
    ).resolves.toStrictEqual(invalidToken);
  });

  it("mcp-server-008 rejects an expired token", async () => {
    const identity = await member();

    await expect(
      listToolsOutcome(accessToken(identity, { claims: { exp: 1 } })),
    ).resolves.toStrictEqual(invalidToken);
  });

  it("mcp-server-010 rejects a signed token with the generic JWT type", async () => {
    const identity = await member();

    await expect(
      listToolsOutcome(accessToken(identity, { type: "JWT" })),
    ).resolves.toStrictEqual(invalidToken);
  });

  it("mcp-server-012 rejects a token with a tampered signature", async () => {
    const identity = await member();
    const [header, payload] = accessToken(identity).split(".");
    const zeroSignature = Buffer.alloc(256).toString("base64url");

    const response = await accept(
      listTools(`${header}.${payload}.${zeroSignature}`),
      [401],
    );

    expect(response.body).toStrictEqual({ error: "invalid_token" });
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${METADATA_URL}", scope="${DEFAULT_SCOPES}", error="invalid_token"`,
    );
  });

  it("mcp-server-013 denies discovery and tool calls without the chat read grant", async () => {
    const identity = await member();
    const token = accessToken(identity, {
      claims: { scope: "user:org:read okou:chat:manage" },
    });

    const responses = await Promise.all([
      accept(listTools(token), [403]),
      accept(callTool(token, "get_chat_indicators"), [403]),
      accept(callTool(token, "get_chat_thread_list"), [403]),
      accept(callTool(token, "list_projects"), [403]),
      accept(callTool(token, "list_models"), [403]),
    ]);

    expect(
      responses.map((response: { readonly body: unknown }) => {
        return response.body;
      }),
    ).toStrictEqual(
      Array.from({ length: 5 }, () => {
        return { error: "insufficient_scope" };
      }),
    );
  });

  it("mcp-server-014 asks for organization consent when only chat read is granted", async () => {
    const identity = await member();

    const response = await accept(
      listTools(accessToken(identity, { claims: { scope: "okou:chat:read" } })),
      [403],
    );

    expect(response.body).toStrictEqual({ error: "insufficient_scope" });
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${METADATA_URL}", scope="user:org:read okou:chat:read", error="insufficient_scope"`,
    );
  });

  it("mcp-server-015 rejects a token for an organization the user does not belong to", async () => {
    const identity = await member();

    await expect(
      listToolsOutcome(
        accessToken(identity, { claims: { org_id: `org_${randomUUID()}` } }),
      ),
    ).resolves.toStrictEqual(invalidToken);
  });

  it("mcp-server-017 rejects a removed member once the membership cache expires", async () => {
    const identity = await member();
    const token = accessToken(identity);
    await expect(listToolsOutcome(token)).resolves.toMatchObject({
      status: 200,
    });

    await store.set(deleteOrgMembership$, identity, context.signal);
    mockNow(now() + 61_000);

    await expect(listToolsOutcome(token)).resolves.toStrictEqual(invalidToken);
  });

  it("mcp-server-020 acknowledges a legacy initialization notification without caching", async () => {
    const identity = await member();

    const response = await accept(
      client.request({
        extraHeaders: legacyHeaders(accessToken(identity)),
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      }),
      [202],
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("mcp-server-022 rejects standalone stateless GET and DELETE sessions", async () => {
    const identity = await member();
    const headers = legacyHeaders(accessToken(identity));

    const responses = await Promise.all([
      accept(client.get({ extraHeaders: headers }), [405]),
      accept(client.delete({ extraHeaders: headers }), [405]),
    ]);

    expect(
      responses.map((response: { readonly status: number }) => {
        return response.status;
      }),
    ).toStrictEqual([405, 405]);
  });

  it("mcp-server-028 serves the next request after an SSE consumer cancels", async () => {
    const identity = await member();
    const token = accessToken(identity);

    // The shared request helpers buffer whole bodies, so consume the real
    // application response directly to cancel its stream mid-flight.
    const streamed = await createAppWithRoutes({
      signal: context.signal,
      routes: mcpServerRoutes,
    }).request("/mcp", {
      method: "POST",
      headers: {
        ...legacyHeaders(token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_chat_thread_list", arguments: {} },
      }),
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    await streamed.body?.cancel();

    await expect(listToolsOutcome(token)).resolves.toMatchObject({
      status: 200,
    });
  });

  it("pf-096 rejects Origin null before authorization", async () => {
    configureMcp();
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: mcpServerRoutes,
    });
    const response = await app.request("/mcp", {
      method: "POST",
      headers: {
        origin: "null",
        "content-type": "application/json",
        ...legacyHeaders(),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Forbidden Origin",
    });
  });

  it("pf-099 allows bearer MCP discovery from third-party HTTPS origin and rejects cookies", async () => {
    const identity = await member();
    const token = accessToken(identity);
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: mcpServerRoutes,
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    const [allowed, withCookie] = await Promise.all([
      app.request("/mcp", {
        method: "POST",
        headers: {
          origin: "https://client.example.test",
          "content-type": "application/json",
          ...legacyHeaders(token),
        },
        body,
      }),
      app.request("/mcp", {
        method: "POST",
        headers: {
          origin: "https://client.example.test",
          cookie: "session=forbidden",
          "content-type": "application/json",
          ...legacyHeaders(token),
        },
        body,
      }),
    ]);

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("*");
    expect(withCookie.status).toBe(403);
    await expect(withCookie.json()).resolves.toStrictEqual({
      error: "Forbidden Origin",
    });
  });
});
