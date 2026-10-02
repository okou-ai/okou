import { createHash, randomUUID } from "node:crypto";

import type { CronCleanupSandboxesResponse } from "@okouai/api-contracts/contracts/cron";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import {
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
  CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
  runnersConnectorRuntimeSyncContract,
} from "@okouai/api-contracts/contracts/runners";
import {
  testCronCleanupSandboxesStateContract,
  type TestCronCleanupSandboxesStateActionBody,
  type TestCronCleanupSandboxesStateActionResponse,
  type TestCronCleanupSandboxesScope,
} from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { generateSandboxToken } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { readHistoryBlobReferenceCountFixture } from "../../../test-fixtures/run-deletion";
import {
  deleteUsagePricingRows,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createFixtureTracker } from "./helpers/route-test";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { runnersRoutes } from "../runners";

const context = testContext({ connectorCatalog: true });
const webhooks = createWebhookCallbackApi(context);
const {
  api,
  chat,
  chatCallbacks,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
} = createChatEventsFixture(context);
const BUCKET = "test-user-storage-bucket";
const FIXED_NOW_MS = Date.parse("2000-01-01T00:10:00.000Z");
const THREADLESS_FORWARD_CUTOFF_MS = Date.parse("2026-08-03T05:40:26.000Z");
const THREADLESS_TEST_NOW_MS = Date.parse("2026-08-03T06:00:00.000Z");
const CRON_CLEANUP_STATE_ROUTE =
  "/api/test/cron-cleanup-sandboxes-state/action";
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

interface RunFixture {
  readonly runId: string;
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly composeId: string;
  readonly orgId: string;
  readonly userId: string;
}

interface ExportJobFixture {
  readonly id: string;
}

interface RunOwnershipFixture {
  readonly usageEventId: string;
  readonly uploadedFileId: string;
  readonly fileArtifactId: string;
  readonly browserSessionId: string;
  readonly generationJobId: string;
  readonly hostedSiteId: string;
  readonly hostedDeploymentId: string;
  readonly hostedArtifactId: string;
}

function minutesAgo(minutes: number): Date {
  return new Date(FIXED_NOW_MS - minutes * 60 * 1000);
}

function requestCronCleanupState(
  body: TestCronCleanupSandboxesStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testCronCleanupSandboxesStateRoutes,
  });
  return Promise.resolve(
    app.request(CRON_CLEANUP_STATE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function postCronCleanupState(
  body: TestCronCleanupSandboxesStateActionBody,
): Promise<TestCronCleanupSandboxesStateActionResponse> {
  const response = await requestCronCleanupState(body);
  if (!response.ok) {
    throw new Error(`cron cleanup state action failed with ${response.status}`);
  }
  return await readJson<TestCronCleanupSandboxesStateActionResponse>(response);
}

async function cleanupScopedSandboxes(
  scope: TestCronCleanupSandboxesScope,
): Promise<CronCleanupSandboxesResponse> {
  const response = await accept(
    setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
      testCronCleanupSandboxesStateContract,
    ).cleanup({ body: scope }),
    [200],
  );
  return response.body;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new Error(`cron cleanup state response missing ${key}`);
  }
  return value;
}

