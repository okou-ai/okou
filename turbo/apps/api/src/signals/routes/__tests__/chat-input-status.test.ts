import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";

import {
  CHAT_INPUT_STATUS_MAX_RESPONSE_BYTES,
  chatInputStatusContract,
} from "@okouai/api-contracts/contracts/chat-input-status";
import {
  chatEventsContract,
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { mcpSendChatMessageOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-tools";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { runsCancelContract } from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  runnersSteerContract,
} from "@okouai/api-contracts/contracts/runners";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it } from "vitest";
import {
  array,
  boolean,
  literal,
  object,
  string,
  unknown as zUnknown,
} from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatInputStatusRoutes } from "../chat-input-status";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { logsRoutes } from "../logs";
import { mcpServerRoutes } from "../mcp-server";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { MCP_WEB_SCOPES } from "./helpers/mcp-web-api";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
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
const MCP_TEST_KID = "chat-input-status-mcp-kid-1";
const MCP_ISSUER = "https://clerk.mcp.example.test";
const MCP_RESOURCE = "https://api.mcp.example.test/mcp";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

const MCP_CALL_REPLY_SCHEMA = object({
  result: object({
    isError: boolean().optional(),
    structuredContent: zUnknown().optional(),
    content: array(object({ type: literal("text"), text: string() })),
  }),
});

const context = testContext();
const bdd = createBddApi(context);
const fixture = createChatEventsFixture(context);
const routeMocks = createRouteMocks(context);

const inputStatusClient = setupApp({
  context,
  routes: chatInputStatusRoutes,
})(chatInputStatusContract);
const mcpClient = setupApp({
  context,
  routes: mcpServerRoutes,
})(mcpServerContract);
const chatEventsClient = setupApp({
  context,
  routes: chatEventsRoutes,
})(chatEventsContract);
const chatThreadCreateClient = setupApp({
  context,
  routes: chatThreadCreateRoutes,
})(chatThreadsContract);
const chatThreadByIdClient = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadByIdContract);
const chatThreadEventsClient = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadEventsContract);
const onboardingCompleteClient = setupApp({
  context,
  routes: onboardingCompleteRoutes,
})(onboardingCompleteContract);
const runnersHeartbeatClient = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const runnersSteerClient = setupApp({
  context,
  routes: runnersRoutes,
})(runnersSteerContract);
const webhookCompleteClient = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const runsCancelClient = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);
const logsListClient = setupApp({
  context,
  routes: logsRoutes,
})(logsListContract);

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const warmupThreadId = randomUUID();
  const warmupEventId = randomUUID();
  const warmupRunId = randomUUID();
  await Promise.all([
    accept(
      inputStatusClient.get({
        headers: {},
        params: { threadId: warmupThreadId, eventId: warmupEventId },
      }),
      [401],
    ),
    accept(
      mcpClient.request({
        extraHeaders: {},
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        },
      }),
      [401, 503],
    ),
    accept(
      chatEventsClient.send({
        headers: {},
        body: {
          prompt: "warmup",
          hasTextContent: true,
          clientEventId: randomUUID(),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "warmup" }],
          },
        },
      }),
      [401],
    ),
    accept(
      chatThreadCreateClient.create({
        headers: {},
        body: { title: "warmup", model: null },
      }),
      [401],
    ),
    accept(
      chatThreadByIdClient.get({
        headers: {},
        params: { id: warmupThreadId },
      }),
      [401],
    ),
    accept(
      chatThreadEventsClient.rows({
        headers: {},
        params: { threadId: warmupThreadId },
        query: { sinceSeqId: 0 },
      }),
      [401],
    ),
    accept(onboardingCompleteClient.complete({ headers: {}, body: {} }), [401]),
    accept(
      runnersHeartbeatClient.heartbeat({
        headers: {},
        body: {
          runnerId: randomUUID(),
          group: "vm0/warmup",
          snapshotGeneration: 1,
          snapshotSequence: 1,
          totalVcpu: 8,
          totalMemoryMb: 16_384,
          maxConcurrent: 2,
          allocatedVcpu: 0,
          allocatedMemoryMb: 0,
          runningCount: 0,
          admittableProfiles: ["vm0/default"],
          heldSandboxStates: [],
          heldHomeStates: [],
          activeReuseProducers: [],
          mode: "running",
        },
      }),
      [401],
    ),
    accept(
      runnersSteerClient.next({
        headers: {},
        params: { runId: warmupRunId },
      }),
      [401],
    ),
    accept(
      runnersSteerClient.steered({
        headers: {},
        params: { runId: warmupRunId, eventId: warmupEventId },
        body: {},
      }),
      [401],
    ),
    accept(
      webhookCompleteClient.complete({
        headers: {},
        body: { runId: warmupRunId, exitCode: 0 },
      }),
      [401],
    ),
    accept(
      runsCancelClient.cancel({
        headers: {},
        params: { id: warmupRunId },
      }),
      [401],
    ),
    accept(
      logsListClient.list({
        headers: {},
        query: { limit: 1 },
      }),
      [401],
    ),
  ]);
});

