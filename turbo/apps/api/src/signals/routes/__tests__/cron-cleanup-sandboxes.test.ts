import { createHash, randomUUID } from "node:crypto";

import type { CronCleanupSandboxesResponse } from "@okouai/api-contracts/contracts/cron";
import {
  triggerSourceSchema,
  type TriggerSource,
} from "@okouai/api-contracts/contracts/logs";
import {
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
  CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  type AgentRunConnectorDiagnosticRegistrationPayload,
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
import { clearMockNow, mockNow } from "../../../lib/time";
import { generateSandboxToken } from "../../auth/tokens";
import {
  holdAgentRunDeletionFixture,
  holdOrgCreditLockFixture,
  holdRunOutputProjectionLockFixture,
  insertPendingInlineDeliveryCallbackFixture,
  readRunCallbackFixture,
  readHistoryBlobReferenceCountFixture,
} from "../../../test-fixtures/run-deletion";
import {
  deleteUsagePricingRows,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { createFixtureTracker } from "./helpers/route-test";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { runnersRoutes } from "../runners";

const context = testContext();
const webhooks = createWebhookCallbackApi(context);
const BUCKET = "test-user-storage-bucket";
const FIXED_NOW_MS = Date.parse("2000-01-01T00:10:00.000Z");
const THREADLESS_FORWARD_CUTOFF_MS = Date.parse("2026-08-03T05:40:26.000Z");
const THREADLESS_TEST_NOW_MS = Date.parse("2026-08-03T06:00:00.000Z");
// Mirrors THREADLESS_RUN_SWEEP_LIMIT in threadless-run-cleanup.service.ts.
const THREADLESS_SWEEP_LIMIT = 20;
// Mirrors CONNECTOR_DIAGNOSTIC_REGISTRATION_CLEANUP_BATCH_SIZE.
const CONNECTOR_DIAGNOSTIC_REGISTRATION_SWEEP_LIMIT = 20;
const NON_TEST_TRIGGER_SOURCES: readonly TriggerSource[] =
  triggerSourceSchema.options.filter((source) => {
    return source !== "test";
  });
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

interface QueueMarkerFixture {
  readonly markerId: string;
  readonly threadId: string;
}

interface QueueMarkerRevoker {
  readonly id: string;
  readonly revokesEventId: string;
  readonly runEventId: string | null;
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

interface ChatThreadFixture {
  readonly threadId: string;
}

function minutesAgo(minutes: number): Date {
  return new Date(FIXED_NOW_MS - minutes * 60 * 1000);
}

function farFuture(): Date {
  return new Date("2999-01-01T00:00:00.000Z");
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

async function cleanupChatThreadFixture(
  fixture: ChatThreadFixture,
): Promise<void> {
  await postCronCleanupState({
    action: "delete-run-thread",
    thread_id: fixture.threadId,
  });
}

async function insertRunFixture(args?: {
  readonly status?: string;
  readonly composeName?: string;
  readonly createdAt?: Date;
  readonly lastHeartbeatAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly cancellationRecoveryCompleted?: boolean;
  readonly threadless?: boolean;
  readonly checkpointReady?: boolean;
  readonly triggerSource?: TriggerSource;
  readonly userId?: string;
  readonly orgId?: string;
  readonly runnerGroup?: string;
}): Promise<RunFixture> {
  const response = await postCronCleanupState({
    action: "seed-run",
    status: args?.status,
    compose_name: args?.composeName,
    created_at: args?.createdAt?.toISOString(),
    last_heartbeat_at:
      args?.lastHeartbeatAt === undefined
        ? undefined
        : (args.lastHeartbeatAt?.toISOString() ?? null),
    completed_at:
      args?.completedAt === undefined
        ? undefined
        : (args.completedAt?.toISOString() ?? null),
    cancellation_recovery_completed: args?.cancellationRecoveryCompleted,
    threadless: args?.threadless,
    checkpoint_ready: args?.checkpointReady,
    trigger_source: args?.triggerSource,
    user_id: args?.userId,
    org_id: args?.orgId,
    runner_group: args?.runnerGroup,
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

async function insertQueueEntry(
  fixture: RunFixture,
  expiresAt: Date,
  options?: {
    readonly encryptedParams?: string;
  },
): Promise<void> {
  await postCronCleanupState({
    action: "seed-queue-entry",
    run_id: fixture.runId,
    expires_at: expiresAt.toISOString(),
    encrypted_params: options?.encryptedParams,
  });
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

async function attachRunThread(
  fixture: RunFixture,
): Promise<ChatThreadFixture> {
  const response = await postCronCleanupState({
    action: "attach-run-thread",
    run_id: fixture.runId,
  });
  return { threadId: stringField(response, "thread_id") };
}

async function findRunOwnership(
  fixture: RunOwnershipFixture,
): Promise<TestCronCleanupSandboxesStateActionResponse> {
  return await postCronCleanupState({
    action: "get-run-ownership",
    ...ownershipActionFields(fixture),
  });
}

async function insertQueueMarker(
  fixture: RunFixture,
): Promise<QueueMarkerFixture> {
  const response = await postCronCleanupState({
    action: "seed-queue-marker",
    run_id: fixture.runId,
  });
  return {
    markerId: stringField(response, "marker_id"),
    threadId: stringField(response, "thread_id"),
  };
}

async function insertRunnerJobEntry(
  fixture: RunFixture,
  expiresAt: Date,
): Promise<void> {
  await postCronCleanupState({
    action: "seed-runner-job",
    run_id: fixture.runId,
    runner_group: "vm0/test",
    profile: "vm0/default",
    api_start_time: new Date(FIXED_NOW_MS).toISOString(),
    expires_at: expiresAt.toISOString(),
  });
}

async function insertConnectorDiagnosticRegistration(
  fixture: RunFixture,
  args?: { readonly createdAt?: Date },
): Promise<void> {
  await postCronCleanupState({
    action: "seed-connector-diagnostic-registration",
    run_id: fixture.runId,
    payload: { version: 1, targets: [] },
    created_at: args?.createdAt?.toISOString(),
  });
}

async function findConnectorDiagnosticRegistration(
  runId: string,
): Promise<AgentRunConnectorDiagnosticRegistrationPayload | null> {
  const response = await postCronCleanupState({
    action: "get-connector-diagnostic-registration",
    run_id: runId,
  });
  const registration = recordField(
    response,
    "connector_diagnostic_registration",
  );
  return registration
    ? agentRunConnectorDiagnosticRegistrationPayloadSchema.parse(
        registration["payload"],
      )
    : null;
}

async function transitionRunTerminal(
  fixture: RunFixture,
  status: "completed" | "failed" | "timeout" | "cancelled",
): Promise<void> {
  await postCronCleanupState({
    action: "transition-run-terminal",
    run_id: fixture.runId,
    status,
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

/** Returns this test's still-present runs in the fixture order. */
async function findRemainingRunIds(
  fixtures: readonly RunFixture[],
): Promise<readonly string[]> {
  const states = await Promise.all(
    fixtures.map(async (fixture) => {
      return {
        runId: fixture.runId,
        present: (await findRun(fixture.runId)) !== null,
      };
    }),
  );
  return states
    .filter((state) => {
      return state.present;
    })
    .map((state) => {
      return state.runId;
    });
}

async function findRunnerJob(runId: string): Promise<{
  readonly runId: string;
} | null> {
  const response = await postCronCleanupState({
    action: "get-runner-job",
    run_id: runId,
  });
  const row = recordField(response, "runner_job");
  return row ? { runId: stringField(row, "runId") } : null;
}

async function findQueueEntry(runId: string): Promise<{
  readonly runId: string;
} | null> {
  const response = await postCronCleanupState({
    action: "get-queue-entry",
    run_id: runId,
  });
  const row = recordField(response, "queue_entry");
  return row ? { runId: stringField(row, "runId") } : null;
}

async function findQueueMarkerRevoker(
  markerId: string,
): Promise<QueueMarkerRevoker | null> {
  const response = await postCronCleanupState({
    action: "get-queue-marker-revoker",
    marker_id: markerId,
  });
  const row = recordField(response, "queue_marker_revoker");
  return row
    ? {
        id: stringField(row, "id"),
        revokesEventId: stringField(row, "revokesEventId"),
        runEventId: nullableString(row.runEventId),
      }
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
  const trackChatThread = createFixtureTracker<ChatThreadFixture>(
    cleanupChatThreadFixture,
  );
  let registeredRunIds: string[] = [];
  let registeredOrgIds: string[] = [];
  let registeredExportJobIds: string[] = [];

  async function trackRun(
    fixturePromise: Promise<RunFixture>,
  ): Promise<RunFixture> {
    const fixture = await trackRunForTeardown(fixturePromise);
    registeredRunIds.push(fixture.runId);
    if (!registeredOrgIds.includes(fixture.orgId)) {
      registeredOrgIds.push(fixture.orgId);
    }
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
        orgIds: [...registeredOrgIds],
        exportJobIds: [...registeredExportJobIds],
      }),
    };
  }

  beforeEach(() => {
    registeredRunIds = [];
    registeredOrgIds = [];
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

  it.each(["completed", "failed", "timeout", "cancelled"] as const)(
    "deletes a connector diagnostic registration when its run becomes %s",
    async (status) => {
      const fixture = await trackRun(
        insertRunFixture({ status: "pending", createdAt: minutesAgo(1) }),
      );
      await insertConnectorDiagnosticRegistration(fixture);
      await expect(
        findConnectorDiagnosticRegistration(fixture.runId),
      ).resolves.toStrictEqual({ version: 1, targets: [] });

      await transitionRunTerminal(fixture, status);

      await expect(
        findConnectorDiagnosticRegistration(fixture.runId),
      ).resolves.toBeNull();
    },
  );

  it("cascades connector diagnostic registration deletion with its run", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(1) }),
    );
    await insertConnectorDiagnosticRegistration(fixture);

    await postCronCleanupState({ action: "delete-run", run_id: fixture.runId });

    await expect(
      findConnectorDiagnosticRegistration(fixture.runId),
    ).resolves.toBeNull();
  });

  it("rejects an invalid connector diagnostic registration payload", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(1) }),
    );

    const response = await requestCronCleanupState({
      action: "seed-connector-diagnostic-registration",
      run_id: fixture.runId,
      payload: { version: 1, targets: [{ kind: "builtin" }] },
    });

    expect(response.status).toBe(400);
    await expect(
      findConnectorDiagnosticRegistration(fixture.runId),
    ).resolves.toBeNull();
  });

  it("compensates terminal registration residue without expiring old active state", async () => {
    const terminal = await trackRun(
      insertRunFixture({ status: "completed", createdAt: minutesAgo(1) }),
    );
    const active = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(1) }),
    );
    const oldRegistrationTime = new Date("1990-01-01T00:00:00.000Z");
    await insertConnectorDiagnosticRegistration(terminal, {
      createdAt: oldRegistrationTime,
    });
    await insertConnectorDiagnosticRegistration(active, {
      createdAt: oldRegistrationTime,
    });

    await cleanupRegisteredFixtures();

    await expect(
      findConnectorDiagnosticRegistration(terminal.runId),
    ).resolves.toBeNull();
    await expect(
      findConnectorDiagnosticRegistration(active.runId),
    ).resolves.toStrictEqual({ version: 1, targets: [] });
  });

  it("bounds connector diagnostic registration compensation and converges", async () => {
    const fixtures: RunFixture[] = [];
    for (
      let index = 0;
      index < CONNECTOR_DIAGNOSTIC_REGISTRATION_SWEEP_LIMIT + 1;
      index++
    ) {
      const fixture = await trackRun(
        insertRunFixture({ status: "completed", createdAt: minutesAgo(1) }),
      );
      await insertConnectorDiagnosticRegistration(fixture, {
        createdAt: new Date(Date.UTC(1990, 0, 1, 0, 0, index)),
      });
      fixtures.push(fixture);
    }

    await cleanupRegisteredFixtures();

    const first = fixtures[0];
    const last = fixtures.at(-1);
    if (!first || !last) {
      throw new Error("Expected bounded registration cleanup fixtures");
    }

    await expect(
      findConnectorDiagnosticRegistration(first.runId),
    ).resolves.toBeNull();
    await expect(
      findConnectorDiagnosticRegistration(last.runId),
    ).resolves.toStrictEqual({ version: 1, targets: [] });

    await cleanupRegisteredFixtures();

    await expect(
      findConnectorDiagnosticRegistration(last.runId),
    ).resolves.toBeNull();
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

  describe.each(NON_TEST_TRIGGER_SOURCES)(
    "when the trigger source is %s",
    (triggerSource) => {
      it("processes the threadless run", async () => {
        mockNow(THREADLESS_TEST_NOW_MS);
        const fixture = await trackRun(
          insertRunFixture({
            status: "completed",
            createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
            completedAt: new Date(
              THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
            ),
            threadless: true,
            triggerSource,
          }),
        );

        const response = await cleanupRegisteredFixtures();

        expect(response.body.threadlessRuns).toStrictEqual({
          discovered: 1,
          cancelled: 0,
          waiting: 0,
          deleted: 1,
          failed: 0,
          errors: [],
        });
        await expect(findRun(fixture.runId)).resolves.toBeNull();
      });
    },
  );

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

  it("waits through the quiet window and deletes at its exact boundary", async () => {
    const completedAt = new Date(THREADLESS_TEST_NOW_MS);
    mockNow(completedAt.getTime() + CANCELLATION_RECOVERY_STALE_AFTER_MS - 1);
    const fixture = await trackRun(
      insertRunFixture({
        status: "completed",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt,
        threadless: true,
      }),
    );

    const waitingResponse = await cleanupRegisteredFixtures();
    expect(waitingResponse.body.threadlessRuns.discovered).toBe(1);
    expect(waitingResponse.body.threadlessRuns.waiting).toBe(1);
    await expect(findRun(fixture.runId)).resolves.not.toBeNull();

    mockNow(completedAt.getTime() + CANCELLATION_RECOVERY_STALE_AFTER_MS);
    const deletedResponse = await cleanupRegisteredFixtures();
    expect(deletedResponse.body.threadlessRuns.discovered).toBe(1);
    expect(deletedResponse.body.threadlessRuns.deleted).toBe(1);
    await expect(findRun(fixture.runId)).resolves.toBeNull();
  });

  it("hard-cancels an active threadless run without deleting it in the same pass", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        createdAt: new Date(THREADLESS_TEST_NOW_MS - 60_000),
        lastHeartbeatAt: new Date(THREADLESS_TEST_NOW_MS - 60_000),
        threadless: true,
      }),
    );

    const cancelledResponse = await cleanupRegisteredFixtures();
    expect(cancelledResponse.body.threadlessRuns.discovered).toBe(1);
    expect(cancelledResponse.body.threadlessRuns.cancelled).toBe(1);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "cancelled",
    });

    mockNow(THREADLESS_TEST_NOW_MS + CANCELLATION_RECOVERY_STALE_AFTER_MS);
    const deletedResponse = await cleanupRegisteredFixtures();
    expect(deletedResponse.body.threadlessRuns.discovered).toBe(1);
    expect(deletedResponse.body.threadlessRuns.deleted).toBe(1);
    await expect(findRun(fixture.runId)).resolves.toBeNull();
  });

  it("redrives expired unresolved cancellation recovery before deletion", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "cancelled",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        completedAt: new Date(
          THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS + 1,
        ),
        cancellationRecoveryCompleted: false,
        threadless: true,
      }),
    );

    const waiting = await cleanupRegisteredFixtures();
    expect(waiting.body.threadlessRuns.discovered).toBe(1);
    expect(waiting.body.threadlessRuns.waiting).toBe(1);
    await expect(findRun(fixture.runId)).resolves.not.toBeNull();

    mockNow(THREADLESS_TEST_NOW_MS + 1);
    const response = await cleanupRegisteredFixtures();
    expect(response.body.threadlessRuns.discovered).toBe(1);
    expect(response.body.threadlessRuns.deleted).toBe(1);
    await expect(findRun(fixture.runId)).resolves.toBeNull();
  });

  it("terminalizes a stranded inline delivery callback before deleting its run", async () => {
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
    const callbackId = await insertPendingInlineDeliveryCallbackFixture(
      fixture.runId,
    );
    await insertRunnerJobEntry(fixture, new Date(0));

    const waiting = await cleanupRegisteredFixtures();
    expect(waiting.body.threadlessRuns.discovered).toBe(1);
    expect(waiting.body.threadlessRuns.waiting).toBe(1);
    await expect(findRun(fixture.runId)).resolves.not.toBeNull();
    await expect(readRunCallbackFixture(callbackId)).resolves.toStrictEqual({
      status: "failed",
      lastError: "Chat thread was deleted before inline callback delivery",
    });
    await expect(findRunnerJob(fixture.runId)).resolves.toBeNull();

    const deleted = await cleanupRegisteredFixtures();
    expect(deleted.body.threadlessRuns.discovered).toBe(1);
    expect(deleted.body.threadlessRuns.deleted).toBe(1);
    await expect(findRun(fixture.runId)).resolves.toBeNull();
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

  it("processes only the oldest bounded batch of threadless runs", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const userId = `user-${randomUUID()}`;
    const orgId = `org-${randomUUID()}`;
    const fixtures = await Promise.all(
      Array.from({ length: THREADLESS_SWEEP_LIMIT + 1 }, async (_, index) => {
        return await trackRun(
          insertRunFixture({
            status: "completed",
            createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + index + 1),
            completedAt: new Date(
              THREADLESS_TEST_NOW_MS - CANCELLATION_RECOVERY_STALE_AFTER_MS,
            ),
            threadless: true,
            userId,
            orgId,
          }),
        );
      }),
    );

    const firstResponse = await cleanupRegisteredFixtures();

    expect(firstResponse.body.threadlessRuns).toStrictEqual({
      discovered: THREADLESS_SWEEP_LIMIT,
      cancelled: 0,
      waiting: 0,
      deleted: THREADLESS_SWEEP_LIMIT,
      failed: 0,
      errors: [],
    });
    const remaining = await findRemainingRunIds(fixtures);
    expect(remaining).toStrictEqual(
      fixtures.slice(THREADLESS_SWEEP_LIMIT).map((fixture) => {
        return fixture.runId;
      }),
    );
    // What the bound left behind stays untouched and eligible for a next pass.
    await expect(
      Promise.all(
        remaining.map((runId) => {
          return findRun(runId);
        }),
      ),
    ).resolves.toStrictEqual(
      remaining.map(() => {
        return { status: "completed", error: null };
      }),
    );
  });

  it("acknowledges an event projection that loses the root-delete race", async () => {
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
    const held = await holdRunOutputProjectionLockFixture({
      runId: fixture.runId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    const headers = {
      authorization: `Bearer ${generateSandboxToken(
        fixture.userId,
        fixture.runId,
        fixture.orgId,
      )}`,
    };
    const eventRequest = webhooks.requestAgentEvents(
      {
        runId: fixture.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              id: `msg_${randomUUID()}`,
              content: [{ type: "text", text: "late output" }],
            },
          },
        ],
      },
      headers,
      [200],
    );
    await expect.poll(held.blockedWaiterCount).toBeGreaterThan(0);

    const cleanup = await cleanupRegisteredFixtures();
    expect(cleanup.body.threadlessRuns.discovered).toBe(1);
    expect(cleanup.body.threadlessRuns.deleted).toBe(1);
    held.release();
    await held.done;
    const eventResponse = await eventRequest;
    expect(eventResponse).toMatchObject({
      status: 200,
      body: { received: 1, firstSequence: 0, lastSequence: 0 },
    });
  });

  it("skips deletion when the threadless state changes before the write transaction", async () => {
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
    const held = await holdOrgCreditLockFixture({
      orgId: fixture.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    const cleanupRequest = cleanupRegisteredFixtures();
    await expect.poll(held.blockedWaiterCount).toBeGreaterThan(0);

    await trackChatThread(attachRunThread(fixture));
    held.release();
    await held.done;
    const cleanup = await cleanupRequest;
    expect(cleanup.body.threadlessRuns.discovered).toBe(1);
    expect(cleanup.body.threadlessRuns.waiting).toBe(1);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("acknowledges completion when root deletion wins the row-lock race", async () => {
    mockNow(THREADLESS_TEST_NOW_MS);
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        createdAt: new Date(THREADLESS_FORWARD_CUTOFF_MS + 1),
        threadless: true,
      }),
    );
    const held = await holdAgentRunDeletionFixture({
      runId: fixture.runId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    const headers = {
      authorization: `Bearer ${generateSandboxToken(
        fixture.userId,
        fixture.runId,
        fixture.orgId,
      )}`,
    };
    const completionRequest = webhooks.requestAgentComplete(
      {
        runId: fixture.runId,
        exitCode: 1,
        error: "late runner failure",
      },
      headers,
      [200],
    );
    await expect.poll(held.blockedWaiterCount).toBeGreaterThan(0);

    held.release();
    await held.done;
    const completion = await completionRequest;
    expect(completion).toMatchObject({
      status: 200,
      body: { success: true, status: "failed" },
    });
    await expect(findRun(fixture.runId)).resolves.toBeNull();
  });

  it("does not cleanup a recent pending run", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(1) }),
    );
    await insertRunnerJobEntry(fixture, farFuture());

    const response = await cleanupRegisteredFixtures();

    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "pending",
      error: null,
    });
    await expect(findRunnerJob(fixture.runId)).resolves.toStrictEqual({
      runId: fixture.runId,
    });
  });

  it("does not cleanup a run with a recent heartbeat", async () => {
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        createdAt: minutesAgo(1),
        lastHeartbeatAt: minutesAgo(1),
      }),
    );

    const response = await cleanupRegisteredFixtures();

    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "running",
      error: null,
    });
  });

  it("keeps a stale running run active when its heartbeat commits first", async () => {
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        createdAt: minutesAgo(10),
        lastHeartbeatAt: minutesAgo(3),
      }),
    );
    const headers = {
      authorization: `Bearer ${generateSandboxToken(
        fixture.userId,
        fixture.runId,
        fixture.orgId,
      )}`,
    };

    await webhooks.requestAgentHeartbeat(
      { runId: fixture.runId },
      headers,
      [200],
    );
    const response = await cleanupRegisteredFixtures();

    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "running",
      error: null,
    });
  });

  it("exposes a pending-run timeout as terminal to connector runtime sync", async () => {
    const fixture = await trackRun(
      insertRunFixture({
        status: "pending",
        createdAt: minutesAgo(6),
        runnerGroup: "vm0/test",
      }),
    );
    await insertRunnerJobEntry(fixture, farFuture());
    await insertConnectorDiagnosticRegistration(fixture);
    context.mocks.ably.publish.mockClear();

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(1);
    expect(response.body.errors).toBe(0);
    expect(response.body.results).toStrictEqual([
      {
        runId: fixture.runId,
        sandboxId: fixture.sandboxId,
        status: "cleaned",
        reason: "Run timed out while pending (never started)",
      },
    ]);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Run timed out while pending (never started)",
    });
    await expect(findRunnerJob(fixture.runId)).resolves.toBeNull();
    await expect(
      findConnectorDiagnosticRegistration(fixture.runId),
    ).resolves.toBeNull();
    expect(
      context.mocks.ably.publish.mock.calls.filter(([channel]) => {
        return channel === "cancel";
      }),
    ).toHaveLength(0);

    const sync = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersConnectorRuntimeSyncContract,
      ).sync({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        params: { runId: fixture.runId },
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

  it("cleans up pending runs without runner jobs after the pending timeout", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(6) }),
    );

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(1);
    expect(response.body.errors).toBe(0);
    expect(response.body.results).toStrictEqual([
      {
        runId: fixture.runId,
        sandboxId: fixture.sandboxId,
        status: "cleaned",
        reason: "Run timed out while pending (never started)",
      },
    ]);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Run timed out while pending (never started)",
    });
    await expect(findRunnerJob(fixture.runId)).resolves.toBeNull();
  });

  it("deletes expired runner job queue entries", async () => {
    const expired = await trackRun(
      insertRunFixture({ status: "completed", createdAt: minutesAgo(1) }),
    );
    const unexpired = await trackRun(
      insertRunFixture({ status: "completed", createdAt: minutesAgo(1) }),
    );
    await insertRunnerJobEntry(expired, minutesAgo(1));
    await insertRunnerJobEntry(unexpired, farFuture());

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(0);
    await expect(findRunnerJob(expired.runId)).resolves.toBeNull();
    await expect(findRunnerJob(unexpired.runId)).resolves.toStrictEqual({
      runId: unexpired.runId,
    });
  });

  it("cleans up running runs after the heartbeat timeout", async () => {
    const fixture = await trackRun(
      insertRunFixture({
        status: "running",
        createdAt: minutesAgo(1),
        lastHeartbeatAt: minutesAgo(3),
        runnerGroup: "vm0/test",
      }),
    );
    context.mocks.ably.publish.mockClear();

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(1);
    expect(response.body.errors).toBe(0);
    expect(response.body.results).toStrictEqual([
      {
        runId: fixture.runId,
        sandboxId: fixture.sandboxId,
        status: "cleaned",
        reason: "Run timed out (no heartbeat)",
      },
    ]);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Run timed out (no heartbeat)",
    });
    expect(
      context.mocks.ably.publish.mock.calls.filter(([channel]) => {
        return channel === "cancel";
      }),
    ).toStrictEqual([["cancel", { runId: fixture.runId, mode: "hard" }]]);

    const duplicate = await cleanupRegisteredFixtures();
    expect(duplicate.body.results).toHaveLength(0);
    expect(
      context.mocks.ably.publish.mock.calls.filter(([channel]) => {
        return channel === "cancel";
      }),
    ).toHaveLength(1);
  });

  it("does not cleanup completed runs even when they are old", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "completed", createdAt: minutesAgo(60) }),
    );

    const response = await cleanupRegisteredFixtures();

    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "completed",
      error: null,
    });
  });

  it("cleans only registered expired runs and leaves an unrelated sentinel untouched", async () => {
    const firstFixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(6) }),
    );
    const secondFixture = await trackRun(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(7) }),
    );
    const sentinel = await trackRunForTeardown(
      insertRunFixture({ status: "pending", createdAt: minutesAgo(8) }),
    );

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(2);
    expect(response.body.errors).toBe(0);
    expect(response.body.results).toHaveLength(2);
    expect(response.body.results).toStrictEqual(
      expect.arrayContaining([
        {
          runId: firstFixture.runId,
          sandboxId: firstFixture.sandboxId,
          status: "cleaned",
          reason: "Run timed out while pending (never started)",
        },
        {
          runId: secondFixture.runId,
          sandboxId: secondFixture.sandboxId,
          status: "cleaned",
          reason: "Run timed out while pending (never started)",
        },
      ]),
    );
    await expect(findRun(firstFixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Run timed out while pending (never started)",
    });
    await expect(findRun(secondFixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Run timed out while pending (never started)",
    });
    await expect(findRun(sentinel.runId)).resolves.toStrictEqual({
      status: "pending",
      error: null,
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

  it("times out expired queued runs", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "queued", createdAt: minutesAgo(130) }),
    );
    await insertQueueEntry(fixture, minutesAgo(1));
    await insertConnectorDiagnosticRegistration(fixture);

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(1);
    expect(response.body.errors).toBe(0);
    expect(response.body.results).toStrictEqual([
      {
        runId: fixture.runId,
        sandboxId: null,
        status: "cleaned",
        reason: "Queued run expired (exceeded queue TTL)",
      },
    ]);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Queued run expired (exceeded queue TTL)",
    });
    await expect(findQueueEntry(fixture.runId)).resolves.toBeNull();
    await expect(
      findConnectorDiagnosticRegistration(fixture.runId),
    ).resolves.toBeNull();
  });

  it("cleans up queued runs missing queue entries after the grace threshold", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "queued", createdAt: minutesAgo(6) }),
    );
    const marker = await insertQueueMarker(fixture);

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(1);
    expect(response.body.errors).toBe(0);
    expect(response.body.results).toStrictEqual([
      {
        runId: fixture.runId,
        sandboxId: null,
        status: "cleaned",
        reason: "Queued run timed out before queue entry was persisted",
      },
    ]);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "timeout",
      error: "Queued run timed out before queue entry was persisted",
    });
    await expect(findQueueEntry(fixture.runId)).resolves.toBeNull();
    await expect(
      findQueueMarkerRevoker(marker.markerId),
    ).resolves.toMatchObject({
      revokesEventId: marker.markerId,
      runEventId: "queue:dequeued",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${marker.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("does not clean up fresh queued runs missing queue entries", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "queued", createdAt: minutesAgo(1) }),
    );

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(0);
    expect(response.body.results).toHaveLength(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "queued",
      error: null,
    });
    await expect(findQueueEntry(fixture.runId)).resolves.toBeNull();
  });

  it("deletes expired stale queue entries without changing terminal runs", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "cancelled", createdAt: minutesAgo(130) }),
    );
    await insertQueueEntry(fixture, minutesAgo(1));

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "cancelled",
      error: null,
    });
    await expect(findQueueEntry(fixture.runId)).resolves.toBeNull();
  });

  it("drains queued runs when an org has no active runs", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "queued", createdAt: minutesAgo(1) }),
    );
    await insertQueueEntry(fixture, minutesAgo(-60));

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "pending",
      error: null,
    });
  });

  it("removes stale queue entries before decrypting queued payloads", async () => {
    const fixture = await trackRun(
      insertRunFixture({ status: "cancelled", createdAt: minutesAgo(1) }),
    );
    await insertQueueEntry(fixture, minutesAgo(-60), {
      encryptedParams: "invalid-encrypted-payload",
    });

    const response = await cleanupRegisteredFixtures();

    expect(response.body.cleaned).toBe(0);
    await expect(findRun(fixture.runId)).resolves.toMatchObject({
      status: "cancelled",
      error: null,
    });
    await expect(findQueueEntry(fixture.runId)).resolves.toBeNull();
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
            orgIds: [],
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
    expect(context.mocks.s3.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: BUCKET,
          Delete: {
            Objects: [{ Key: "exports/expired.zip" }],
          },
        }),
      }),
    );
  });
});
