import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { executionContextSchema } from "@okouai/api-contracts/contracts/runners";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { piMemoryPhase2Checkpoints } from "@okouai/db/schema/pi-memory-phase2-checkpoint";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { storages } from "@okouai/db/schema/storage";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { createStore } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { guestBoundaryEnvironment } from "../../../__tests__/env-stub";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, nowDate } from "../../../lib/time";
import { settle } from "../../utils";
import { db } from "../../../lib/db";
import { mockOptionalEnv } from "../../../lib/env";
import { holdAgentRunRowLockFixture } from "../../../test-fixtures/chat-events";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { runnersRoutes } from "../../routes/runners";
import { webhooksAgentCompleteRoutes } from "../../routes/webhooks-agent-complete";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../routes/webhooks-agent-health-usage-telemetry";
import { webhooksAgentStorageRoutes } from "../../routes/webhooks-agent-storage";
import { testCronCleanupSandboxesStateRoutes } from "../../routes/test-cron-cleanup-sandboxes-state";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "../../routes/__tests__/helpers/feature-switches";
import { seedBuiltInModelKey } from "../../routes/__tests__/helpers/runtime-state";
import {
  advancePiMemoryPhase2InputRevision,
  notifyPiMemoryPhase2ExternalHeadChange,
  PI_MEMORY_PHASE2_LEASE_DURATION_MS,
} from "../pi-memory-phase2-job.service";
import { executePiMemoryPhase2Work$ } from "../pi-memory-phase2-worker.service";
import { PI_MEMORY_PHASE2_USAGE_DRAIN_MS } from "../pi-memory-phase2-usage.service";
import {
  piMemoryPhase2MaintenanceCallbackPayloadSchema,
  handlePiMemoryPhase2MaintenanceCallback,
} from "../pi-memory-phase2-maintenance.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2CandidatesWithSources as insertPhase2Candidates,
  readPhase2Job,
  insertPhase2StorageVersion,
  setPhase2StorageHead,
} from "./pi-memory-phase2-job.test-fixture";

// #31937 and #32266 require infrastructure-only fault injection and exact
// control/usage evidence. Public APIs cannot create lost ACKs, revoked
// in-flight claims, historical leases, or Phase 2 cron state, and must not
// expose these private rows. Real routes still own Runner claim authentication,
// generic publication, usage ingestion, and completion.
const context = testContext();
const guestEnvironment = guestBoundaryEnvironment();
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const repo = resolve(
  fileURLToPath(new URL("../../../../../../..", import.meta.url)),
);
const cargo = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: resolve(repo, "crates"),
    encoding: "utf8",
  }),
) as { target_directory: string };
const secretCandidate = "PRIVATE_CANDIDATE_31937";

