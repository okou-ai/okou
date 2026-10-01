import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { mcpSendChatMessageOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { mcpGetChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-messages";
import {
  mcpGetChatThreadOutputSchema,
  mcpListChatThreadsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { mcpUpdateChatThreadOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-thread-update";
import { mcpGetChatStatusOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-status";
import { mcpToolErrorContentSchema } from "@okouai/api-contracts/contracts/mcp-tool-errors";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { mcpServerRoutes } from "../mcp-server";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const resource = "https://api.mcp.example.test/mcp";
const issuer = "https://clerk.mcp.example.test";
const orgScope = "user:org:read";
const readScope = "okou:chat:read";
const requiredScopes = `${orgScope} ${readScope}`;
const defaultScopes =
  "openid email profile user:org:read okou:chat:read okou:chat:send okou:chat:manage okou:run:cancel offline_access";
const modernVersion = "2026-07-28";
function client() {
  return setupApp({ context, routes: mcpServerRoutes })(mcpServerContract);
}
function rpc(body: unknown): unknown {
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
function fixture() {
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
  await flushWaitUntilForTest();
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
function structuredToolError(result: Awaited<ReturnType<typeof callTool>>) {
  expect(result.isError).toBeTruthy();
  return mcpToolErrorContentSchema.parse(result.structuredContent).error;
}
async function conversationFixture() {
  const auth = fixture();
  const api = createBddApi(context);
  const chat = createChatFilesBddApi(context);
  const actor = api.user({ userId: auth.userId, orgId: auth.orgId });
  api.acceptAgentStorageWrites();
  const agent = await api.createAgent(actor, {
    displayName: "MCP parity Agent",
    visibility: "private",
  });
  await createRunsApi(context).ensureOrgModelProvider(actor);
  const token = auth.token({ scope: defaultScopes });
  return { auth, api, chat, actor, agentId: agent.agentId, token };
}

describe("external MCP authentication and transport", () => {
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

describe("MCP Web parity", () => {
  it.each([true, false])(
    "advertises one protocol through the SDK with modern=%s",
    async (modern) => {
      const auth = fixture();
      const app = createAppWithRoutes({
        routes: mcpServerRoutes,
        signal: context.signal,
      });
      const transport = new StreamableHTTPClientTransport(new URL(resource), {
        authProvider: {
          token: () => {
            return Promise.resolve(auth.token({ scope: defaultScopes }));
          },
        },
        fetch: async (input, init) => {
          return await app.request(new Request(input, init));
        },
      });
      const sdk = new Client(
        { name: "okou-parity-test", version: "1" },
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
      const tools = await sdk.listTools();
      expect(
        tools.tools.map((tool) => {
          return tool.name;
        }),
      ).not.toContain("create_chat_thread");
      expect(
        tools.tools.map((tool) => {
          return tool.name;
        }),
      ).toContain("send_chat_message");
      const validator = new AjvJsonSchemaValidator();
      for (const tool of tools.tools) {
        expect(() => {
          validator.getValidator(tool.inputSchema as JsonSchemaType);
          validator.getValidator(tool.outputSchema as JsonSchemaType);
        }).not.toThrow();
      }
      const send = tools.tools.find((tool) => {
        return tool.name === "send_chat_message";
      });
      expect(send?.inputSchema).toMatchObject({
        type: "object",
        required: ["agentId", "prompt"],
      });
      expect(JSON.stringify(send?.inputSchema)).not.toMatch(
        /requestId|inputRef|waitMs/u,
      );
      const listed = await sdk.callTool({
        name: "list_chat_threads",
        arguments: {},
      });
      expect(listed).toMatchObject({
        structuredContent: { threads: [], nextCursor: null },
      });
    },
  );

  it("creates and continues ordinary conversations without a request identity", async () => {
    const f = await conversationFixture();
    const first = mcpSendChatMessageOutputSchema.parse(
      (
        await callTool(f.token, "send_chat_message", {
          agentId: f.agentId,
          prompt: "First ordinary MCP input",
        })
      ).structuredContent,
    );
    const continued = mcpSendChatMessageOutputSchema.parse(
      (
        await callTool(f.token, "send_chat_message", {
          agentId: f.agentId,
          threadId: first.threadId,
          prompt: "Second ordinary MCP input",
        })
      ).structuredContent,
    );
    expect(continued.threadId).toBe(first.threadId);
    expect(first.runId).toBeNull();
    const history = mcpGetChatMessagesOutputSchema.parse(
      (
        await callTool(f.token, "get_chat_messages", {
          threadId: first.threadId,
        })
      ).structuredContent,
    );
    expect(
      history.messages
        .filter((message) => {
          return message.role === "user";
        })
        .map((message) => {
          return message.text;
        }),
    ).toStrictEqual(["First ordinary MCP input", "Second ordinary MCP input"]);
    const web = await f.chat.listThreadEvents(f.actor, first.threadId);
    expect(JSON.stringify(web.events)).toContain("mcp_test_client");
    expect(first).not.toHaveProperty("inputRef");
    expect(first).not.toHaveProperty("replayed");
  });

  it("does not deduplicate two new sends with identical text", async () => {
    const f = await conversationFixture();
    const first = mcpSendChatMessageOutputSchema.parse(
      (
        await callTool(f.token, "send_chat_message", {
          agentId: f.agentId,
          prompt: "Repeated intended text",
        })
      ).structuredContent,
    );
    const second = mcpSendChatMessageOutputSchema.parse(
      (
        await callTool(f.token, "send_chat_message", {
          agentId: f.agentId,
          prompt: "Repeated intended text",
        })
      ).structuredContent,
    );
    expect(second.threadId).not.toBe(first.threadId);
  });

  it.each([
    { requestId: randomUUID() },
    { text: "old send input" },
    { inputRef: { threadId: randomUUID(), eventId: randomUUID(), seqId: 1 } },
    { waitMs: 10 },
    { orgId: "org_override" },
    { clientEventId: randomUUID() },
  ])("rejects removed protocol and identity overrides %j", async (extra) => {
    const f = await conversationFixture();
    const error = structuredToolError(
      await callTool(f.token, "send_chat_message", {
        agentId: f.agentId,
        prompt: "Must not be sent",
        ...extra,
      }),
    );
    expect(error.code).toBe("invalid_arguments");
    const listed = mcpListChatThreadsOutputSchema.parse(
      (await callTool(f.token, "list_chat_threads")).structuredContent,
    );
    expect(listed.threads).toStrictEqual([]);
  });

  it("applies sparse metadata using the Web update and does not revert a newer update", async () => {
    const f = await conversationFixture();
    const sent = mcpSendChatMessageOutputSchema.parse(
      (
        await callTool(f.token, "send_chat_message", {
          agentId: f.agentId,
          prompt: "Metadata test",
        })
      ).structuredContent,
    );
    const changed = mcpUpdateChatThreadOutputSchema.parse(
      (
        await callTool(f.token, "update_chat_thread", {
          threadId: sent.threadId,
          patch: { title: "First title" },
        })
      ).structuredContent,
    );
    expect(changed.title).toBe("First title");
    await callTool(f.token, "update_chat_thread", {
      threadId: sent.threadId,
      patch: { title: "Newer title" },
    });
    const read = mcpGetChatThreadOutputSchema.parse(
      (await callTool(f.token, "get_chat_thread", { threadId: sent.threadId }))
        .structuredContent,
    );
    expect(read.thread.title).toBe("Newer title");
    expect(read.thread.model.selectedModel).toBe(changed.selectedModel);
    expect(changed).not.toHaveProperty("retryUntil");
    expect(
      structuredToolError(
        await callTool(f.token, "update_chat_thread", {
          threadId: sent.threadId,
          requestId: randomUUID(),
          patch: { title: "Old protocol" },
        }),
      ).code,
    ).toBe("invalid_arguments");
  });

  it("preserves owner and organization isolation across send, read and update", async () => {
    const f = await conversationFixture();
    const sent = mcpSendChatMessageOutputSchema.parse(
      (
        await callTool(f.token, "send_chat_message", {
          agentId: f.agentId,
          prompt: "Private conversation",
        })
      ).structuredContent,
    );
    const peerId = `user_${randomUUID()}`;
    const peer = f.auth.token({ sub: peerId, scope: defaultScopes });
    expect(
      structuredToolError(
        await callTool(peer, "send_chat_message", {
          agentId: f.agentId,
          threadId: sent.threadId,
          prompt: "Forbidden continuation",
        }),
      ).code,
    ).toMatch(/not_found/iu);
    expect(
      structuredToolError(
        await callTool(peer, "get_chat_messages", { threadId: sent.threadId }),
      ).code,
    ).toBe("not_found");
    expect(
      structuredToolError(
        await callTool(peer, "update_chat_thread", {
          threadId: sent.threadId,
          patch: { title: "Forbidden title" },
        }),
      ).code,
    ).toBe("not_found");
    const foreignOrg = `org_${randomUUID()}`;
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          id: randomUUID(),
          role: "org:member",
          organization: { id: foreignOrg },
        },
      ],
      totalCount: 1,
    });
    const foreign = f.auth.token({
      sub: `user_${randomUUID()}`,
      org_id: foreignOrg,
      scope: defaultScopes,
    });
    expect(
      structuredToolError(
        await callTool(foreign, "get_chat_thread", { threadId: sent.threadId }),
      ).code,
    ).toBe("not_found");
  });

  it("requires the send scope even when manually invoking the tool", async () => {
    const f = await conversationFixture();
    const result = await callTool(f.auth.token(), "send_chat_message", {
      agentId: f.agentId,
      prompt: "No send grant",
    });
    expect(result.isError).toBeTruthy();
    expect(
      mcpListChatThreadsOutputSchema.parse(
        (await callTool(f.token, "list_chat_threads")).structuredContent,
      ).threads,
    ).toStrictEqual([]);
  });

  it("pages canonical messages and binds cursors to the same owner and filters", async () => {
    const f = await conversationFixture();
    const first = mcpSendChatMessageOutputSchema.parse(
      (
        await callTool(f.token, "send_chat_message", {
          agentId: f.agentId,
          prompt: "Cursor first",
        })
      ).structuredContent,
    );
    await callTool(f.token, "send_chat_message", {
      agentId: f.agentId,
      threadId: first.threadId,
      prompt: "Cursor second",
    });
    const page = mcpGetChatMessagesOutputSchema.parse(
      (
        await callTool(f.token, "get_chat_messages", {
          threadId: first.threadId,
          limit: 1,
        })
      ).structuredContent,
    );
    expect(page.messages[0]?.text).toBe("Cursor second");
    expect(page.olderCursor).not.toBeNull();
    const older = mcpGetChatMessagesOutputSchema.parse(
      (
        await callTool(f.token, "get_chat_messages", {
          threadId: first.threadId,
          limit: 1,
          cursor: page.olderCursor,
        })
      ).structuredContent,
    );
    expect(older.messages[0]?.text).toBe("Cursor first");
    expect(
      structuredToolError(
        await callTool(f.token, "get_chat_messages", {
          threadId: first.threadId,
          limit: 2,
          cursor: page.olderCursor,
        }),
      ).code,
    ).toBe("invalid_cursor");
    const peer = f.auth.token({
      sub: `user_${randomUUID()}`,
      scope: defaultScopes,
    });
    expect(
      structuredToolError(
        await callTool(peer, "get_chat_messages", {
          threadId: first.threadId,
          limit: 1,
          cursor: page.olderCursor,
        }),
      ).code,
    ).toBe("invalid_cursor");
  });

  it("reads ordinary Run state and denies a peer's cancellation", async () => {
    const f = await conversationFixture();
    const runs = createRunsApi(context);
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(f.actor);
    const run = await runs.createRun(f.actor, {
      agentId: f.agentId,
      prompt: "Ordinary Run state",
    });
    const read = mcpGetChatStatusOutputSchema.parse(
      (await callTool(f.token, "get_chat_status", { runId: run.runId }))
        .structuredContent,
    );
    const web = await runs.readRun(f.actor, run.runId);
    expect(read).toStrictEqual(web);
    const peer = f.auth.token({
      sub: `user_${randomUUID()}`,
      scope: defaultScopes,
    });
    expect(
      structuredToolError(
        await callTool(peer, "get_chat_status", { runId: run.runId }),
      ).code,
    ).toBe("not_found");
    expect(
      structuredToolError(
        await callTool(peer, "cancel_run", { runId: run.runId }),
      ),
    ).toStrictEqual({
      code: "NOT_FOUND",
      message: `No such run: '${run.runId}'`,
      retryable: false,
    });
    expect(
      structuredToolError(
        await callTool(f.token, "get_chat_status", {
          runId: run.runId,
          waitMs: 1,
        }),
      ).code,
    ).toBe("invalid_arguments");
    const cancelled = await callTool(f.token, "cancel_run", {
      runId: run.runId,
    });
    expect(cancelled.isError).not.toBeTruthy();
    expect(cancelled.structuredContent).toMatchObject({
      runId: run.runId,
      status: "cancelled",
    });
    expect((await runs.readRun(f.actor, run.runId)).status).toBe("cancelled");
  });
});