function recordField(
  body: TestCronCleanupSandboxesStateActionResponse,
  key: string,
): Record<string, unknown> | null {
  const value = body[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function cleanupRunFixture(fixture: RunFixture): Promise<void> {
  await postCronCleanupState({
    action: "delete-run",
    run_id: fixture.runId,
    session_id: fixture.sessionId,
    compose_id: fixture.composeId,
    org_id: fixture.orgId,
  });
}

async function cleanupExportJobFixture(
  fixture: ExportJobFixture,
): Promise<void> {
  await postCronCleanupState({
    action: "delete-export-job",
    export_job_id: fixture.id,
  });
}

function ownershipActionFields(
  fixture: RunOwnershipFixture,
): Record<string, string> {
  return {
    usage_event_id: fixture.usageEventId,
    uploaded_file_id: fixture.uploadedFileId,
    file_artifact_id: fixture.fileArtifactId,
    browser_session_id: fixture.browserSessionId,
    generation_job_id: fixture.generationJobId,
    hosted_site_id: fixture.hostedSiteId,
    hosted_deployment_id: fixture.hostedDeploymentId,
    hosted_artifact_id: fixture.hostedArtifactId,
  };
}

async function cleanupRunOwnershipFixture(
  fixture: RunOwnershipFixture,
): Promise<void> {
  await postCronCleanupState({
    action: "delete-run-ownership",
    ...ownershipActionFields(fixture),
  });
}

async function insertRunFixture(args?: {
  readonly status?: string;
  readonly composeName?: string;
  readonly createdAt?: Date;
  readonly lastHeartbeatAt?: Date;
  readonly completedAt?: Date | null;
  readonly cancellationRecoveryCompleted?: boolean;
  readonly threadless?: boolean;
  readonly checkpointReady?: boolean;
  readonly triggerSource?: TriggerSource;
  readonly userId?: string;
  readonly orgId?: string;
  readonly runnerGroup?: string;
}): Promise<RunFixture> {
  const fixture: NonNullable<typeof args> = args ?? {};
  const response = await postCronCleanupState({
    action: "seed-run",
    status: fixture.status,
    compose_name: fixture.composeName,
    created_at: fixture.createdAt?.toISOString(),
    last_heartbeat_at: fixture.lastHeartbeatAt?.toISOString(),
    completed_at:
      fixture.completedAt === undefined
        ? undefined
        : (fixture.completedAt?.toISOString() ?? null),
    cancellation_recovery_completed: fixture.cancellationRecoveryCompleted,
    threadless: fixture.threadless,
    checkpoint_ready: fixture.checkpointReady,
    trigger_source: fixture.triggerSource,
    user_id: fixture.userId,
    org_id: fixture.orgId,
    runner_group: fixture.runnerGroup,
  });
  return {
    runId: stringField(response, "run_id"),
    sandboxId: stringField(response, "sandbox_id"),
    sessionId: stringField(response, "session_id"),
    composeId: stringField(response, "compose_id"),
    orgId: stringField(response, "org_id"),
    userId: stringField(response, "user_id"),
  };
}

async function insertRunOwnership(
  fixture: RunFixture,
): Promise<RunOwnershipFixture> {
  const response = await postCronCleanupState({
    action: "seed-run-ownership",
    run_id: fixture.runId,
  });
  return {
    usageEventId: stringField(response, "usage_event_id"),
    uploadedFileId: stringField(response, "uploaded_file_id"),
    fileArtifactId: stringField(response, "file_artifact_id"),
    browserSessionId: stringField(response, "browser_session_id"),
    generationJobId: stringField(response, "generation_job_id"),
    hostedSiteId: stringField(response, "hosted_site_id"),
    hostedDeploymentId: stringField(response, "hosted_deployment_id"),
    hostedArtifactId: stringField(response, "hosted_artifact_id"),
  };
}

async function findRunOwnership(
  fixture: RunOwnershipFixture,
): Promise<TestCronCleanupSandboxesStateActionResponse> {
  return await postCronCleanupState({
    action: "get-run-ownership",
    ...ownershipActionFields(fixture),
  });
}

async function insertExportJob(args: {
  readonly status: string;
  readonly createdAt?: Date;
  readonly expiresAt?: Date | null;
  readonly s3Key?: string | null;
}): Promise<ExportJobFixture> {
  const response = await postCronCleanupState({
    action: "seed-export-job",
    status: args.status,
    created_at: args.createdAt?.toISOString(),
    expires_at:
      args.expiresAt === undefined
        ? undefined
        : (args.expiresAt?.toISOString() ?? null),
    s3_key: args.s3Key ?? undefined,
  });
  return { id: stringField(response, "export_job_id") };
}

async function findRun(runId: string): Promise<{
  readonly status: string;
  readonly error: string | null;
} | null> {
  const response = await postCronCleanupState({
    action: "get-run",
    run_id: runId,
  });
  const row = recordField(response, "run");
  return row
    ? { status: stringField(row, "status"), error: nullableString(row.error) }
    : null;
}

async function findExportJob(jobId: string): Promise<{
  readonly status: string;
  readonly error: string | null;
} | null> {
  const response = await postCronCleanupState({
    action: "get-export-job",
    export_job_id: jobId,
  });
  const row = recordField(response, "export_job");
  return row
    ? { status: stringField(row, "status"), error: nullableString(row.error) }
    : null;
}

describe("sandbox cleanup", () => {
  const trackRunForTeardown =
    createFixtureTracker<RunFixture>(cleanupRunFixture);
  const trackExportJobForTeardown = createFixtureTracker<ExportJobFixture>(
    cleanupExportJobFixture,
  );
  const trackRunOwnership = createFixtureTracker<RunOwnershipFixture>(
    cleanupRunOwnershipFixture,
  );
  let registeredRunIds: string[] = [];
  let registeredExportJobIds: string[] = [];

  async function trackRun(
    fixturePromise: Promise<RunFixture>,
  ): Promise<RunFixture> {
    const fixture = await trackRunForTeardown(fixturePromise);
    registeredRunIds.push(fixture.runId);
    return fixture;
  }

  async function trackExportJob(
    fixturePromise: Promise<ExportJobFixture>,
  ): Promise<ExportJobFixture> {
    const fixture = await trackExportJobForTeardown(fixturePromise);
    registeredExportJobIds.push(fixture.id);
    return fixture;
  }

  async function cleanupRegisteredFixtures(): Promise<{
    readonly body: CronCleanupSandboxesResponse;
  }> {
    return {
      body: await cleanupScopedSandboxes({
        chatThreadIds: [],
        runIds: [...registeredRunIds],
        exportJobIds: [...registeredExportJobIds],
      }),
    };
  }

  beforeEach(() => {
    registeredRunIds = [];
    registeredExportJobIds = [];
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    mockNow(FIXED_NOW_MS);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  afterEach(() => {
    clearMockNow();
  });

  it("returns an empty cleanup result for an empty fixture scope", async () => {
    const response = await cleanupRegisteredFixtures();

    expect(response.body).toStrictEqual({
      cleaned: 0,
      errors: 0,
      results: [],
      exportJobsCleaned: 0,
      exportJobsStuck: 0,
      threadlessRuns: {
        discovered: 0,
        cancelled: 0,
        waiting: 0,
        deleted: 0,
        failed: 0,
        errors: [],
      },
    });
  });

  it("leaves the audited pre-forward threadless cohort discoverable", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS - 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
        ),
        threadless: true,
      }),
    );
    const response = await cleanupRegisteredFixtures();

    expect(response.body.threadlessRuns.discovered).toBe(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("ignores preview-only test fixture runs without bypassing non-test runs", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
        ),
        threadless: true,
        triggerSource: "test",
      }),
    );

    const response = await cleanupRegisteredFixtures();

    expect(response.body.threadlessRuns.discovered).toBe(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("releases a checkpoint history reference through the bounded threadless sweep", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "failed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
        ),
        threadless: true,
        checkpointReady: true,
      }),
    );
    const hash = createHash("sha256")
      .update(`bdd session history ${fixture.runId}`)
      .digest("hex");
    await webhooks.requestAgentCheckpoint(
      {
        runId: fixture.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: fixture.runId,
        cliAgentSessionHistoryHash: hash,
      },
      {
        authorization: `Bearer ${generateSandboxToken(fixture.userId, fixture.runId, fixture.orgId)}`,
      },
      [200],
    );
    // The maintenance clock/eligibility fixture and exact ledger inspection
    // are infrastructure-only; checkpoint persistence and the sweep are real.
    await expect(readHistoryBlobReferenceCountFixture(hash)).resolves.toBe(1);
    const response = await cleanupRegisteredFixtures();
    expect(response.body.threadlessRuns.deleted).toBe(1);
    await expect(findRun(fixture.runId)).resolves.toBeNull();
    await expect(readHistoryBlobReferenceCountFixture(hash)).resolves.toBe(0);
    await cleanupRegisteredFixtures();
    await expect(readHistoryBlobReferenceCountFixture(hash)).resolves.toBe(0);
  });

  it("cascades run-owned artifacts while preserving independent ownership", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
        ),
        threadless: true,
      }),
    );
    const usageProvider = `cleanup-test-${fixture.runId}`;
    await seedUsagePricingRows([
      {
        kind: "model",
        provider: usageProvider,
        category: "tokens.input",
        unitPrice: 9,
        unitSize: 1,
      },
    ]);
    onTestFinished(async () => {
      await deleteUsagePricingRows({
        kind: "model",
        provider: usageProvider,
        categories: ["tokens.input"],
      });
    });
    const ownership = await trackRunOwnership(insertRunOwnership(fixture));

    const response = await cleanupRegisteredFixtures();

    expect(response.body.threadlessRuns.discovered).toBe(1);
    expect(response.body.threadlessRuns.deleted).toBe(1);
    const state = await findRunOwnership(ownership);
    expect(recordField(state, "uploaded_file")).toBeNull();
    expect(recordField(state, "file_artifact")).toBeNull();
    expect(recordField(state, "usage_event")).toMatchObject({
      runId: null,
      status: "processed",
      creditsCharged: 9,
    });
    expect(recordField(state, "browser_session")).toMatchObject({
      id: ownership.browserSessionId,
      runId: null,
    });
    expect(recordField(state, "generation_job")).toMatchObject({
      id: ownership.generationJobId,
      runId: null,
    });
    expect(recordField(state, "hosted_site")).toMatchObject({
      id: ownership.hostedSiteId,
      createdFromRunId: fixture.runId,
    });
    expect(recordField(state, "hosted_deployment")).toMatchObject({
      id: ownership.hostedDeploymentId,
      runId: fixture.runId,
    });
    expect(recordField(state, "hosted_artifact")).toStrictEqual({
      id: ownership.hostedArtifactId,
    });
  });

  it("keeps debug compose runs until the debug heartbeat timeout", async () => {
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        composeName: `debug-${randomUUID()}`,
        createdAt: minutesAgo(1),
        lastHeartbeatAt: minutesAgo(30),
      }),
    );

    const response = await cleanupRegisteredFixtures();

    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "running",
      error: null,
    });
  });

  it.each(["request rejection", "per-key error"] as const)(
    "preserves expired export jobs for retry when S3 deletion returns a %s",
    async (failure) => {
      const s3Key = `exports/${randomUUID()}.zip`;
      const expiredJob = await trackExportJob(
        insertExportJob({
          status: "completed",
          createdAt: minutesAgo(30),
          expiresAt: minutesAgo(1),
          s3Key,
        }),
      );
      if (failure === "request rejection") {
        context.mocks.s3.send.mockRejectedValueOnce(
          new Error("S3 request failed"),
        );
      } else {
        context.mocks.s3.send.mockResolvedValueOnce({
          Errors: [{ Key: s3Key, Code: "AccessDenied" }],
        });
      }

      const app = createAppWithRoutes({
        signal: context.signal,
        routes: testCronCleanupSandboxesStateRoutes,
      });
      const failed = await app.request(
        "/api/test/cron-cleanup-sandboxes-state/cleanup",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chatThreadIds: [],
            runIds: [],
            exportJobIds: [expiredJob.id],
          }),
        },
      );

      expect(failed.status).toBe(500);
      await expect(findExportJob(expiredJob.id)).resolves.toStrictEqual({
        status: "completed",
        error: null,
      });

      const retried = await cleanupRegisteredFixtures();
      expect(retried.body.exportJobsCleaned).toBe(1);
      await expect(findExportJob(expiredJob.id)).resolves.toBeNull();
    },
  );

  it("cleans expired export jobs and fails stuck export jobs", async () => {
    const expiredJob = await trackExportJob(
      insertExportJob({
        status: "completed",
        createdAt: minutesAgo(30),
        expiresAt: minutesAgo(1),
        s3Key: "exports/expired.zip",
      }),
    );
    const stuckJob = await trackExportJob(
      insertExportJob({
        status: "running",
        createdAt: minutesAgo(11),
      }),
    );
    const sentinel = await trackExportJobForTeardown(
      insertExportJob({
        status: "completed",
        createdAt: minutesAgo(30),
        expiresAt: minutesAgo(1),
        s3Key: "exports/sentinel.zip",
      }),
    );

    const response = await cleanupRegisteredFixtures();

    expect(response.body).toStrictEqual({
      cleaned: 0,
      errors: 0,
      results: [],
      exportJobsCleaned: 1,
      exportJobsStuck: 1,
      threadlessRuns: {
        discovered: 0,
        cancelled: 0,
        waiting: 0,
        deleted: 0,
        failed: 0,
        errors: [],
      },
    });
    await expect(findExportJob(expiredJob.id)).resolves.toBeNull();
    await expect(findExportJob(stuckJob.id)).resolves.toStrictEqual({
      status: "failed",
      error: "Export job timed out",
    });
    await expect(findExportJob(sentinel.id)).resolves.toStrictEqual({
      status: "completed",
      error: null,
    });
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(1);
    expect(context.mocks.s3.send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Bucket: BUCKET,
        Delete: {
          Objects: [{ Key: "exports/expired.zip" }],
        },
      },
    });
  });
});