function signIn(actor: ApiTestUser) {
  routeMocks.clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole ?? "org:admin",
  );
  return SESSION_HEADERS;
}

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function mcpCall(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await accept(
    mcpClient.request({
      extraHeaders: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "MCP-Method": "tools/call",
        "MCP-Name": name,
      },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
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
  const rawBody: unknown = response.body;
  let parsedReply: unknown = rawBody;
  if (typeof rawBody === "string") {
    const frame = rawBody.split("\n").find((line) => {
      return line.startsWith("data: ");
    });
    if (!frame) {
      throw new Error("Expected an MCP SSE reply");
    }
    parsedReply = JSON.parse(frame.slice(6)) as unknown;
  }
  return MCP_CALL_REPLY_SCHEMA.parse(parsedReply).result;
}

function installMcpOAuthHarness() {
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
    identity: { readonly userId: string; readonly orgId: string },
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
        sub: identity.userId,
        org_id: identity.orgId,
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

  async function addMembership(
    userId: string,
    orgId: string,
    role: "admin" | "member" = "admin",
  ): Promise<void> {
    await store.set(
      seedOrgMembership$,
      { userId, orgId, role },
      context.signal,
    );
  }

  return { signToken, addMembership };
}

async function prepareEntitledMcpActor() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected actor orgId");
  }
  const orgId = actor.orgId;
  const previousOpenrouterKey = optionalEnv("OPENROUTER_API_KEY");
  fixture.chatCallbacks.acceptChatObjectStorage();
  fixture.api.acceptStorageDownloads();
  fixture.api.acceptTelemetryIngest();
  fixture.chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
  const captured = captureConnectorExternalState(context, [
    "OPENROUTER_API_KEY",
  ]);
  const owner = publicRunOwner(context, actor, {
    restoreEnvironment: () => {
      captured();
      mockOptionalEnv("OPENROUTER_API_KEY", previousOpenrouterKey);
    },
  });
  await owner.run(async () => {
    await Promise.all([
      bdd.bootstrapLimitedFreeOnboarding(actor),
      fixture.api.configureRunnerGroup(),
    ]);
  });
  const oauth = installMcpOAuthHarness();
  await oauth.addMembership(actor.userId, orgId, "admin");
  const token = oauth.signToken({ userId: actor.userId, orgId });
  return { actor: { ...actor, orgId }, owner, oauth, token };
}

