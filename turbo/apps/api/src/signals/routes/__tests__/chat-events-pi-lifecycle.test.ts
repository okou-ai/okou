import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, zstdDecompressSync } from "node:zlib";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import {
  chatEventsContract,
  chatThreadMetadataContract,
  resolveChatEventRecommendedFollowups,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  paidToolsContract,
} from "@okouai/api-contracts/contracts/paid-tools";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import {
  runContextContract,
  runsByIdContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  CANONICAL_PI_MEMORY_MOUNT_PATH,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  webhookCompleteContract,
  webhookEventsContract,
  webhookUsageEventContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  materializePiAgentModelConfig,
  runPiSubagent,
} from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { Header, x as extractTar } from "tar";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { paidToolsRoutes } from "../paid-tools";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";
import { runDetailRoutes } from "../run-detail";
import { runsRoutes } from "../runs";
import { usageRecordRoutes } from "../usage-record";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { userPreferencesRoutes } from "../user-preferences";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createUserConfigBddApi } from "./helpers/api-bdd-user-config";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  createChatEventsFixture,
  eventBackedContents,
  executionEnvironment,
  modelProviderSecretPlaceholder,
  okouTokenFromExecution,
  userMessages,
  type RunnerExecutionInput,
} from "./helpers/chat-events-fixture";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
  vertexTextResponse,
} from "./helpers/google-text";
import { setPaidToolDisabled } from "./helpers/paid-tools";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import {
  readThreadModelCredits,
  readThreadModelUsage,
} from "./helpers/public-thread-usage";

const CHAT_RECOVERY_COMMAND_SNIPPET =
  "okou chat messages --output-dir /tmp/okou-chat-history";

const IMAGE_MODEL_OVERRIDE_SNIPPET =
  "The model cannot be changed per request. Do not pass `--model` to image generation commands.";

const IMAGE_MODEL_CONNECTOR_SNIPPET =
  "Image generation through a connected third-party service chooses its model separately; this setting does not apply to that path.";

const RESTRICTED_CONTENT_HEADING = "# Restricted Explicit Content";

const BROWSER_ENABLED_PROMPT_SNIPPET =
  "Okou Cloud Browser and Okou Computer Use are separate surfaces.";

const BROWSER_DISABLED_PROMPT_SNIPPET =
  "Okou Browser is currently off for this chat thread.";

const WARMUP_UUID = "00000000-0000-4000-8000-000000000001";

const MEMORY_RECALL_TOOL_CALLS = Object.freeze([
  Object.freeze({ name: "memories_list", arguments: {} }),
  Object.freeze({
    name: "memories_search",
    arguments: { query: "harbor", path: "MEMORY.md" },
  }),
  Object.freeze({ name: "memories_read", arguments: { path: "MEMORY.md" } }),
  Object.freeze({
    name: "memories_read",
    arguments: { path: "details/harbor.md" },
  }),
]);

function createOwnedActorRunner(context: TestContext, actor: ApiTestUser) {
  let accepted = captureConnectorExternalState(context);
  let previous: (() => void) | undefined;
  onTestFinished(() => {
    previous?.();
  });
  const owner = publicRunOwner(context, actor, {
    continueAcceptedOperations: true,
    restoreEnvironment: () => {
      previous ??= captureConnectorExternalState(context);
      accepted();
    },
  });
  function run<T>(operation: () => Promise<T>): Promise<T> {
    return owner.run(() => {
      const pending = settleIncludingAbort(operation);
      accepted = captureConnectorExternalState(context);
      return pending.then((result) => {
        if (!result.ok) {
          throw result.error;
        }
        return result.value;
      });
    });
  }
  return {
    owner,
    run,
    rememberExecution: owner.rememberExecution,
  };
}

function completionMetadataForExecution(
  execution: RunnerExecutionInput,
  target: { readonly runId: string; readonly threadId: string },
  sessionIdOverride?: string,
) {
  if (execution.cliAgentType === "pi") {
    return {
      cliAgentType: "pi" as const,
      cliAgentSessionId:
        sessionIdOverride ?? execution.piSessionId ?? target.threadId,
      cliAgentSessionHistoryDisposition: "native_only" as const,
    };
  }
  const cliAgentType =
    execution.cliAgentType === "codex"
      ? ("codex" as const)
      : ("claude-code" as const);
  return {
    cliAgentType,
    cliAgentSessionId:
      sessionIdOverride ?? `bdd-${cliAgentType}-${target.runId}`,
    cliAgentSessionHistoryDisposition: "native_only" as const,
  };
}

function buildMemoryArchive(
  files: readonly { readonly path: string; readonly content: string }[],
) {
  const blocks: Buffer[] = [];
  const entries = files.map((file) => {
    const bytes = Buffer.from(file.content, "utf8");
    const header = Buffer.alloc(512);
    new Header({
      path: file.path,
      size: bytes.length,
      type: "File",
      mode: 0o644,
    }).encode(header);
    blocks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
    return {
      path: file.path,
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  });
  blocks.push(Buffer.alloc(1024));
  return {
    entries,
    archive: gzipSync(Buffer.concat(blocks)),
    manifest: Buffer.from(
      JSON.stringify({
        version: 1,
        files: entries,
        createdAt: "1970-01-01T00:00:00.000Z",
      }),
    ),
  };
}

function installInMemoryObjectStore(context: TestContext) {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
    const key = (command as { input?: { Key?: string } }).input?.Key;
    if (!key) {
      throw new Error("Expected a storage object key");
    }
    return Promise.resolve(
      `https://r2.example.com/owned-memory/${encodeURIComponent(key)}?signedAt=${now()}`,
    );
  });
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof GetObjectCommand ||
      command instanceof HeadObjectCommand
    ) {
      const bytes = command.input.Key
        ? objects.get(command.input.Key)
        : undefined;
      if (!bytes) {
        return Promise.reject(
          Object.assign(new Error("Missing owned storage object"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      });
    }
    return Promise.resolve({});
  });
  server.use(
    http.get("https://r2.example.com/owned-memory/:key", ({ params }) => {
      const key =
        typeof params.key === "string" ? decodeURIComponent(params.key) : "";
      const bytes = objects.get(key);
      return bytes
        ? new HttpResponse(new Uint8Array(bytes))
        : new HttpResponse(null, { status: 404 });
    }),
  );
  return objects;
}

/** Run the real Pi runtime in-process with only the model endpoint replaced by MSW. */
async function readPiExecutionMemoryInProcess(
  execution: Pick<
    ExecutionContext,
    | "runId"
    | "piSessionId"
    | "piModelConfig"
    | "piLaunchConfig"
    | "appendSystemPrompt"
  >,
  mount: NonNullable<ExecutionContext["startupInputs"]["memory"]>,
  signal: AbortSignal,
  onFirstModelRequest?: () => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "published-pi-inproc-"));
  const requests: unknown[] = [];
  const toolEnds: { readonly toolName: string; readonly isError: boolean }[] =
    [];

  const outcome = await settleIncludingAbort(async () => {
    const agentDir = join(root, ".pi/agent");
    const memoryDir = join(agentDir, "memory");
    await mkdir(memoryDir, { recursive: true });
    if (!mount.empty) {
      if (!mount.archiveUrl) {
        throw new Error("Selected non-empty Memory has no archive URL");
      }
      const downloaded = await fetch(mount.archiveUrl, { signal });
      if (!downloaded.ok) {
        throw new Error("Selected Memory download failed");
      }
      const archiveFile = join(root, "memory.tar.gz");
      await writeFile(archiveFile, Buffer.from(await downloaded.arrayBuffer()));
      await extractTar({ file: archiveFile, cwd: memoryDir, strict: true });
    }
    if (
      !execution.piModelConfig ||
      !execution.piLaunchConfig ||
      !execution.piSessionId
    ) {
      throw new Error("Expected a complete ordinary Pi execution");
    }

    const baseUrl = `https://memory-provider-${randomUUID()}.example/v1`;
    let requestNumber = 0;
    server.use(
      http.post(`${baseUrl}/codex/responses`, async ({ request }) => {
        const raw = Buffer.from(await request.arrayBuffer());
        const bytes =
          request.headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(raw)
            : raw;
        const requestId = ++requestNumber;
        requests.push(JSON.parse(bytes.toString("utf8")) as unknown);
        if (requestId === 1) {
          await onFirstModelRequest?.();
        }
        const call = MEMORY_RECALL_TOOL_CALLS[requestId - 1];
        const item = call
          ? {
              type: "function_call",
              id: `fc_${requestId}`,
              call_id: `call_${requestId}`,
              name: call.name,
              arguments: JSON.stringify(call.arguments),
              status: "completed",
            }
          : {
              type: "message",
              id: "msg_done",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Read complete",
                  annotations: [],
                },
              ],
            };
        const events = [
          {
            type: "response.created",
            response: {
              id: "resp_memory",
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
              ...item,
              ...(call ? { arguments: "" } : { content: [] }),
              status: "in_progress",
            },
          },
          ...(call
            ? [
                {
                  type: "response.function_call_arguments.delta",
                  output_index: 0,
                  item_id: item.id,
                  delta: item.arguments,
                },
              ]
            : [
                {
                  type: "response.output_text.delta",
                  output_index: 0,
                  item_id: item.id,
                  delta: "Read complete",
                },
              ]),
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_memory",
              object: "response",
              status: "completed",
              output: [item],
              usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
            },
          },
        ];
        return new HttpResponse(
          events
            .map((event) => {
              return `data: ${JSON.stringify(event)}\n\n`;
            })
            .join("")
            .trimEnd(),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const model = await materializePiAgentModelConfig({
      config: {
        ...execution.piModelConfig,
        baseUrl,
        transport: "sse",
      },
      resolveCredential() {
        return "test-memory-provider-credential";
      },
    });

    await runPiSubagent(
      {
        cwd: root,
        agentDir,
        sessionId: execution.piSessionId,
        model,
        appendSystemPrompt: execution.appendSystemPrompt,
        resourceSnapshot: {
          schemaVersion: 1,
          agentsFiles: [],
          skills: [],
        },
        prompt: "Recall the harbor project using personal Memory",
        subscribeInput() {
          return () => {};
        },
        onEvent(event) {
          if (event.type === "tool_execution_end") {
            toolEnds.push({
              toolName: event.toolName,
              isError: event.isError,
            });
          }
        },
      },
      signal,
    );

    return { requests, toolEnds };
  });

  const removed = await settleIncludingAbort(() => {
    return rm(root, { recursive: true, force: true });
  });
  if (!outcome.ok) {
    throw outcome.error;
  }
  if (!removed.ok) {
    throw removed.error;
  }
  return outcome.value;
}

