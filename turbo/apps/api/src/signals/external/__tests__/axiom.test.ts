import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runPhaseTimingContract } from "@okouai/api-contracts/contracts/run-phase-timing";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookTelemetryContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { findDocumentTemplateItem } from "@okouai/core/document-template-items";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import {
  array,
  record,
  string,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import {
  apiTestS3PresignedUrl,
  mockAxiomSdkTelemetryFailure,
} from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../../routes/chat-events";
import { featureSwitchesRoutes } from "../../routes/feature-switches";
import { meModelProvidersUpsertRoutes } from "../../routes/me-model-providers-upsert";
import { runPhaseTimingRoutes } from "../../routes/run-phase-timing";
import { runnersRoutes } from "../../routes/runners";
import { runsRoutes } from "../../routes/runs";
import { runsCancelRoutes } from "../../routes/runs-cancel";
import { webhooksAgentCompleteRoutes } from "../../routes/webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../../routes/webhooks-agent-events";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../routes/webhooks-agent-health-usage-telemetry";
import { webhooksClerkRoutes } from "../../routes/webhooks-clerk";
import {
  createBddApi,
  type ApiTestUser,
} from "../../routes/__tests__/helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "../../routes/__tests__/helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "../../routes/__tests__/helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "../../routes/__tests__/helpers/api-bdd-runs";
import { mockClerkUsers } from "../../routes/__tests__/helpers/clerk-users";
import { createRouteMocks } from "../../routes/__tests__/helpers/route-test";
import { settleIncludingAbort } from "../../utils";

type DispatchEnvelope = zInfer<typeof runnerDispatchEnvelopeSchema>;
type RunnerHeartbeatBody = zInfer<
  (typeof runnersHeartbeatContract.heartbeat)["body"]
>;

interface TrackedRun {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly sandboxToken: string;
  done: boolean;
}

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

const CLAUDE_MODEL = "claude-fable-5-1";
const DEFAULT_PROFILE = "vm0/default";
const SIMPLE_INVOICE_TEMPLATE_ID = "document-template:simple-invoice" as const;
const AXIOM_INGEST_URL = "https://api.axiom.co/v1/datasets/:dataset/ingest";

const axiomEventsBodySchema = array(record(string(), zUnknown()));

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const routeMocks = createRouteMocks(context);

const webhooksClerkApi = setupApp({
  context,
  routes: webhooksClerkRoutes,
})(webhookClerkContract);
const personalModelProvidersApi = setupApp({
  context,
  routes: meModelProvidersUpsertRoutes,
})(personalModelProvidersMainContract);
const featureSwitchesApi = setupApp({
  context,
  routes: featureSwitchesRoutes,
})(featureSwitchesContract);
const chatEventsApi = setupApp({
  context,
  routes: chatEventsRoutes,
})(chatEventsContract);
const runnersHeartbeatApi = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const runsByIdApi = setupApp({
  context,
  routes: runsRoutes,
})(runsByIdContract);
const runsCancelApi = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);
const runPhaseTimingApi = setupApp({
  context,
  routes: runPhaseTimingRoutes,
})(runPhaseTimingContract);
const webhooksAgentCompleteApi = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const webhooksAgentEventsApi = setupApp({
  context,
  routes: webhooksAgentEventsRoutes,
})(webhookEventsContract);
const webhooksAgentTelemetryApi = setupApp({
  context,
  routes: webhooksAgentHealthUsageTelemetryRoutes,
})(webhookTelemetryContract);

function officialRunnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function signIn(actor: ApiTestUser): void {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "BDD",
      lastName: "Axiom",
    },
  ]);
  const memberships = actor.orgId
    ? [
        {
          id: `membership-${actor.userId}-${actor.orgId}`,
          createdAt: Date.parse("2020-01-01T00:00:00.000Z"),
          role: actor.orgRole ?? "org:admin",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ]
    : [];
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: memberships,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: memberships,
    },
  );
}

function initRuntimeMocks(): void {
  chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
}