async function sendAutoRun(
  actor: ApiTestUser,
  token: string,
  prompt: string,
  clientEventId = randomUUID(),
) {
  const sent = await accept(
    chatEventsClient.send({
      headers: signIn(actor),
      body: {
        prompt,
        model: null,
        hasTextContent: true,
        clientEventId,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: prompt }],
        },
      },
    }),
    [201],
  );
  await flushWaitUntilForTest();
  const status = await accept(
    inputStatusClient.get({
      headers: bearerHeaders(token),
      params: { threadId: sent.body.threadId, eventId: clientEventId },
    }),
    [200],
  );
  if (status.body.status !== "consumed") {
    throw new Error(`Expected consumed run, got ${status.body.status}`);
  }
  return {
    threadId: sent.body.threadId,
    runId: status.body.runId,
    clientEventId,
    replacementEventId: status.body.replacement?.eventId ?? null,
  };
}

describe("retained chat input observation", () => {
  it(
    "chat-input-status-003 correlates MCP inputs sharing a Run and returns bounded, body-free terminal outcomes",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner, token } = await prepareEntitledMcpActor();

      const firstSendReply = await mcpCall(token, "send_chat_message", {
        prompt: "First MCP prompt",
        model: null,
      });
      expect(firstSendReply.isError).toBeFalsy();
      const firstSent = mcpSendChatMessageOutputSchema.parse(
        firstSendReply.structuredContent,
      );
      await flushWaitUntilForTest();

      const [beforeDetail, firstConsumedHttp] = await Promise.all([
        accept(
          chatThreadByIdClient.get({
            headers: signIn(actor),
            params: { id: firstSent.threadId },
          }),
          [200],
        ),
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: firstSent.threadId,
              eventId: firstSent.eventId,
            },
          }),
          [200],
        ),
      ]);

      expect(firstConsumedHttp.headers.get("cache-control")).toBe("no-store");
      expect(firstConsumedHttp.body.status).toBe("consumed");
      expect(firstConsumedHttp.body.terminal).toBeNull();
      expect(firstConsumedHttp.body.input?.eventId).toBe(firstSent.eventId);
      expect(firstConsumedHttp.body.replacement?.eventId).toStrictEqual(
        expect.any(String),
      );

      if (firstConsumedHttp.body.status !== "consumed") {
        throw new Error("Expected first input to be consumed");
      }
      const runId = firstConsumedHttp.body.runId;
      const execution = await owner.executionInput(runId);

      const promptMarker = "long-steer-marker-";
      const longPrompt = `${promptMarker}${"x".repeat(32_001 - promptMarker.length)}`;
      expect(longPrompt).toHaveLength(32_001);

      const secondSendReply = await mcpCall(token, "send_chat_message", {
        threadId: firstSent.threadId,
        prompt: longPrompt,
      });
      expect(secondSendReply.isError).toBeFalsy();
      const secondSent = mcpSendChatMessageOutputSchema.parse(
        secondSendReply.structuredContent,
      );
      await flushWaitUntilForTest();

      const sandboxHeaders = bearerHeaders(execution.sandboxToken);
      const [secondQueuedHttp, polled] = await Promise.all([
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: firstSent.threadId,
              eventId: secondSent.eventId,
            },
          }),
          [200],
        ),
        accept(
          runnersSteerClient.next({
            headers: sandboxHeaders,
            params: { runId },
          }),
          [200],
        ),
      ]);

      expect(secondQueuedHttp.body).toStrictEqual({
        threadId: firstSent.threadId,
        eventId: secondSent.eventId,
        status: "queued",
        input: {
          eventId: secondSent.eventId,
          seqId: expect.any(Number),
          createdAt: expect.any(String),
        },
        replacement: null,
        runId: null,
        terminal: null,
      });
      expect(polled.body.input?.eventId).toBe(secondSent.eventId);

      const steered = await accept(
        runnersSteerClient.steered({
          headers: sandboxHeaders,
          params: { runId, eventId: secondSent.eventId },
          body: {},
        }),
        [200],
      );
      expect(steered.body).toStrictEqual({ outcome: "steered" });

      const [secondSteeredHttp, secondSteeredMcp] = await Promise.all([
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: firstSent.threadId,
              eventId: secondSent.eventId,
            },
          }),
          [200],
        ),
        mcpCall(token, "get_chat_input_status", {
          threadId: firstSent.threadId,
          eventId: secondSent.eventId,
        }),
      ]);

      const firstConsumedJson = JSON.stringify(firstConsumedHttp.body);
      const secondSteeredJson = JSON.stringify(secondSteeredHttp.body);
      expect(secondSteeredHttp.body.status).toBe("consumed");
      expect(secondSteeredHttp.body.runId).toBe(runId);
      expect(secondSteeredHttp.body.terminal).toBeNull();
      expect(secondSteeredHttp.body.replacement?.eventId).toStrictEqual(
        expect.any(String),
      );
      expect(secondSteeredHttp.body.replacement?.eventId).not.toBe(
        secondSent.eventId,
      );
      expect(Buffer.byteLength(secondSteeredJson, "utf8")).toBe(
        Buffer.byteLength(firstConsumedJson, "utf8"),
      );
      expect(Buffer.byteLength(secondSteeredJson, "utf8")).toBeLessThanOrEqual(
        CHAT_INPUT_STATUS_MAX_RESPONSE_BYTES,
      );
      expect(secondSteeredJson).not.toContain(promptMarker);
      expect(secondSteeredMcp.isError).toBeFalsy();
      expect(secondSteeredMcp.structuredContent).toStrictEqual(
        secondSteeredHttp.body,
      );

      await accept(
        webhookCompleteClient.complete({
          headers: sandboxHeaders,
          body: {
            runId,
            exitCode: 0,
            completion: {
              cliAgentType: "pi",
              cliAgentSessionId: firstSent.threadId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const [
        firstCompletedHttp,
        firstCompletedMcp,
        secondCompletedHttp,
        secondCompletedMcp,
        threadRows,
        afterDetail,
      ] = await Promise.all([
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: firstSent.threadId,
              eventId: firstSent.eventId,
            },
          }),
          [200],
        ),
        mcpCall(token, "get_chat_input_status", {
          threadId: firstSent.threadId,
          eventId: firstSent.eventId,
        }),
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: firstSent.threadId,
              eventId: secondSent.eventId,
            },
          }),
          [200],
        ),
        mcpCall(token, "get_chat_input_status", {
          threadId: firstSent.threadId,
          eventId: secondSent.eventId,
        }),
        accept(
          chatThreadEventsClient.rows({
            headers: signIn(actor),
            params: { threadId: firstSent.threadId },
            query: { sinceSeqId: 0, limit: 50 },
          }),
          [200],
        ),
        accept(
          chatThreadByIdClient.get({
            headers: signIn(actor),
            params: { id: firstSent.threadId },
          }),
          [200],
        ),
      ]);

      const completedRow = threadRows.body.rows.find((row) => {
        return row.eventType === "run.completed" && row.runId === runId;
      });
      if (!completedRow) {
        throw new Error("Expected a retained run.completed row");
      }
      const expectedTerminal = {
        eventId: completedRow.id,
        seqId: completedRow.seqId,
        createdAt: completedRow.createdAt,
      };

      expect(firstCompletedHttp.body).toMatchObject({
        status: "completed",
        runId,
        terminal: expectedTerminal,
      });
      expect(secondCompletedHttp.body).toMatchObject({
        status: "completed",
        runId,
        terminal: expectedTerminal,
      });
      expect(
        Buffer.byteLength(JSON.stringify(secondCompletedHttp.body), "utf8"),
      ).toBeLessThanOrEqual(CHAT_INPUT_STATUS_MAX_RESPONSE_BYTES);
      expect(JSON.stringify(secondCompletedHttp.body)).not.toContain(
        promptMarker,
      );
      expect(firstCompletedMcp.isError).toBeFalsy();
      expect(firstCompletedMcp.structuredContent).toStrictEqual(
        firstCompletedHttp.body,
      );
      expect(secondCompletedMcp.isError).toBeFalsy();
      expect(secondCompletedMcp.structuredContent).toStrictEqual(
        secondCompletedHttp.body,
      );
      expect(afterDetail.body.lastReadAt).toBe(beforeDetail.body.lastReadAt);
    },
  );

  it(
    "chat-input-status-004 returns the matching Chat failed event without its error body",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner, token } = await prepareEntitledMcpActor();
      const started = await sendAutoRun(actor, token, "Trigger failed outcome");
      const execution = await owner.executionInput(started.runId);

      await accept(
        webhookCompleteClient.complete({
          headers: bearerHeaders(execution.sandboxToken),
          body: {
            runId: started.runId,
            exitCode: 1,
            error: "private failure detail",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const [statusResponse, threadRows] = await Promise.all([
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: started.threadId,
              eventId: started.clientEventId,
            },
          }),
          [200],
        ),
        accept(
          chatThreadEventsClient.rows({
            headers: signIn(actor),
            params: { threadId: started.threadId },
            query: { sinceSeqId: 0, limit: 50 },
          }),
          [200],
        ),
      ]);

      const failedRow = threadRows.body.rows.find((row) => {
        return row.eventType === "run.failed" && row.runId === started.runId;
      });
      if (!failedRow) {
        throw new Error("Expected a retained run.failed row");
      }

      expect(statusResponse.headers.get("cache-control")).toBe("no-store");
      expect(statusResponse.body).toMatchObject({
        threadId: started.threadId,
        eventId: started.clientEventId,
        status: "failed",
        runId: started.runId,
        terminal: {
          eventId: failedRow.id,
          seqId: failedRow.seqId,
          createdAt: failedRow.createdAt,
        },
      });
      expect(JSON.stringify(statusResponse.body)).not.toContain(
        "private failure detail",
      );
    },
  );

  it(
    "chat-input-status-007 distinguishes an unassigned queued input, its recall and unavailable evidence",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner, token } = await prepareEntitledMcpActor();
      const activeRun = await sendAutoRun(actor, token, "Keep the thread busy");
      await owner.executionInput(activeRun.runId);

      const queuedEventId = randomUUID();
      await accept(
        chatEventsClient.send({
          headers: signIn(actor),
          body: {
            threadId: activeRun.threadId,
            prompt: "Queued follow-up to revoke",
            hasTextContent: true,
            clientEventId: queuedEventId,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "Queued follow-up to revoke" }],
            },
          },
        }),
        [201],
      );
      await flushWaitUntilForTest();

      const queuedStatus = await accept(
        inputStatusClient.get({
          headers: bearerHeaders(token),
          params: {
            threadId: activeRun.threadId,
            eventId: queuedEventId,
          },
        }),
        [200],
      );
      expect(queuedStatus.body).toStrictEqual({
        threadId: activeRun.threadId,
        eventId: queuedEventId,
        status: "queued",
        input: {
          eventId: queuedEventId,
          seqId: expect.any(Number),
          createdAt: expect.any(String),
        },
        replacement: null,
        runId: null,
        terminal: null,
      });

      const revokeReply = await mcpCall(token, "revoke_queued_message", {
        threadId: activeRun.threadId,
        eventId: queuedEventId,
      });
      expect(revokeReply.isError).toBeFalsy();
      await flushWaitUntilForTest();

      const unknownEventId = randomUUID();
      const [revokedStatus, unavailableStatus] = await Promise.all([
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: activeRun.threadId,
              eventId: queuedEventId,
            },
          }),
          [200],
        ),
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: activeRun.threadId,
              eventId: unknownEventId,
            },
          }),
          [200],
        ),
      ]);

      expect(revokedStatus.body).toStrictEqual({
        threadId: activeRun.threadId,
        eventId: queuedEventId,
        status: "revoked",
        input: queuedStatus.body.input,
        replacement: {
          eventId: expect.any(String),
          seqId: expect.any(Number),
          createdAt: expect.any(String),
        },
        runId: null,
        terminal: null,
      });
      expect(revokedStatus.body.replacement?.eventId).not.toBe(queuedEventId);

      expect(unavailableStatus.body).toStrictEqual({
        threadId: activeRun.threadId,
        eventId: unknownEventId,
        status: "unavailable",
        input: null,
        replacement: null,
        runId: null,
        terminal: null,
      });
    },
  );

  it(
    "chat-input-status-010 preserves user and organization isolation and requires original input identity",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner, oauth, token } = await prepareEntitledMcpActor();
      const started = await sendAutoRun(
        actor,
        token,
        "Original isolated input",
      );
      const replacementEventId = started.replacementEventId;
      if (!replacementEventId) {
        throw new Error("Expected consuming replacement event ID");
      }

      const sameOrgPeer = bdd.user({
        orgId: actor.orgId,
        orgRole: "org:member",
      });
      const otherOrgId = `org_${randomUUID()}`;

      const [, otherOwnThread] = await Promise.all([
        owner.executionInput(started.runId),
        accept(
          chatThreadCreateClient.create({
            headers: signIn(actor),
            body: { title: "Different own thread", model: null },
          }),
          [201],
        ),
        oauth.addMembership(sameOrgPeer.userId, actor.orgId, "member"),
        oauth.addMembership(actor.userId, otherOrgId, "member"),
      ]);

      const sameOrgPeerToken = oauth.signToken({
        userId: sameOrgPeer.userId,
        orgId: actor.orgId,
      });
      const sameUserOtherOrgToken = oauth.signToken({
        userId: actor.userId,
        orgId: otherOrgId,
      });
      const unknownThreadId = randomUUID();

      const [
        wrongOwnThreadHttp,
        replacementIdHttp,
        unknownThreadHttp,
        peerHttp,
        peerMcp,
        otherOrgHttp,
        otherOrgMcp,
      ] = await Promise.all([
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: otherOwnThread.body.id,
              eventId: started.clientEventId,
            },
          }),
          [200],
        ),
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: started.threadId,
              eventId: replacementEventId,
            },
          }),
          [400],
        ),
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(token),
            params: {
              threadId: unknownThreadId,
              eventId: started.clientEventId,
            },
          }),
          [404],
        ),
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(sameOrgPeerToken),
            params: {
              threadId: started.threadId,
              eventId: started.clientEventId,
            },
          }),
          [404],
        ),
        mcpCall(sameOrgPeerToken, "get_chat_input_status", {
          threadId: started.threadId,
          eventId: started.clientEventId,
        }),
        accept(
          inputStatusClient.get({
            headers: bearerHeaders(sameUserOtherOrgToken),
            params: {
              threadId: started.threadId,
              eventId: started.clientEventId,
            },
          }),
          [404],
        ),
        mcpCall(sameUserOtherOrgToken, "get_chat_input_status", {
          threadId: started.threadId,
          eventId: started.clientEventId,
        }),
      ]);

      expect(wrongOwnThreadHttp.body).toStrictEqual({
        threadId: otherOwnThread.body.id,
        eventId: started.clientEventId,
        status: "unavailable",
        input: null,
        replacement: null,
        runId: null,
        terminal: null,
      });
      expect(replacementIdHttp.body.error.message).toBe(
        "Use the original accepted input event ID",
      );
      expect(unknownThreadHttp.body.error.code).toBe("NOT_FOUND");
      expect(peerHttp.body.error.code).toBe("NOT_FOUND");
      expect(peerMcp).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "NOT_FOUND" } },
      });
      expect(otherOrgHttp.body.error.code).toBe("NOT_FOUND");
      expect(otherOrgMcp).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "NOT_FOUND" } },
      });
    },
  );
});
