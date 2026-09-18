import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecureContext, TLSSocket } from "node:tls";
import { promisify } from "node:util";

import {
  executionContextSchema,
  PI_DEFERRED_SANDBOX_HEADER,
  runnersJobClaimContract,
  runnersPollContract,
} from "@okouai/api-contracts/contracts/runners";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { createPiSessionJsonl } from "@okouai/pi-agent-runtime/api";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { agentRunInference } from "@okouai/db/schema/agent-run-inference";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { guestBoundaryEnvironment } from "../../../__tests__/env-stub";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "../../routes/__tests__/helpers/route-test";
import { db } from "../../../lib/db";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { createDeferredPromise, settle } from "../../utils";
import {
  deletePiObjectOrphansForOwner,
  publishPiInferenceObject,
} from "../pi-inference-object.service";
import {
  consumeDeferredPiRun$,
  publishPiSandboxDemand,
} from "../pi-deferred-sandbox.service";
import {
  piDeferredConfigurationSchema,
  piDeferredContextSchema,
  piDeferredH1Schema,
} from "../pi-deferred-sandbox-contract";
import {
  removePiInferenceFixture,
  seedPiInferenceFixture,
} from "../../../test-fixtures/pi-inference-lifecycle";
import { generateOkouToken } from "../../auth/tokens";
import { runnersRoutes } from "../../routes/runners";
import { webhooksAgentCheckpointsRoutes } from "../../routes/webhooks-agent-checkpoints";
import { webhooksAgentCompleteRoutes } from "../../routes/webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../../routes/webhooks-agent-events";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../routes/webhooks-agent-health-usage-telemetry";
import { webhooksAgentSessionOutputRoutes } from "../../routes/webhooks-agent-session-output";
import { webhooksAgentStorageRoutes } from "../../routes/webhooks-agent-storage";

const context = testContext();
const guestEnvironment = guestBoundaryEnvironment();
const repo = resolve(
  fileURLToPath(new URL("../../../../../../..", import.meta.url)),
);
const cargo = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: resolve(repo, "crates"),
    encoding: "utf8",
  }),
) as { target_directory: string };
const commit = "a".repeat(40);

type ContinuationMode = "pending" | "settled";

interface RequestObservation {
  readonly path: string;
  readonly status: number;
}

interface GuestEventBatch {
  readonly runId: string;
  readonly events: readonly {
    readonly sequenceNumber: number;
    readonly session_file?: string;
    readonly session_id?: string;
    readonly subtype?: string;
    readonly type: string;
  }[];
}