function heartbeatPayload(args: {
  readonly runnerId: string;
  readonly runnerHostname: string;
  readonly group: string;
}): RunnerHeartbeatBody {
  return {
    runnerId: args.runnerId,
    runnerHostname: args.runnerHostname,
    group: args.group,
    snapshotGeneration: 1,
    snapshotSequence: 1,
    totalVcpu: 16,
    totalMemoryMb: 32_768,
    maxConcurrent: 4,
    allocatedVcpu: 0,
    allocatedMemoryMb: 0,
    runningCount: 0,
    admittableProfiles: [DEFAULT_PROFILE],
    heldSandboxStates: [],
    heldHomeStates: [],
    activeReuseProducers: [],
    mode: "running",
    ingressServiceActive: true,
  };
}

function createRunTracker() {
  const tracked: TrackedRun[] = [];

  onTestFinished(async () => {
    clearMockNow();
    const pendingEntries = tracked.filter((entry) => {
      return !entry.done;
    });
    if (pendingEntries.length === 0) {
      await flushWaitUntilForTest();
      return;
    }
    initRuntimeMocks();
    context.mocks.s3.getSignedUrl.mockImplementation(
      (_client: unknown, command: unknown) => {
        return Promise.resolve(apiTestS3PresignedUrl(command));
      },
    );
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const errors: unknown[] = [];
    const initialFlush = await settleIncludingAbort(flushWaitUntilForTest);
    if (!initialFlush.ok) {
      errors.push(initialFlush.error);
    }
    const pendingCompletions: Promise<unknown>[] = [];
    for (const entry of pendingEntries) {
      const cleaned = await settleIncludingAbort(async () => {
        signIn(entry.actor);
        const current = await accept(
          runsByIdApi.getById({
            headers: SESSION_HEADERS,
            params: { id: entry.runId },
          }),
          [200],
        );
        if (["queued", "pending", "running"].includes(current.body.status)) {
          await accept(
            runsCancelApi.cancel({
              headers: SESSION_HEADERS,
              params: { id: entry.runId },
            }),
            [200],
          );
        }
        if (!["completed", "failed", "timeout"].includes(current.body.status)) {
          pendingCompletions.push(
            accept(
              webhooksAgentCompleteApi.complete({
                headers: bearerHeaders(entry.sandboxToken),
                body: {
                  runId: entry.runId,
                  exitCode: 137,
                  error: "Run cancelled by test cleanup",
                },
              }),
              [200],
            ),
          );
        }
        entry.done = true;
      });
      if (!cleaned.ok) {
        errors.push(cleaned.error);
      }
    }
    if (pendingCompletions.length > 0) {
      const completed = await settleIncludingAbort(() => {
        return Promise.all(pendingCompletions);
      });
      if (!completed.ok) {
        errors.push(completed.error);
      }
    }
    const finalFlush = await settleIncludingAbort(flushWaitUntilForTest);
    if (!finalFlush.ok) {
      errors.push(finalFlush.error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Axiom transport test cleanup failed");
    }
  });

  return {
    track(actor: ApiTestUser, runId: string, sandboxToken: string): TrackedRun {
      const entry: TrackedRun = { actor, runId, sandboxToken, done: false };
      tracked.push(entry);
      return entry;
    },
  };
}

function createDirectRunnerHarness(group: string) {
  const acceptedByRunId = new Map<string, ExecutionContext>();
  const acceptedOrder: string[] = [];

  async function register(): Promise<void> {
    const runnerId = randomUUID();
    const heartbeatGeneration = 1;
    const hostname = `runner-${runnerId}.okou.app`;
    const expectedAuth = officialRunnerHeaders().authorization;

    server.use(
      http.post(
        `https://${hostname}/runners/${runnerId}/control/runs/:runId/dispatch`,
        async ({ request, params }) => {
          if (request.headers.get("authorization") !== expectedAuth) {
            return new HttpResponse(null, { status: 401 });
          }
          const encoding = request.headers.get("content-encoding");
          const rawBytes = Buffer.from(await request.arrayBuffer());
          const bytes =
            encoding === "gzip"
              ? gunzipSync(rawBytes).toString("utf8")
              : rawBytes.toString("utf8");
          const envelope: DispatchEnvelope = runnerDispatchEnvelopeSchema.parse(
            JSON.parse(bytes),
          );
          if (
            envelope.runnerId !== runnerId ||
            envelope.heartbeatGeneration !== heartbeatGeneration ||
            envelope.executionContext.runId !== params.runId
          ) {
            throw new Error("Unexpected direct Runner dispatch identity");
          }
          acceptedByRunId.set(
            envelope.executionContext.runId,
            envelope.executionContext,
          );
          acceptedOrder.push(envelope.executionContext.runId);
          return HttpResponse.json({
            runnerId,
            heartbeatGeneration,
            runId: envelope.executionContext.runId,
            disposition: "accepted",
          });
        },
      ),
    );

    await accept(
      runnersHeartbeatApi.heartbeat({
        headers: officialRunnerHeaders(),
        body: heartbeatPayload({
          runnerId,
          runnerHostname: hostname,
          group,
        }),
      }),
      [200],
    );
  }

  function nextAccepted(afterIndex: number): ExecutionContext {
    const runId = acceptedOrder[afterIndex];
    if (!runId) {
      throw new Error("Expected a direct Runner dispatch to be accepted");
    }
    const execution = acceptedByRunId.get(runId);
    if (!execution) {
      throw new Error(`Missing captured execution context for run ${runId}`);
    }
    return execution;
  }

  return {
    register,
    acceptedCount: () => {
      return acceptedOrder.length;
    },
    nextAccepted,
  };
}

async function provisionOrg(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected a workspace actor");
  }
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
  context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
    type: "organization.created",
    data: { id: actor.orgId, created_by: actor.userId, created_at: now() },
  });
  await accept(webhooksClerkApi.post({ body: "{}", extraHeaders: {} }), [200]);
  await flushWaitUntilForTest();
}

