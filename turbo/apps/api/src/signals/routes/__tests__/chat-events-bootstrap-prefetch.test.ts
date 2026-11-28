import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  chatEventsContract,
  chatThreadEventsContract,
  chatThreadMetadataContract,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  runnersSteerContract,
} from "@okouai/api-contracts/contracts/runners";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  runWebhookContract,
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { HttpResponse } from "msw";
import { Header } from "tar";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { ApiTestMocks } from "../../../__tests__/mocks";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { cliAuthRoutes } from "../cli-auth";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentStorageRoutes } from "../webhooks-agent-storage";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import {
  createChatEventsFixture,
  okouTokenFromExecution,
  userMessages,
  type RunnerExecutionInput,
} from "./helpers/chat-events-fixture";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

const WARMUP_UUID = "00000000-0000-4000-8000-000000000001";
const CLERK_SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

function completionMetadataForExecution(
  execution: RunnerExecutionInput,
  target: { readonly runId: string; readonly threadId: string },
) {
  if (execution.cliAgentType === "pi") {
    return {
      cliAgentType: "pi" as const,
      cliAgentSessionId: execution.piSessionId ?? target.threadId,
      cliAgentSessionHistoryDisposition: "native_only" as const,
    };
  }
  const cliAgentType =
    execution.cliAgentType === "codex"
      ? ("codex" as const)
      : ("claude-code" as const);
  return {
    cliAgentType,
    cliAgentSessionId: `bdd-${cliAgentType}-${target.runId}`,
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
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({ ContentLength: bytes.length });
      }
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
          transformToByteArray: () => {
            return Promise.resolve(bytes);
          },
        },
      });
    }
    return Promise.resolve({});
  });
  return objects;
}

interface PublishedRealtimeEvent {
  readonly channel: string;
  readonly topic: unknown;
  readonly payload: unknown;
}

function publishedRealtimeEvents(
  mocks: ApiTestMocks,
): readonly PublishedRealtimeEvent[] {
  const gets = mocks.ably.channelGet.mock;
  const publishes = mocks.ably.publish.mock;
  return publishes.calls.map((call, index) => {
    const publishedAt = publishes.invocationCallOrder[index] ?? 0;
    let channel = "";
    for (const [getIndex, order] of gets.invocationCallOrder.entries()) {
      if (order < publishedAt) {
        channel = String(gets.calls[getIndex]?.[0] ?? "");
      }
    }
    return {
      channel,
      topic: call[0],
      payload: call[1],
    };
  });
}