describe("chat-events-pi-lifecycle", () => {
  const context = testContext();
  const fixture = createChatEventsFixture(context);
  const bddApi = createBddApi(context);
  const runsApi = createRunsApi(context);
  const userConfig = createUserConfigBddApi(context);
  const chatEventsClient = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const chatThreadMetaClient = setupAppWithRoutes({
    context,
    routes: chatThreadGetRoutes,
  })(chatThreadMetadataContract);
  const userPreferencesClient = setupAppWithRoutes({
    context,
    routes: userPreferencesRoutes,
  })(userPreferencesContract);
  const userModelPreferenceClient = setupAppWithRoutes({
    context,
    routes: userModelPreferenceRoutes,
  })(userModelPreferenceContract);
  const paidToolsClient = setupAppWithRoutes({
    context,
    routes: paidToolsRoutes,
  })(paidToolsContract);
  const proactiveSuggestionsClient = setupAppWithRoutes({
    context,
    routes: proactiveSuggestionsRoutes,
  })(proactiveSuggestionsContract);
  const runsByIdClient = setupAppWithRoutes({
    context,
    routes: runsRoutes,
  })(runsByIdContract);
  const runContextClient = setupAppWithRoutes({
    context,
    routes: runDetailRoutes,
  })(runContextContract);
  const usageRecordClient = setupAppWithRoutes({
    context,
    routes: usageRecordRoutes,
  })(usageRecordContract);
  const webhookEventsClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentEventsRoutes,
  })(webhookEventsContract);
  const webhookCompleteClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const webhookUsageClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  })(webhookUsageEventContract);

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    await Promise.all([
      accept(
        chatEventsClient.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            clientEventId: WARMUP_UUID,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
          },
        }),
        [401],
      ),
      accept(
        chatThreadMetaClient.get({
          headers: {},
          params: { id: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        userPreferencesClient.update({
          headers: {},
          body: { cloudBrowserEnabledByDefault: true },
        }),
        [401],
      ),
      accept(
        userModelPreferenceClient.updateImageModel({
          headers: {},
          body: { selectedImageModel: "gpt-image-2.5-flare" },
        }),
        [401],
      ),
      accept(
        paidToolsClient.update({
          headers: {},
          params: { toolId: "web-search" },
          body: { disabled: false },
        }),
        [401],
      ),
      accept(
        proactiveSuggestionsClient.update({
          headers: {},
          body: { enabled: false },
        }),
        [401],
      ),
      accept(
        runsByIdClient.getById({
          headers: {},
          params: { id: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        runContextClient.getContext({
          headers: {},
          params: { id: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        usageRecordClient.get({
          headers: {},
          query: { scope: "mine", range: "24h", tz: "UTC" },
        }),
        [401],
      ),
      accept(
        webhookEventsClient.send({
          headers: {},
          body: {
            runId: WARMUP_UUID,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: WARMUP_UUID,
                sequenceNumber: 1,
              },
            ],
          },
        }),
        [401],
      ),
      accept(
        webhookCompleteClient.complete({
          headers: {},
          body: { runId: WARMUP_UUID, exitCode: 0 },
        }),
        [401],
      ),
      accept(
        webhookUsageClient.send({
          headers: {},
          body: {
            runId: WARMUP_UUID,
            events: [
              {
                idempotencyKey: WARMUP_UUID,
                kind: "model",
                provider: "gpt-6-luna",
                category: "input_tokens",
                quantity: 1,
              },
            ],
          },
        }),
        [401],
      ),
    ]);
  });

  function installBaseChatMocks(): void {
    fixture.chatCallbacks.acceptChatObjectStorage();
    fixture.api.acceptStorageDownloads();
    fixture.api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    fixture.chatCallbacks.disableVapid();
  }

  async function createLimitedFreeChatActor(options?: {
    readonly enableRunContextRead?: boolean;
    readonly includeClaude?: boolean;
  }) {
    const actor = fixture.bdd.user();
    const owned = createOwnedActorRunner(context, actor);
    installBaseChatMocks();
    if (options?.includeClaude) {
      mockClaudeCodeTokenEndpoint();
    }
    if (options?.enableRunContextRead) {
      fixture.chatCallbacks.mockChatOutputEvents([]);
    }
    const runnerGroupPromise = fixture.api.configureRunnerGroup();
    await Promise.all([
      runnerGroupPromise,
      owned.run(() => {
        return bddApi.bootstrapLimitedFreeOnboarding(actor);
      }),
    ]);
    if (options?.includeClaude) {
      await owned.run(() => {
        return fixture.api.createPersonalModelProvider(actor, {
          type: "claude-code-oauth-token",
          secret: "bdd-personal-claude-token",
        });
      });
    }
    return {
      actor,
      run: owned.run,
      sendChatRun: (...parameters: Parameters<typeof fixture.sendChatRun>) => {
        return owned.run(() => {
          return fixture.sendChatRun(...parameters);
        });
      },
      runExecution: async (runId: string) => {
        return await owned.run(async () => {
          const execution = await fixture.runExecution(runId);
          owned.rememberExecution(runId, execution.execution.sandboxToken);
          return execution;
        });
      },
      async completeTurn(
        target: { readonly runId: string; readonly threadId: string },
        execution: RunnerExecutionInput,
        sandboxHeaders: { readonly authorization: string },
        answer: string,
        sessionIdOverride?: string,
      ) {
        const completion = completionMetadataForExecution(
          execution,
          target,
          sessionIdOverride,
        );
        await owned.run(async () => {
          await fixture.webhooks.requestAgentEvents(
            {
              runId: target.runId,
              events: [
                {
                  type: "assistant",
                  sequenceNumber: 1,
                  message: { content: [{ type: "text", text: answer }] },
                },
                { type: "result", sequenceNumber: 2, result: answer },
              ],
            },
            sandboxHeaders,
            [200],
          );
          await fixture.webhooks.requestAgentComplete(
            {
              runId: target.runId,
              exitCode: 0,
              lastEventSequence: 2,
              completion,
            },
            sandboxHeaders,
            [200],
          );
          await flushWaitUntilForTest();
        });
        return completion;
      },
    };
  }

  async function createPiActor(options?: {
    readonly includeClaude?: boolean;
    readonly pro?: boolean;
    readonly enableRunContextRead?: boolean;
  }) {
    const actor = fixture.bdd.user();
    const owned = createOwnedActorRunner(context, actor);
    installBaseChatMocks();
    if (options?.includeClaude) {
      mockClaudeCodeTokenEndpoint();
    }
    if (options?.enableRunContextRead) {
      fixture.chatCallbacks.mockChatOutputEvents([]);
    }
    await owned.run(async () => {
      await Promise.all([
        fixture.api.configureRunnerGroup(),
        options?.pro
          ? fixture.api.grantProEntitlement(actor)
          : bddApi.bootstrapLimitedFreeOnboarding(actor),
        fixture.connectSubscriptionPiModel(actor),
        ...(options?.includeClaude
          ? [
              fixture.api.createPersonalModelProvider(actor, {
                type: "claude-code-oauth-token",
                secret: "bdd-personal-claude-token",
              }),
            ]
          : []),
      ]);
    });
    return {
      actor,
      run: owned.run,
      rememberExecution: owned.rememberExecution,
      sendChatRun: (...parameters: Parameters<typeof fixture.sendChatRun>) => {
        return owned.run(() => {
          return fixture.sendChatRun(...parameters);
        });
      },
      sendWaitingChatInput: (
        ...parameters: Parameters<typeof fixture.sendWaitingChatInput>
      ) => {
        return owned.run(() => {
          return fixture.sendWaitingChatInput(...parameters);
        });
      },
      runExecution: async (runId: string) => {
        return await owned.run(async () => {
          const execution = await fixture.runExecution(runId);
          owned.rememberExecution(runId, execution.execution.sandboxToken);
          return execution;
        });
      },
    };
  }

  async function publishPiMemoryVersion(args: {
    readonly actor: ApiTestUser;
    readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly rememberExecution: (runId: string, sandboxToken: string) => void;
    readonly objects: Map<string, Buffer>;
    readonly prompt: string;
    readonly files: readonly {
      readonly path: string;
      readonly content: string;
    }[];
  }) {
    const writer = await args.run(() => {
      return fixture.sendChatRun(args.actor, {
        model: "gpt-6-luna",
        prompt: args.prompt,
      });
    });
    const exec = await args.run(async () => {
      const execution = await fixture.runExecution(writer.runId);
      args.rememberExecution(writer.runId, execution.execution.sandboxToken);
      return execution;
    });
    const memory = exec.execution.startupInputs.memory;
    if (!memory) {
      throw new Error("Expected writable Pi Memory mount on writer Run");
    }
    const built = buildMemoryArchive(args.files);
    const prepared = await args.run(() => {
      return fixture.webhooks.requestAgentStoragePrepare(
        {
          runId: writer.runId,
          storageId: memory.storageId,
          parentVersionId: memory.versionId,
          files: built.entries,
        },
        exec.sandboxHeaders,
        [200],
      );
    });
    if (prepared.status !== 200 || !prepared.body.uploads) {
      throw new Error("Expected storage prepare upload URLs");
    }
    args.objects.set(prepared.body.uploads.archive.key, built.archive);
    args.objects.set(prepared.body.uploads.manifest.key, built.manifest);
    const versionId = prepared.body.versionId;
    await args.run(async () => {
      await fixture.webhooks.requestAgentStorageCommit(
        {
          runId: writer.runId,
          storageId: memory.storageId,
          parentVersionId: memory.versionId,
          versionId,
          files: built.entries,
        },
        exec.sandboxHeaders,
        [200],
      );
      await fixture.webhooks.requestAgentComplete(
        {
          runId: writer.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "pi",
            cliAgentSessionId: writer.threadId,
            cliAgentSessionHistoryDisposition: "native_only",
            storageOutputs: [
              {
                name: "memory",
                mountPath: CANONICAL_PI_MEMORY_MOUNT_PATH,
                version: versionId,
                ...(memory.missingRootPolicy === undefined
                  ? {}
                  : { missingRootPolicy: memory.missingRootPolicy }),
              },
            ],
          },
        },
        exec.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
    });
    return { runId: writer.runId, versionId, storageId: memory.storageId };
  }

  async function runPiHandoffPreservation(firstPrompt: string) {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", 1);
    const chatActor = await createPiActor({ includeClaude: true });
    const { actor } = chatActor;
    let resourceDownloads = 0;
    const historyObjects = fixture.mockPiObjectStore();
    fixture.mockPiResourceArchiveDownloads(true, () => {
      resourceDownloads += 1;
    });

    const blocker = await chatActor.sendChatRun(actor, {
      model: "claude-fable-5-1",
      prompt: "Occupy the single workspace slot before Pi handoff",
    });
    const blockerExec = await chatActor.runExecution(blocker.runId);

    const waiting = await chatActor.sendWaitingChatInput(actor, {
      model: "gpt-6-luna",
      prompt: firstPrompt,
    });

    await chatActor.run(() => {
      return fixture.completeChatRunOk(
        blocker.runId,
        blockerExec.sandboxHeaders,
      );
    });
    const run1 = await chatActor.run(() => {
      return waiting.launchedRun();
    });
    const exec1 = await chatActor.runExecution(run1.runId);

    const usage1 = {
      runId: run1.runId,
      events: [
        {
          idempotencyKey: randomUUID(),
          kind: "model" as const,
          provider: "gpt-6-luna",
          category: "input_tokens",
          quantity: 1200,
        },
      ],
    };
    const answer1 = `First handoff answer ${randomUUID()}`;
    await chatActor.run(async () => {
      const [firstUsage, secondUsage] = await Promise.all([
        fixture.webhooks.requestAgentUsageEvent(
          usage1,
          exec1.sandboxHeaders,
          [200],
        ),
        fixture.webhooks.requestAgentUsageEvent(
          usage1,
          exec1.sandboxHeaders,
          [200],
        ),
      ]);
      expect(firstUsage.body).toStrictEqual({ success: true });
      expect(secondUsage.body).toStrictEqual({ success: true });
      await fixture.webhooks.requestAgentEvents(
        {
          runId: run1.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: 1,
              message: { content: [{ type: "text", text: answer1 }] },
            },
            { type: "result", sequenceNumber: 2, result: answer1 },
          ],
        },
        exec1.sandboxHeaders,
        [200],
      );
      await fixture.webhooks.requestAgentComplete(
        {
          runId: run1.runId,
          exitCode: 0,
          lastEventSequence: 2,
          completion: {
            cliAgentType: "pi",
            cliAgentSessionId: waiting.threadId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        exec1.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
    });

    const secondPrompt = `${firstPrompt}\nfollow-up turn`;
    const run2 = await chatActor.sendChatRun(actor, {
      threadId: waiting.threadId,
      model: "gpt-6-luna",
      prompt: secondPrompt,
    });
    const exec2 = await chatActor.runExecution(run2.runId);

    const usage2 = {
      runId: run2.runId,
      events: [
        {
          idempotencyKey: randomUUID(),
          kind: "model" as const,
          provider: "gpt-6-luna",
          category: "output_tokens",
          quantity: 640,
        },
      ],
    };
    const answer2 = `Second handoff answer ${randomUUID()}`;
    await chatActor.run(async () => {
      const [firstUsage, secondUsage] = await Promise.all([
        fixture.webhooks.requestAgentUsageEvent(
          usage2,
          exec2.sandboxHeaders,
          [200],
        ),
        fixture.webhooks.requestAgentUsageEvent(
          usage2,
          exec2.sandboxHeaders,
          [200],
        ),
      ]);
      expect(firstUsage.body).toStrictEqual({ success: true });
      expect(secondUsage.body).toStrictEqual({ success: true });
      await fixture.webhooks.requestAgentEvents(
        {
          runId: run2.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: 1,
              message: { content: [{ type: "text", text: answer2 }] },
            },
            { type: "result", sequenceNumber: 2, result: answer2 },
          ],
        },
        exec2.sandboxHeaders,
        [200],
      );
      await fixture.webhooks.requestAgentComplete(
        {
          runId: run2.runId,
          exitCode: 0,
          lastEventSequence: 2,
          completion: {
            cliAgentType: "pi",
            cliAgentSessionId: waiting.threadId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        exec2.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
    });

    const [storedRun1, storedRun2, history, usage] = await Promise.all([
      fixture.api.readRun(actor, run1.runId),
      fixture.api.readRun(actor, run2.runId),
      fixture.chat.listThreadEvents(actor, waiting.threadId),
      readThreadModelUsage(context, actor, waiting.threadId),
    ]);

    return {
      threadId: waiting.threadId,
      run1,
      run2,
      exec1: exec1.execution,
      exec2: exec2.execution,
      firstPrompt,
      secondPrompt,
      answer1,
      answer2,
      storedRun1,
      storedRun2,
      events: history.events,
      usage,
      resourceDownloads,
      historyUploadCount: historyObjects.size,
    };
  }

  describe("batched identity preload", () => {
    it(
      "chat-events-batched-preload-002 keeps independent member preferences and paid-tool snapshots in one organization",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const owner = fixture.bdd.user({ orgRole: "org:admin" });
        const member = fixture.bdd.user({
          orgId: owner.orgId,
          orgRole: "org:member",
        });
        const ownerLifecycle = createOwnedActorRunner(context, owner);
        const memberLifecycle = createOwnedActorRunner(context, member);
        installBaseChatMocks();
        mockClaudeCodeTokenEndpoint();

        const runnerGroupPromise = fixture.api.configureRunnerGroup();
        await Promise.all([
          runnerGroupPromise,
          ownerLifecycle.run(() => {
            return fixture.api.grantProEntitlement(owner);
          }),
        ]);

        await ownerLifecycle.run(async () => {
          await fixture.api.createPersonalModelProvider(owner, {
            type: "claude-code-oauth-token",
            secret: "bdd-owner-claude-token",
          });
          const updatedPreferences = await accept(
            userPreferencesClient.update({
              headers: fixture.sessionHeaders(owner),
              body: { cloudBrowserEnabledByDefault: false },
            }),
            [200],
          );
          expect(
            updatedPreferences.body.cloudBrowserEnabledByDefault,
          ).toBeFalsy();
          await setPaidToolDisabled(context, owner, "data-search", true);
          await setPaidToolDisabled(context, owner, "social", true);
        });

        await memberLifecycle.run(async () => {
          await fixture.bdd.completeOnboarding(member);
          await fixture.api.createPersonalModelProvider(member, {
            type: "claude-code-oauth-token",
            secret: "bdd-member-claude-token",
          });
        });

        const ownerRun = await ownerLifecycle.run(() => {
          return fixture.sendChatRun(owner, {
            model: "claude-fable-5-1",
            prompt: "Owner prompt with browser off and two disabled tools",
          });
        });
        const ownerExec = await ownerLifecycle.run(async () => {
          const execution = await fixture.runExecution(ownerRun.runId);
          ownerLifecycle.rememberExecution(
            ownerRun.runId,
            execution.execution.sandboxToken,
          );
          return execution;
        });

        const memberRun = await memberLifecycle.run(() => {
          return fixture.sendChatRun(member, {
            model: "claude-fable-5-1",
            prompt: "Member prompt with default preferences",
          });
        });
        const memberExec = await memberLifecycle.run(async () => {
          const execution = await fixture.runExecution(memberRun.runId);
          memberLifecycle.rememberExecution(
            memberRun.runId,
            execution.execution.sandboxToken,
          );
          return execution;
        });

        const ownerThread = await fixture.chat.readThreadMetadata(
          owner,
          ownerRun.threadId,
        );
        const memberThread = await fixture.chat.readThreadMetadata(
          member,
          memberRun.threadId,
        );

        expect(ownerThread.cloudBrowserEnabled).toBeFalsy();
        expect(ownerThread.modelSettings).toStrictEqual({});
        expect(memberThread.cloudBrowserEnabled).toBeTruthy();
        expect(memberThread.modelSettings).toStrictEqual({});

        expect(ownerExec.execution.appendSystemPrompt).toContain(
          BROWSER_DISABLED_PROMPT_SNIPPET,
        );
        expect(ownerExec.execution.appendSystemPrompt).not.toContain(
          BROWSER_ENABLED_PROMPT_SNIPPET,
        );
        expect(
          JSON.parse(
            ownerExec.execution.platformEnvironment[
              DISABLED_PAID_TOOLS_ENV_VAR
            ] ?? "null",
          ),
        ).toStrictEqual(["data-search", "social"]);

        expect(memberExec.execution.appendSystemPrompt).toContain(
          BROWSER_ENABLED_PROMPT_SNIPPET,
        );
        expect(memberExec.execution.appendSystemPrompt).not.toContain(
          BROWSER_DISABLED_PROMPT_SNIPPET,
        );
        expect(
          JSON.parse(
            memberExec.execution.platformEnvironment[
              DISABLED_PAID_TOOLS_ENV_VAR
            ] ?? "null",
          ),
        ).toStrictEqual([]);
      },
    );
  });

  describe("Pi handoff and duplicate personal usage", () => {
    it(
      "chat-events-pi-handoff-005 claims gpt-6-luna with Sandbox credentials without charging duplicate personal usage",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const chatActor = await createPiActor();
        const { actor } = chatActor;

        const run = await chatActor.sendChatRun(actor, {
          model: "gpt-6-luna",
          prompt: "Claim standard Luna in Pi and test duplicate usage",
        });
        const { execution, sandboxHeaders } = await chatActor.runExecution(
          run.runId,
        );

        expect(execution.cliAgentType).toBe("pi");
        expect(execution.piModelConfig).toMatchObject({
          provider: "openai-codex",
          dialect: "openai-codex-responses",
          model: "gpt-6-luna",
        });
        expect(execution.piModelConfig).not.toHaveProperty("serviceTier");
        expect(executionEnvironment(execution).CHATGPT_ACCESS_TOKEN).toBe(
          modelProviderSecretPlaceholder(
            "codex-oauth-token",
            "CHATGPT_ACCESS_TOKEN",
          ),
        );

        const usageBody = {
          runId: run.runId,
          events: [
            {
              idempotencyKey: randomUUID(),
              kind: "model" as const,
              provider: "gpt-6-luna",
              category: "input_tokens",
              quantity: 950,
            },
          ],
        };
        const [firstUsage, secondUsage] = await chatActor.run(() => {
          return Promise.all([
            fixture.webhooks.requestAgentUsageEvent(
              usageBody,
              sandboxHeaders,
              [200],
            ),
            fixture.webhooks.requestAgentUsageEvent(
              usageBody,
              sandboxHeaders,
              [200],
            ),
          ]);
        });
        expect(firstUsage.body).toStrictEqual({ success: true });
        expect(secondUsage.body).toStrictEqual({ success: true });

        await chatActor.run(() => {
          return fixture.api.requestCancelRun(actor, run.runId, [200]);
        });
        await flushWaitUntilForTest();

        const [cancelledRun, usage] = await Promise.all([
          fixture.api.readRun(actor, run.runId),
          readThreadModelUsage(context, actor, run.threadId),
        ]);
        expect(cancelledRun.status).toBe("cancelled");
        expect(usage).toStrictEqual({ credits: 0, tokens: 0 });
      },
    );

    it(
      "chat-events-pi-handoff-001 passes skill command input unchanged across queued and continued rounds",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const result = await runPiHandoffPreservation(
          "/skill:handoff-skill first  argument\nsecond line",
        );

        expect(result.exec1.prompt).toBe(result.firstPrompt);
        expect(result.exec2.prompt).toBe(result.secondPrompt);
        expect(result.exec1.cliAgentType).toBe("pi");
        expect(result.exec2.cliAgentType).toBe("pi");
        expect(result.exec1.piSessionId).toBe(result.threadId);
        expect(result.exec2.piSessionId).toBe(result.threadId);
        expect(result.exec1.nativeContinuation).toStrictEqual({
          sessionId: null,
          generationRunId: null,
          recoveryPrompt: null,
        });
        expect(result.exec2.nativeContinuation.sessionId).toBe(result.threadId);
        expect(result.exec2.nativeContinuation.generationRunId).toBe(
          result.run1.runId,
        );
        expect(result.exec2.nativeContinuation.recoveryPrompt).toContain(
          CHAT_RECOVERY_COMMAND_SNIPPET,
        );
        expect(result.exec2.appendSystemPrompt ?? "").not.toContain(
          result.answer1,
        );

        for (const [run, answer, stored] of [
          [result.run1, result.answer1, result.storedRun1],
          [result.run2, result.answer2, result.storedRun2],
        ] as const) {
          expect(
            result.events
              .filter((event) => {
                return (
                  event.runId === run.runId &&
                  event.eventType === "run.completed"
                );
              })
              .map((event) => {
                return event.eventType;
              }),
          ).toStrictEqual(["run.completed"]);
          expect(
            eventBackedContents(result.events, run.runId).map((message) => {
              return chatEventDisplayText(message);
            }),
          ).toStrictEqual([answer]);
          expect(stored.result).toMatchObject({
            framework: "pi",
            frameworkSessionId: result.threadId,
          });
        }
        expect(result.usage.tokens).toBe(0);
        expect(result.resourceDownloads).toBe(0);
        expect(result.historyUploadCount).toBe(0);
      },
    );

    it(
      "chat-events-pi-handoff-004 passes workspace file path input unchanged across queued and continued rounds",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const result = await runPiHandoffPreservation(
          "/home/user/workspace/report.txt first  argument\nsecond line",
        );

        expect(result.exec1.prompt).toBe(result.firstPrompt);
        expect(result.exec2.prompt).toBe(result.secondPrompt);
        expect(result.exec1.cliAgentType).toBe("pi");
        expect(result.exec2.cliAgentType).toBe("pi");
        expect(result.exec1.piSessionId).toBe(result.threadId);
        expect(result.exec2.piSessionId).toBe(result.threadId);
        expect(result.exec1.nativeContinuation).toStrictEqual({
          sessionId: null,
          generationRunId: null,
          recoveryPrompt: null,
        });
        expect(result.exec2.nativeContinuation.sessionId).toBe(result.threadId);
        expect(result.exec2.nativeContinuation.generationRunId).toBe(
          result.run1.runId,
        );
        expect(result.exec2.nativeContinuation.recoveryPrompt).toContain(
          CHAT_RECOVERY_COMMAND_SNIPPET,
        );
        expect(result.exec2.appendSystemPrompt ?? "").not.toContain(
          result.answer1,
        );

        for (const [run, answer, stored] of [
          [result.run1, result.answer1, result.storedRun1],
          [result.run2, result.answer2, result.storedRun2],
        ] as const) {
          expect(
            result.events
              .filter((event) => {
                return (
                  event.runId === run.runId &&
                  event.eventType === "run.completed"
                );
              })
              .map((event) => {
                return event.eventType;
              }),
          ).toStrictEqual(["run.completed"]);
          expect(
            eventBackedContents(result.events, run.runId).map((message) => {
              return chatEventDisplayText(message);
            }),
          ).toStrictEqual([answer]);
          expect(stored.result).toMatchObject({
            framework: "pi",
            frameworkSessionId: result.threadId,
          });
        }
        expect(result.usage.tokens).toBe(0);
        expect(result.resourceDownloads).toBe(0);
        expect(result.historyUploadCount).toBe(0);
      },
    );
  });

  describe("built-in image model guidance", () => {
    it(
      "chat-events-media-001 keeps a run's image guidance stable and applies member changes to subsequent turns",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const chatActor = await createLimitedFreeChatActor({
          enableRunContextRead: true,
        });
        const { actor } = chatActor;

        const run1 = await chatActor.sendChatRun(actor, {
          model: null,
          prompt: "Draft a hero image with the default image model",
        });
        const exec1 = await chatActor.runExecution(run1.runId);

        expect(exec1.execution.appendSystemPrompt).toContain(
          "Built-in image generation uses `gpt-image-2.5-flare`",
        );
        expect(exec1.execution.appendSystemPrompt).toContain(
          IMAGE_MODEL_OVERRIDE_SNIPPET,
        );
        expect(exec1.execution.appendSystemPrompt).toContain(
          IMAGE_MODEL_CONNECTOR_SNIPPET,
        );
        expect(exec1.execution.appendSystemPrompt).toContain(
          RESTRICTED_CONTENT_HEADING,
        );

        await chatActor.completeTurn(
          run1,
          exec1.execution,
          exec1.sandboxHeaders,
          "First image turn complete",
        );

        await userConfig.updateImageModelPreference(actor, {
          selectedImageModel: "fal-ai/flux-pro/v1.1",
        });

        const run2 = await chatActor.sendChatRun(actor, {
          threadId: run1.threadId,
          model: null,
          prompt: "Render a second visual using Flux Pro 1.1",
        });
        const exec2 = await chatActor.runExecution(run2.runId);

        expect(exec2.execution.appendSystemPrompt).toContain(
          "Built-in image generation uses `flux-pro-1.1`",
        );
        expect(exec2.execution.appendSystemPrompt).toContain(
          IMAGE_MODEL_OVERRIDE_SNIPPET,
        );
        expect(exec2.execution.appendSystemPrompt).toContain(
          IMAGE_MODEL_CONNECTOR_SNIPPET,
        );
        expect(exec2.execution.appendSystemPrompt).toContain(
          RESTRICTED_CONTENT_HEADING,
        );

        // Edit the preference while Run 2 is still active; Run 2's snapshot must stay stable.
        await userConfig.updateImageModelPreference(actor, {
          selectedImageModel: "fal-ai/nano-banana-2",
        });
        const run2Context = await runsApi.requestRunContext(
          actor,
          run2.runId,
          [200],
        );
        expect(run2Context.status).toBe(200);
        if (run2Context.status === 200) {
          expect(run2Context.body.appendSystemPrompt).toContain(
            "Built-in image generation uses `flux-pro-1.1`",
          );
          expect(run2Context.body.appendSystemPrompt).not.toContain(
            "`nano-banana-2`",
          );
        }

        await chatActor.completeTurn(
          run2,
          exec2.execution,
          exec2.sandboxHeaders,
          "Second image turn complete",
        );

        const run3 = await chatActor.sendChatRun(actor, {
          threadId: run1.threadId,
          model: null,
          prompt: "Render a third visual using Nano Banana 2",
        });
        const exec3 = await chatActor.runExecution(run3.runId);

        expect(exec3.execution.appendSystemPrompt).toContain(
          "Built-in image generation uses `nano-banana-2`",
        );
        expect(exec3.execution.appendSystemPrompt).toContain(
          IMAGE_MODEL_OVERRIDE_SNIPPET,
        );
        expect(exec3.execution.appendSystemPrompt).toContain(
          IMAGE_MODEL_CONNECTOR_SNIPPET,
        );
        expect(exec3.execution.appendSystemPrompt).toContain(
          RESTRICTED_CONTENT_HEADING,
        );
      },
    );
  });

  describe("delegated Pi provenance", () => {
    it(
      "chat-events-pi-delegation-001 preserves delegated Pi provenance and rejects foreign thread writes",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const chatActor = await createPiActor({ includeClaude: true });
        const { actor } = chatActor;
        const sameOrgOtherMember = fixture.bdd.user({
          orgId: actor.orgId,
          orgRole: "org:member",
        });
        const otherWorkspaceMember = fixture.bdd.user();

        await fixture.bdd.completeOnboarding(sameOrgOtherMember);
        await bddApi.bootstrapLimitedFreeOnboarding(otherWorkspaceMember);

        const sourceTitle = "Coordinator Research Thread";
        const sourceThread = await fixture.chat.createThread(actor, {
          title: sourceTitle,
          model: "claude-fable-5-1",
        });
        const targetThread = await fixture.chat.createThread(actor, {
          title: "Delegated Pi Target",
          model: "gpt-6-luna",
        });
        const sameOrgOtherThread = await fixture.chat.createThread(
          sameOrgOtherMember,
          {
            title: "Colleague Thread",
            model: null,
          },
        );
        const otherWorkspaceThread = await fixture.chat.createThread(
          otherWorkspaceMember,
          {
            title: "Foreign Workspace Thread",
            model: null,
          },
        );

        const sourceRun = await chatActor.sendChatRun(actor, {
          threadId: sourceThread.id,
          model: "claude-fable-5-1",
          prompt: "Coordinate delegated work on the Pi thread",
        });
        const sourceExec = await chatActor.runExecution(sourceRun.runId);
        const agentToken = okouTokenFromExecution(sourceExec.execution);

        const delegatedClientEventId = randomUUID();
        const delegatedPrompt =
          "Execute delegated Pi subtask and report findings";
        const sent = await chatActor.run(() => {
          return fixture.requestSendEventWithBearer(
            agentToken,
            {
              threadId: targetThread.id,
              clientEventId: delegatedClientEventId,
              model: "gpt-6-luna",
              prompt: delegatedPrompt,
            },
            [201],
          );
        });
        expect(sent.status).toBe(201);
        if (sent.status === 201) {
          expect(sent.body.threadId).toBe(targetThread.id);
          expect(sent.body.createdAt).toBeTruthy();
        }

        await flushWaitUntilForTest();
        const launchedPage = await fixture.chat.listThreadEvents(
          actor,
          targetThread.id,
        );
        const launchedRunId = launchedPage.events.find((event) => {
          return (
            event.eventType === "input.prompt" &&
            event.revokesEventId === delegatedClientEventId &&
            event.runId !== undefined
          );
        })?.runId;
        expect(launchedRunId).toBeDefined();
        if (!launchedRunId) {
          throw new Error("Expected delegated Pi input to promote to a Run");
        }

        const piExec = await chatActor.runExecution(launchedRunId);
        expect(piExec.execution.cliAgentType).toBe("pi");
        expect(piExec.execution.piSessionId).toBe(targetThread.id);
        expect(piExec.execution.piModelConfig).toMatchObject({
          provider: "openai-codex",
          model: "gpt-6-luna",
        });

        await chatActor.run(async () => {
          const answer = "Delegated Pi findings ready.";
          await fixture.webhooks.requestAgentEvents(
            {
              runId: launchedRunId,
              events: [
                {
                  type: "assistant",
                  sequenceNumber: 1,
                  message: { content: [{ type: "text", text: answer }] },
                },
                { type: "result", sequenceNumber: 2, result: answer },
              ],
            },
            piExec.sandboxHeaders,
            [200],
          );
          await fixture.webhooks.requestAgentComplete(
            {
              runId: launchedRunId,
              exitCode: 0,
              lastEventSequence: 2,
              completion: {
                cliAgentType: "pi",
                cliAgentSessionId: targetThread.id,
                cliAgentSessionHistoryDisposition: "native_only",
              },
            },
            piExec.sandboxHeaders,
            [200],
          );
          await flushWaitUntilForTest();
        });

        const history = await fixture.chat.listThreadEvents(
          actor,
          targetThread.id,
        );
        const originalPromptEvent = history.events.find((event) => {
          return (
            event.id === delegatedClientEventId &&
            event.eventType === "input.prompt"
          );
        });
        expect(originalPromptEvent?.eventType).toBe("input.prompt");
        if (originalPromptEvent?.eventType === "input.prompt") {
          expect(originalPromptEvent.userMessage.parts).toContainEqual({
            type: "chat_thread",
            runId: sourceRun.runId,
            threadId: sourceRun.threadId,
            titleSnapshot: sourceTitle,
          });
        }

        const [foreignWorkspace, foreignMember, unknownTarget] =
          await Promise.all([
            fixture.requestSendEventWithBearer(
              agentToken,
              {
                threadId: otherWorkspaceThread.id,
                clientEventId: randomUUID(),
                prompt: "Attempt cross-workspace send",
              },
              [404],
            ),
            fixture.requestSendEventWithBearer(
              agentToken,
              {
                threadId: sameOrgOtherThread.id,
                clientEventId: randomUUID(),
                prompt: "Attempt cross-member send",
              },
              [404],
            ),
            fixture.requestSendEventWithBearer(
              agentToken,
              {
                threadId: randomUUID(),
                clientEventId: randomUUID(),
                prompt: "Attempt unknown thread send",
              },
              [404],
            ),
          ]);
        expect(foreignWorkspace.status).toBe(404);
        expect(foreignMember.status).toBe(404);
        expect(unknownTarget.status).toBe(404);
      },
    );
  });

  describe("Pi failed native continuation", () => {
    it(
      "chat-events-pi-failed-history-002 retains the actual native identity after a failed partial answer",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const chatActor = await createPiActor();
        const { actor } = chatActor;

        const run1 = await chatActor.sendChatRun(actor, {
          model: "gpt-6-luna",
          prompt: "Start native Pi conversation",
        });
        const exec1 = await chatActor.runExecution(run1.runId);
        await chatActor.run(async () => {
          await fixture.webhooks.requestAgentEvents(
            {
              runId: run1.runId,
              events: [
                {
                  type: "system",
                  subtype: "init",
                  session_id: run1.threadId,
                  sequenceNumber: 1,
                },
                {
                  type: "assistant",
                  sequenceNumber: 2,
                  message: {
                    content: [{ type: "text", text: "Initial Pi answer" }],
                  },
                },
                {
                  type: "result",
                  sequenceNumber: 3,
                  result: "Initial Pi answer",
                },
              ],
            },
            exec1.sandboxHeaders,
            [200],
          );
          await fixture.webhooks.requestAgentComplete(
            {
              runId: run1.runId,
              exitCode: 0,
              lastEventSequence: 3,
              completion: {
                cliAgentType: "pi",
                cliAgentSessionId: run1.threadId,
                cliAgentSessionHistoryDisposition: "native_only",
              },
            },
            exec1.sandboxHeaders,
            [200],
          );
          await flushWaitUntilForTest();
        });

        const run2 = await chatActor.sendChatRun(actor, {
          threadId: run1.threadId,
          model: "gpt-6-luna",
          prompt: "Continue and fail after partial output",
        });
        const exec2 = await chatActor.runExecution(run2.runId);
        await chatActor.run(() => {
          return fixture.webhooks.requestAgentEvents(
            {
              runId: run2.runId,
              events: [
                {
                  type: "system",
                  subtype: "init",
                  session_id: run1.threadId,
                  sequenceNumber: 1,
                },
                {
                  type: "assistant",
                  sequenceNumber: 2,
                  message: {
                    content: [
                      { type: "text", text: "Partial Pi response before exit" },
                    ],
                  },
                },
              ],
            },
            exec2.sandboxHeaders,
            [200],
          );
        });

        const failedCompletion = {
          runId: run2.runId,
          exitCode: 1,
          lastEventSequence: 2,
          completion: {
            cliAgentType: "pi" as const,
            cliAgentSessionId: run1.threadId,
            cliAgentSessionHistoryDisposition: "native_only" as const,
          },
        };
        const firstComplete = await chatActor.run(() => {
          return fixture.webhooks.requestAgentComplete(
            failedCompletion,
            exec2.sandboxHeaders,
            [200],
          );
        });
        expect(firstComplete.body).toStrictEqual({
          success: true,
          status: "failed",
        });
        await flushWaitUntilForTest();

        const failedReadback = await fixture.api.readRun(actor, run2.runId);
        expect(failedReadback.status).toBe("failed");
        expect(failedReadback.failureReason).toBe("unknown");
        expect(failedReadback.result).toMatchObject({
          framework: "pi",
          frameworkSessionId: run1.threadId,
        });

        const replayComplete = await chatActor.run(() => {
          return fixture.webhooks.requestAgentComplete(
            failedCompletion,
            exec2.sandboxHeaders,
            [200],
          );
        });
        expect(replayComplete.body).toStrictEqual({
          success: true,
          status: "failed",
        });
        const replayedReadback = await fixture.api.readRun(actor, run2.runId);
        expect(replayedReadback.status).toBe("failed");
        expect(replayedReadback.failureReason).toBe("unknown");
        expect(replayedReadback.result).toStrictEqual(failedReadback.result);

        const run3 = await chatActor.sendChatRun(actor, {
          threadId: run1.threadId,
          model: "gpt-6-luna",
          prompt: "Resume from the partial failed native turn",
        });
        const exec3 = await chatActor.runExecution(run3.runId);
        expect(exec3.execution.cliAgentType).toBe("pi");
        expect(exec3.execution.piSessionId).toBe(run1.threadId);
        expect(exec3.execution.nativeContinuation.sessionId).toBe(
          run1.threadId,
        );
        expect(exec3.execution.nativeContinuation.generationRunId).toBe(
          run2.runId,
        );
        expect(exec3.execution.nativeContinuation.recoveryPrompt).toContain(
          CHAT_RECOVERY_COMMAND_SNIPPET,
        );
      },
    );
  });

  describe("ordinary Pi published personal Memory", () => {
    it(
      "pi-memory-recall-001 (1/3) reads the selected published version in Pi independently of Suggestions and concurrent newer publishes",
      { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const chatActor = await createPiActor({ enableRunContextRead: true });
        const { actor } = chatActor;
        const objects = installInMemoryObjectStore(context);

        const suggestionsOff = await accept(
          proactiveSuggestionsClient.update({
            headers: fixture.sessionHeaders(actor),
            body: { enabled: false },
          }),
          [200],
        );
        expect(suggestionsOff.body.enabled).toBeFalsy();

        const v1Summary = "Harbor project overview: south pier active.";
        const v1Detail = "Harbor detail: crane berth 7B opens on Friday.";
        const v2Secret = "Harbor v2 update: beacon tower 999 commissioned.";

        const publishedV1 = await publishPiMemoryVersion({
          actor,
          run: chatActor.run,
          rememberExecution: chatActor.rememberExecution,
          objects,
          prompt: "Publish initial harbor memory",
          files: [
            { path: "memory_summary.md", content: v1Summary },
            {
              path: "MEMORY.md",
              content:
                "# Personal Memory\n- [Harbor project](details/harbor.md): harbor pier notes",
            },
            { path: "details/harbor.md", content: v1Detail },
          ],
        });
        expect(
          (await fixture.api.readRun(actor, publishedV1.runId)).status,
        ).toBe("completed");

        const recall = await chatActor.sendChatRun(actor, {
          model: "gpt-6-luna",
          prompt: "Recall the harbor project",
        });
        const recallExec = await chatActor.runExecution(recall.runId);
        const recallMemory = recallExec.execution.startupInputs.memory;
        expect(recallMemory).not.toBeNull();
        if (!recallMemory) {
          throw new Error("Expected selected Memory mount on recall Run");
        }
        const recallContext = await runsApi.requestRunContext(
          actor,
          recall.runId,
          [200],
        );
        expect(recallContext.status).toBe(200);
        if (recallContext.status === 200) {
          expect(recallContext.body.storageMounts).toContainEqual(
            expect.objectContaining({
              name: "memory",
              version: publishedV1.versionId,
              mountPath: CANONICAL_PI_MEMORY_MOUNT_PATH,
            }),
          );
        }

        let writer2RunId = "";
        const piRead = await readPiExecutionMemoryInProcess(
          recallExec.execution,
          recallMemory,
          context.signal,
          async () => {
            const publishedV2 = await publishPiMemoryVersion({
              actor,
              run: chatActor.run,
              rememberExecution: chatActor.rememberExecution,
              objects,
              prompt: "Publish newer harbor memory",
              files: [
                { path: "memory_summary.md", content: v2Secret },
                {
                  path: "MEMORY.md",
                  content: `# Personal Memory\n- [Harbor v2](details/harbor.md): ${v2Secret}`,
                },
                { path: "details/harbor.md", content: v2Secret },
              ],
            });
            writer2RunId = publishedV2.runId;
          },
        );

        expect((await fixture.api.readRun(actor, writer2RunId)).status).toBe(
          "completed",
        );

        const firstRequestText = JSON.stringify(piRead.requests[0]);
        const laterRequestsText = JSON.stringify(piRead.requests.slice(1));
        const allReadText = JSON.stringify(piRead);

        expect(firstRequestText).toContain(v1Summary);
        expect(firstRequestText).toContain("Personal Memory recall");
        expect(firstRequestText).not.toContain(v1Detail);
        expect(laterRequestsText).toContain("details/harbor.md");
        expect(laterRequestsText).toContain(v1Detail);
        expect(piRead.toolEnds).toHaveLength(4);
        expect(allReadText).not.toContain(v2Secret);
      },
    );

    it(
      "pi-memory-recall-001 (2/3) keeps the queued Run pinned to the earlier published Memory version while new Runs select the newer version",
      { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const chatActor = await createPiActor();
        const { actor } = chatActor;
        const objects = installInMemoryObjectStore(context);

        const publishedV1 = await publishPiMemoryVersion({
          actor,
          run: chatActor.run,
          rememberExecution: chatActor.rememberExecution,
          objects,
          prompt: "Publish v1 memory before queueing",
          files: [
            { path: "memory_summary.md", content: "V1 summary" },
            { path: "MEMORY.md", content: "# V1 Memory" },
          ],
        });

        const queued = await chatActor.sendChatRun(actor, {
          model: "gpt-6-luna",
          prompt: "Queued harbor check before newer memory",
        });

        const publishedV2 = await publishPiMemoryVersion({
          actor,
          run: chatActor.run,
          rememberExecution: chatActor.rememberExecution,
          objects,
          prompt: "Publish v2 memory while queued run waits",
          files: [
            { path: "memory_summary.md", content: "V2 summary" },
            { path: "MEMORY.md", content: "# V2 Memory" },
          ],
        });

        const queuedExec = await chatActor.runExecution(queued.runId);
        expect(queuedExec.execution.startupInputs.memory?.versionId).toBe(
          publishedV1.versionId,
        );
        await chatActor.run(() => {
          return fixture.cancelChatRun(
            actor,
            queued.runId,
            queuedExec.sandboxHeaders,
          );
        });

        const freshRun = await chatActor.sendChatRun(actor, {
          model: "gpt-6-luna",
          prompt: "Read latest harbor memory",
        });
        const freshExec = await chatActor.runExecution(freshRun.runId);
        expect(freshExec.execution.startupInputs.memory?.versionId).toBe(
          publishedV2.versionId,
        );
      },
    );

    it(
      "pi-memory-recall-001 (3/3) isolates another organization member to their own empty Memory root and denies foreign Run context",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const chatActor = await createPiActor({ enableRunContextRead: true });
        const { actor } = chatActor;
        const objects = installInMemoryObjectStore(context);

        const v1Summary = "Harbor private summary for member one.";
        const v1Detail = "Harbor private detail: berth 7B secret code.";
        const published = await publishPiMemoryVersion({
          actor,
          run: chatActor.run,
          rememberExecution: chatActor.rememberExecution,
          objects,
          prompt: "Publish member one harbor memory",
          files: [
            { path: "memory_summary.md", content: v1Summary },
            {
              path: "MEMORY.md",
              content:
                "# Personal Memory\n- [Harbor](details/harbor.md): harbor secret",
            },
            { path: "details/harbor.md", content: v1Detail },
          ],
        });

        const recall = await chatActor.sendChatRun(actor, {
          model: "gpt-6-luna",
          prompt: "Member one recall",
        });
        await chatActor.runExecution(recall.runId);

        const otherMember = fixture.bdd.user({
          orgId: actor.orgId,
          orgRole: "org:member",
        });
        const otherOwned = createOwnedActorRunner(context, otherMember);
        await otherOwned.run(async () => {
          await fixture.bdd.completeOnboarding(otherMember);
          await fixture.connectSubscriptionPiModel(otherMember);
        });

        const foreignContext = await runsApi.requestRunContext(
          otherMember,
          recall.runId,
          [404],
        );
        expect(foreignContext.status).toBe(404);

        const otherRun = await otherOwned.run(() => {
          return fixture.sendChatRun(otherMember, {
            model: "gpt-6-luna",
            prompt: "Recall any harbor memory",
          });
        });
        const otherExec = await otherOwned.run(async () => {
          const execution = await fixture.runExecution(otherRun.runId);
          otherOwned.rememberExecution(
            otherRun.runId,
            execution.execution.sandboxToken,
          );
          return execution;
        });
        const otherMemory = otherExec.execution.startupInputs.memory;
        expect(otherMemory).not.toBeNull();
        if (!otherMemory) {
          throw new Error("Expected member two empty Memory mount");
        }
        expect(otherMemory.storageId).not.toBe(published.storageId);
        expect(otherMemory.empty).toBeTruthy();

        const otherRead = await readPiExecutionMemoryInProcess(
          otherExec.execution,
          otherMemory,
          context.signal,
        );
        const otherText = JSON.stringify(otherRead);
        expect(otherText).not.toContain(v1Summary);
        expect(otherText).not.toContain(v1Detail);
        expect(
          otherRead.toolEnds.some((entry) => {
            return entry.isError;
          }),
        ).toBeTruthy();
      },
    );
  });

  describe("incomplete-round context and thread history", () => {
    it(
      "chat-events-history-001 injects incomplete rounds and truncates old content chronologically",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const chatActor = await createLimitedFreeChatActor({
          includeClaude: true,
        });
        const { actor } = chatActor;

        const run1 = await chatActor.sendChatRun(actor, {
          model: "claude-fable-5-1",
          prompt: "Initial completed native turn",
        });
        const exec1 = await chatActor.runExecution(run1.runId);
        const initialMeta = await chatActor.completeTurn(
          run1,
          exec1.execution,
          exec1.sandboxHeaders,
          "First turn succeeded",
        );

        const longTailMarker = "TAIL_MARKER_MUST_BE_TRUNCATED";
        const longPrompt = `First failed turn prefix ${"a".repeat(4050)} ${longTailMarker}`;
        const run2 = await chatActor.sendChatRun(actor, {
          threadId: run1.threadId,
          model: "claude-fable-5-1",
          prompt: longPrompt,
        });
        const exec2 = await chatActor.runExecution(run2.runId);
        expect(exec2.execution.appendSystemPrompt ?? "").not.toContain(
          "# Incomplete Rounds Context",
        );
        await chatActor.run(() => {
          return fixture.webhooks.requestAgentComplete(
            {
              runId: run2.runId,
              exitCode: 1,
              error: "First incomplete failure",
              failureReason: "provider_server_error",
            },
            exec2.sandboxHeaders,
            [200],
          );
        });
        await fixture.waitForRunStatus(actor, run2.runId, "failed");

        const secondFailedPrompt = "Second failed turn prompt alpha";
        const run3 = await chatActor.sendChatRun(actor, {
          threadId: run1.threadId,
          model: "claude-fable-5-1",
          prompt: secondFailedPrompt,
        });
        const exec3 = await chatActor.runExecution(run3.runId);
        await chatActor.run(() => {
          return fixture.webhooks.requestAgentComplete(
            {
              runId: run3.runId,
              exitCode: 1,
              error: "Second incomplete failure",
              failureReason: "provider_server_error",
            },
            exec3.sandboxHeaders,
            [200],
          );
        });
        await fixture.waitForRunStatus(actor, run3.runId, "failed");

        const retryPrompt = "Retry turn after two failures";
        const run4 = await chatActor.sendChatRun(actor, {
          threadId: run1.threadId,
          model: "claude-fable-5-1",
          prompt: retryPrompt,
        });
        const exec4 = await chatActor.runExecution(run4.runId);
        const retrySystemPrompt = exec4.execution.appendSystemPrompt ?? "";

        expect(exec4.execution.prompt).toBe(retryPrompt);
        expect(retrySystemPrompt).toContain("# Incomplete Rounds Context");
        const firstIndex = retrySystemPrompt.indexOf(
          "First failed turn prefix",
        );
        const secondIndex = retrySystemPrompt.indexOf(secondFailedPrompt);
        expect(firstIndex).toBeGreaterThan(-1);
        expect(secondIndex).toBeGreaterThan(firstIndex);
        expect(retrySystemPrompt).toContain("- RELATIVE_INDEX: -1");
        expect(retrySystemPrompt).toContain("- RELATIVE_INDEX: 0");
        expect(retrySystemPrompt).toContain("- RUN_STATUS: failed");
        expect(retrySystemPrompt).toContain("...[truncated]");
        expect(retrySystemPrompt).not.toContain(longTailMarker);

        expect(exec4.execution.nativeContinuation.sessionId).toBeNull();
        expect(exec4.execution.nativeContinuation.generationRunId).toBeNull();
        expect(exec4.execution.nativeContinuation.recoveryPrompt).toContain(
          CHAT_RECOVERY_COMMAND_SNIPPET,
        );

        const retryMeta = await chatActor.completeTurn(
          run4,
          exec4.execution,
          exec4.sandboxHeaders,
          "Retry turn completed cleanly",
        );
        const storedRetryRun = await fixture.api.readRun(actor, run4.runId);
        expect(storedRetryRun.status).toBe("completed");
        expect(retryMeta.cliAgentSessionId).not.toBe(
          initialMeta.cliAgentSessionId,
        );
        expect(storedRetryRun.result).toMatchObject({
          framework: retryMeta.cliAgentType,
          frameworkSessionId: retryMeta.cliAgentSessionId,
        });
      },
    );

    it(
      "chat-events-history-002 (1/2) generates the thread title once, strips markup, references thread ID on continuation, and honors manual rename",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const chatActor = await createLimitedFreeChatActor();
        const { actor } = chatActor;

        const providerRequests: {
          readonly authorization: string | null;
          readonly model: string;
          readonly kind: "title" | "followup" | "other";
        }[] = [];
        mockGoogleText();
        server.use(
          http.post(VERTEX_TEXT_URL, async ({ request }) => {
            const parsed = vertexTextRequest(await request.json(), request.url);
            const systemText = parsed.messages
              .filter((message) => {
                return message.role === "system";
              })
              .map((message) => {
                return message.content;
              })
              .join("\n");
            const kind = systemText.includes(
              "Generate a short, descriptive title",
            )
              ? "title"
              : systemText.includes("recommended follow-up messages")
                ? "followup"
                : "other";
            providerRequests.push({
              authorization: request.headers.get("authorization"),
              model: parsed.model,
              kind,
            });
            if (kind === "followup") {
              return vertexTextResponse(
                JSON.stringify([
                  { prompt: "Review launch checklist", kind: "talk" },
                  { prompt: "Inspect error budget", kind: "talk" },
                  { prompt: "Post status summary", kind: "talk" },
                ]),
              );
            }
            return vertexTextResponse("**Quarterly** `Release` Plan");
          }),
        );

        const run1 = await chatActor.sendChatRun(actor, {
          model: null,
          prompt: "Plan our quarterly release checklist",
        });
        const exec1 = await chatActor.runExecution(run1.runId);
        await chatActor.completeTurn(
          run1,
          exec1.execution,
          exec1.sandboxHeaders,
          "Here is the draft quarterly release checklist.",
        );

        expect(providerRequests).toContainEqual({
          authorization: "Bearer synthetic-google-token",
          model: "gemini-3.1-flash-lite",
          kind: "title",
        });
        expect(providerRequests).toContainEqual({
          authorization: "Bearer synthetic-google-token",
          model: "gemini-3.8-flash",
          kind: "followup",
        });

        const afterFirst = await fixture.chat.readThreadMetadata(
          actor,
          run1.threadId,
        );
        expect(afterFirst.title).toBe("Quarterly Release Plan");

        const run2 = await chatActor.sendChatRun(actor, {
          threadId: run1.threadId,
          model: null,
          prompt: "Add rollback verification steps",
        });
        const exec2 = await chatActor.runExecution(run2.runId);
        expect(exec2.execution.appendSystemPrompt).toContain(
          `CHAT_THREAD_ID: ${run1.threadId}`,
        );
        await chatActor.completeTurn(
          run2,
          exec2.execution,
          exec2.sandboxHeaders,
          "Added rollback verification steps.",
        );

        const manualTitle = "Release Readiness Manual Title";
        await fixture.chat.renameThread(actor, run1.threadId, manualTitle);

        const run3 = await chatActor.sendChatRun(actor, {
          threadId: run1.threadId,
          model: null,
          prompt: "Confirm final sign-off list",
        });
        const exec3 = await chatActor.runExecution(run3.runId);
        await chatActor.completeTurn(
          run3,
          exec3.execution,
          exec3.sandboxHeaders,
          "Confirmed final sign-off list.",
        );

        const afterRename = await fixture.chat.readThreadMetadata(
          actor,
          run1.threadId,
        );
        expect(afterRename.title).toBe(manualTitle);
        expect(
          providerRequests.filter((entry) => {
            return entry.kind === "title";
          }),
        ).toStrictEqual([
          {
            authorization: "Bearer synthetic-google-token",
            model: "gemini-3.1-flash-lite",
            kind: "title",
          },
        ]);
      },
    );

    it(
      "chat-events-history-002 (2/2) persists recommended follow-ups and enforces immutable single-winner revokes across races and replays",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const chatActor = await createLimitedFreeChatActor();
        const { actor } = chatActor;

        mockGoogleText();
        server.use(
          http.post(VERTEX_TEXT_URL, async ({ request }) => {
            const parsed = vertexTextRequest(await request.json(), request.url);
            if (parsed.model === "gemini-3.8-flash") {
              return vertexTextResponse(
                JSON.stringify([
                  { prompt: "Review launch checklist", kind: "talk" },
                  { prompt: "Inspect error budget", kind: "talk" },
                  { prompt: "Post status summary", kind: "talk" },
                ]),
              );
            }
            return vertexTextResponse("Release Follow-ups");
          }),
        );

        const firstClientEventId = randomUUID();
        const run1 = await chatActor.sendChatRun(actor, {
          model: null,
          clientEventId: firstClientEventId,
          prompt: "Summarize launch readiness",
        });
        const exec1 = await chatActor.runExecution(run1.runId);
        await chatActor.completeTurn(
          run1,
          exec1.execution,
          exec1.sandboxHeaders,
          "Launch readiness summary complete.",
        );

        const afterFirst = await fixture.chat.listThreadEvents(
          actor,
          run1.threadId,
        );
        const followupEvent = afterFirst.events.find(
          (
            event,
          ): event is Extract<ChatEvent, { eventType: "output.followups" }> => {
            return event.eventType === "output.followups";
          },
        );
        expect(followupEvent).toBeDefined();
        if (!followupEvent) {
          throw new Error("Expected persisted output.followups event");
        }
        const chosenPrompt = "Review launch checklist";
        expect(
          resolveChatEventRecommendedFollowups(followupEvent),
        ).toContainEqual(expect.objectContaining({ prompt: chosenPrompt }));

        const unrelatedConflict = await chatActor.run(() => {
          return fixture.chat.requestSendEvent(
            actor,
            {
              threadId: run1.threadId,
              prompt: chosenPrompt,
              clientEventId: firstClientEventId,
              revokesEventId: followupEvent.id,
            },
            [409],
          );
        });
        expect(unrelatedConflict.status).toBe(409);

        const candidateA = randomUUID();
        const candidateB = randomUUID();
        const headers = fixture.sessionHeaders(actor);
        const submitFollowup = (clientEventId: string) => {
          return accept(
            chatEventsClient.send({
              headers,
              body: {
                threadId: run1.threadId,
                prompt: chosenPrompt,
                hasTextContent: true,
                clientEventId,
                revokesEventId: followupEvent.id,
                userMessage: {
                  version: 1,
                  parts: [{ type: "text", text: chosenPrompt }],
                },
              },
            }),
            [201, 409],
          );
        };

        const [a1, a2, b1, b2] = await chatActor.run(() => {
          return Promise.all([
            submitFollowup(candidateA),
            submitFollowup(candidateA),
            submitFollowup(candidateB),
            submitFollowup(candidateB),
          ]);
        });
        const aWon = a1.status === 201;
        const winnerId = aWon ? candidateA : candidateB;
        const loserId = aWon ? candidateB : candidateA;
        const [winnerFirst, winnerSecond] = aWon ? [a1, a2] : [b1, b2];
        const [loserFirst, loserSecond] = aWon ? [b1, b2] : [a1, a2];

        expect(winnerFirst.status).toBe(201);
        expect(winnerSecond.status).toBe(201);
        expect(winnerSecond.body).toStrictEqual(winnerFirst.body);
        expect(loserFirst.status).toBe(409);
        expect(loserSecond.status).toBe(409);

        const winnerReplay = await chatActor.run(() => {
          return submitFollowup(winnerId);
        });
        const loserReplay = await chatActor.run(() => {
          return submitFollowup(loserId);
        });
        expect(winnerReplay.status).toBe(201);
        expect(winnerReplay.body).toStrictEqual(winnerFirst.body);
        expect(loserReplay.status).toBe(409);

        await flushWaitUntilForTest();
        const finalHistory = await fixture.chat.listThreadEvents(
          actor,
          run1.threadId,
        );
        const revokingFollowup = finalHistory.events.filter((event) => {
          return event.revokesEventId === followupEvent.id;
        });
        expect(revokingFollowup).toHaveLength(1);
        expect(revokingFollowup[0]?.id).toBe(winnerId);
        expect(
          finalHistory.events.filter((event) => {
            return (
              event.eventType === "input.prompt" &&
              event.revokesEventId === winnerId &&
              event.runId !== undefined
            );
          }),
        ).toHaveLength(1);
      },
    );
  });

  describe("chat-events-pi-failures and preparation", () => {
    it(
      "chat-events-pi-failures-002 preserves native subscription continuity and active steering input without history upload",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = fixture.bdd.user();
        const owned = createOwnedActorRunner(context, actor);
        installBaseChatMocks();
        await Promise.all([
          fixture.api.configureRunnerGroup(),
          owned.run(() => {
            return bddApi.bootstrapLimitedFreeOnboarding(actor);
          }),
          owned.run(() => {
            return fixture.connectSubscriptionPiModel(actor);
          }),
        ]);
        const historyObjects = fixture.mockPiObjectStore();

        const firstPrompt = "Draft the initial migration plan";
        const firstAnswer =
          "Initial migration plan token-7f4e91c2 ready for review.";
        const run1 = await owned.run(() => {
          return fixture.sendChatRun(actor, {
            model: "gpt-6-luna",
            prompt: firstPrompt,
          });
        });
        const exec1 = await owned.run(async () => {
          const execution = await fixture.runExecution(run1.runId);
          owned.rememberExecution(run1.runId, execution.execution.sandboxToken);
          return execution;
        });
        await owned.run(async () => {
          await fixture.webhooks.requestAgentEvents(
            {
              runId: run1.runId,
              events: [
                {
                  type: "assistant",
                  sequenceNumber: 1,
                  message: { content: [{ type: "text", text: firstAnswer }] },
                },
                { type: "result", sequenceNumber: 2, result: firstAnswer },
              ],
            },
            exec1.sandboxHeaders,
            [200],
          );
          await fixture.webhooks.requestAgentComplete(
            {
              runId: run1.runId,
              exitCode: 0,
              lastEventSequence: 2,
              completion: {
                cliAgentType: "pi",
                cliAgentSessionId: run1.threadId,
                cliAgentSessionHistoryDisposition: "native_only",
              },
            },
            exec1.sandboxHeaders,
            [200],
          );
          await flushWaitUntilForTest();
        });

        const secondPrompt = "Refine the rollback verification steps";
        const run2 = await owned.run(() => {
          return fixture.sendChatRun(actor, {
            threadId: run1.threadId,
            model: "gpt-6-luna",
            prompt: secondPrompt,
          });
        });
        const exec2 = await owned.run(async () => {
          const execution = await fixture.runExecution(run2.runId);
          owned.rememberExecution(run2.runId, execution.execution.sandboxToken);
          return execution;
        });

        expect(exec2.execution.prompt).toBe(secondPrompt);
        expect(exec2.execution.cliAgentType).toBe("pi");
        expect(exec2.execution.piSessionId).toBe(run1.threadId);
        expect(exec2.execution.nativeContinuation).toMatchObject({
          sessionId: run1.threadId,
          generationRunId: run1.runId,
        });
        expect(exec2.execution.appendSystemPrompt ?? "").not.toContain(
          firstAnswer,
        );
        expect(historyObjects.size).toBe(0);

        const steeringEventId = randomUUID();
        const steeringPrompt = "Also include the staging smoke check";
        await owned.run(() => {
          return fixture.chat.requestSendEvent(
            actor,
            {
              threadId: run1.threadId,
              prompt: steeringPrompt,
              clientEventId: steeringEventId,
            },
            [201],
          );
        });
        await flushWaitUntilForTest();

        const firstPoll = await owned.run(() => {
          return fixture.api.nextSteerableInput(
            exec2.execution.sandboxToken,
            run2.runId,
          );
        });
        const secondPoll = await owned.run(() => {
          return fixture.api.nextSteerableInput(
            exec2.execution.sandboxToken,
            run2.runId,
          );
        });
        expect(firstPoll).toStrictEqual({
          input: {
            eventId: steeringEventId,
            prompt: steeringPrompt,
          },
        });
        expect(secondPoll).toStrictEqual({
          input: {
            eventId: steeringEventId,
            prompt: steeringPrompt,
          },
        });

        const steered = await owned.run(() => {
          return fixture.api.declareSteeredInput(
            exec2.execution.sandboxToken,
            run2.runId,
            steeringEventId,
          );
        });
        expect(steered).toStrictEqual({ outcome: "steered" });
        await flushWaitUntilForTest();

        const [threadEvents, modelCredits] = await Promise.all([
          fixture.chat.listThreadEvents(actor, run1.threadId),
          readThreadModelCredits(context, actor, run1.threadId),
        ]);
        const revokingSteering = userMessages(threadEvents.events).filter(
          (event) => {
            return event.revokesEventId === steeringEventId;
          },
        );
        expect(revokingSteering).toHaveLength(1);
        expect(revokingSteering[0]).toMatchObject({
          eventType: "input.prompt",
          runId: run2.runId,
          revokesEventId: steeringEventId,
        });
        expect(chatEventDisplayText(revokingSteering[0]!)).toBe(steeringPrompt);

        const activeRunTerminalEvents = threadEvents.events.filter((event) => {
          return (
            event.runId === run2.runId &&
            isChatRunTerminalEventType(event.eventType)
          );
        });
        expect(activeRunTerminalEvents).toStrictEqual([]);
        expect(historyObjects.size).toBe(0);
        expect(modelCredits).toBe(0);
      },
    );

    it(
      "chat-events-pi-preparation-001 launches an at-capacity Pi send on a fresh session once a slot frees",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        mockEnv("CONCURRENT_RUN_LIMIT_CAP", 1);
        const actor = fixture.bdd.user();
        const owned = createOwnedActorRunner(context, actor);
        installBaseChatMocks();
        mockClaudeCodeTokenEndpoint();
        await Promise.all([
          fixture.api.configureRunnerGroup(),
          owned.run(() => {
            return bddApi.bootstrapLimitedFreeOnboarding(actor);
          }),
          owned.run(() => {
            return fixture.api.createPersonalModelProvider(actor, {
              type: "claude-code-oauth-token",
              secret: "bdd-personal-claude-token",
            });
          }),
          owned.run(() => {
            return fixture.connectSubscriptionPiModel(actor);
          }),
        ]);

        const blocker = await owned.run(() => {
          return fixture.sendChatRun(actor, {
            model: "claude-fable-5-1",
            prompt: "Occupy the single workspace run slot",
          });
        });
        const blockerExecution = await owned.run(async () => {
          const execution = await fixture.runExecution(blocker.runId);
          owned.rememberExecution(
            blocker.runId,
            execution.execution.sandboxToken,
          );
          return execution;
        });

        const queuedPrompt = "Launch personal gpt-6-luna once a slot frees";
        const waiting = await owned.run(() => {
          return fixture.sendWaitingChatInput(actor, {
            model: "gpt-6-luna",
            prompt: queuedPrompt,
          });
        });

        await owned.run(() => {
          return fixture.cancelChatRun(
            actor,
            blocker.runId,
            blockerExecution.sandboxHeaders,
          );
        });

        const launched = await owned.run(() => {
          return waiting.launchedRun();
        });
        const { execution } = await owned.run(async () => {
          const result = await fixture.runExecution(launched.runId);
          owned.rememberExecution(
            launched.runId,
            result.execution.sandboxToken,
          );
          return result;
        });

        expect(launched.threadId).toBe(waiting.threadId);
        expect(execution.prompt).toBe(queuedPrompt);
        expect(execution.cliAgentType).toBe("pi");
        expect(execution.piSessionId).toBe(waiting.threadId);
        expect(execution.piLaunchConfig).toStrictEqual({ schemaVersion: 2 });
        expect(execution.piModelConfig).toMatchObject({
          provider: "openai-codex",
          model: "gpt-6-luna",
        });
      },
    );
  });
});