interface BoundaryServer {
  readonly baseUrl: string;
  readonly proxyUrl: string;
  readonly caCertificate: string;
  readonly requests: RequestObservation[];
  readonly guestEventBodies: GuestEventBatch[];
  readonly providerBodies: unknown[];
  readonly proxyConnections: string[];
  readonly proxyErrors: string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

async function readTlsHttpRequest(socket: TLSSocket): Promise<Buffer> {
  const request = createDeferredPromise<Buffer>(context.signal);
  let bytes = Buffer.alloc(0);
  const cleanup = () => {
    socket.off("data", onData);
    socket.off("error", onError);
    socket.off("end", onEnd);
  };
  const onError = (error: Error) => {
    cleanup();
    request.reject(error);
  };
  const onEnd = () => {
    cleanup();
    request.reject(new Error("Provider proxy TLS request ended early"));
  };
  const onData = (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    const headerEnd = bytes.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = bytes.subarray(0, headerEnd).toString("latin1");
    const contentLength = Number(
      /(?:^|\r\n)content-length:\s*(\d+)/i.exec(header)?.[1] ?? "0",
    );
    const requestLength = headerEnd + 4 + contentLength;
    if (bytes.length < requestLength) {
      return;
    }
    cleanup();
    request.resolve(bytes.subarray(0, requestLength));
  };
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("end", onEnd);
  return await request.promise;
}

async function serveProviderProxy(
  socket: TLSSocket,
  requests: RequestObservation[],
  providerBodies: unknown[],
): Promise<void> {
  const request = await readTlsHttpRequest(socket);
  const headerEnd = request.indexOf("\r\n\r\n");
  const firstLine = request
    .subarray(0, headerEnd)
    .toString("latin1")
    .split("\r\n")[0];
  const path = firstLine?.split(" ")[1] ?? "/";
  const body = request.subarray(headerEnd + 4);
  providerBodies.push(JSON.parse(body.toString("utf8")) as unknown);
  const text = "Resumed exactly once";
  const responseId = "deferred-boundary-continuation";
  const messageId = "deferred-boundary-message";
  const events = [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: messageId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  const responseBody = events
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
  socket.end(
    `HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: ${Buffer.byteLength(responseBody)}\r\nconnection: close\r\n\r\n${responseBody}`,
  );
  requests.push({ path, status: 200 });
}

async function startBoundaryServer(): Promise<BoundaryServer> {
  const certificateRoot = await mkdtemp(
    join(tmpdir(), "pi-deferred-boundary-ca-"),
  );
  const key = join(certificateRoot, "gateway.key");
  const certificate = join(certificateRoot, "gateway.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=api.deepseek.com",
      "-addext",
      "subjectAltName=DNS:api.deepseek.com",
    ],
    { stdio: "ignore" },
  );
  onTestFinished(() => {
    return rm(certificateRoot, { recursive: true, force: true });
  });
  const secureContext = createSecureContext({
    key: await readFile(key),
    cert: await readFile(certificate),
  });
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...runnersRoutes,
      ...webhooksAgentCheckpointsRoutes,
      ...webhooksAgentCompleteRoutes,
      ...webhooksAgentEventsRoutes,
      ...webhooksAgentHealthUsageTelemetryRoutes,
      ...webhooksAgentSessionOutputRoutes,
      ...webhooksAgentStorageRoutes,
    ],
  });
  const requests: RequestObservation[] = [];
  const guestEventBodies: GuestEventBatch[] = [];
  const providerBodies: unknown[] = [];
  const proxyConnections: string[] = [];
  const proxyErrors: string[] = [];
  async function serve(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const result = await settle(
      (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        const path = request.url ?? "/";
        // The integration boundary starts at authenticated handoff preparation
        // and ends at official continuation. Keep its unrelated liveness,
        // object-storage checkpoint and terminal transition local. In
        // particular, the liveness stub lets the historical ordinary Agent
        // token reach the real handoff verifier instead of failing earlier.
        if (path === "/api/webhooks/agent/heartbeat") {
          requests.push({ path, status: 200 });
          response.writeHead(200);
          response.end();
          return;
        }
        if (path === "/api/webhooks/agent/checkpoints/prepare-history") {
          requests.push({ path, status: 200 });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ existing: true, encoding: "zstd" }));
          return;
        }
        if (path === "/api/webhooks/agent/complete") {
          requests.push({ path, status: 204 });
          response.writeHead(204);
          response.end();
          return;
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === "string") {
            headers.set(key, value);
          }
        }
        if (path === "/api/webhooks/agent/events") {
          guestEventBodies.push(
            JSON.parse(bytes.toString("utf8")) as GuestEventBatch,
          );
        }
        const apiResponse = await app.request(path, {
          method: request.method,
          headers,
          ...(bytes.length ? { body: bytes } : {}),
        });
        const responseBody = await apiResponse.arrayBuffer();
        requests.push({ path, status: apiResponse.status });
        response.writeHead(
          apiResponse.status,
          Object.fromEntries(apiResponse.headers),
        );
        response.end(Buffer.from(responseBody));
      })(),
      context.signal,
    );
    if (!result.ok) {
      response.writeHead(500);
      response.end(String(result.error));
    }
  }

  const requestTasks: Promise<PromiseSettledResult<void>[]>[] = [];
  const server = createServer((request, response) => {
    requestTasks.push(Promise.allSettled([serve(request, response)]));
  });
  server.on("connect", (request, socket, head) => {
    proxyConnections.push(request.url ?? "");
    const task = settle(
      (async () => {
        if (request.url !== "api.deepseek.com:443") {
          throw new Error(`Unexpected provider CONNECT target: ${request.url}`);
        }
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          socket.unshift(head);
        }
        const tlsSocket = new TLSSocket(socket, {
          isServer: true,
          secureContext,
        });
        await serveProviderProxy(tlsSocket, requests, providerBodies);
      })(),
      context.signal,
    ).then((result) => {
      if (!result.ok) {
        proxyErrors.push(String(result.error));
        socket.destroy(result.error as Error);
        throw result.error;
      }
    });
    requestTasks.push(Promise.allSettled([task]));
  });
  const listening = once(server, "listening", { signal: context.signal });
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Deferred boundary listener has no address");
  }
  onTestFinished(async () => {
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
    const results = (await Promise.all(requestTasks)).flat();
    expect(
      results.filter((result) => {
        return result.status === "rejected";
      }),
    ).toStrictEqual([]);
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    proxyUrl: baseUrl,
    caCertificate: certificate,
    requests,
    guestEventBodies,
    providerBodies,
    proxyConnections,
    proxyErrors,
  };
}