describe("chat-events-bootstrap-prefetch", () => {
  const context = testContext();
  const fixture = createChatEventsFixture(context);
  const bddApi = createBddApi(context);
  const runsApi = createRunsApi(context);
  const routeMocks = createRouteMocks(context);

  const chatEventsClient = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const chatThreadMetaClient = setupAppWithRoutes({
    context,
    routes: chatThreadGetRoutes,
  })(chatThreadMetadataContract);
  const chatThreadEventsClient = setupAppWithRoutes({
    context,
    routes: chatThreadRoutes,
  })(chatThreadEventsContract);
  const runsByIdClient = setupAppWithRoutes({
    context,
    routes: runsRoutes,
  })(runsByIdContract);
  const runsCancelClient = setupAppWithRoutes({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);
  const runnersHeartbeatClient = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersHeartbeatContract);
  const runnersSteerClient = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersSteerContract);
  const userModelPreferenceClient = setupAppWithRoutes({
    context,
    routes: userModelPreferenceRoutes,
  })(userModelPreferenceContract);
  const personalModelProvidersClient = setupAppWithRoutes({
    context,
    routes: meModelProvidersUpsertRoutes,
  })(personalModelProvidersMainContract);
  const builtinManualGrantClient = setupAppWithRoutes({
    context,
    routes: builtinConnectorsRoutes,
  })(builtinConnectorManualGrantContract);
  const connectorAccountsClient = setupAppWithRoutes({
    context,
    routes: connectorAccountRoutes,
  })(connectorAccountsContract);
  const cliAuthDeviceClient = setupAppWithRoutes({
    context,
    routes: cliAuthRoutes,
  })(cliAuthDeviceContract);
  const cliAuthApproveClient = setupAppWithRoutes({
    context,
    routes: cliAuthRoutes,
  })(cliAuthApproveContract);
  const cliAuthTokenClient = setupAppWithRoutes({
    context,
    routes: cliAuthRoutes,
  })(cliAuthTokenContract);
  const onboardingCompleteClient = setupAppWithRoutes({
    context,
    routes: onboardingCompleteRoutes,
  })(onboardingCompleteContract);
  const webhookClerkClient = setupAppWithRoutes({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);
  const webhookCompleteClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const webhookStorageClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentStorageRoutes,
  })(runWebhookContract);

  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmed = await settleIncludingAbort(async () => {
      await Promise.all([
        accept(
          webhookClerkClient.post({
            body: "{}",
            extraHeaders: {},
          }),
          [401],
        ),
        accept(
          onboardingCompleteClient.complete({
            headers: {},
            body: {},
          }),
          [401],
        ),
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
          chatThreadEventsClient.rows({
            headers: {},
            params: { threadId: WARMUP_UUID },
            query: { sinceSeqId: 0 },
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
          runsCancelClient.cancel({
            headers: {},
            params: { id: WARMUP_UUID },
          }),
          [401],
        ),
        accept(
          runnersHeartbeatClient.heartbeat({
            headers: {},
            body: {
              runnerId: WARMUP_UUID,
              group: "vm0/warmup",
              snapshotGeneration: 1,
              snapshotSequence: 1,
              totalVcpu: 1,
              totalMemoryMb: 1024,
              maxConcurrent: 1,
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
            params: { runId: WARMUP_UUID },
          }),
          [401],
        ),
        accept(
          userModelPreferenceClient.update({
            headers: {},
            body: { selectedModel: "claude-sonnet-5-5", serviceTier: null },
          }),
          [401],
        ),
        accept(
          personalModelProvidersClient.upsert({
            headers: {},
            body: {
              type: "claude-code-oauth-token",
              secret: "warmup-secret",
            },
          }),
          [401],
        ),
        accept(
          builtinManualGrantClient.connect({
            headers: {},
            params: { connectorSlug: "openai" },
            body: {
              authMethod: "api-token",
              values: { apiKey: "sk-warmup" },
              account: { intent: "add" },
            },
          }),
          [401],
        ),
        accept(
          connectorAccountsClient.setDefault({
            headers: {},
            params: { connectionId: WARMUP_UUID },
            body: { target: { kind: "builtin", connectorSlug: "openai" } },
          }),
          [401],
        ),
        accept(
          cliAuthApproveClient.approve({
            headers: {},
            body: { device_code: "warmup-device-code" },
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
          webhookStorageClient.storagePrepare({
            headers: {},
            body: {
              runId: WARMUP_UUID,
              storageId: WARMUP_UUID,
              parentVersionId: WARMUP_UUID,
              files: [],
            },
          }),
          [401],
        ),
        accept(
          webhookStorageClient.storageCommit({
            headers: {},
            body: {
              runId: WARMUP_UUID,
              storageId: WARMUP_UUID,
              parentVersionId: WARMUP_UUID,
              versionId: WARMUP_UUID,
              files: [],
            },
          }),
          [401],
        ),
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  function authenticateActor(actor: ApiTestUser): {
    readonly authorization: string;
  } {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const emailId = `email_${actor.userId}`;
    mockClerkUsers(context, [
      {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
        firstName: "BDD",
        lastName: "User",
      },
    ]);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: actor.orgId
        ? [
            {
              role: actor.orgRole ?? "org:admin",
              organization: { id: actor.orgId },
              publicUserData: { userId: actor.userId },
            },
          ]
        : [],
    });
    return CLERK_SESSION_HEADERS;
  }

  async function listThreadEvents(
    headers: { readonly authorization: string },
    threadId: string,
  ): Promise<readonly ChatEvent[]> {
    const response = await accept(
      chatThreadEventsClient.rows({
        headers,
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    return projectChatEventRows(response.body.rows);
  }

  function installBaseChatMocks(): void {
    fixture.chatCallbacks.acceptChatObjectStorage();
    fixture.api.acceptStorageDownloads();
    fixture.api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    fixture.chatCallbacks.disableVapid();
  }

  async function createLimitedFreeActor(options?: {
    readonly includeClaude?: boolean;
    readonly runnerOptions?: Parameters<typeof runsApi.configureRunnerGroup>[0];
  }) {
    const actor = bddApi.user();
    if (!actor.orgId) {
      throw new Error("Expected limited-free actor to have an organization");
    }
    const orgId = actor.orgId;
    installBaseChatMocks();
    if (options?.includeClaude) {
      mockClaudeCodeTokenEndpoint();
    }

    const trackedRuns = new Map<string, string | undefined>();
    const completedRuns = new Set<string>();
    const pendingQueuedInputs: {
      readonly threadId: string;
      readonly clientEventId: string;
    }[] = [];
    const capturedBucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const capturedKmsKey = env("SECRETS_KMS_KEY_ID");
    const capturedRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");

    onTestFinished(async () => {
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", capturedBucket);
      mockEnv("SECRETS_KMS_KEY_ID", capturedKmsKey);
      if (capturedRunnerGroup !== undefined) {
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", capturedRunnerGroup);
      }
      context.mocks.ably.publish.mockResolvedValue(undefined);
      await settleIncludingAbort(flushWaitUntilForTest);

      const headers = authenticateActor(actor);
      for (const queued of pendingQueuedInputs) {
        await settleIncludingAbort(() => {
          return accept(
            chatEventsClient.send({
              headers,
              body: {
                threadId: queued.threadId,
                revokesEventId: queued.clientEventId,
              },
            }),
            [201, 400, 404, 409],
          );
        });
      }

      for (const [runId, sandboxToken] of trackedRuns) {
        if (completedRuns.has(runId)) {
          continue;
        }
        const current = await settleIncludingAbort(() => {
          return accept(
            runsByIdClient.getById({ headers, params: { id: runId } }),
            [200, 404],
          );
        });
        const currentStatus =
          current.ok && current.value.status === 200
            ? current.value.body.status
            : undefined;
        if (
          currentStatus !== undefined &&
          ["queued", "pending", "running"].includes(currentStatus)
        ) {
          await settleIncludingAbort(() => {
            return accept(
              runsCancelClient.cancel({ headers, params: { id: runId } }),
              [200],
            );
          });
        }
        if (
          sandboxToken &&
          (currentStatus === undefined ||
            !["completed", "failed", "timeout"].includes(currentStatus))
        ) {
          await settleIncludingAbort(() => {
            return accept(
              webhookCompleteClient.complete({
                headers: { authorization: `Bearer ${sandboxToken}` },
                body: { runId, exitCode: 1, error: "Run cancelled" },
              }),
              [200],
            );
          });
        }
      }
      await settleIncludingAbort(flushWaitUntilForTest);
    });

    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
      type: "organization.created",
      data: { id: orgId, created_by: actor.userId, created_at: now() },
    });

    const [runnerGroup] = await Promise.all([
      runsApi.configureRunnerGroup(options?.runnerOptions),
      (async () => {
        await accept(
          webhookClerkClient.post({ body: "{}", extraHeaders: {} }),
          [200],
        );
        await flushWaitUntilForTest();
        const headers = authenticateActor(actor);
        await accept(
          onboardingCompleteClient.complete({ headers, body: {} }),
          [200],
        );
      })(),
    ]);

    if (options?.includeClaude) {
      await accept(
        personalModelProvidersClient.upsert({
          headers: authenticateActor(actor),
          body: {
            type: "claude-code-oauth-token",
            secret: "bdd-personal-claude-token",
          },
        }),
        [200, 201],
      );
    }

    async function sendChatRun(body: {
      readonly prompt: string;
      readonly threadId?: string;
      readonly model?: string | null;
      readonly clientEventId?: string;
    }): Promise<{
      readonly runId: string;
      readonly threadId: string;
      readonly clientEventId: string;
    }> {
      const clientEventId = body.clientEventId ?? randomUUID();
      const headers = authenticateActor(actor);
      const sent = await accept(
        chatEventsClient.send({
          headers,
          body: {
            prompt: body.prompt,
            ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
            ...(body.model === undefined ? {} : { model: body.model }),
            clientEventId,
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: body.prompt }],
            },
          },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      const events = await listThreadEvents(headers, sent.body.threadId);
      const runId = userMessages(events).find((message) => {
        return (
          message.revokesEventId === clientEventId &&
          message.runId !== undefined
        );
      })?.runId;
      if (!runId) {
        throw new Error("Expected chat send to launch a Run");
      }
      trackedRuns.set(runId, undefined);
      return { runId, threadId: sent.body.threadId, clientEventId };
    }

    async function sendWaitingInput(body: {
      readonly prompt: string;
      readonly threadId: string;
      readonly model?: string | null;
      readonly clientEventId?: string;
    }): Promise<{
      readonly threadId: string;
      readonly clientEventId: string;
      readonly launchedRun: () => Promise<{
        readonly runId: string;
        readonly threadId: string;
      }>;
    }> {
      const clientEventId = body.clientEventId ?? randomUUID();
      const headers = authenticateActor(actor);
      const sent = await accept(
        chatEventsClient.send({
          headers,
          body: {
            prompt: body.prompt,
            threadId: body.threadId,
            ...(body.model === undefined ? {} : { model: body.model }),
            clientEventId,
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: body.prompt }],
            },
          },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      const waiting = await listThreadEvents(headers, sent.body.threadId);
      expect(
        userMessages(waiting).filter((message) => {
          return (
            message.revokesEventId === clientEventId &&
            message.runId !== undefined
          );
        }),
      ).toStrictEqual([]);
      return {
        threadId: sent.body.threadId,
        clientEventId,
        async launchedRun() {
          await flushWaitUntilForTest();
          const events = await listThreadEvents(
            authenticateActor(actor),
            sent.body.threadId,
          );
          const runId = userMessages(events).find((message) => {
            return (
              message.revokesEventId === clientEventId &&
              message.runId !== undefined
            );
          })?.runId;
          if (!runId) {
            throw new Error("Expected queued input to launch a Run");
          }
          trackedRuns.set(runId, undefined);
          return { runId, threadId: sent.body.threadId };
        },
      };
    }

    async function runExecution(runId: string) {
      const execution = await runsApi.executionInput(runId);
      trackedRuns.set(runId, execution.sandboxToken);
      return {
        execution,
        sandboxHeaders: { authorization: `Bearer ${execution.sandboxToken}` },
      };
    }

    async function completeRun(
      target: { readonly runId: string; readonly threadId: string },
      execution: RunnerExecutionInput,
      sandboxHeaders: { readonly authorization: string },
    ) {
      await accept(
        webhookCompleteClient.complete({
          headers: sandboxHeaders,
          body: {
            runId: target.runId,
            exitCode: 0,
            completion: completionMetadataForExecution(execution, target),
          },
        }),
        [200],
      );
      completedRuns.add(target.runId);
      await flushWaitUntilForTest();
    }

    return {
      actor,
      runnerGroup,
      trackRun(runId: string) {
        trackedRuns.set(runId, undefined);
      },
      trackPendingQueuedInput(threadId: string, clientEventId: string) {
        pendingQueuedInputs.push({ threadId, clientEventId });
      },
      sendChatRun,
      sendWaitingInput,
      runExecution,
      completeRun,
    };
  }

  it(
    "chat-events-bootstrap-prefetch-001 mounts user memory published through the Sandbox API in matching and independent picks",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createLimitedFreeActor();
      const objects = installInMemoryObjectStore(context);

      const initialRun = await chatActor.sendChatRun({
        model: null,
        prompt: "Initialize user memory mount",
      });
      const initialExec = await chatActor.runExecution(initialRun.runId);
      const initialMemory = initialExec.execution.startupInputs.memory;
      expect(initialMemory).not.toBeNull();
      if (!initialMemory) {
        throw new Error("Expected initial Run to mount user Memory");
      }

      const built = buildMemoryArchive([
        {
          path: "MEMORY.md",
          content: "# Prefetch Memory\nRemembered release note\n",
        },
      ]);
      const prepared = await accept(
        webhookStorageClient.storagePrepare({
          headers: initialExec.sandboxHeaders,
          body: {
            runId: initialRun.runId,
            storageId: initialMemory.storageId,
            parentVersionId: initialMemory.versionId,
            files: built.entries,
          },
        }),
        [200],
      );
      expect(prepared.status).toBe(200);
      if (!prepared.body.uploads) {
        throw new Error("Expected storage prepare upload URLs");
      }
      objects.set(prepared.body.uploads.archive.key, built.archive);
      objects.set(prepared.body.uploads.manifest.key, built.manifest);

      const publishedVersionId = prepared.body.versionId;
      const committed = await accept(
        webhookStorageClient.storageCommit({
          headers: initialExec.sandboxHeaders,
          body: {
            runId: initialRun.runId,
            storageId: initialMemory.storageId,
            parentVersionId: initialMemory.versionId,
            versionId: publishedVersionId,
            files: built.entries,
          },
        }),
        [200],
      );
      expect(committed.status).toBe(200);

      await chatActor.completeRun(
        initialRun,
        initialExec.execution,
        initialExec.sandboxHeaders,
      );

      const immediateRun = await chatActor.sendChatRun({
        model: null,
        prompt: "Launch immediately after memory publication",
      });
      const immediateExec = await chatActor.runExecution(immediateRun.runId);

      const waiting = await chatActor.sendWaitingInput({
        threadId: immediateRun.threadId,
        model: null,
        prompt: "Wait on busy thread for independent memory pick",
      });
      await chatActor.completeRun(
        immediateRun,
        immediateExec.execution,
        immediateExec.sandboxHeaders,
      );
      const independentRun = await waiting.launchedRun();
      const independentExec = await chatActor.runExecution(
        independentRun.runId,
      );

      expect(immediateExec.execution.startupInputs.memory).toMatchObject({
        storageId: initialMemory.storageId,
        versionId: publishedVersionId,
      });
      expect(independentExec.execution.startupInputs.memory).toMatchObject({
        storageId: initialMemory.storageId,
        versionId: publishedVersionId,
      });
    },
  );

  it(
    "chat-events-bootstrap-prefetch-002 preserves a non-default member model preference through prefetch and an independent pick",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createLimitedFreeActor({ includeClaude: true });
      const { actor } = chatActor;
      await accept(
        userModelPreferenceClient.update({
          headers: authenticateActor(actor),
          body: { selectedModel: "claude-sonnet-5-5", serviceTier: null },
        }),
        [200],
      );

      const firstRun = await chatActor.sendChatRun({
        prompt: "Initial prompt with saved Sonnet 5.5 preference",
      });
      const firstExec = await chatActor.runExecution(firstRun.runId);

      const waiting = await chatActor.sendWaitingInput({
        threadId: firstRun.threadId,
        prompt: "Queued prompt drained independently",
      });

      await chatActor.completeRun(
        firstRun,
        firstExec.execution,
        firstExec.sandboxHeaders,
      );

      const secondRun = await waiting.launchedRun();
      const secondExec = await chatActor.runExecution(secondRun.runId);

      expect(firstExec.execution.modelUsageProvider).toBe("claude-sonnet-5-5");
      expect(secondExec.execution.modelUsageProvider).toBe("claude-sonnet-5-5");
    },
  );

  it(
    "chat-events-bootstrap-prefetch-010 uses the selected default account for each successive pick",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createLimitedFreeActor();
      const { actor } = chatActor;
      const headers = authenticateActor(actor);

      const firstGranted = await accept(
        builtinManualGrantClient.connect({
          headers,
          params: { connectorSlug: "openai" },
          body: {
            authMethod: "api-token",
            values: { apiKey: "sk-bdd-openai-first-account" },
            account: { intent: "add" },
          },
        }),
        [200],
      );
      const secondGranted = await accept(
        builtinManualGrantClient.connect({
          headers,
          params: { connectorSlug: "openai" },
          body: {
            authMethod: "api-token",
            values: { apiKey: "sk-bdd-openai-second-account" },
            account: { intent: "add" },
          },
        }),
        [200],
      );
      const firstConnectionId = firstGranted.body.connectionId;
      const secondConnectionId = secondGranted.body.connectionId;

      const firstRun = await chatActor.sendChatRun({
        model: null,
        prompt: "First run using initial default OpenAI account",
      });
      const firstExec = await chatActor.runExecution(firstRun.runId);
      await chatActor.completeRun(
        firstRun,
        firstExec.execution,
        firstExec.sandboxHeaders,
      );

      await accept(
        connectorAccountsClient.setDefault({
          headers: authenticateActor(actor),
          params: { connectionId: secondConnectionId },
          body: { target: { kind: "builtin", connectorSlug: "openai" } },
        }),
        [200],
      );

      const secondRun = await chatActor.sendChatRun({
        model: null,
        prompt: "Second run using newly selected default OpenAI account",
      });
      const secondExec = await chatActor.runExecution(secondRun.runId);

      expect(firstExec.execution.secretConnectorMap?.OPENAI_TOKEN).toBe(
        "openai",
      );
      expect(
        firstExec.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: firstConnectionId,
      });
      expect(secondExec.execution.secretConnectorMap?.OPENAI_TOKEN).toBe(
        "openai",
      );
      expect(
        secondExec.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: secondConnectionId,
      });
    },
  );

  it(
    "chat-events-bootstrap-prefetch-008 preserves the queued input and claimable run through web",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const dispatchReceived = createDeferredPromise<void>(context.signal);
      const releaseDispatch = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!releaseDispatch.settled()) {
          releaseDispatch.resolve();
        }
      });

      const chatActor = await createLimitedFreeActor({
        runnerOptions: {
          reply: async (envelope) => {
            if (!dispatchReceived.settled()) {
              dispatchReceived.resolve();
            }
            await releaseDispatch.promise;
            return HttpResponse.json({
              runnerId: envelope.runnerId,
              heartbeatGeneration: envelope.heartbeatGeneration,
              runId: envelope.executionContext.runId,
              disposition: "accepted",
            });
          },
        },
      });
      const { actor } = chatActor;
      const headers = authenticateActor(actor);
      const clientEventId = randomUUID();
      const prompt = "Web prompt preserved before runner claim";

      const sent = await accept(
        chatEventsClient.send({
          headers,
          body: {
            prompt,
            model: null,
            clientEventId,
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: prompt }],
            },
          },
        }),
        [201],
      );
      expect(sent.status).toBe(201);
      const threadId = sent.body.threadId;

      await dispatchReceived.promise;

      const [events, metadata] = await Promise.all([
        listThreadEvents(headers, threadId),
        accept(
          chatThreadMetaClient.get({
            headers,
            params: { id: threadId },
          }),
          [200],
        ),
      ]);

      const replacement = userMessages(events).find((message) => {
        return (
          message.revokesEventId === clientEventId &&
          message.runId !== undefined
        );
      });
      expect(replacement?.runId).toBeDefined();
      const runId = replacement?.runId;
      if (!runId) {
        throw new Error("Expected Run-associated replacement of clientEventId");
      }
      chatActor.trackRun(runId);

      const storedRun = await accept(
        runsByIdClient.getById({
          headers,
          params: { id: runId },
        }),
        [200],
      );

      if (!releaseDispatch.settled()) {
        releaseDispatch.resolve();
      }
      await flushWaitUntilForTest();
      const execution = await chatActor.runExecution(runId);

      expect(storedRun.body.prompt).toBe(prompt);
      expect(metadata.body.id).toBe(threadId);
      expect(okouTokenFromExecution(execution.execution)).toMatch(
        /^vm0_sandbox_/,
      );
    },
  );

  it(
    "chat-events-bootstrap-prefetch-009 preserves the queued input and claimable run through cli",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const dispatchReceived = createDeferredPromise<void>(context.signal);
      const releaseDispatch = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!releaseDispatch.settled()) {
          releaseDispatch.resolve();
        }
      });

      const [chatActor, device] = await Promise.all([
        createLimitedFreeActor({
          runnerOptions: {
            reply: async (envelope) => {
              if (!dispatchReceived.settled()) {
                dispatchReceived.resolve();
              }
              await releaseDispatch.promise;
              return HttpResponse.json({
                runnerId: envelope.runnerId,
                heartbeatGeneration: envelope.heartbeatGeneration,
                runId: envelope.executionContext.runId,
                disposition: "accepted",
              });
            },
          },
        }),
        accept(cliAuthDeviceClient.create({ body: {} }), [200]),
      ]);
      const { actor } = chatActor;
      await accept(
        cliAuthApproveClient.approve({
          headers: authenticateActor(actor),
          body: { device_code: device.body.device_code },
        }),
        [200],
      );
      const exchanged = await accept(
        cliAuthTokenClient.exchange({
          body: { device_code: device.body.device_code },
        }),
        [200],
      );
      const cliHeaders = {
        authorization: `Bearer ${exchanged.body.access_token}`,
      };
      const clientEventId = randomUUID();
      const prompt = "CLI prompt preserved before runner claim";

      const sent = await accept(
        chatEventsClient.send({
          headers: cliHeaders,
          body: {
            prompt,
            model: null,
            clientEventId,
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: prompt }],
            },
          },
        }),
        [201],
      );
      expect(sent.status).toBe(201);
      const threadId = sent.body.threadId;

      await dispatchReceived.promise;

      const [events, metadata] = await Promise.all([
        listThreadEvents(cliHeaders, threadId),
        accept(
          chatThreadMetaClient.get({
            headers: cliHeaders,
            params: { id: threadId },
          }),
          [200],
        ),
      ]);

      const replacement = userMessages(events).find((message) => {
        return (
          message.revokesEventId === clientEventId &&
          message.runId !== undefined
        );
      });
      expect(replacement?.runId).toBeDefined();
      const runId = replacement?.runId;
      if (!runId) {
        throw new Error("Expected Run-associated replacement of clientEventId");
      }
      chatActor.trackRun(runId);

      const storedRun = await accept(
        runsByIdClient.getById({
          headers: cliHeaders,
          params: { id: runId },
        }),
        [200],
      );

      if (!releaseDispatch.settled()) {
        releaseDispatch.resolve();
      }
      await flushWaitUntilForTest();
      const execution = await chatActor.runExecution(runId);

      expect(storedRun.body.prompt).toBe(prompt);
      expect(metadata.body.id).toBe(threadId);
      expect(okouTokenFromExecution(execution.execution)).toMatch(
        /^vm0_sandbox_/,
      );
    },
  );

  it(
    "chat-events-bootstrap-prefetch-011 delivers a steer input to the active authenticated Runner",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createLimitedFreeActor();
      const { actor, runnerGroup } = chatActor;

      const activeRun = await chatActor.sendChatRun({
        model: null,
        prompt: "Active run awaiting steer input",
      });
      const activeExec = await chatActor.runExecution(activeRun.runId);

      const steerClientEventId = randomUUID();
      const steerPrompt = "Focus on the failing integration test first";
      chatActor.trackPendingQueuedInput(activeRun.threadId, steerClientEventId);
      await accept(
        chatEventsClient.send({
          headers: authenticateActor(actor),
          body: {
            threadId: activeRun.threadId,
            model: null,
            prompt: steerPrompt,
            clientEventId: steerClientEventId,
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: steerPrompt }],
            },
          },
        }),
        [201],
      );
      await flushWaitUntilForTest();

      const polled = await accept(
        runnersSteerClient.next({
          headers: activeExec.sandboxHeaders,
          params: { runId: activeRun.runId },
        }),
        [200],
      );

      expect(publishedRealtimeEvents(context.mocks)).toContainEqual({
        channel: `runner-group:${runnerGroup}`,
        topic: "active-input",
        payload: { runId: activeRun.runId },
      });
      expect(polled.body).toStrictEqual({
        input: {
          eventId: steerClientEventId,
          prompt: steerPrompt,
        },
      });
    },
  );
});
