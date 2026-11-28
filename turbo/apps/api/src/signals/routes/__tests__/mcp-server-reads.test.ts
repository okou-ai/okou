import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";

import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  array,
  boolean,
  literal,
  number,
  object,
  record,
  string,
  union,
  unknown as zUnknown,
} from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { billingStatusRoutes } from "../billing-status";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { mcpServerRoutes } from "../mcp-server";
import { projectRoutes } from "../projects";
import { runModelsRoutes } from "../run-models";
import { runsCancelRoutes } from "../runs-cancel";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { MCP_WEB_SCOPES } from "./helpers/mcp-web-api";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

function createFrozenRsaMaterial(): {
  readonly privateKeyPem: string;
  readonly publicJwkJson: string;
} {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return Object.freeze({
    privateKeyPem: String(
      pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    ),
    publicJwkJson: JSON.stringify(pair.publicKey.export({ format: "jwk" })),
  });
}

const MCP_KEY_MATERIAL = createFrozenRsaMaterial();
const MCP_TEST_KID = "mcp-test-kid-1";
const MCP_ISSUER = "https://clerk.mcp.example.test";
const MCP_RESOURCE = "https://api.mcp.example.test/mcp";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const READ_SCOPES = "user:org:read okou:chat:read okou:project:read";

const CORE_EXPECTED_TOOLS = Object.freeze([
  "get_chat_input_status",
  "list_projects",
  "list_project_threads",
  "list_models",
  "get_chat_thread_list",
  "get_chat_messages",
  "search_chat_messages",
  "get_chat_indicators",
  "get_chat_activity_summary",
  "rename_chat_thread",
  "update_chat_thread_model",
  "send_chat_message",
  "revoke_queued_message",
  "cancel_run",
]);

const NOT_FOUND_ERROR = Object.freeze({ code: "NOT_FOUND" });
const NOT_FOUND_STRUCTURED = Object.freeze({ error: NOT_FOUND_ERROR });
const NOT_FOUND_RESULT = Object.freeze({
  isError: true,
  structuredContent: NOT_FOUND_STRUCTURED,
});

const MCP_CALL_REPLY_SCHEMA = object({
  result: object({
    isError: boolean().optional(),
    structuredContent: zUnknown().optional(),
    content: array(object({ type: literal("text"), text: string() })),
  }),
});

const WEB_ROUTES = Object.freeze([
  ...projectRoutes,
  ...runModelsRoutes,
  ...billingStatusRoutes,
  ...chatThreadRoutes,
  ...chatEventsRoutes,
  ...runsCancelRoutes,
]);

const context = testContext();
const bdd = createBddApi(context);
const mcpClient = setupApp({ context, routes: mcpServerRoutes })(
  mcpServerContract,
);
const projectsClient = setupApp({ context, routes: projectRoutes })(
  projectsContract,
);
const rawWeb = setupRawAppRequest({ context, routes: WEB_ROUTES });