async function addPersonalClaudeProvider(actor: ApiTestUser): Promise<void> {
  signIn(actor);
  await accept(
    personalModelProvidersApi.upsert({
      headers: SESSION_HEADERS,
      body: {
        type: "claude-code-oauth-token",
        secret: `claude-token-${randomUUID()}`,
      },
    }),
    [201],
  );
}

async function setupNativeRunMember(
  options: {
    readonly featureSwitches?: Readonly<Record<string, boolean>>;
  } = {},
) {
  const tracker = createRunTracker();
  const actor = bdd.user();
  const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;

  initRuntimeMocks();
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
  mockClaudeCodeTokenEndpoint();
  signIn(actor);

  const runner = createDirectRunnerHarness(group);

  await Promise.all([
    runner.register(),
    provisionOrg(actor),
    addPersonalClaudeProvider(actor),
    ...(options.featureSwitches
      ? [
          accept(
            featureSwitchesApi.update({
              headers: SESSION_HEADERS,
              body: { switches: options.featureSwitches },
            }),
            [200],
          ),
        ]
      : []),
  ]);

  async function launchChatRun(args: {
    readonly prompt: string;
    readonly userMessage?: UserMessageInputDocument;
  }) {
    const beforeCount = runner.acceptedCount();
    const clientEventId = randomUUID();
    signIn(actor);
    const sent = await accept(
      chatEventsApi.send({
        headers: SESSION_HEADERS,
        body: {
          prompt: args.prompt,
          hasTextContent: true,
          clientEventId,
          model: CLAUDE_MODEL,
          userMessage: args.userMessage ?? {
            version: 1,
            parts: [{ type: "text", text: args.prompt }],
          },
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    const execution = runner.nextAccepted(beforeCount);
    const trackedEntry = tracker.track(
      actor,
      execution.runId,
      execution.sandboxToken,
    );
    return {
      threadId: sent.body.threadId,
      runId: execution.runId,
      execution,
      trackedEntry,
    };
  }

  async function readRun(runId: string) {
    signIn(actor);
    const response = await accept(
      runsByIdApi.getById({
        headers: SESSION_HEADERS,
        params: { id: runId },
      }),
      [200],
    );
    return response.body;
  }

  async function completeClaudeRun(
    launched: Awaited<ReturnType<typeof launchChatRun>>,
    options: { readonly flush?: boolean } = {},
  ) {
    const headers = bearerHeaders(launched.execution.sandboxToken);
    const sessionId = `axiom-session-${launched.runId}`;
    await accept(
      webhooksAgentEventsApi.send({
        headers,
        body: {
          runId: launched.runId,
          events: [
            {
              type: "result",
              result: "Completed report deliverable.",
              sequenceNumber: 0,
            },
          ],
        },
      }),
      [200],
    );
    await accept(
      webhooksAgentCompleteApi.complete({
        headers,
        body: {
          runId: launched.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: sessionId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
      }),
      [200],
    );
    if (options.flush !== false) {
      await flushWaitUntilForTest();
    }
    launched.trackedEntry.done = true;
  }

  return {
    actor,
    launchChatRun,
    readRun,
    completeClaudeRun,
  };
}

function captureDirectAxiomIngest(
  options: {
    readonly targetDataset?: string;
    readonly respond?: (
      dataset: string,
      events: readonly Record<string, unknown>[],
    ) => Response;
  } = {},
) {
  const deliveries: {
    readonly dataset: string;
    readonly events: readonly Record<string, unknown>[];
  }[] = [];

  server.use(
    http.post(AXIOM_INGEST_URL, async ({ params, request }) => {
      const dataset =
        typeof params.dataset === "string"
          ? decodeURIComponent(params.dataset)
          : "";
      const parsed = axiomEventsBodySchema.parse(await request.json());
      if (
        options.targetDataset === undefined ||
        dataset === options.targetDataset
      ) {
        deliveries.push({ dataset, events: parsed });
      }
      if (options.respond) {
        return options.respond(dataset, parsed);
      }
      return HttpResponse.json({
        ingested: parsed.length,
        failed: 0,
        processedBytes: 256,
      });
    }),
  );

  return deliveries;
}

describe("Axiom telemetry and run observation transport", () => {
  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    runnerDispatchEnvelopeSchema.safeParse({});
    const warmed = await settleIncludingAbort(async () => {
      await Promise.all([
        accept(webhooksClerkApi.post({ body: "{}", extraHeaders: {} }), [401]),
        accept(
          personalModelProvidersApi.upsert({
            headers: {},
            body: { type: "claude-code-oauth-token", secret: "warmup" },
          }),
          [401],
        ),
        accept(
          featureSwitchesApi.update({
            headers: {},
            body: {
              switches: { [FeatureSwitchKey.ArtifactThreePointTiming]: false },
            },
          }),
          [401],
        ),
        accept(
          chatEventsApi.send({
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
          runnersHeartbeatApi.heartbeat({
            headers: {},
            body: heartbeatPayload({
              runnerId: warmupId,
              runnerHostname: `runner-${warmupId}.okou.app`,
              group: "vm0/warmup",
            }),
          }),
          [401],
        ),
        accept(
          runsByIdApi.getById({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runsCancelApi.cancel({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runPhaseTimingApi.mark({
            headers: {},
            body: { phase: "research-start" },
          }),
          [401],
        ),
        accept(
          webhooksAgentCompleteApi.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
          }),
          [401],
        ),
        accept(
          webhooksAgentEventsApi.send({
            headers: {},
            body: {
              runId: warmupId,
              events: [{ type: "system", sequenceNumber: 0 }],
            },
          }),
          [401],
        ),
        accept(
          webhooksAgentTelemetryApi.send({
            headers: {},
            body: {},
          }),
          [400],
        ),
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  it(
    "axiom-001 preserves independent filesystem samples through the metrics HTTP transport",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const deliveries = captureDirectAxiomIngest({
        targetDataset: "sandbox-telemetry-metrics",
      });

      const launched = await setup.launchChatRun({
        prompt: "Collect filesystem metrics samples",
      });

      const sampleTs = nowDate().toISOString();
      const validRootfs = {
        used_bytes: 1000,
        total_bytes: 4000,
        available_bytes: 3000,
        used_inodes: 100,
        total_inodes: 500,
        available_inodes: 400,
      };
      const validHome = {
        used_bytes: 2000,
        total_bytes: 8000,
        available_bytes: 6000,
        used_inodes: 200,
        total_inodes: 900,
        available_inodes: 700,
      };
      const invalidNegativeFs = {
        used_bytes: -1,
        total_bytes: 4000,
        available_bytes: 3000,
        used_inodes: 100,
        total_inodes: 500,
        available_inodes: 400,
      };

      const response = await accept(
        webhooksAgentTelemetryApi.send({
          headers: bearerHeaders(launched.execution.sandboxToken),
          body: {
            runId: launched.runId,
            metrics: [
              {
                ts: sampleTs,
                cpu: 10,
                mem_used: 128,
                mem_total: 1024,
                rootfs: validRootfs,
                home: validHome,
              },
              {
                ts: sampleTs,
                cpu: 20,
                mem_used: 256,
                mem_total: 1024,
                rootfs: validRootfs,
              },
              {
                ts: sampleTs,
                cpu: 30,
                mem_used: 384,
                mem_total: 1024,
                home: validHome,
              },
              {
                ts: sampleTs,
                cpu: 40,
                mem_used: 512,
                mem_total: 1024,
              },
              {
                ts: sampleTs,
                cpu: 50,
                mem_used: 640,
                mem_total: 1024,
                rootfs: validRootfs,
                home: invalidNegativeFs,
              },
              {
                ts: sampleTs,
                cpu: 60,
                mem_used: 768,
                mem_total: 1024,
                rootfs: invalidNegativeFs,
                home: validHome,
              },
            ],
          },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        success: true,
        id: launched.runId,
      });

      const rootfsFields = {
        rootfs_used_bytes: validRootfs.used_bytes,
        rootfs_total_bytes: validRootfs.total_bytes,
        rootfs_available_bytes: validRootfs.available_bytes,
        rootfs_used_inodes: validRootfs.used_inodes,
        rootfs_total_inodes: validRootfs.total_inodes,
        rootfs_available_inodes: validRootfs.available_inodes,
      };
      const homeFields = {
        home_used_bytes: validHome.used_bytes,
        home_total_bytes: validHome.total_bytes,
        home_available_bytes: validHome.available_bytes,
        home_used_inodes: validHome.used_inodes,
        home_total_inodes: validHome.total_inodes,
        home_available_inodes: validHome.available_inodes,
      };
      const baseSample = (cpu: number, memUsed: number) => {
        return {
          _time: sampleTs,
          runId: launched.runId,
          userId: setup.actor.userId,
          cpu,
          mem_used: memUsed,
          mem_total: 1024,
        };
      };

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.events).toStrictEqual([
        { ...baseSample(10, 128), ...rootfsFields, ...homeFields },
        { ...baseSample(20, 256), ...rootfsFields },
        { ...baseSample(30, 384), ...homeFields },
        baseSample(40, 512),
        { ...baseSample(50, 640), ...rootfsFields },
        { ...baseSample(60, 768), ...homeFields },
      ]);
    },
  );

  it(
    "axiom-008 writes the authenticated stage timeline with callback provenance (skipResearch=false)",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const deliveries = captureDirectAxiomIngest({
        targetDataset: "web-logs",
      });

      const launched = await setup.launchChatRun({
        prompt: "Write a market report with three-point phase marks",
      });
      // Upstream #50973 enabled ArtifactThreePointTiming by default for everyone.
      expect(launched.execution.appendSystemPrompt ?? "").toContain(
        "okou run mark",
      );

      const okouToken = launched.execution.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected Run OKOU_TOKEN in platformEnvironment");
      }

      const baseMs = Math.floor(now() / 1000) * 1000;

      mockNow(baseMs + 1000);
      const researchTime = nowDate().toISOString();
      const researchMark = await accept(
        runPhaseTimingApi.mark({
          headers: bearerHeaders(okouToken),
          body: { phase: "research-start" },
        }),
        [202],
      );
      expect(researchMark.body).toStrictEqual({
        schemaVersion: 2,
        status: "accepted",
      });

      mockNow(baseMs + 2000);
      const generationTime = nowDate().toISOString();
      const generationMark = await accept(
        runPhaseTimingApi.mark({
          headers: bearerHeaders(okouToken),
          body: {
            phase: "generation-start",
            kind: "report",
            skipResearch: false,
          },
        }),
        [202],
      );
      expect(generationMark.body).toStrictEqual({
        schemaVersion: 2,
        status: "accepted",
      });

      mockNow(baseMs + 3000);
      const completionTime = nowDate().toISOString();
      await setup.completeClaudeRun(launched);

      const phaseEvents = deliveries
        .flatMap((delivery) => {
          return delivery.events;
        })
        .filter((event) => {
          return event.type === "run_phase_mark";
        });

      const sharedIdentity = {
        schema_version: 2,
        type: "run_phase_mark",
        source: "callback",
        run_id: launched.runId,
        user_id: setup.actor.userId,
        org_id: setup.actor.orgId,
      };
      expect(phaseEvents).toStrictEqual([
        {
          ...sharedIdentity,
          _time: researchTime,
          phase: "research-start",
        },
        {
          ...sharedIdentity,
          _time: generationTime,
          phase: "generation-start",
          generation_kind: "report",
          research_skipped: false,
        },
        {
          ...sharedIdentity,
          _time: completionTime,
          phase: "completion-callback",
        },
      ]);
    },
  );

  it(
    "axiom-014 suppresses collection while preserving normal completion for owner opt-out",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember({
        featureSwitches: {
          [FeatureSwitchKey.ArtifactThreePointTiming]: false,
        },
      });
      const deliveries = captureDirectAxiomIngest({
        targetDataset: "web-logs",
      });

      const launched = await setup.launchChatRun({
        prompt: "Create a report after opting out of three-point timing",
      });
      expect(launched.execution.appendSystemPrompt ?? "").not.toContain(
        "okou run mark",
      );

      const okouToken = launched.execution.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected Run OKOU_TOKEN in platformEnvironment");
      }

      const [researchMark, generationMark] = await Promise.all([
        accept(
          runPhaseTimingApi.mark({
            headers: bearerHeaders(okouToken),
            body: { phase: "research-start" },
          }),
          [404],
        ),
        accept(
          runPhaseTimingApi.mark({
            headers: bearerHeaders(okouToken),
            body: {
              phase: "generation-start",
              kind: "report",
              skipResearch: false,
            },
          }),
          [404],
        ),
      ]);
      expect(researchMark.headers.get("cache-control")).toBe("no-store");
      expect(generationMark.headers.get("cache-control")).toBe("no-store");

      await setup.completeClaudeRun(launched, { flush: false });

      const [, completed] = await Promise.all([
        flushWaitUntilForTest(),
        setup.readRun(launched.runId),
      ]);
      expect(completed.status).toBe("completed");
      expect(deliveries).toStrictEqual([]);
    },
  );

  it(
    "axiom-023 keeps normal completion successful when the telemetry provider is unavailable",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const deliveries = captureDirectAxiomIngest({
        targetDataset: "web-logs",
        respond: () => {
          return HttpResponse.json(
            { message: "telemetry provider temporarily unavailable" },
            { status: 503 },
          );
        },
      });

      const launched = await setup.launchChatRun({
        prompt: "Complete normally when Axiom returns HTTP 503",
      });
      await setup.completeClaudeRun(launched, { flush: false });

      const [, completed] = await Promise.all([
        flushWaitUntilForTest(),
        setup.readRun(launched.runId),
      ]);
      expect(completed.status).toBe("completed");
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.events).toMatchObject([
        {
          type: "run_phase_mark",
          phase: "completion-callback",
          run_id: launched.runId,
        },
      ]);
    },
  );

  it(
    "log-axiom-transport-026 preserves a created template run when Axiom ingestion fails",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const invoiceItem = findDocumentTemplateItem(SIMPLE_INVOICE_TEMPLATE_ID);
      if (!invoiceItem) {
        throw new Error("Expected simple-invoice built-in document template");
      }

      const setup = await setupNativeRunMember();
      mockAxiomSdkTelemetryFailure({
        mode: "ingest",
        datasets: ["vm0-web-logs-dev"],
        eventTypes: ["template_used"],
      });

      const prompt = "Generate an invoice for ACME Consulting.";
      const launched = await setup.launchChatRun({
        prompt,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "template",
              titleSnapshot: invoiceItem.title,
              template: {
                type: "document",
                selection: { documentTemplateId: SIMPLE_INVOICE_TEMPLATE_ID },
              },
            },
            { type: "text", text: prompt },
          ],
        },
      });

      const currentRun = await setup.readRun(launched.runId);
      expect(currentRun.status).toBe("running");
      expect(launched.execution.appendSystemPrompt ?? "").toContain(
        "Selected document template:",
      );
    },
  );
});