async function createClaimedRun(mode: ContinuationMode, toolPath: string) {
  // The deferred producer is default-off and exposes no production endpoint
  // that can create this pre-claim source state. Internal setup stops before
  // the real Runner poll/claim and authenticated handoff HTTP boundaries.
  const fixture = await seedPiInferenceFixture({ phase: "publishing" });
  onTestFinished(async () => {
    await removePiInferenceFixture(fixture);
    await deletePiObjectOrphansForOwner(db(), { userId: fixture.userId });
    await db()
      .delete(builtInModelKeys)
      .where(eq(builtInModelKeys.vendor, fixture.runId));
  });
  createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
  mockEnv("GIT_COMMIT_SHA", commit);
  mockOptionalEnv(
    "RUNNER_DEFAULT_GROUP",
    `vm0/deferred-boundary-${fixture.runId}`,
  );
  mockEnv(
    "CLI_PKG_URL",
    `https://static.okou.io/okou-cli/${commit}/package.tgz`,
  );
  const [key] = await db()
    .insert(builtInModelKeys)
    .values({ vendor: fixture.runId, apiKey: "boundary-provider-key" })
    .returning({ id: builtInModelKeys.id });
  if (!key) {
    throw new Error("Deferred boundary fixture has no model key");
  }
  await db()
    .update(agentRuns)
    .set({
      builtInModelKeyId: key.id,
      modelProvider: "built-in",
      triggerSource: "web",
    })
    .where(eq(agentRuns.id, fixture.runId));
  const configuration = piDeferredConfigurationSchema.parse({
    schemaVersion: 1,
    resourceOwner: { userId: fixture.userId, orgId: fixture.orgId },
    body: {
      agentId: fixture.agentId,
      prompt: "Synthetic foundation fixture",
      triggerSource: "web",
    },
    productAgentExecutionPlan: {
      identity: "agent",
      content: { version: "1", agent: { framework: "claude-code" } },
    },
    connectorScope: {
      allowedConnectorSlugs: [],
      allowedCustomConnectorIds: [],
    },
    modelProviderId: null,
    modelProviderCredentialScope: null,
    modelProviderType: "built-in",
    selectedModel: "deepseek-v4-flash",
    runtimeProvider: "deepseek",
    runtimeModel: "deepseek-v4-flash",
    modelConfig: {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-flash",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "DEEPSEEK_API_KEY",
    },
    builtInModelRuntimeRoute: {
      selectedModel: "deepseek-v4-flash",
      providerType: "deepseek",
      upstreamModel: "deepseek-v4-flash",
      modelKeyId: key.id,
    },
    includeOkouTokenSecret: false,
  });
  const configurationHash = await publishPiInferenceObject(
    db(),
    fixture,
    "configuration",
    piDeferredConfigurationSchema,
    configuration,
  );
  const resourceSnapshot = {
    schemaVersion: 1 as const,
    agentsFiles: [],
    skills: [],
  };
  const contextHash = await publishPiInferenceObject(
    db(),
    fixture,
    "context",
    piDeferredContextSchema,
    {
      schemaVersion: 1,
      baseSession: { sessionId: fixture.threadId, sha256: null },
      resourceSnapshot,
      storageMounts: [],
      h0SessionHistory: createPiSessionJsonl({
        cwd: "/home/user/workspace",
        sessionId: fixture.threadId,
        timestamp: nowDate().toISOString(),
      }),
    },
  );

  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: fixture.threadId,
  });
  session.appendMessage({
    role: "user",
    content: "Continue from H1 without replaying the original provider turn",
    timestamp: 1,
  });
  session.appendMessage({
    role: "assistant",
    content:
      mode === "pending"
        ? [
            {
              type: "toolCall",
              id: "retained-tool-id",
              name: "read",
              arguments: { path: toolPath },
            },
          ]
        : [{ type: "text", text: "Already settled in API" }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: mode === "pending" ? "toolUse" : "stop",
    timestamp: 2,
  });
  const sessionHistory = session.toJsonl();
  const h1Hash = await publishPiInferenceObject(
    db(),
    fixture,
    "h1",
    piDeferredH1Schema,
    {
      schemaVersion: 1,
      manifestGeneration: 3,
      lastEventSequence: 4,
      sessionHistory,
      historyHash: sha256(sessionHistory),
    },
  );
  await db()
    .update(agentRunInference)
    .set({
      input: {
        schemaVersion: 1,
        inputEventId: null,
        inputGeneration: 0,
        configurationHash,
        contextHash,
        h0: { kind: "empty" },
        deferredSecrets: { kind: "none" },
      },
      publication: { h1Hash, manifestGeneration: 3, lastEventSequence: 4 },
    })
    .where(eq(agentRunInference.runId, fixture.runId));
  const continuation: Parameters<typeof publishPiSandboxDemand>[2] =
    mode === "pending"
      ? {
          mode: "pending-tools",
          h1Hash,
          manifestGeneration: 3,
          pendingToolIds: ["retained-tool-id"],
          lastEventSequence: 4,
        }
      : {
          mode: "settled-session",
          h1Hash,
          manifestGeneration: 3,
          lastEventSequence: 4,
        };
  await expect(
    publishPiSandboxDemand(
      db(),
      { runId: fixture.runId, ownerEpoch: 1, generation: 1 },
      continuation,
    ),
  ).resolves.toBeTruthy();
  await expect(
    createStore().set(consumeDeferredPiRun$, fixture.runId, context.signal),
  ).resolves.toBeTruthy();

  const runnerId = randomUUID();
  const runnerHeaders = {
    authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
  };
  const poll = await accept(
    setupApp({ context, routes: runnersRoutes })(runnersPollContract).poll({
      headers: runnerHeaders,
      extraHeaders: { [PI_DEFERRED_SANDBOX_HEADER]: "1" },
      body: {
        group: `vm0/deferred-boundary-${fixture.runId}`,
        supportedProfiles: ["vm0/default"],
        runnerId,
      },
    }),
    [200],
  );
  expect(poll.body.job?.runId).toBe(fixture.runId);
  const response = await accept(
    setupApp({ context, routes: runnersRoutes })(runnersJobClaimContract).claim(
      {
        params: { id: fixture.runId },
        headers: runnerHeaders,
        extraHeaders: { [PI_DEFERRED_SANDBOX_HEADER]: "1" },
        body: {
          runnerIdentity: { runnerId, heartbeatGeneration: 1 },
          capabilities: { piModelConfigGenerations: [1, 2, 3, 4] },
        },
      },
    ),
    [200],
  );
  const execution = executionContextSchema.parse(response.body);
  expect(execution.piLaunchConfig?.apiFirstTurn).toMatchObject({
    schemaVersion: 2,
    ownerEpoch: 2,
    generation: 1,
    continuation: { mode: continuation.mode },
  });
  return {
    execution,
    fixture,
    ordinaryToken: generateOkouToken(
      fixture.userId,
      fixture.runId,
      fixture.orgId,
    ),
    resourceSnapshot,
    sessionHistory,
  };
}