async function mcpRpc(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await accept(
    mcpClient.request({
      extraHeaders: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "MCP-Method": method,
        ...(typeof params.name === "string" ? { "MCP-Name": params.name } : {}),
      },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
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
  if (typeof body !== "string") {
    return body;
  }
  const frame = body.split("\n").find((line) => {
    return line.startsWith("data: ");
  });
  if (!frame) {
    throw new Error("Expected an MCP SSE reply");
  }
  return JSON.parse(frame.slice(6)) as unknown;
}

async function mcpCall(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  return MCP_CALL_REPLY_SCHEMA.parse(
    await mcpRpc(token, "tools/call", { name, arguments: args }),
  ).result;
}

async function mcpWeb(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  return await rawWeb(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function createHarness() {
  const store = createStore();
  mockEnv("MCP_RESOURCE_URL", MCP_RESOURCE);
  mockEnv("MCP_OAUTH_ISSUER", MCP_ISSUER);
  const publicJwk: unknown = JSON.parse(MCP_KEY_MATERIAL.publicJwkJson);
  if (typeof publicJwk !== "object" || publicJwk === null) {
    throw new Error("Expected public JWK object");
  }
  server.use(
    http.get("https://api.clerk.com/v1/jwks", () => {
      return HttpResponse.json({
        keys: [
          {
            ...publicJwk,
            kid: MCP_TEST_KID,
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    }),
  );
  const privateKey = createPrivateKey(MCP_KEY_MATERIAL.privateKeyPem);

  function signToken(
    actor: ApiTestUser & { readonly orgId: string },
    claims: Record<string, unknown> = {},
  ): string {
    const seconds = Math.floor(now() / 1000);
    const encode = (value: Record<string, unknown>) => {
      return Buffer.from(JSON.stringify(value)).toString("base64url");
    };
    const input = `${encode({ alg: "RS256", kid: MCP_TEST_KID, typ: "at+jwt" })}.${encode(
      {
        iss: MCP_ISSUER,
        aud: MCP_RESOURCE,
        sub: actor.userId,
        org_id: actor.orgId,
        client_id: "mcp_test_client",
        scope: MCP_WEB_SCOPES,
        iat: seconds,
        nbf: seconds - 1,
        exp: seconds + 3600,
        ...claims,
      },
    )}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  }

  async function seededUser(
    orgId?: string,
  ): Promise<ApiTestUser & { readonly orgId: string }> {
    const user = bdd.user({ orgRole: "org:member", orgId });
    if (!user.orgId) {
      throw new Error("Expected a workspace member");
    }
    await store.set(
      seedOrgMembership$,
      { userId: user.userId, orgId: user.orgId, role: "member" },
      context.signal,
    );
    return { ...user, orgId: user.orgId };
  }

  async function addMembership(userId: string, orgId: string): Promise<void> {
    await store.set(
      seedOrgMembership$,
      { userId, orgId, role: "member" },
      context.signal,
    );
  }

  async function memberWithToken() {
    const member = await seededUser();
    const issue = (claims: Record<string, unknown> = {}) => {
      return signToken(member, claims);
    };
    return { member, token: issue(), issue };
  }

  return { seededUser, addMembership, memberWithToken, signToken };
}

interface ListedMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

async function listedToolDefinitions(
  token: string,
): Promise<readonly ListedMcpTool[]> {
  const reply = await mcpRpc(token, "tools/list");
  if (
    typeof reply !== "object" ||
    reply === null ||
    !("result" in reply) ||
    typeof reply.result !== "object" ||
    reply.result === null ||
    !("tools" in reply.result) ||
    !Array.isArray(reply.result.tools)
  ) {
    throw new Error(`Expected an MCP tool list, got ${JSON.stringify(reply)}`);
  }
  return reply.result.tools.flatMap((tool: unknown) => {
    if (
      typeof tool !== "object" ||
      tool === null ||
      !("name" in tool) ||
      typeof tool.name !== "string"
    ) {
      return [];
    }
    return [
      {
        name: tool.name,
        description:
          "description" in tool && typeof tool.description === "string"
            ? tool.description
            : undefined,
        inputSchema: "inputSchema" in tool ? tool.inputSchema : undefined,
        outputSchema: "outputSchema" in tool ? tool.outputSchema : undefined,
      },
    ];
  });
}

async function listedTools(token: string): Promise<string[]> {
  const tools = await listedToolDefinitions(token);
  return tools.map((tool) => {
    return tool.name;
  });
}

function memberSession(member: {
  readonly userId: string;
  readonly orgId: string;
}) {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    "org:member",
  );
  return { authorization: "Bearer clerk-session" };
}

function sendResult(result: { readonly structuredContent?: unknown }) {
  const content = result.structuredContent;
  if (
    typeof content !== "object" ||
    content === null ||
    !("threadId" in content) ||
    !("eventId" in content) ||
    typeof content.threadId !== "string" ||
    typeof content.eventId !== "string"
  ) {
    throw new Error(`Expected a sent message, got ${JSON.stringify(result)}`);
  }
  return { threadId: content.threadId, eventId: content.eventId };
}

async function createResearchProject(member: {
  readonly userId: string;
  readonly orgId: string;
}): Promise<string> {
  const projectId = createProjectOperationId(now(), randomUUID());
  await accept(
    projectsClient.create({
      headers: memberSession(member),
      body: { id: projectId, eventId: projectId, name: "Research" },
    }),
    [201],
  );
  return projectId;
}

async function startProjectChat(token: string, projectId: string) {
  return sendResult(
    await mcpCall(token, "send_chat_message", {
      projectId,
      prompt: "Project kickoff",
    }),
  );
}

async function scopedTokensWithMessage() {
  const harness = createHarness();
  const { issue } = await harness.memberWithToken();
  const sendToken = issue({ scope: `${READ_SCOPES} okou:chat:send` });
  const cancelToken = issue({ scope: `${READ_SCOPES} okou:run:cancel` });
  const manageToken = issue({ scope: `${READ_SCOPES} okou:chat:manage` });
  const sent = sendResult(
    await mcpCall(sendToken, "send_chat_message", { prompt: "Hello" }),
  );
  return { sendToken, cancelToken, manageToken, sent };
}

describe("thin MCP Web adapters", () => {
  it("mcp-server-reads-006 returns the unmodified Web project and model lists", async () => {
    const { token } = await createHarness().memberWithToken();

    const projects = await mcpWeb(token, "/api/projects");
    const models = await mcpWeb(token, "/api/run-models");
    expect(projects.status).toBe(200);
    expect(models.status).toBe(200);

    const listedProjects = await mcpCall(token, "list_projects");
    const listedModels = await mcpCall(token, "list_models");
    expect(listedProjects.structuredContent).toStrictEqual(projects.body);
    expect(listedModels.structuredContent).toStrictEqual(models.body);
  });

  it("mcp-server-reads-001 (1/2) discovers tools with valid schemas, search docs, and empty search results", async () => {
    const { token } = await createHarness().memberWithToken();

    const tools = await listedToolDefinitions(token);
    const names = tools.map((tool) => {
      return tool.name;
    });
    for (const expectedName of CORE_EXPECTED_TOOLS) {
      expect(names).toContain(expectedName);
    }
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      if (tool.outputSchema !== undefined) {
        expect(tool.outputSchema).toMatchObject({ type: "object" });
      }
    }

    const searchTool = tools.find((tool) => {
      return tool.name === "search_chat_messages";
    });
    expect(JSON.stringify(searchTool?.inputSchema)).toContain("CJK");
    expect(JSON.stringify(searchTool?.outputSchema)).toContain("UTF-16");

    const sendTool = tools.find((tool) => {
      return tool.name === "send_chat_message";
    });
    expect(JSON.stringify(sendTool?.inputSchema)).toContain("userMessage");

    const bothPromptAndUserMessage = await mcpCall(token, "send_chat_message", {
      prompt: "Plain",
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Structured" }],
      },
    });
    expect(bothPromptAndUserMessage.isError).toBeTruthy();

    const emptySearch = await mcpCall(token, "search_chat_messages", {
      keyword: "unmatched",
    });
    expect(emptySearch.structuredContent).toStrictEqual({ results: [] });
  });

  it("mcp-server-reads-001 (2/2) sends a structured userMessage, replaces external source with MCP client, and records thread history", async () => {
    const { token } = await createHarness().memberWithToken();

    const sent = await mcpCall(token, "send_chat_message", {
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Please review this excerpt" },
          {
            type: "feedback",
            quote: "Original sentence",
            note: [{ type: "text", text: "Tighten wording" }],
          },
          {
            type: "source",
            kind: "slack",
            href: "https://slack.example.test/archives/C1/p1",
          },
        ],
      },
    });
    expect(sent.isError).toBeFalsy();
    const firstText = sent.content[0]?.text;
    if (!firstText) {
      throw new Error("Expected text content matching structuredContent");
    }
    expect(sent.structuredContent).toStrictEqual(JSON.parse(firstText));
    const { threadId, eventId } = sendResult(sent);

    const history = await mcpCall(token, "get_chat_messages", { threadId });
    expect(history.structuredContent).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          eventId,
          eventType: "input.prompt",
          payload: expect.objectContaining({
            userMessage: {
              version: 1,
              parts: [
                { type: "text", text: "Please review this excerpt" },
                {
                  type: "feedback",
                  quote: "Original sentence",
                  note: [{ type: "text", text: "Tighten wording" }],
                },
                {
                  type: "source",
                  kind: "mcp",
                  clientId: "mcp_test_client",
                },
              ],
            },
          }),
        }),
      ]),
    });

    const threadList = await mcpCall(token, "get_chat_thread_list");
    expect(threadList.structuredContent).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          kind: "created",
          threadId,
        }),
      ]),
    });
  });

  it("mcp-server-reads-016 (1/3) denies a peer reading or renaming the member's thread", async () => {
    const harness = createHarness();
    const { member, token } = await harness.memberWithToken();
    const peer = await harness.seededUser(member.orgId);
    const peerToken = harness.signToken(peer);
    const sent = sendResult(
      await mcpCall(token, "send_chat_message", { prompt: "Hello" }),
    );

    const denied = [
      await mcpCall(peerToken, "get_chat_messages", {
        threadId: sent.threadId,
      }),
      await mcpCall(peerToken, "rename_chat_thread", {
        threadId: sent.threadId,
        title: "Taken over",
      }),
    ];
    for (const result of denied) {
      expect(result).toMatchObject(NOT_FOUND_RESULT);
    }
  });

  it("mcp-server-reads-016 (2/3) denies a peer revoking or sending into the member's thread", async () => {
    const harness = createHarness();
    const { member, token } = await harness.memberWithToken();
    const peer = await harness.seededUser(member.orgId);
    const peerToken = harness.signToken(peer);
    const sent = sendResult(
      await mcpCall(token, "send_chat_message", { prompt: "Hello" }),
    );

    const denied = [
      await mcpCall(peerToken, "revoke_queued_message", {
        threadId: sent.threadId,
        eventId: sent.eventId,
      }),
      await mcpCall(peerToken, "send_chat_message", {
        threadId: sent.threadId,
        prompt: "Peer message",
      }),
    ];
    for (const result of denied) {
      expect(result).toMatchObject(NOT_FOUND_RESULT);
    }
  });

  it("mcp-server-reads-016 (3/3) denies the member sending into another organization's thread", async () => {
    const harness = createHarness();
    const { token } = await harness.memberWithToken();
    const outsider = await harness.seededUser();
    const outside = sendResult(
      await mcpCall(harness.signToken(outsider), "send_chat_message", {
        prompt: "Hi",
      }),
    );

    const result = await mcpCall(token, "send_chat_message", {
      threadId: outside.threadId,
      prompt: "Cross workspace",
    });
    expect(result).toMatchObject(NOT_FOUND_RESULT);
  });

  it("mcp-server-reads-005 (1/2) lists and allows only the tools each send, cancel or manage grant covers", async () => {
    const { sendToken, cancelToken, manageToken, sent } =
      await scopedTokensWithMessage();

    const sendTools = await listedTools(sendToken);
    expect(sendTools).toContain("send_chat_message");
    expect(sendTools).not.toContain("revoke_queued_message");
    const cancelTools = await listedTools(cancelToken);
    expect(cancelTools).toContain("revoke_queued_message");
    expect(cancelTools).not.toContain("send_chat_message");
    const manageTools = await listedTools(manageToken);
    expect(manageTools).toContain("rename_chat_thread");
    expect(manageTools).not.toContain("cancel_run");

    const outOfScope = [
      await mcpRpc(sendToken, "tools/call", {
        name: "revoke_queued_message",
        arguments: sent,
      }),
      await mcpRpc(cancelToken, "tools/call", {
        name: "send_chat_message",
        arguments: { threadId: sent.threadId, prompt: "Again" },
      }),
      await mcpRpc(manageToken, "tools/call", {
        name: "cancel_run",
        arguments: { runId: randomUUID() },
      }),
    ];
    for (const reply of outOfScope) {
      expect(reply).toHaveProperty("error");
      expect(reply).not.toHaveProperty("result");
    }
  });

  it("mcp-server-reads-005 (2/2) rejects Web events outside the send or cancel grant", async () => {
    const { sendToken, cancelToken, sent } = await scopedTokensWithMessage();

    const revoke = await mcpWeb(sendToken, "/api/chat/events", "POST", {
      threadId: sent.threadId,
      revokesEventId: sent.eventId,
    });
    expect(revoke.status).toBe(403);
    const send = await mcpWeb(cancelToken, "/api/chat/events", "POST", {
      threadId: sent.threadId,
      prompt: "Again",
      hasTextContent: true,
      userMessage: { version: 1, parts: [{ type: "text", text: "Again" }] },
    });
    expect(send.status).toBe(403);
  });

  it("mcp-server-reads-013 renames and resets the model through MCP with the Web events", async () => {
    const { token } = await createHarness().memberWithToken();
    const sent = sendResult(
      await mcpCall(token, "send_chat_message", { prompt: "Hello" }),
    );
    const modelEventId = randomUUID();
    const tierEventId = randomUUID();

    const renamed = await mcpRpc(token, "tools/call", {
      name: "rename_chat_thread",
      arguments: { threadId: sent.threadId, title: "Renamed with Web" },
    });
    const modelUpdated = await mcpRpc(token, "tools/call", {
      name: "update_chat_thread_model",
      arguments: {
        threadId: sent.threadId,
        model: null,
        eventId: modelEventId,
        serviceTierEventId: tierEventId,
      },
    });
    for (const reply of [renamed, modelUpdated]) {
      expect(reply).toMatchObject({ result: { content: [] } });
      expect(reply).not.toHaveProperty("result.structuredContent");
    }

    const web = await mcpWeb(token, "/api/chat-threads/events");
    expect(web.status).toBe(200);
    expect(web.body).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          kind: "renamed",
          chatThreadId: sent.threadId,
          title: "Renamed with Web",
        }),
        expect.objectContaining({
          kind: "model_selection_updated",
          id: modelEventId,
          chatThreadId: sent.threadId,
          selectedModel: "auto",
        }),
        expect.objectContaining({
          kind: "service_tier_updated",
          id: tierEventId,
          chatThreadId: sent.threadId,
          serviceTier: null,
        }),
      ]),
    });
    const list = await mcpCall(token, "get_chat_thread_list");
    expect(list.structuredContent).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          kind: "model_selection_updated",
          eventId: modelEventId,
          threadId: sent.threadId,
        }),
        expect.objectContaining({
          kind: "service_tier_updated",
          eventId: tierEventId,
          threadId: sent.threadId,
        }),
      ]),
    });
  });

  it("mcp-server-reads-017 keeps the grant to its organization for the same user's other thread", async () => {
    const harness = createHarness();
    const { member, token, issue } = await harness.memberWithToken();
    const { orgId: secondOrgId } = await harness.seededUser();
    await harness.addMembership(member.userId, secondOrgId);
    const other = sendResult(
      await mcpCall(issue({ org_id: secondOrgId }), "send_chat_message", {
        prompt: "Second workspace",
      }),
    );

    const snapshot = await mcpWeb(
      token,
      `/api/chat-threads/${other.threadId}/event-snapshot`,
    );
    const rows = await mcpWeb(
      token,
      `/api/chat-threads/${other.threadId}/event-rows?sinceSeqId=0`,
    );
    for (const response of [snapshot, rows]) {
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    await expect(
      mcpCall(token, "get_chat_messages", { threadId: other.threadId }),
    ).resolves.toMatchObject(NOT_FOUND_RESULT);
    const list = await mcpCall(token, "get_chat_thread_list");
    expect(JSON.stringify(list.structuredContent)).not.toContain(
      other.threadId,
    );
  });

  it("mcp-server-reads-007 (1/4) hides the member's Project from a peer", async () => {
    const harness = createHarness();
    const { member, token } = await harness.memberWithToken();
    const projectId = await createResearchProject(member);
    const peer = await harness.seededUser(member.orgId);
    const peerToken = harness.signToken(peer);

    await expect(mcpCall(token, "list_projects")).resolves.toMatchObject({
      structuredContent: {
        projects: [
          expect.objectContaining({ id: projectId, name: "Research" }),
        ],
      },
    });
    await expect(mcpCall(peerToken, "list_projects")).resolves.toMatchObject({
      structuredContent: { projects: [] },
    });
    await expect(
      mcpCall(peerToken, "list_project_threads", { projectId }),
    ).resolves.toMatchObject(NOT_FOUND_RESULT);
    await expect(
      mcpCall(peerToken, "send_chat_message", { projectId, prompt: "Peer" }),
    ).resolves.toMatchObject(NOT_FOUND_RESULT);
  });

  it("mcp-server-reads-007 (2/4) starts a Chat in the member's Project", async () => {
    const harness = createHarness();
    const { member, token } = await harness.memberWithToken();
    const projectId = await createResearchProject(member);

    const started = await startProjectChat(token, projectId);

    const list = await mcpCall(token, "get_chat_thread_list");
    expect(list.structuredContent).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          kind: "created",
          threadId: started.threadId,
          projectId,
        }),
      ]),
    });
    await expect(
      mcpCall(token, "list_project_threads", { projectId, limit: 1 }),
    ).resolves.toMatchObject({
      structuredContent: {
        threads: [expect.objectContaining({ threadId: started.threadId })],
        nextAfter: null,
      },
    });
  });

  it("mcp-server-reads-007 (3/4) rejects a send naming both the thread and the Project", async () => {
    const harness = createHarness();
    const { member, token } = await harness.memberWithToken();
    const projectId = await createResearchProject(member);
    const started = await startProjectChat(token, projectId);

    const both = await mcpCall(token, "send_chat_message", {
      threadId: started.threadId,
      projectId,
      prompt: "Both",
    });
    expect(both).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "BAD_REQUEST" } },
    });
  });

  it("mcp-server-reads-007 (4/4) continues the retained Chat by thread ID", async () => {
    const { token } = await createHarness().memberWithToken();
    const retained = sendResult(
      await mcpCall(token, "send_chat_message", { prompt: "Retained" }),
    );

    const continued = sendResult(
      await mcpCall(token, "send_chat_message", {
        threadId: retained.threadId,
        prompt: "Continue",
      }),
    );
    expect(continued.threadId).toBe(retained.threadId);
    await expect(
      mcpCall(token, "get_chat_messages", { threadId: retained.threadId }),
    ).resolves.toMatchObject({
      structuredContent: {
        rows: expect.arrayContaining([
          expect.objectContaining({ eventId: continued.eventId }),
        ]),
      },
    });
  });

  it("pf-093 authorizes a device to subscribe to its own workspace through Ably", async () => {
    const harness = createHarness();
    const { member, token } = await harness.memberWithToken();
    const tokenRequestParams = object({
      capability: union([
        string(),
        record(string(), array(string())),
      ]).optional(),
      clientId: string().optional(),
      timestamp: number().optional(),
      ttl: number().optional(),
    });
    context.mocks.ably.createTokenRequest.mockImplementation(
      (rawParams: unknown) => {
        const params = tokenRequestParams.parse(rawParams);
        return Promise.resolve({
          keyName: "ably-test-key",
          clientId: params.clientId ?? member.userId,
          capability:
            typeof params.capability === "string"
              ? params.capability
              : JSON.stringify(params.capability ?? {}),
          timestamp: params.timestamp ?? now(),
          ttl: params.ttl ?? 60_000,
          nonce: "test-nonce",
          mac: "test-mac",
        });
      },
    );

    const result = await mcpCall(token, "get_chat_realtime_token");
    expect(result.isError).not.toBeTruthy();
    const parsed = object({
      clientId: string(),
      capability: string(),
    }).parse(result.structuredContent);
    expect(parsed.clientId).toBe(member.userId);
    const capability = JSON.parse(parsed.capability) as Record<
      string,
      readonly string[]
    >;
    const channels = Object.keys(capability);
    expect(
      channels.every((channel) => {
        return (
          channel.includes(member.userId) && channel.includes(member.orgId)
        );
      }),
    ).toBeTruthy();
    expect(
      Object.values(capability).every((ops) => {
        return ops.length === 1 && ops[0] === "subscribe";
      }),
    ).toBeTruthy();
  });

  it("pf-094 sends and plays a private WAV through MCP and signed storage URLs", async () => {
    const harness = createHarness();
    const { member, token } = await harness.memberWithToken();
    const peer = await harness.seededUser(member.orgId);
    const peerToken = harness.signToken(peer);
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/signed-voice.wav",
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({
          ContentLength: 128,
          ContentType: "audio/wav",
        });
      }
      if (command instanceof GetObjectCommand) {
        if (!command.input.Key?.startsWith("private-artifacts/")) {
          return Promise.reject(
            Object.assign(new Error("Missing object"), { name: "NoSuchKey" }),
          );
        }
        return Promise.resolve({
          ContentLength: 128,
          ContentType: "audio/wav",
          Body: Readable.from([Buffer.alloc(128, 0x61)]),
        });
      }
      if (command instanceof PutObjectCommand) {
        return Promise.resolve({ ETag: '"etag-1"' });
      }
      return Promise.resolve({});
    });

    const prepared = await mcpCall(token, "prepare_voice_upload", {
      filename: "device-note.wav",
      size: 128,
    });
    expect(prepared.isError).not.toBeTruthy();
    const uploaded = object({
      id: string(),
      uploadUrl: string(),
    }).parse(prepared.structuredContent);
    expect(uploaded.uploadUrl).toContain("https://r2.example.test/");

    const completed = await mcpCall(token, "complete_voice_upload", {
      id: uploaded.id,
    });
    expect(completed.isError).not.toBeTruthy();

    const sent = sendResult(
      await mcpCall(token, "send_chat_message", {
        userMessage: {
          version: 1,
          parts: [
            {
              type: "voice",
              clips: [{ fileId: uploaded.id }],
            },
          ],
        },
      }),
    );
    expect(sent.threadId).toBeTruthy();

    const playback = await mcpCall(token, "get_voice_playback_url", {
      fileId: uploaded.id,
    });
    expect(playback.isError).not.toBeTruthy();
    expect(playback.structuredContent).toMatchObject({
      url: "https://r2.example.test/signed-voice.wav",
    });

    const peerPlayback = await mcpCall(peerToken, "get_voice_playback_url", {
      fileId: uploaded.id,
    });
    expect(peerPlayback).toMatchObject(NOT_FOUND_RESULT);
  });

  it("pf-095 (1/2) recovers an empty device thread after losing the acknowledgement", async () => {
    const { token } = await createHarness().memberWithToken();
    const clientThreadId = randomUUID();

    const firstThread = object({ threadId: string() }).parse(
      (
        await mcpCall(token, "create_chat_thread", {
          clientThreadId,
          title: "Device conversation",
        })
      ).structuredContent,
    );
    const secondThread = object({ threadId: string() }).parse(
      (
        await mcpCall(token, "create_chat_thread", {
          clientThreadId,
          title: "Device conversation",
        })
      ).structuredContent,
    );
    expect(secondThread.threadId).toBe(firstThread.threadId);
  });

  it("pf-095 (2/2) recovers a keyed device send after losing the acknowledgement", async () => {
    const { token } = await createHarness().memberWithToken();
    const clientEventId = randomUUID();

    const firstSend = sendResult(
      await mcpCall(token, "send_chat_message", {
        clientEventId,
        prompt: "Retry safe message",
      }),
    );
    const secondSend = sendResult(
      await mcpCall(token, "send_chat_message", {
        threadId: firstSend.threadId,
        clientEventId,
        prompt: "Retry safe message",
      }),
    );
    expect(secondSend).toMatchObject({
      threadId: firstSend.threadId,
      eventId: firstSend.eventId,
    });

    const messages = await mcpCall(token, "get_chat_messages", {
      threadId: firstSend.threadId,
    });
    const rows = object({ rows: array(object({ eventId: string() })) }).parse(
      messages.structuredContent,
    ).rows;
    expect(
      rows.filter((row) => {
        return row.eventId === firstSend.eventId;
      }),
    ).toHaveLength(1);
  });

  it(
    "mcp-server-reads-008 reflects committed Run transitions without marking indicator or history reads as read",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const harness = createHarness();
      const { member, token } = await harness.memberWithToken();
      const fixture = createChatEventsFixture(context);
      const owner = publicRunOwner(context, member);
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();

      await Promise.all([
        fixture.api.configureRunnerGroup(),
        owner.run(() => {
          return bdd.bootstrapLimitedFreeOnboarding(member);
        }),
      ]);

      const launched = await owner.run(() => {
        return fixture.sendChatRun(member, {
          prompt: "Track indicator transitions via MCP",
          model: null,
        });
      });

      const indicatorsSchema = object({
        threads: record(string(), string()),
        unreadAt: record(string(), string()),
      });
      const firstIndicators = indicatorsSchema.parse(
        (await mcpCall(token, "get_chat_indicators")).structuredContent,
      );
      expect(firstIndicators.threads[launched.threadId]).toBe("active");
      expect(firstIndicators.unreadAt).toStrictEqual({});

      await owner.executionInput(launched.runId);

      const secondIndicators = indicatorsSchema.parse(
        (await mcpCall(token, "get_chat_indicators")).structuredContent,
      );
      expect(secondIndicators.threads[launched.threadId]).toBe("active");
      expect(secondIndicators.unreadAt).toStrictEqual({});

      const cancelled = await mcpCall(token, "cancel_run", {
        runId: launched.runId,
      });
      expect(cancelled.isError).not.toBeTruthy();
      expect(cancelled.structuredContent).toMatchObject({
        runId: launched.runId,
        status: "cancelled",
      });

      const history = object({
        snapshot: zUnknown().nullable(),
        hasMore: boolean(),
        rows: array(
          object({
            eventType: string(),
            runId: string().nullable().optional(),
            createdAt: string(),
          }),
        ),
      }).parse(
        (
          await mcpCall(token, "get_chat_messages", {
            threadId: launched.threadId,
          })
        ).structuredContent,
      );
      expect(history.snapshot).toBeNull();
      expect(history.hasMore).toBeFalsy();
      const cancelRow = history.rows.find((row) => {
        return (
          row.eventType === "run.cancelled" && row.runId === launched.runId
        );
      });
      expect(cancelRow).toBeDefined();

      const finalIndicators = indicatorsSchema.parse(
        (await mcpCall(token, "get_chat_indicators")).structuredContent,
      );
      expect(finalIndicators.threads[launched.threadId]).toBe("unread");
      expect(finalIndicators.unreadAt[launched.threadId]).toBe(
        cancelRow?.createdAt,
      );

      const threadRead = await owner.run(() => {
        return fixture.chat.readThread(member, launched.threadId);
      });
      expect(threadRead.lastReadAt).toBeNull();
    },
  );

  it(
    "mcp-server-reads-019 authorizes OAuth cancellation through the same Web entry, preserving peer denial and cancellation side effects",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const harness = createHarness();
      const { member, token } = await harness.memberWithToken();
      const readOnlyToken = harness.signToken(member, { scope: READ_SCOPES });
      const peer = await harness.seededUser(member.orgId);
      const peerToken = harness.signToken(peer);

      const fixture = createChatEventsFixture(context);
      const owner = publicRunOwner(context, member);
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();

      await Promise.all([
        fixture.api.configureRunnerGroup(),
        owner.run(() => {
          return bdd.bootstrapLimitedFreeOnboarding(member);
        }),
      ]);

      const launched = await owner.run(() => {
        return fixture.sendChatRun(member, {
          prompt: "Authorize OAuth activity summary and cancellation",
          model: null,
        });
      });
      await owner.executionInput(launched.runId);

      const [mcpSummary, webSummary] = await Promise.all([
        mcpCall(token, "get_chat_activity_summary", {
          threadId: launched.threadId,
          runId: launched.runId,
        }),
        mcpWeb(
          token,
          `/api/chat-threads/${launched.threadId}/activity-summary`,
          "POST",
          { runId: launched.runId },
        ),
      ]);
      expect(mcpSummary.isError).not.toBeTruthy();
      expect(mcpSummary.structuredContent).toMatchObject({
        runId: launched.runId,
      });
      expect(webSummary.status).toBe(200);
      expect(webSummary.body).toMatchObject({
        runId: launched.runId,
      });

      const [readOnlyCancel, peerWebCancel, peerMcpCancel] = await Promise.all([
        mcpWeb(readOnlyToken, `/api/runs/${launched.runId}/cancel`, "POST", {}),
        mcpWeb(peerToken, `/api/runs/${launched.runId}/cancel`, "POST", {}),
        mcpCall(peerToken, "cancel_run", { runId: launched.runId }),
      ]);
      expect(readOnlyCancel.status).toBe(403);
      expect(readOnlyCancel.body).toMatchObject({
        error: { code: "FORBIDDEN" },
      });
      expect(peerMcpCancel.isError).toBeTruthy();
      expect(peerMcpCancel.structuredContent).toStrictEqual(peerWebCancel.body);

      const memberCancel = await mcpCall(token, "cancel_run", {
        runId: launched.runId.toUpperCase(),
      });
      expect(memberCancel.isError).not.toBeTruthy();
      expect(memberCancel.structuredContent).toMatchObject({
        runId: launched.runId,
        status: "cancelled",
        message: "Run cancelled successfully",
      });

      const [readBack, repeatWebCancel] = await Promise.all([
        owner.run(() => {
          return fixture.api.readRun(member, launched.runId);
        }),
        mcpWeb(token, `/api/runs/${launched.runId}/cancel`, "POST", {}),
      ]);
      expect(readBack.status).toBe("cancelled");
      expect(repeatWebCancel.status).toBe(200);
      expect(repeatWebCancel.body).toMatchObject({
        id: launched.runId,
        status: "cancelled",
        message: "Run cancelled successfully",
      });
    },
  );
});