function sse(response: ServerResponse, index: number, failure: boolean) {
  const id = `resp_boundary_${index}`;
  const text = "Maintenance completed";
  const tool = index < 2;
  const item = tool
    ? {
        type: "function_call",
        id: `fc_${index}`,
        call_id: `call_${index}`,
        name: "phase2_write",
        arguments: JSON.stringify({
          path: index === 0 ? "memory/MEMORY.md" : "memory/memory_summary.md",
          content:
            index === 0
              ? "# Task Group: boundary\n"
              : "v1\n## User Profile\n- boundary\n",
        }),
        status: "completed",
      }
    : {
        type: "message",
        id: `msg_${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
  const events = [
    {
      type: "response.created",
      response: {
        id,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: tool
        ? { ...item, arguments: "", status: "in_progress" }
        : { ...item, content: [], status: "in_progress" },
    },
    tool
      ? {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: item.id,
          delta: item.arguments,
        }
      : {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: text,
        },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        object: "response",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    },
  ];
  if (failure && index > 0) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          message: "provider boundary failure",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events
      .map((event) => {
        return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
  );
}

type Fault =
  | "none"
  | "maintenance_agent_missing_retry"
  | "represented_no_diff"
  | "commit_ack"
  | "complete_transaction"
  | "complete_ack"
  | "provider"
  | "abrupt"
  | "revoked"
  | "invalid_marker"
  | "observer"
  | "new_input";

type BoundaryScope = Awaited<ReturnType<typeof createPhase2TestScope>>;
type CleanupMode = "active" | "renewed-race";
interface ActiveMaintenanceFence {
  readonly selectionDigest: string;
  readonly selectedCount: number;
  readonly selectedUtf8Bytes: number;
}

async function cleanupMaintenanceRun(runId: string, scope: BoundaryScope) {
  const response = await accept(
    setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
      testCronCleanupSandboxesStateContract,
    ).cleanup({
      body: {
        chatThreadIds: [],
        runIds: [runId],
        orgIds: [scope.orgId],
        exportJobIds: [],
      },
    }),
    [200],
  );
  return response.body;
}

async function readActiveMaintenanceFence(
  runId: string,
  scope: BoundaryScope,
): Promise<ActiveMaintenanceFence> {
  const job = await readPhase2Job(scope);
  if (
    !job ||
    job.claimedSelectionDigest === null ||
    job.claimedSelectedCount === null ||
    job.claimedSelectedUtf8Bytes === null
  ) {
    throw new Error("Missing active maintenance fence");
  }
  expect(job).toMatchObject({ status: "leased", maintenanceRunId: runId });
  return {
    selectionDigest: job.claimedSelectionDigest,
    selectedCount: job.claimedSelectedCount,
    selectedUtf8Bytes: job.claimedSelectedUtf8Bytes,
  };
}

async function crossActiveCleanupBoundary(
  runId: string,
  scope: BoundaryScope,
  cleanupMode: CleanupMode | undefined,
): Promise<void> {
  if (cleanupMode === "active") {
    const cleanupResult = await cleanupMaintenanceRun(runId, scope);
    expect(cleanupResult.threadlessRuns).toStrictEqual({
      discovered: 0,
      cancelled: 0,
      waiting: 0,
      deleted: 0,
      failed: 0,
      errors: [],
    });
  }
  if (cleanupMode === "renewed-race") {
    await db()
      .update(piMemoryPhase2Jobs)
      .set({ leaseExpiresAt: new Date(nowDate().getTime() - 1) })
      .where(eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId));
    const runLock = await holdAgentRunRowLockFixture({
      runId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      runLock.release();
      await runLock.done;
    });
    const cleanupRequest = cleanupMaintenanceRun(runId, scope);
    await expect.poll(runLock.waiterCount).toBeGreaterThan(0);
    await db()
      .update(piMemoryPhase2Jobs)
      .set({
        leaseExpiresAt: new Date(
          nowDate().getTime() + PI_MEMORY_PHASE2_LEASE_DURATION_MS,
        ),
      })
      .where(eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId));
    runLock.release();
    await runLock.done;
    const cleanupResult = await cleanupRequest;
    expect(cleanupResult.threadlessRuns).toStrictEqual({
      discovered: 1,
      cancelled: 0,
      waiting: 1,
      deleted: 0,
      failed: 0,
      errors: [],
    });
    const continuousResult = await cleanupMaintenanceRun(runId, scope);
    expect(continuousResult.threadlessRuns).toStrictEqual({
      discovered: 0,
      cancelled: 0,
      waiting: 0,
      deleted: 0,
      failed: 0,
      errors: [],
    });
  }
  if (cleanupMode) {
    await expect(
      db()
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    ).resolves.toStrictEqual([{ status: "running" }]);
  }
}

function phase2JobSeed(fault: Fault, dispatchTime: Date) {
  if (fault !== "maintenance_agent_missing_retry") {
    return { updatedAt: dispatchTime };
  }
  return {
    status: "retryable_failure" as const,
    retryCount: 1,
    retryAt: new Date(dispatchTime.getTime() - 1),
    lastErrorClass: "maintenance_agent_missing",
    updatedAt: new Date(dispatchTime.getTime() - 1),
  };
}

async function assertHistoricalMissingAgentRetry(args: {
  readonly fault: Fault;
  readonly scope: BoundaryScope;
  readonly dispatchTime: Date;
  readonly runId: string;
}): Promise<void> {
  if (args.fault !== "maintenance_agent_missing_retry") {
    return;
  }
  await expect(
    createStore().set(
      executePiMemoryPhase2Work$,
      {
        scope: args.scope,
        currentTime: new Date(args.dispatchTime.getTime() + 1),
      },
      context.signal,
    ),
  ).resolves.toStrictEqual({ outcome: "dispatched", runId: args.runId });
  await expect(
    db()
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, args.scope.orgId),
          eq(agentRuns.userId, args.scope.userId),
        ),
      ),
  ).resolves.toStrictEqual([{ id: args.runId }]);
}

async function claimMaintenanceRun(
  app: ReturnType<typeof createAppWithRoutes>,
  runId: string,
) {
  const response = await app.request(`/api/runners/jobs/${runId}/claim`, {
    method: "POST",
    headers: {
      authorization: OFFICIAL_RUNNER_AUTHORIZATION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      runnerIdentity: {
        runnerId: randomUUID(),
        heartbeatGeneration: 1,
      },
      capabilities: { piModelConfigGenerations: [1, 2, 3] },
    }),
  });
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  const execution = executionContextSchema.parse(body);
  if (!execution.piLaunchConfig?.maintenance || !execution.piModelConfig) {
    throw new Error("Claimed run is missing Pi maintenance context");
  }
  return {
    execution,
    maintenance: execution.piLaunchConfig.maintenance,
    piLaunchConfig: execution.piLaunchConfig,
  };
}

async function launch(fault: Fault, noDiff = false, cleanupMode?: CleanupMode) {
  const scope = await createPhase2TestScope(`boundary-${fault}`, {
    emptyBase: true,
  });
  // PiMemory is off for everyone by default; the maintenance dispatcher
  // only runs for owners whose explicit override enables it.
  await updateFeatureSwitchesForUser(
    context,
    { orgId: scope.orgId, userId: scope.userId },
    { [FeatureSwitchKey.PiMemory]: true },
  );
  onTestFinished(async () => {
    await deleteFeatureSwitchesForUser(context, {
      orgId: scope.orgId,
      userId: scope.userId,
    });
  });
  const candidate = {
    piSessionId: randomUUID(),
    sourceRunId: randomUUID(),
    sourceHistoryHash: createHash("sha256").update(randomUUID()).digest("hex"),
    sourceCompletedAt: new Date("2026-09-03T04:00:00.000Z"),
    rawMemory: secretCandidate,
    rolloutSummary: "private evidence",
  };
  const baseFiles = noDiff
    ? [
        { path: "MEMORY.md", content: "# Task Group: boundary\n" },
        {
          path: "memory_summary.md",
          content: "v1\n## User Profile\n- boundary\n",
        },
      ]
    : [];
  if (fault === "represented_no_diff") {
    // A selected candidate already represented by the valid mounted base
    // takes the real early no-diff path without incurring provider usage.
    const sessionHash = createHash("sha256")
      .update(candidate.piSessionId)
      .digest("hex");
    baseFiles.push({
      path: `rollout_summaries/pi/${sessionHash}.md`,
      content: [
        `pi_session_id: ${JSON.stringify(candidate.piSessionId)}`,
        `source_run_id: ${JSON.stringify(candidate.sourceRunId)}`,
        `source_history_hash: ${JSON.stringify(candidate.sourceHistoryHash)}`,
        `source_completed_at: ${JSON.stringify(candidate.sourceCompletedAt.toISOString())}`,
        "",
        candidate.rolloutSummary,
        "",
      ].join("\n"),
    });
  }
  const files = baseFiles.map((file) => {
    return {
      path: file.path,
      size: Buffer.byteLength(file.content),
      hash: createHash("sha256").update(file.content).digest("hex"),
    };
  });
  const baseVersion = noDiff
    ? await insertPhase2StorageVersion(scope, "valid-base", {
        versionId: createHash("sha256")
          .update(
            `storage:${scope.memoryStorageId}\n${files
              .map((file) => {
                return `${file.path}:${file.hash}`;
              })
              .sort()
              .join("\n")}`,
          )
          .digest("hex"),
        fileCount: files.length,
        size: files.reduce((sum, file) => {
          return sum + file.size;
        }, 0),
        archiveSize: 1,
      })
    : scope.baseVersion;
  if (noDiff) {
    await setPhase2StorageHead(scope, baseVersion);
  }
  await seedOrgMetadata({ orgId: scope.orgId, tier: "pro", credits: 100_000 });
  const cleanup: { runId?: string; sessionId?: string } = {};
  onTestFinished(async () => {
    await db().delete(usageEvent).where(eq(usageEvent.orgId, scope.orgId));
    if (cleanup.sessionId) {
      await db()
        .delete(agentSessions)
        .where(eq(agentSessions.id, cleanup.sessionId));
    } else if (cleanup.runId) {
      await db().delete(agentRuns).where(eq(agentRuns.id, cleanup.runId));
    }
  });
  await seedBuiltInModelKey(context, "gpt-5.6-terra");
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://objects.example.test/private-first-turn",
  );
  if (!noDiff || fault === "represented_no_diff") {
    await insertPhase2Candidates(scope, [candidate]);
  }
  const dispatchTime = nowDate();
  await insertPendingPhase2Job(scope, phase2JobSeed(fault, dispatchTime));
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  const result = await createStore().set(
    executePiMemoryPhase2Work$,
    { scope, currentTime: dispatchTime },
    context.signal,
  );
  expect(result.outcome).toBe("dispatched");
  if (result.outcome !== "dispatched") {
    throw new Error("Maintenance dispatch failed");
  }
  const runId = result.runId;
  cleanup.runId = runId;
  const [maintenanceRunIdentity] = await db()
    .select({
      sessionId: agentRuns.sessionId,
      chatThreadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, result.runId));
  if (!maintenanceRunIdentity) {
    throw new Error("Missing maintenance run identity");
  }
  cleanup.sessionId = maintenanceRunIdentity.sessionId;
  await expect(
    db()
      .select({ agentId: agentSessions.agentId })
      .from(agentSessions)
      .where(eq(agentSessions.id, maintenanceRunIdentity.sessionId)),
  ).resolves.toStrictEqual([{ agentId: null }]);
  expect(maintenanceRunIdentity.chatThreadId).toBeNull();
  await expect(
    db()
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.orgId, scope.orgId)),
  ).resolves.toStrictEqual([]);
  await assertHistoricalMissingAgentRetry({
    fault,
    scope,
    dispatchTime,
    runId: result.runId,
  });
  const activeFence = await readActiveMaintenanceFence(result.runId, scope);
  const [callback] = await db()
    .select()
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, result.runId));
  const binding = piMemoryPhase2MaintenanceCallbackPayloadSchema.parse(
    callback?.payload,
  );
  const trigger = `maintenance_observer_${scope.memoryStorageId.replaceAll("-", "")}`;
  async function releaseObserver() {
    if (fault === "observer") {
      await db().execute(
        sql`DROP TRIGGER IF EXISTS ${sql.identifier(trigger)} ON pi_memory_phase2_jobs`,
      );
      await db().execute(
        sql`DROP FUNCTION IF EXISTS ${sql.identifier(trigger)}()`,
      );
    }
  }
  if (fault === "observer") {
    await db()
      .execute(sql`CREATE FUNCTION ${sql.identifier(trigger)}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF replace(NEW.memory_storage_id::text, '-', '') = right(TG_NAME, 32) AND NEW.last_maintenance_checkpoint_id IS NOT NULL THEN
        RAISE EXCEPTION 'deterministic observer failure';
      END IF; RETURN NEW; END $$`);
    await db().execute(
      sql`CREATE TRIGGER ${sql.identifier(trigger)} BEFORE UPDATE ON pi_memory_phase2_jobs FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(trigger)}()`,
    );
    onTestFinished(releaseObserver);
  }
  const root = await mkdtemp(join(tmpdir(), "pi-maintenance-boundary-"));
  onTestFinished(() => {
    return rm(root, { recursive: true, force: true });
  });
  const memory = join(root, "memory");
  const runtime = join(root, "runtime");
  const bin = join(root, "bin");
  await Promise.all(
    [memory, bin, join(runtime, "run-payload"), join(runtime, "user-env")].map(
      (path) => {
        return mkdir(path, { recursive: true });
      },
    ),
  );
  await Promise.all(
    baseFiles.map(async (file) => {
      const path = join(memory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }),
  );
  const [mountedRun] = await db()
    .select({ storageMounts: agentRuns.storageMounts })
    .from(agentRuns)
    .where(eq(agentRuns.id, result.runId));
  await db()
    .update(agentRuns)
    .set({
      storageMounts: mountedRun?.storageMounts?.map((mount) => {
        return { ...mount, mountPath: memory };
      }),
    })
    .where(eq(agentRuns.id, result.runId));
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...runnersRoutes,
      ...webhooksAgentCompleteRoutes,
      ...webhooksAgentHealthUsageTelemetryRoutes,
      ...webhooksAgentStorageRoutes,
    ],
  });
  const objects = new Map<string, Buffer>();
  if (noDiff) {
    objects.set(`${baseVersion.s3Key}/archive.tar.gz`, Buffer.from("base"));
    objects.set(
      `${baseVersion.s3Key}/manifest.json`,
      Buffer.from(JSON.stringify({ files })),
    );
  }
  const requests: { path: string; body: string; status: number }[] = [];
  const proxyUsageBodies: string[] = [];
  let providerCount = 0;
  let commitCount = 0;
  let baseUrl = "";
  async function respondProvider(response: ServerResponse): Promise<void> {
    if (providerCount === 1 && fault === "new_input") {
      await insertPhase2Candidates(scope, [
        {
          piSessionId: randomUUID(),
          rawMemory: "later candidate",
          rolloutSummary: "later evidence",
        },
      ]);
      await db().transaction((tx) => {
        return advancePiMemoryPhase2InputRevision(tx, {
          ...scope,
          enqueuedAt: nowDate(),
        });
      });
    }
    if (providerCount === 1 && fault === "abrupt") {
      const pid = Number(await readFile(join(root, "child.pid"), "utf8"));
      process.kill(pid, "SIGKILL");
      response.destroy();
      return;
    }
    // This harness runs the real CLI/Guest but has no runner proxy. Model its
    // canonical usage ingress from each observed provider response and retain
    // the exact request so retries exercise the same idempotency keys.
    if (fault !== "provider" || providerCount === 0) {
      const body = JSON.stringify({
        runId,
        events: [
          { category: "tokens.input", quantity: 8 },
          { category: "tokens.output", quantity: 5 },
          { category: "tokens.cache_read", quantity: 2 },
        ].map((entry) => {
          return {
            ...entry,
            idempotencyKey: randomUUID(),
            kind: "model",
            provider: "gpt-5.6-terra",
          };
        }),
      });
      const proxyUsage = await app.request("/api/webhooks/agent/usage-event", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
      });
      expect(proxyUsage.status).toBe(200);
      proxyUsageBodies.push(body);
    }
    sse(response, providerCount++, fault === "provider");
    return;
  }
  async function serveRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const served = await settle(
      (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        const path = request.url ?? "/";
        if (path === "/v1/responses") {
          await respondProvider(response);
          return;
        }
        if (path.startsWith("/s3/")) {
          objects.set(decodeURIComponent(path.slice(4)), bytes);
          response.writeHead(200);
          response.end();
          return;
        }
        if (path.endsWith("/complete") && fault === "complete_transaction") {
          requests.push({ path, body: bytes.toString(), status: 503 });
          response.writeHead(503);
          response.end("unavailable");
          return;
        }
        if (path === "/test/maintenance-completed") {
          if (fault === "revoked") {
            const replacement = randomUUID();
            await db()
              .update(piMemoryPhase2Jobs)
              .set({ leaseToken: replacement, sandboxLeaseToken: replacement })
              .where(
                eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId),
              );
          }
          if (fault === "invalid_marker") {
            const marker = join(
              runtime,
              "pi-launch-payload/maintenance-validation.json",
            );
            // The fixture awaits this barrier after mounted validation and
            // before exiting, so Guest has not started checkpoint preparation.
            // This mutation never injects valid evidence.
            await writeFile(marker, "{}", { mode: 0o600 });
          }
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
        const apiResponse = await app.request(path, {
          method: request.method,
          headers,
          ...(bytes.length ? { body: bytes } : {}),
        });
        const body = await apiResponse.text();
        requests.push({
          path,
          body: bytes.toString(),
          status: apiResponse.status,
        });
        if (path.endsWith("/commit")) {
          commitCount += 1;
        }
        if (
          (path.endsWith("/commit") &&
            fault === "commit_ack" &&
            commitCount === 1) ||
          (path.endsWith("/complete") && fault === "complete_ack")
        ) {
          // Transaction has completed; destroy only its HTTP acknowledgement.
          response.destroy();
          return;
        }
        response.writeHead(
          apiResponse.status,
          Object.fromEntries(apiResponse.headers),
        );
        response.end(body);
      })(),
      context.signal,
    );
    if (!served.ok) {
      response.writeHead(500);
      response.end(String(served.error));
    }
  }
  // Own every request promise until teardown; Node's HTTP listener ignores
  // returned promises and cannot propagate a rejected handler to the test.
  const requestTasks: Promise<PromiseSettledResult<void>[]>[] = [];
  const server = createServer((request, response) => {
    requestTasks.push(Promise.allSettled([serveRequest(request, response)]));
  });
  const listening = once(server, "listening", { signal: context.signal });
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing listener");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
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
  context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
    const input = (command as { input: { Key: string } }).input;
    return Promise.resolve(`${baseUrl}/s3/${encodeURIComponent(input.Key)}`);
  });
  context.mocks.s3.send.mockImplementation((command) => {
    const input = (command as { input: { Key?: string } }).input;
    const object = input.Key ? objects.get(input.Key) : undefined;
    if (!object) {
      throw Object.assign(new Error("Object missing"), { name: "NotFound" });
    }
    return Promise.resolve({
      ContentLength: object.length,
      Body: Readable.from([object]),
    });
  });
  const { execution, maintenance, piLaunchConfig } = await claimMaintenanceRun(
    app,
    result.runId,
  );
  expect(execution.connectorRuntimeTargets).toStrictEqual([]);
  expect(execution.piModelConfig).toMatchObject({
    provider: "openai",
    model: "gpt-5.6-terra",
  });
  expect(maintenance).toMatchObject({
    memoryStorageId: scope.memoryStorageId,
    claimedBaseVersionId: baseVersion.versionId,
    leaseToken: binding.leaseToken,
    selected: binding.selected,
  });
  await crossActiveCleanupBoundary(result.runId, scope, cleanupMode);
  const token = execution.sandboxToken;
  const quote = (value: string) => {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
  };
  const fixture = resolve(
    repo,
    "turbo/apps/cli/src/test/fixtures/pi-agent-loop-rpc-host.ts",
  );
  const completionBarrier = ["revoked", "invalid_marker"].includes(fault)
    ? [`${baseUrl}/test/maintenance-completed`]
    : [];
  const shim = `#!/bin/sh\nprintf '%s' "$$" > ${quote(join(root, "child.pid"))}\nexec ${[process.execPath, "--import", import.meta.resolve("tsx"), fixture, join(root, "agent"), join(root, "sessions"), memory, ...completionBarrier].map(quote).join(" ")}\n`;
  await writeFile(join(bin, "npx"), shim, { mode: 0o700 });
  const payloadFile = join(runtime, "run-payload/payload.json");
  const userEnvFile = join(runtime, "user-env/env.json");
  await writeFile(
    payloadFile,
    JSON.stringify({
      prompt: "Run first-party Pi memory maintenance.",
      piSessionId: result.runId,
      artifacts: JSON.stringify([
        {
          name: "memory",
          storageId: scope.memoryStorageId,
          versionId: baseVersion.versionId,
          mountPath: memory,
          missingRootPolicy: "fail",
        },
      ]),
      piLaunchConfig: JSON.stringify(piLaunchConfig),
      piModelConfig: JSON.stringify({
        provider: "openai",
        model: "gpt-5.6-terra",
        baseUrl: `${baseUrl}/v1`,
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "OPENAI_API_KEY",
      }),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    userEnvFile,
    JSON.stringify({
      CLI_PKG_URL: "boundary-cli",
      OPENAI_API_KEY: "boundary-provider-key",
      PATH: `${bin}:${guestEnvironment.PATH ?? ""}`,
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    resolve(cargo.target_directory, "local/guest-agent"),
    [],
    {
      env: {
        HOME: guestEnvironment.HOME,
        OKOU_RUN_ID: result.runId,
        OKOU_API_BACKEND_URL: baseUrl,
        OKOU_API_TOKEN: token,
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
  const [exit] = await once(child, "exit", { signal: context.signal });
  const job = await readPhase2Job(scope);
  const receipts = await db()
    .select()
    .from(piMemoryPhase2Checkpoints)
    .where(eq(piMemoryPhase2Checkpoints.runId, result.runId));
  const checkpointRows = await db()
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.runId, result.runId));
  const lineage = await db()
    .select()
    .from(storageVersionLineage)
    .where(eq(storageVersionLineage.runId, result.runId));
  const usage = await db()
    .select()
    .from(usageEvent)
    .where(eq(usageEvent.orgId, scope.orgId));
  const [run] = await db()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, result.runId));
  expect(output).not.toContain(secretCandidate);
  expect(
    requests
      .map((request) => {
        return request.body;
      })
      .join("\n"),
  ).not.toContain(secretCandidate);
  return {
    scope,
    binding,
    runId: result.runId,
    token,
    app,
    output,
    exit,
    job,
    receipts,
    checkpointRows,
    lineage,
    usage,
    run,
    requests,
    proxyUsageBodies,
    providerCount,
    objects,
    memory,
    releaseObserver,
    activeFence,
  };
}

async function assertUsageReplay(
  run: Awaited<ReturnType<typeof launch>>,
  billedResponses: number,
) {
  expect(run.usage).toHaveLength(billedResponses * 3);
  for (const [category, quantity] of [
    ["tokens.input", 8],
    ["tokens.output", 5],
    ["tokens.cache_read", 2],
  ] as const) {
    expect(
      run.usage.filter((entry) => {
        return entry.category === category;
      }),
    ).toHaveLength(billedResponses);
    expect(
      run.usage
        .filter((entry) => {
          return entry.category === category;
        })
        .every((entry) => {
          return (
            entry.quantity === quantity &&
            entry.runId === run.runId &&
            entry.provider === "gpt-5.6-terra"
          );
        }),
    ).toBeTruthy();
  }
  expect(run.proxyUsageBodies).toHaveLength(billedResponses);
  for (let retry = 0; retry < 2; retry++) {
    for (const body of run.proxyUsageBodies) {
      expect(
        (
          await run.app.request("/api/webhooks/agent/usage-event", {
            method: "POST",
            headers: {
              authorization: `Bearer ${run.token}`,
              "content-type": "application/json",
            },
            body,
          })
        ).status,
      ).toBe(200);
    }
  }
  const replayUsage = await db()
    .select()
    .from(usageEvent)
    .where(eq(usageEvent.orgId, run.scope.orgId));
  const accounting = (rows: typeof replayUsage) => {
    return rows
      .map(({ idempotencyKey, quantity, category, runId }) => {
        return {
          idempotencyKey,
          quantity,
          category,
          runId,
        };
      })
      .sort((left, right) => {
        return left.idempotencyKey.localeCompare(right.idempotencyKey);
      });
  };
  expect(accounting(replayUsage)).toStrictEqual(accounting(run.usage));
}

describe("private maintenance across CLI, Guest, generic checkpoint and real PostgreSQL", () => {
  it.each([
    { label: "none", fault: "none", cleanupMode: undefined },
    {
      label: "maintenance_agent_missing_retry",
      fault: "maintenance_agent_missing_retry",
      cleanupMode: undefined,
    },
    { label: "commit_ack", fault: "commit_ack", cleanupMode: undefined },
    {
      label: "complete_transaction",
      fault: "complete_transaction",
      cleanupMode: undefined,
    },
    { label: "complete_ack", fault: "complete_ack", cleanupMode: undefined },
    { label: "observer", fault: "observer", cleanupMode: undefined },
    { label: "new_input", fault: "new_input", cleanupMode: undefined },
    {
      label: "cleanup lease renewal",
      fault: "none",
      cleanupMode: "renewed-race",
    },
  ] as const)(
    "settles changed output exactly once through $label",
    async ({ fault, cleanupMode }) => {
      const run = await launch(fault, false, cleanupMode);
      expect(run.job, run.output).toMatchObject({
        completedRevision: 1,
        retryCount: 0,
        lastMaintenanceOutcome: "published",
      });
      expect(run.receipts).toHaveLength(1);
      expect(run.lineage).toHaveLength(1);
      expect(run.providerCount).toBe(3);
      expect(run.usage.length).toBeGreaterThan(0);
      expect(
        run.usage.every((entry) => {
          return entry.runId === run.runId;
        }),
      ).toBeTruthy();
      await expect(
        readFile(join(run.memory, "MEMORY.md"), "utf8"),
      ).resolves.toContain("boundary");
      if (fault === "complete_transaction") {
        expect(run.checkpointRows).toHaveLength(0);
        expect(run.run?.status).toBe("running");
      } else {
        expect(run.checkpointRows).toHaveLength(1);
        expect(run.run?.status).toBe("completed");
      }
      expect(run.run).toMatchObject({
        triggerSource: "agent",
        chatThreadId: null,
      });
      await expect(
        db()
          .select({ sourceRunId: piMemoryStage1Candidates.sourceRunId })
          .from(piMemoryStage1Candidates)
          .where(eq(piMemoryStage1Candidates.sourceRunId, run.runId)),
      ).resolves.toStrictEqual([]);
      if (fault === "none") {
        const terminal = run.requests.find((request) => {
          return request.path.endsWith("/complete") && request.status === 200;
        });
        if (!terminal) {
          throw new Error("Missing actual maintenance terminal request");
        }
        for (let retry = 0; retry < 2; retry++) {
          const replay = await run.app.request(terminal.path, {
            method: "POST",
            headers: {
              authorization: `Bearer ${run.token}`,
              "content-type": "application/json",
            },
            body: terminal.body,
          });
          expect(replay.status).toBe(200);
        }
        await expect(
          db()
            .select({ sourceRunId: piMemoryStage1Candidates.sourceRunId })
            .from(piMemoryStage1Candidates)
            .where(eq(piMemoryStage1Candidates.sourceRunId, run.runId)),
        ).resolves.toStrictEqual([]);
      }
      if (fault === "observer") {
        expect(run.job?.lastMaintenanceCheckpointId).toBeNull();
        await run.releaseObserver();
      }
      await handlePiMemoryPhase2MaintenanceCallback(db(), {
        runId: run.runId,
        payload: run.binding,
        status: "completed",
      });
      const selected = await db()
        .select()
        .from(piMemoryStage1Candidates)
        .where(
          eq(
            piMemoryStage1Candidates.memoryStorageId,
            run.scope.memoryStorageId,
          ),
        );
      expect(
        selected.filter((candidate) => {
          return candidate.lastSelectedSourceHistoryHash !== null;
        }),
      ).toHaveLength(1);
      if (fault === "new_input") {
        expect(run.job).toMatchObject({
          inputRevision: 2,
          completedRevision: 1,
          status: "pending",
        });
        expect(selected).toHaveLength(2);
      }
      // A subsequent ordinary writer owns the current HEAD; replay only ACKs
      // the old receipt and must preserve the new input and observed HEAD.
      const later = await insertPhase2StorageVersion(
        run.scope,
        "later-external",
      );
      await setPhase2StorageHead(run.scope, later);
      await db().transaction((tx) => {
        return notifyPiMemoryPhase2ExternalHeadChange(tx, {
          ...run.scope,
          observedHeadVersionId: later.versionId,
          changedAt: nowDate(),
        });
      });
      const beforeReplay = await readPhase2Job(run.scope);
      const commit = run.requests.find((request) => {
        return request.path.endsWith("/commit");
      });
      expect(commit).toBeDefined();
      if (!commit) {
        throw new Error("Missing real Guest commit");
      }
      const replay = await run.app.request(commit.path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${run.token}`,
          "content-type": "application/json",
        },
        body: commit.body,
      });
      expect(replay.status).toBe(200);
      await expect(readPhase2Job(run.scope)).resolves.toStrictEqual(
        beforeReplay,
      );
      const [head] = await db()
        .select()
        .from(storages)
        .where(eq(storages.id, run.scope.memoryStorageId));
      expect(head?.headVersionId).toBe(later.versionId);
      const wrongClaim = JSON.parse(commit.body);
      expect(wrongClaim.maintenanceAttestation.schemaVersion).toBe(2);
      wrongClaim.maintenanceAttestation.leaseToken = randomUUID();
      expect(
        (
          await run.app.request(commit.path, {
            method: "POST",
            headers: {
              authorization: `Bearer ${run.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(wrongClaim),
          })
        ).status,
      ).toBe(404);
      await assertUsageReplay(run, 3);

      await expect(
        db()
          .select()
          .from(storageVersionLineage)
          .where(eq(storageVersionLineage.runId, run.runId)),
      ).resolves.toHaveLength(1);

      if (cleanupMode === "renewed-race") {
        const completedAt = run.run?.completedAt;
        if (!completedAt) {
          throw new Error("Cleanup regression run did not complete");
        }
        const staleLeaseToken = randomUUID();
        await db()
          .update(piMemoryPhase2Jobs)
          .set({
            status: "leased",
            inputRevision: 2,
            claimedRevision: 2,
            claimedBaseVersionId: later.versionId,
            leaseToken: staleLeaseToken,
            legacyLeaseToken: null,
            sandboxLeaseToken: staleLeaseToken,
            leaseExpiresAt: new Date(completedAt.getTime() - 1),
            maintenanceRunId: run.runId,
            retryCount: 0,
            retryAt: null,
            lastErrorClass: null,
            claimedSelectionDigest: run.activeFence.selectionDigest,
            claimedSelectedCount: run.activeFence.selectedCount,
            claimedSelectedUtf8Bytes: run.activeFence.selectedUtf8Bytes,
            lastObservedHeadVersionId: later.versionId,
            updatedAt: completedAt,
          })
          .where(
            eq(piMemoryPhase2Jobs.memoryStorageId, run.scope.memoryStorageId),
          );
        mockNow(completedAt.getTime() + PI_MEMORY_PHASE2_USAGE_DRAIN_MS);
        const cleanupResult = await cleanupMaintenanceRun(run.runId, run.scope);
        expect(cleanupResult.threadlessRuns).toStrictEqual({
          discovered: 1,
          cancelled: 0,
          waiting: 0,
          deleted: 1,
          failed: 0,
          errors: [],
        });
        await expect(
          db()
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(eq(agentRuns.id, run.runId)),
        ).resolves.toStrictEqual([]);
      }
    },
  );

  it.each([
    {
      label: "represented_no_diff",
      fault: "represented_no_diff",
      cleanupMode: undefined,
    },
    {
      label: "represented_no_diff across active cleanup",
      fault: "represented_no_diff",
      cleanupMode: "active",
    },
  ] as const)(
    "settles real no-diff with $label selection and no provider charge",
    async ({ fault, cleanupMode }) => {
      const run = await launch(fault, true, cleanupMode);
      expect(run.job, run.output).toMatchObject({
        completedRevision: 1,
        lastMaintenanceOutcome: "no_diff",
      });
      expect(run.providerCount).toBe(0);
      expect(run.usage).toHaveLength(0);
      expect(run.receipts).toHaveLength(1);
      expect(run.lineage).toHaveLength(0);
      expect(run.checkpointRows).toHaveLength(1);
      const commit = run.requests.find((request) => {
        return request.path.endsWith("/storages/commit");
      });
      if (!commit) {
        throw new Error("Missing actual no-diff checkpoint commit");
      }
      for (let retry = 0; retry < 2; retry++) {
        const response = await run.app.request(commit.path, {
          method: "POST",
          headers: {
            authorization: `Bearer ${run.token}`,
            "content-type": "application/json",
          },
          body: commit.body,
        });
        expect(response.status).toBe(200);
        await handlePiMemoryPhase2MaintenanceCallback(db(), {
          runId: run.runId,
          payload: run.binding,
          status: "completed",
        });
      }
      await expect(readPhase2Job(run.scope)).resolves.toMatchObject({
        completedRevision: 1,
        retryCount: 0,
        lastMaintenanceOutcome: "no_diff",
      });
      await expect(
        db()
          .select()
          .from(storageVersionLineage)
          .where(eq(storageVersionLineage.runId, run.runId)),
      ).resolves.toHaveLength(0);

      if (cleanupMode === "active") {
        const completedAt = run.run?.completedAt;
        if (!completedAt) {
          throw new Error("Cleanup no-diff run did not complete");
        }
        mockNow(completedAt.getTime() + PI_MEMORY_PHASE2_USAGE_DRAIN_MS);
        const cleanupResult = await cleanupMaintenanceRun(run.runId, run.scope);
        expect(cleanupResult.threadlessRuns).toStrictEqual({
          discovered: 1,
          cancelled: 0,
          waiting: 0,
          deleted: 1,
          failed: 0,
          errors: [],
        });
        await expect(
          db()
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(eq(agentRuns.id, run.runId)),
        ).resolves.toStrictEqual([]);
      }
    },
  );

  it.each(["provider", "abrupt", "revoked", "invalid_marker"] as const)(
    "recovers the exact parent without publishing after %s",
    async (fault) => {
      const run = await launch(fault);
      if (fault === "revoked" || fault === "invalid_marker") {
        // Guest leaves checkpoint failure terminal reporting to Runner's
        // existing fallback. Exercise that same authenticated completion wire.
        const terminal = await run.app.request("/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            authorization: `Bearer ${run.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: run.runId,
            exitCode: 1,
            error: "Guest checkpoint failed",
          }),
        });
        expect(terminal.status, run.output).toBe(200);
      } else {
        expect(run.run?.status, run.output).toBe("failed");
      }
      expect(run.receipts).toHaveLength(0);
      expect(run.lineage).toHaveLength(0);
      await assertUsageReplay(
        run,
        fault === "provider" || fault === "abrupt" ? 1 : 3,
      );
      expect(
        run.usage.every((entry) => {
          return entry.runId === run.runId;
        }),
      ).toBeTruthy();
      const [storage] = await db()
        .select()
        .from(storages)
        .where(eq(storages.id, run.scope.memoryStorageId));
      expect(storage?.headVersionId).toBe(run.scope.baseVersion.versionId);
      const callback = {
        runId: run.runId,
        payload: run.binding,
        status: "failed" as const,
        error: "provider failure",
      };
      await handlePiMemoryPhase2MaintenanceCallback(db(), callback);
      await handlePiMemoryPhase2MaintenanceCallback(db(), callback);
      if (fault !== "revoked") {
        await expect(readPhase2Job(run.scope)).resolves.toMatchObject({
          retryCount: 1,
          lastMaintenanceOutcome: "failed",
        });
      } else {
        await expect(readPhase2Job(run.scope)).resolves.toMatchObject({
          retryCount: 0,
          completedRevision: 0,
        });
      }
    },
  );
});