async function runGuest(args: {
  readonly baseUrl: string;
  readonly proxyUrl: string;
  readonly caCertificate: string;
  readonly token: string;
  readonly ordinaryToken: string;
  readonly execution: ReturnType<typeof executionContextSchema.parse>;
  readonly timeoutSeconds?: number;
}) {
  const root = await mkdtemp(join(tmpdir(), "pi-deferred-boundary-"));
  onTestFinished(() => {
    return rm(root, { recursive: true, force: true });
  });
  const runtime = join(root, "runtime");
  const bin = join(root, "bin");
  await Promise.all([
    mkdir(join(runtime, "run-payload"), { recursive: true }),
    mkdir(join(runtime, "user-env"), { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);
  const childStarted = join(root, "child-started");
  const environmentCapture = join(root, "child-environment");
  const observedHandoff = join(root, "observed-handoff.json");
  const deferredHandoffFile = join(runtime, "pi-deferred-handoff/payload.json");
  const cliStderr = join(root, "cli-stderr.log");
  const cli = resolve(repo, "turbo/apps/cli/dist/okou.js");
  const proxyPreload = join(root, "provider-proxy.cjs");
  const undici = resolve(repo, "turbo/apps/cli/node_modules/undici");
  await writeFile(
    proxyPreload,
    [
      `const { ProxyAgent, setGlobalDispatcher } = require(${JSON.stringify(undici)});`,
      "setGlobalDispatcher(new ProxyAgent(process.env.ALL_PROXY));",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const shim = [
    "#!/bin/sh",
    "set -eu",
    `printf '%s\\n%s\\n%s\\n' "\${OKOU_TOKEN:-}" "\${OKOU_API_TOKEN+present}" "\${OKOU_PI_DEFERRED_HANDOFF_FILE:-}" > ${quote(environmentCapture)}`,
    `cp "$OKOU_PI_DEFERRED_HANDOFF_FILE" ${quote(observedHandoff)}`,
    `touch ${quote(childStarted)}`,
    `exec ${[process.execPath, "--require", proxyPreload, cli, "__agent-loop"].map(quote).join(" ")} 2> ${quote(cliStderr)}`,
    "",
  ].join("\n");
  await writeFile(join(bin, "npx"), shim, { mode: 0o700 });
  const payloadFile = join(runtime, "run-payload/payload.json");
  const userEnvFile = join(runtime, "user-env/env.json");
  await writeFile(
    payloadFile,
    JSON.stringify({
      prompt: args.execution.prompt,
      piSessionId: args.execution.piSessionId,
      piLaunchConfig: JSON.stringify(args.execution.piLaunchConfig),
      piModelConfig: JSON.stringify(args.execution.piModelConfig),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    userEnvFile,
    JSON.stringify({
      CLI_PKG_URL: "boundary-cli",
      OKOU_TOKEN: args.ordinaryToken,
      OPENAI_API_KEY: "boundary-provider-key",
      ALL_PROXY: args.proxyUrl,
      NO_PROXY: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: args.caCertificate,
      PATH: `${bin}:${guestEnvironment.PATH ?? ""}`,
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    resolve(cargo.target_directory, "local/guest-agent"),
    [],
    {
      env: {
        HOME: join(root, "home"),
        SHELL: "/bin/sh",
        OKOU_RUN_ID: args.execution.runId,
        OKOU_API_BACKEND_URL: args.baseUrl,
        OKOU_API_TOKEN: args.token,
        OKOU_API_START_TIME: String(args.execution.apiStartTime),
        OKOU_SANDBOX_ID: "00000000-0000-4000-8000-000000000866",
        OKOU_SANDBOX_REUSE_RESULT: "reused",
        OKOU_AGENT_EXECUTION_TIMEOUT_SECS: String(args.timeoutSeconds ?? 20),
        CLI_AGENT_TYPE: "pi",
        OKOU_GUEST_RUNTIME_DIR: runtime,
        OKOU_RUN_PAYLOAD_FILE: payloadFile,
        OKOU_USER_ENV_FILE: userEnvFile,
        OKOU_TEST_DISABLE_HTTP_RETRY_DELAY: "1",
        PATH: `${bin}:${guestEnvironment.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (bytes) => {
    output += String(bytes);
  });
  child.stderr.on("data", (bytes) => {
    output += String(bytes);
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const [code, signal] = await once(child, "exit", { signal: context.signal });
  return {
    code,
    signal,
    output,
    childStarted,
    environmentCapture,
    observedHandoff,
    deferredHandoffFile,
    cliStderr: await readFile(cliStderr, "utf8").catch(() => {
      return "";
    }),
  };
}

describe("deferred Pi signed Guest to real CLI boundary", () => {
  it.each(["pending", "settled"] as const)(
    "carries real claimed Sandbox authority into %s continuation without exposing it",
    async (mode) => {
      const server = await startBoundaryServer();
      const toolPath = join(
        "/home/user/workspace",
        `deferred-boundary-${randomUUID()}.txt`,
      );
      const toolContent = `authenticated tool result ${randomUUID()}`;
      await mkdir(dirname(toolPath), { recursive: true });
      await writeFile(toolPath, toolContent);
      onTestFinished(() => {
        return rm(toolPath, { force: true });
      });
      const claimed = await createClaimedRun(mode, toolPath);
      const run = await runGuest({
        baseUrl: server.baseUrl,
        proxyUrl: server.proxyUrl,
        caCertificate: server.caCertificate,
        token: claimed.execution.sandboxToken,
        ordinaryToken: claimed.ordinaryToken,
        execution: claimed.execution,
        timeoutSeconds: mode === "settled" ? 5 : undefined,
      });
      expect(
        { code: run.code, signal: run.signal },
        `${run.output}\nCLI stderr:\n${run.cliStderr}\nProvider proxy:\n${JSON.stringify({ connections: server.proxyConnections, errors: server.proxyErrors, requestCount: server.providerBodies.length })}`,
      ).toStrictEqual({
        code: mode === "settled" ? 124 : 0,
        signal: null,
      });
      const [ordinaryToken, privateTokenMarker, handoffPath] = (
        await readFile(run.environmentCapture, "utf8")
      )
        .trimEnd()
        .split("\n");
      expect(ordinaryToken).toBe(claimed.ordinaryToken);
      expect(privateTokenMarker).toBe("");
      expect(handoffPath).toContain("pi-deferred-handoff");
      const handoff = JSON.parse(
        await readFile(run.observedHandoff, "utf8"),
      ) as {
        sessionHistory: string;
        resourceSnapshot: unknown;
      };
      expect(handoff.sessionHistory).toBe(claimed.sessionHistory);
      expect(handoff.resourceSnapshot).toStrictEqual(claimed.resourceSnapshot);
      const startupEvent = server.guestEventBodies
        .filter((batch) => {
          return batch.runId === claimed.fixture.runId;
        })
        .flatMap((batch) => {
          return batch.events;
        })
        .find((event) => {
          return event.type === "system" && event.subtype === "init";
        });
      expect(startupEvent).toMatchObject({
        sequenceNumber: 5,
        session_id: claimed.fixture.threadId,
        subtype: "init",
        type: "system",
      });
      expect(startupEvent?.session_file).toContain(claimed.fixture.threadId);
      expect(
        server.requests.filter((request) => {
          return (
            request.path.includes(
              `/api/runners/jobs/${claimed.fixture.runId}/pi-handoff/`,
            ) && request.status === 200
          );
        }).length,
      ).toBeGreaterThan(0);
      expect(server.proxyErrors).toStrictEqual([]);
      if (mode === "pending") {
        expect(server.proxyConnections).toStrictEqual(["api.deepseek.com:443"]);
        expect(server.providerBodies).toHaveLength(1);
        const providerBody = JSON.stringify(server.providerBodies[0]);
        expect(providerBody).toContain("retained-tool-id");
        expect(providerBody).toContain(toolContent);
        expect(providerBody).not.toContain("Synthetic foundation fixture");
      } else {
        expect(server.proxyConnections).toStrictEqual([]);
        expect(server.providerBodies).toStrictEqual([]);
      }
    },
    45_000,
  );

  it("rejects the real ordinary signed token at handoff before child or provider activity", async () => {
    const server = await startBoundaryServer();
    const toolPath = join(
      "/home/user/workspace",
      `deferred-boundary-rejected-${randomUUID()}.txt`,
    );
    await writeFile(toolPath, "must not be read");
    onTestFinished(() => {
      return rm(toolPath, { force: true });
    });
    const claimed = await createClaimedRun("pending", toolPath);
    const run = await runGuest({
      baseUrl: server.baseUrl,
      proxyUrl: server.proxyUrl,
      caCertificate: server.caCertificate,
      token: claimed.ordinaryToken,
      ordinaryToken: claimed.ordinaryToken,
      execution: claimed.execution,
    });
    expect({ code: run.code, signal: run.signal }).toStrictEqual({
      code: 1,
      signal: null,
    });
    await expect(readFile(run.childStarted)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(run.environmentCapture)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(run.deferredHandoffFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(server.providerBodies).toStrictEqual([]);
    expect(
      server.requests.some((request) => {
        return (
          request.path.includes(
            `/api/runners/jobs/${claimed.fixture.runId}/pi-handoff/0`,
          ) && request.status === 401
        );
      }),
    ).toBeTruthy();
  }, 45_000);
});