describe("sandbox cleanup of publicly launched runs", () => {
  const PENDING_TIMEOUT_ELAPSED_MS = 6 * 60 * 1000;
  const HEARTBEAT_TIMEOUT_ELAPSED_MS = 3 * 60 * 1000;
  const PENDING_TIMEOUT_REASON = "Run timed out while pending (never started)";
  const HEARTBEAT_TIMEOUT_REASON = "Run timed out (no heartbeat)";

  afterEach(() => {
    clearMockNow();
  });

  async function cleanupOwnedRuns(
    runIds: readonly string[],
  ): Promise<CronCleanupSandboxesResponse> {
    return await cleanupScopedSandboxes({
      chatThreadIds: [],
      runIds: [...runIds],
      exportJobIds: [],
    });
  }

  function cancelPublications(): readonly unknown[][] {
    return context.mocks.ably.publish.mock.calls.filter(([channel]) => {
      return channel === "cancel";
    });
  }

  async function expectActiveRun(
    actor: ApiTestUser,
    runId: string,
    status: "pending" | "running",
  ): Promise<void> {
    const run = await api.readRun(actor, runId);
    expect(run.status).toBe(status);
    expect(run.error).toBeUndefined();
  }

  async function expectRunDeleted(
    actor: ApiTestUser,
    runId: string,
  ): Promise<void> {
    await expect(
      api.requestReadRun(actor, runId, [404]),
    ).resolves.toMatchObject({ status: 404 });
  }

  function completedAtMs(run: { readonly completedAt?: string }): number {
    if (!run.completedAt) {
      throw new Error("Expected the terminal run to expose completedAt");
    }
    return Date.parse(run.completedAt);
  }

  /** A completed web run whose chat thread the user then deleted. */
  async function completedRunOfDeletedThread(prompt: string) {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const run = await sendChatRun(actor, { agentId, prompt });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, claimed.sandboxHeaders);
    await waitForRunStatus(actor, run.runId, "completed");
    await chat.deleteThread(actor, run.threadId);
    await flushWaitUntilForTest();
    const completed = await api.readRun(actor, run.runId);
    return {
      actor,
      runId: run.runId,
      completedAtMs: completedAtMs(completed),
    };
  }

  it("does not cleanup a recent pending run", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "recent pending run survives cleanup",
    });
    mockNow(now() + 60_000);

    const response = await cleanupOwnedRuns([run.runId]);

    expect(response.results).toHaveLength(0);
    await expectActiveRun(actor, run.runId, "pending");
    // The queued launch stays claimable after the cleanup pass.
    const claimed = await claimChatRun(runnerGroup, run.runId);
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  });

  it("does not cleanup a run with a recent heartbeat", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "recently claimed run survives cleanup",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    mockNow(now() + 60_000);

    const response = await cleanupOwnedRuns([run.runId]);

    expect(response.results).toHaveLength(0);
    await expectActiveRun(actor, run.runId, "running");
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  });

  it("keeps a stale running run active when its heartbeat commits first", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "late heartbeat keeps the run active",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    mockNow(now() + HEARTBEAT_TIMEOUT_ELAPSED_MS);

    await webhooks.requestAgentHeartbeat(
      { runId: run.runId },
      claimed.sandboxHeaders,
      [200],
    );
    const response = await cleanupOwnedRuns([run.runId]);

    expect(response.results).toHaveLength(0);
    await expectActiveRun(actor, run.runId, "running");
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  });

  it("exposes a pending-run timeout as terminal to connector runtime sync", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "pending run times out before a runner claims it",
    });
    const pending = await api.readRun(actor, run.runId);
    mockNow(now() + PENDING_TIMEOUT_ELAPSED_MS);
    context.mocks.ably.publish.mockClear();

    const response = await cleanupOwnedRuns([run.runId]);

    expect(response.cleaned).toBe(1);
    expect(response.errors).toBe(0);
    expect(response.results).toStrictEqual([
      {
        runId: run.runId,
        sandboxId: pending.sandboxId ?? null,
        status: "cleaned",
        reason: PENDING_TIMEOUT_REASON,
      },
    ]);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "timeout",
      error: PENDING_TIMEOUT_REASON,
    });
    const lateClaim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expectApiError(lateClaim.body);
    expect(cancelPublications()).toHaveLength(0);

    const sync = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersConnectorRuntimeSyncContract,
      ).sync({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        params: { runId: run.runId },
        body: {
          targets: [{ kind: "builtin", connectorSlug: "slack" }],
        },
      }),
      [409],
    );
    expect(sync.body.error).toStrictEqual({
      code: CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
      message: "Run is terminal",
    });
  });

  it("cleans up running runs after the heartbeat timeout", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "claimed run stops heartbeating",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const running = await api.readRun(actor, run.runId);
    mockNow(now() + HEARTBEAT_TIMEOUT_ELAPSED_MS);
    context.mocks.ably.publish.mockClear();

    const response = await cleanupOwnedRuns([run.runId]);

    expect(response.cleaned).toBe(1);
    expect(response.errors).toBe(0);
    expect(response.results).toStrictEqual([
      {
        runId: run.runId,
        sandboxId: running.sandboxId ?? null,
        status: "cleaned",
        reason: HEARTBEAT_TIMEOUT_REASON,
      },
    ]);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "timeout",
      error: HEARTBEAT_TIMEOUT_REASON,
    });
    await expect(
      api.readRunnerCancellation(
        claimed.claim.sandboxToken,
        run.runId,
        runnerGroup,
      ),
    ).resolves.toMatchObject({ state: "present", mode: "hard" });
    expect(cancelPublications()).toStrictEqual([
      ["cancel", { runId: run.runId, mode: "hard" }],
    ]);

    const duplicate = await cleanupOwnedRuns([run.runId]);
    expect(duplicate.results).toHaveLength(0);
    expect(cancelPublications()).toHaveLength(1);
  });

  it("does not cleanup completed runs even when they are old", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "completed run is not timed out",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, claimed.sandboxHeaders);
    await waitForRunStatus(actor, run.runId, "completed");
    mockNow(now() + 60 * 60 * 1000);

    const response = await cleanupOwnedRuns([run.runId]);

    expect(response.results).toHaveLength(0);
    const completed = await api.readRun(actor, run.runId);
    expect(completed.status).toBe("completed");
    expect(completed.error).toBeUndefined();
  });

  it("cleans only registered expired runs and leaves an unrelated sentinel untouched", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
    const { actor, agentId } = await entitledNativeChatActor();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "first registered pending run",
    });
    const second = await sendChatRun(actor, {
      agentId,
      prompt: "second registered pending run",
    });
    const sentinel = await sendChatRun(actor, {
      agentId,
      prompt: "unregistered pending sentinel",
    });
    const firstSandboxId = (await api.readRun(actor, first.runId)).sandboxId;
    const secondSandboxId = (await api.readRun(actor, second.runId)).sandboxId;
    mockNow(now() + PENDING_TIMEOUT_ELAPSED_MS);

    const response = await cleanupOwnedRuns([first.runId, second.runId]);

    expect(response.cleaned).toBe(2);
    expect(response.errors).toBe(0);
    expect(response.results).toHaveLength(2);
    expect(response.results).toStrictEqual(
      expect.arrayContaining([
        {
          runId: first.runId,
          sandboxId: firstSandboxId ?? null,
          status: "cleaned",
          reason: PENDING_TIMEOUT_REASON,
        },
        {
          runId: second.runId,
          sandboxId: secondSandboxId ?? null,
          status: "cleaned",
          reason: PENDING_TIMEOUT_REASON,
        },
      ]),
    );
    await expect(api.readRun(actor, first.runId)).resolves.toMatchObject({
      status: "timeout",
      error: PENDING_TIMEOUT_REASON,
    });
    await expect(api.readRun(actor, second.runId)).resolves.toMatchObject({
      status: "timeout",
      error: PENDING_TIMEOUT_REASON,
    });
    await expectActiveRun(actor, sentinel.runId, "pending");
    await cancelChatRun(actor, sentinel.runId);
  });

  it("processes a threadless run left by a deleted web thread", async () => {
    const threadless = await completedRunOfDeletedThread(
      "threadless run is processed",
    );
    mockNow(threadless.completedAtMs + CANCELLATION_RECOVERY_STALE_AFTER_MS);

    const response = await cleanupOwnedRuns([threadless.runId]);

    expect(response.threadlessRuns).toStrictEqual({
      discovered: 1,
      cancelled: 0,
      waiting: 0,
      deleted: 1,
      failed: 0,
      errors: [],
    });
    await expectRunDeleted(threadless.actor, threadless.runId);
  });

  it("waits through the quiet window and deletes at its exact boundary", async () => {
    const threadless = await completedRunOfDeletedThread(
      "threadless run waits for its quiet window",
    );
    mockNow(
      threadless.completedAtMs + CANCELLATION_RECOVERY_STALE_AFTER_MS - 1,
    );

    const waitingResponse = await cleanupOwnedRuns([threadless.runId]);
    expect(waitingResponse.threadlessRuns.discovered).toBe(1);
    expect(waitingResponse.threadlessRuns.waiting).toBe(1);
    await expect(
      api.readRun(threadless.actor, threadless.runId),
    ).resolves.toMatchObject({ status: "completed" });

    mockNow(threadless.completedAtMs + CANCELLATION_RECOVERY_STALE_AFTER_MS);
    const deletedResponse = await cleanupOwnedRuns([threadless.runId]);
    expect(deletedResponse.threadlessRuns.discovered).toBe(1);
    expect(deletedResponse.threadlessRuns.deleted).toBe(1);
    await expectRunDeleted(threadless.actor, threadless.runId);
  });

  it("redrives expired unresolved cancellation recovery before deletion", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "running run is cancelled by thread deletion",
    });
    await claimChatRun(runnerGroup, run.runId);
    // Deleting the thread hard-cancels the claimed run; the Runner never
    // reports its end, so cancellation recovery stays unresolved.
    await chat.deleteThread(actor, run.threadId);
    await flushWaitUntilForTest();
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
    const cancelledAtMs = completedAtMs(cancelled);
    mockNow(cancelledAtMs + CANCELLATION_RECOVERY_STALE_AFTER_MS - 1);

    const waiting = await cleanupOwnedRuns([run.runId]);
    expect(waiting.threadlessRuns.discovered).toBe(1);
    expect(waiting.threadlessRuns.waiting).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });

    mockNow(cancelledAtMs + CANCELLATION_RECOVERY_STALE_AFTER_MS);
    const response = await cleanupOwnedRuns([run.runId]);
    expect(response.threadlessRuns.discovered).toBe(1);
    expect(response.threadlessRuns.deleted).toBe(1);
    await expectRunDeleted(actor, run.runId);
  });
});
