import { randomUUID } from "node:crypto";

import {
  type TestCronCleanupSandboxesStateActionBody,
  testCronCleanupSandboxesStateContract,
} from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { triggerSourceSchema } from "@okouai/api-contracts/contracts/logs";
import {
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  MIN_EPOCH_MS_TIMESTAMP,
} from "@okouai/api-contracts/contracts/runners";
import { agents } from "@okouai/db/schema/agent";
import { artifacts } from "@okouai/db/schema/artifact";
import { browserSessions } from "@okouai/db/schema/browser-session";
import { builtInGenerationJobs } from "@okouai/db/schema/built-in-generation-job";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { exportJobs } from "@okouai/db/schema/export-job";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { hostedDeployments, hostedSites } from "@okouai/db/schema/hosted-site";
import {
  assertHostedDeploymentScope,
  canonicalizeHostedSiteScope,
} from "../services/hosted-site-scope.service";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  encryptQueuedRunnerJobPayload,
  queuedRunnerJobPayload,
} from "../services/agent-run-queue-payload.service";
import {
  normalizeRunMetadata,
  writeRunMetadata,
} from "../services/agent-run-metadata-write.service";
import { transitionAgentRunsToTerminal } from "../services/agent-run-terminal-transition.service";
import { cleanupSandboxes$ } from "../services/cron-cleanup-sandboxes.service";
import { insertChatEvent } from "../services/chat-event.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { ensureOrgMetadataPlanEntitlement } from "../services/org-plan-entitlements.service";

const actionBody$ = bodyResultOf(testCronCleanupSandboxesStateContract.action);
const cleanupBody$ = bodyResultOf(
  testCronCleanupSandboxesStateContract.cleanup,
);

function actionOk(extra: Record<string, unknown> = {}) {
  return {
    status: 200 as const,
    body: { ok: true as const, ...extra },
  };
}

function actionBadRequest(error: string) {
  return { status: 400 as const, body: { error } };
}

type CronCleanupSandboxesAction =
  TestCronCleanupSandboxesStateActionBody["action"];
type CronCleanupSandboxesActionResponse =
  | ReturnType<typeof actionOk>
  | ReturnType<typeof actionBadRequest>;
type CronCleanupSandboxesActionHandler = (
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<CronCleanupSandboxesActionResponse>;

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  return readString(body, key) ?? undefined;
}

function readDate(body: Record<string, unknown>, key: string): Date | null {
  const value = body[key];
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readNullableDate(
  body: Record<string, unknown>,
  key: string,
): Date | null | undefined {
  if (!(key in body)) {
    return undefined;
  }
  if (body[key] === null) {
    return null;
  }
  return readDate(body, key) ?? undefined;
}

function readOptionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

async function seedRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const triggerSource = triggerSourceSchema.safeParse(
    readOptionalString(body, "trigger_source") ?? "web",
  );
  if (!triggerSource.success) {
    return actionBadRequest("trigger_source is invalid");
  }

  const userId = readOptionalString(body, "user_id") ?? `user-${randomUUID()}`;
  const orgId = readOptionalString(body, "org_id") ?? `org-${randomUUID()}`;
  const agentName =
    readOptionalString(body, "compose_name") ?? `cleanup-${randomUUID()}`;
  const [agent] = await db
    .insert(agents)
    .values({
      id: randomUUID(),
      owner: userId,
      orgId,
      name: agentName,
      visibility: "private",
    })
    .returning({ id: agents.id });
  signal.throwIfAborted();
  if (!agent) {
    return actionBadRequest("failed to seed Agent");
  }

  await db.transaction(async (tx) => {
    const metadataRows = await tx
      .insert(orgMetadataCanonicalWrites)
      .values({
        orgId,
        tier: "free",
        credits: 10_000,
      })
      .onConflictDoNothing()
      .returning({
        orgId: orgMetadataCanonicalWrites.orgId,
        tier: orgMetadataCanonicalWrites.tier,
      });
    for (const metadata of metadataRows) {
      await ensureOrgMetadataPlanEntitlement(tx, metadata);
    }
  });
  signal.throwIfAborted();

  const [session] = await db
    .insert(agentSessions)
    .values({ userId, orgId, agentId: agent.id })
    .returning({ id: agentSessions.id });
  signal.throwIfAborted();
  if (!session) {
    return actionBadRequest("failed to seed session");
  }

  const threadless = readOptionalBoolean(body, "threadless") === true;
  const status = readOptionalString(body, "status") ?? "pending";
  // Queued fixtures can be promoted through the production metadata writer.
  // Lifecycle-only fixtures that never enter that path intentionally stay null.
  const runMetadata =
    threadless || status === "queued"
      ? normalizeRunMetadata({ triggerSource: triggerSource.data })
      : null;
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      sessionId: session.id,
      storageMounts:
        readOptionalBoolean(body, "checkpoint_ready") === true ? [] : null,
      status,
      prompt: readOptionalString(body, "prompt") ?? "cleanup sandboxes test",
      sandboxId:
        readOptionalString(body, "sandbox_id") ?? `sandbox-${randomUUID()}`,
      createdAt: readDate(body, "created_at") ?? undefined,
      completedAt: readNullableDate(body, "completed_at"),
      lastHeartbeatAt: readNullableDate(body, "last_heartbeat_at"),
      runnerGroup: readOptionalString(body, "runner_group"),
      cancellationRecoveryCompleted: readOptionalBoolean(
        body,
        "cancellation_recovery_completed",
      ),
      ...runMetadata,
    })
    .returning({ id: agentRuns.id, sandboxId: agentRuns.sandboxId });
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("failed to seed run");
  }

  return actionOk({
    run_id: run.id,
    sandbox_id: run.sandboxId,
    session_id: session.id,
    compose_id: agent.id,
    org_id: orgId,
    user_id: userId,
  });
}

async function seedConnectorDiagnosticRegistrationForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const payload =
    agentRunConnectorDiagnosticRegistrationPayloadSchema.safeParse(
      body["payload"],
    );
  if (!payload.success) {
    return actionBadRequest("payload is invalid");
  }
  await db.insert(agentRunConnectorDiagnosticRegistrations).values({
    runId,
    payload: payload.data,
    createdAt: readDate(body, "created_at") ?? undefined,
  });
  signal.throwIfAborted();
  return actionOk();
}

async function getConnectorDiagnosticRegistrationForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [registration] = await db
    .select({
      payload: agentRunConnectorDiagnosticRegistrations.payload,
      createdAt: agentRunConnectorDiagnosticRegistrations.createdAt,
    })
    .from(agentRunConnectorDiagnosticRegistrations)
    .where(eq(agentRunConnectorDiagnosticRegistrations.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    connector_diagnostic_registration: registration
      ? {
          payload: agentRunConnectorDiagnosticRegistrationPayloadSchema.parse(
            registration.payload,
          ),
          created_at: registration.createdAt.toISOString(),
        }
      : null,
  });
}

async function deleteConnectorDiagnosticRegistrationForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  await db
    .delete(agentRunConnectorDiagnosticRegistrations)
    .where(eq(agentRunConnectorDiagnosticRegistrations.runId, runId));
  signal.throwIfAborted();
  return actionOk();
}

async function corruptConnectorDiagnosticRegistrationForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  await db
    .update(agentRunConnectorDiagnosticRegistrations)
    .set({
      payload: sql`'null'::jsonb`,
    })
    .where(eq(agentRunConnectorDiagnosticRegistrations.runId, runId));
  signal.throwIfAborted();
  return actionOk();
}

async function deleteRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [run] = await db
    .select({
      sessionId: agentRuns.sessionId,
      orgId: agentRuns.orgId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  const [session] = run
    ? await db
        .select({ agentId: agentSessions.agentId })
        .from(agentSessions)
        .where(eq(agentSessions.id, run.sessionId))
        .limit(1)
    : [];
  signal.throwIfAborted();
  const runThreadRows = await db
    .select({ id: chatEvents.chatThreadId })
    .from(chatEvents)
    .where(eq(chatEvents.runId, runId));
  signal.throwIfAborted();
  const runThreadIds = runThreadRows.map((row) => {
    return row.id;
  });
  if (runThreadIds.length > 0) {
    await db.delete(chatEvents).where(eq(chatEvents.runId, runId));
    signal.throwIfAborted();
    await db
      .delete(chatThreads)
      .where(
        and(
          inArray(chatThreads.id, runThreadIds),
          notExists(
            db
              .select({ id: chatEvents.id })
              .from(chatEvents)
              .where(eq(chatEvents.chatThreadId, chatThreads.id)),
          ),
        ),
      );
    signal.throwIfAborted();
  }
  await db.delete(agentRunQueue).where(eq(agentRunQueue.runId, runId));
  signal.throwIfAborted();
  await db.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, runId));
  signal.throwIfAborted();
  await db.delete(agentRuns).where(eq(agentRuns.id, runId));
  signal.throwIfAborted();
  const sessionId = run?.sessionId ?? readString(body, "session_id");
  const owningOrgId = run?.orgId ?? readString(body, "org_id");
  const agentId = session?.agentId ?? readString(body, "compose_id");
  if (sessionId) {
    await db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    signal.throwIfAborted();
    if (agentId) {
      await db.delete(agents).where(eq(agents.id, agentId));
      signal.throwIfAborted();
    }
  }
  if (owningOrgId) {
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, owningOrgId));
    signal.throwIfAborted();
  }
  return actionOk();
}

async function seedHostedPublication(
  db: Db,
  run: { readonly id: string; readonly orgId: string; readonly userId: string },
  uploadedFile: { readonly id: string; readonly createdAt: Date },
  signal: AbortSignal,
): Promise<{
  readonly hostedSiteId: string;
  readonly hostedDeploymentId: string;
  readonly hostedArtifactId: string;
}> {
  const hostedSiteId = randomUUID();
  const hostedDeploymentId = randomUUID();
  const publicSlug = `cleanup-${randomUUID()}`;
  await db.transaction(async (tx) => {
    const scope = await canonicalizeHostedSiteScope(tx, {
      orgId: run.orgId,
      slug: publicSlug,
      createdFromRunId: run.id,
    });
    signal.throwIfAborted();
    await tx.insert(hostedSites).values({
      id: hostedSiteId,
      orgId: run.orgId,
      userId: run.userId,
      slug: publicSlug,
      ...scope,
      publicBrand: "vm0",
      publicSlug,
      createdFromRunId: run.id,
    });
    signal.throwIfAborted();
    await assertHostedDeploymentScope(tx, {
      siteId: hostedSiteId,
      orgId: run.orgId,
      runId: run.id,
    });
    signal.throwIfAborted();
    await tx.insert(hostedDeployments).values({
      id: hostedDeploymentId,
      siteId: hostedSiteId,
      orgId: run.orgId,
      userId: run.userId,
      runId: run.id,
      publicBrand: "vm0",
      status: "ready",
      deploymentVersion: 1,
      artifactUrl: `https://storage.example/${hostedDeploymentId}.zip`,
      r2Prefix: `hosted/${hostedDeploymentId}`,
      manifest: {
        version: 1,
        deploymentId: hostedDeploymentId,
        siteId: hostedSiteId,
        publicSlug,
        deploymentVersion: 1,
        createdAt: nowDate().toISOString(),
        artifactKind: "hosted-site",
        spaFallback: false,
        files: {},
      },
      manifestHash: "a".repeat(64),
      contentHash: "b".repeat(64),
      fileCount: 0,
      sizeBytes: 0,
      url: `https://${publicSlug}.sites.example`,
      readyAt: nowDate(),
    });
  });
  signal.throwIfAborted();
  const hostedArtifactId = randomUUID();
  await db.insert(artifacts).values({
    id: hostedArtifactId,
    orgId: run.orgId,
    authorUserId: run.userId,
    kind: "hosted-site",
    entityId: hostedSiteId,
    logicalKey: `site:${hostedSiteId}`,
    projectionFileId: uploadedFile.id,
    projectionCreatedAt: uploadedFile.createdAt,
    title: publicSlug,
  });
  signal.throwIfAborted();

  return { hostedSiteId, hostedDeploymentId, hostedArtifactId };
}

async function seedRunOwnershipForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [run] = await db
    .select({
      id: agentRuns.id,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("run not found");
  }

  const usageEventId = randomUUID();
  await db.insert(usageEvent).values({
    id: usageEventId,
    runId,
    idempotencyKey: randomUUID(),
    orgId: run.orgId,
    userId: run.userId,
    kind: "model",
    provider: `cleanup-test-${runId}`,
    category: "tokens.input",
    quantity: 1,
    status: "pending",
  });
  signal.throwIfAborted();

  const [uploadedFile] = await db
    .insert(runUploadedFiles)
    .values({
      runId,
      source: "web",
      externalId: randomUUID(),
      userId: run.userId,
      orgId: run.orgId,
      filename: "cleanup-owned.txt",
      contentType: "text/plain",
      sizeBytes: 7,
      url: `https://storage.example/${randomUUID()}`,
      metadata: {},
    })
    .returning({
      id: runUploadedFiles.id,
      createdAt: runUploadedFiles.createdAt,
    });
  signal.throwIfAborted();
  if (!uploadedFile) {
    return actionBadRequest("failed to seed uploaded file");
  }
  const fileArtifactId = randomUUID();
  await db.insert(artifacts).values({
    id: fileArtifactId,
    orgId: run.orgId,
    authorUserId: run.userId,
    kind: "file",
    entityId: uploadedFile.id,
    logicalKey: `file:${uploadedFile.id}`,
    projectionFileId: uploadedFile.id,
    projectionCreatedAt: uploadedFile.createdAt,
    title: "cleanup-owned.txt",
  });
  signal.throwIfAborted();

  const browserSessionId = randomUUID();
  await db.insert(browserSessions).values({
    chatThreadId: browserSessionId,
    runId,
    orgId: run.orgId,
    userId: run.userId,
    publicBrand: "vm0",
    name: "cleanup-browser",
    status: "suspended",
    timeoutMinutes: 30,
  });
  signal.throwIfAborted();

  const generationJobId = randomUUID();
  await db.insert(builtInGenerationJobs).values({
    id: generationJobId,
    type: "image",
    status: "completed",
    orgId: run.orgId,
    userId: run.userId,
    runId,
    request: {},
  });
  signal.throwIfAborted();

  const { hostedSiteId, hostedDeploymentId, hostedArtifactId } =
    await seedHostedPublication(db, run, uploadedFile, signal);

  return actionOk({
    usage_event_id: usageEventId,
    uploaded_file_id: uploadedFile.id,
    file_artifact_id: fileArtifactId,
    browser_session_id: browserSessionId,
    generation_job_id: generationJobId,
    hosted_site_id: hostedSiteId,
    hosted_deployment_id: hostedDeploymentId,
    hosted_artifact_id: hostedArtifactId,
  });
}

async function getRunOwnershipForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const usageEventId = readString(body, "usage_event_id");
  const uploadedFileId = readString(body, "uploaded_file_id");
  const fileArtifactId = readString(body, "file_artifact_id");
  const browserSessionId = readString(body, "browser_session_id");
  const generationJobId = readString(body, "generation_job_id");
  const hostedSiteId = readString(body, "hosted_site_id");
  const hostedDeploymentId = readString(body, "hosted_deployment_id");
  const hostedArtifactId = readString(body, "hosted_artifact_id");
  if (
    !usageEventId ||
    !uploadedFileId ||
    !fileArtifactId ||
    !browserSessionId ||
    !generationJobId ||
    !hostedSiteId ||
    !hostedDeploymentId ||
    !hostedArtifactId
  ) {
    return actionBadRequest("ownership ids are required");
  }

  const [usage] = await db
    .select({
      runId: usageEvent.runId,
      status: usageEvent.status,
      creditsCharged: usageEvent.creditsCharged,
    })
    .from(usageEvent)
    .where(eq(usageEvent.id, usageEventId));
  const [uploadedFile] = await db
    .select({ id: runUploadedFiles.id })
    .from(runUploadedFiles)
    .where(eq(runUploadedFiles.id, uploadedFileId));
  const [fileArtifact] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.id, fileArtifactId));
  const [browserSession] = await db
    .select({ id: browserSessions.chatThreadId, runId: browserSessions.runId })
    .from(browserSessions)
    .where(eq(browserSessions.chatThreadId, browserSessionId));
  const [generationJob] = await db
    .select({
      id: builtInGenerationJobs.id,
      runId: builtInGenerationJobs.runId,
    })
    .from(builtInGenerationJobs)
    .where(eq(builtInGenerationJobs.id, generationJobId));
  const [hostedSite] = await db
    .select({
      id: hostedSites.id,
      createdFromRunId: hostedSites.createdFromRunId,
    })
    .from(hostedSites)
    .where(eq(hostedSites.id, hostedSiteId));
  const [hostedDeployment] = await db
    .select({ id: hostedDeployments.id, runId: hostedDeployments.runId })
    .from(hostedDeployments)
    .where(eq(hostedDeployments.id, hostedDeploymentId));
  const [hostedArtifact] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.id, hostedArtifactId));
  signal.throwIfAborted();

  return actionOk({
    usage_event: usage ?? null,
    uploaded_file: uploadedFile ?? null,
    file_artifact: fileArtifact ?? null,
    browser_session: browserSession ?? null,
    generation_job: generationJob ?? null,
    hosted_site: hostedSite ?? null,
    hosted_deployment: hostedDeployment ?? null,
    hosted_artifact: hostedArtifact ?? null,
  });
}

async function deleteRunOwnershipForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const ids = [
    readString(body, "file_artifact_id"),
    readString(body, "hosted_artifact_id"),
  ].filter((id): id is string => {
    return id !== null;
  });
  if (ids.length > 0) {
    await db.delete(artifacts).where(inArray(artifacts.id, ids));
  }
  const usageEventId = readString(body, "usage_event_id");
  if (usageEventId) {
    await db.delete(usageEvent).where(eq(usageEvent.id, usageEventId));
  }
  const browserSessionId = readString(body, "browser_session_id");
  if (browserSessionId) {
    await db
      .delete(browserSessions)
      .where(eq(browserSessions.chatThreadId, browserSessionId));
  }
  const generationJobId = readString(body, "generation_job_id");
  if (generationJobId) {
    await db
      .delete(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.id, generationJobId));
  }
  const hostedSiteId = readString(body, "hosted_site_id");
  if (hostedSiteId) {
    await db.delete(hostedSites).where(eq(hostedSites.id, hostedSiteId));
  }
  signal.throwIfAborted();
  return actionOk();
}

async function seedRunnerJobForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  const expiresAt = readDate(body, "expires_at");
  if (!runId || !expiresAt) {
    return actionBadRequest("run_id and expires_at are required");
  }
  await db.insert(runnerJobQueue).values({
    runId,
    runnerGroup: readOptionalString(body, "runner_group") ?? "vm0/test",
    profile: readOptionalString(body, "profile") ?? "vm0/default",
    executionContext: {
      storageMounts: [],
      environment: null,
      platformEnvironment: {},
      resumeSession: null,
      encryptedSecrets: null,
      cliAgentType: "claude-code",
      apiStartTime: readDate(body, "api_start_time")?.getTime() ?? 0,
    },
    expiresAt,
  });
  signal.throwIfAborted();
  return actionOk();
}

async function seedQueueEntryForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  const expiresAt = readDate(body, "expires_at");
  if (!runId || !expiresAt) {
    return actionBadRequest("run_id and expires_at are required");
  }
  const [run] = await db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("run not found");
  }
  const encryptedParams =
    readOptionalString(body, "encrypted_params") ??
    (await encryptQueuedRunnerJobPayload(
      queuedRunnerJobPayload({
        runnerGroup: "vm0/test",
        profile: "vm0/default",
        cliAgentSessionId: null,
        reuseKey: null,
        executionContext: {
          storageMounts: [],
          environment: null,
          platformEnvironment: {},
          secretValueEnvironmentKeys: null,
          resumeSession: null,
          encryptedSecrets: null,
          connectorRuntimeTargets: [],
          cliAgentType: "claude-code",
          apiStartTime: MIN_EPOCH_MS_TIMESTAMP,
        },
      }),
    ));
  signal.throwIfAborted();
  await db.insert(agentRunQueue).values({
    runId,
    userId: run.userId,
    orgId: run.orgId,
    createdAt: run.createdAt,
    expiresAt,
    encryptedParams,
  });
  signal.throwIfAborted();
  return actionOk();
}

async function seedQueueMarkerForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [run] = await db
    .select({
      userId: agentRuns.userId,
      sessionId: agentRuns.sessionId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("run not found");
  }
  const [session] = await db
    .select({ agentId: agentSessions.agentId })
    .from(agentSessions)
    .where(eq(agentSessions.id, run.sessionId))
    .limit(1);
  signal.throwIfAborted();
  if (!session) {
    return actionBadRequest("session not found");
  }
  const [thread] = await db
    .insert(chatThreads)
    .values({
      userId: run.userId,
      agentId: session.agentId,
      title: "cron cleanup marker test",
    })
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!thread) {
    return actionBadRequest("failed to seed chat thread");
  }
  const marker = await db.transaction(async (tx) => {
    return await insertChatEvent(tx, {
      chatThreadId: thread.id,
      eventType: "run.queued",
      content: "Waiting in queue...",
      runId,
      runEventId: "queue:queued",
    });
  });
  signal.throwIfAborted();
  if (!marker) {
    return actionBadRequest("failed to seed queue marker");
  }
  return actionOk({ marker_id: marker.id, thread_id: thread.id });
}

async function attachRunThreadForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [run] = await db
    .select({ userId: agentRuns.userId, sessionId: agentRuns.sessionId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  if (!run) {
    return actionBadRequest("run not found");
  }
  const [session] = await db
    .select({ agentId: agentSessions.agentId })
    .from(agentSessions)
    .where(eq(agentSessions.id, run.sessionId));
  if (!session) {
    return actionBadRequest("session not found");
  }
  const [thread] = await db
    .insert(chatThreads)
    .values({
      userId: run.userId,
      agentId: session.agentId,
      title: "concurrent cleanup recheck",
    })
    .returning({ id: chatThreads.id });
  if (!thread) {
    return actionBadRequest("failed to seed chat thread");
  }
  await writeRunMetadata(db, {
    patch: { chatThreadId: thread.id },
    where: eq(agentRuns.id, runId),
  });
  signal.throwIfAborted();
  return actionOk({ thread_id: thread.id });
}

async function deleteRunThreadForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const threadId = readString(body, "thread_id");
  if (!threadId) {
    return actionBadRequest("thread_id is required");
  }
  await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
  signal.throwIfAborted();
  return actionOk();
}

async function seedExportJobForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const status = readString(body, "status");
  if (!status) {
    return actionBadRequest("status is required");
  }
  const [job] = await db
    .insert(exportJobs)
    .values({
      userId: readOptionalString(body, "user_id") ?? `user-${randomUUID()}`,
      orgId: readOptionalString(body, "org_id") ?? `org-${randomUUID()}`,
      status,
      createdAt: readDate(body, "created_at") ?? undefined,
      expiresAt: readNullableDate(body, "expires_at"),
      s3Key: readOptionalString(body, "s3_key") ?? null,
    })
    .returning({ id: exportJobs.id });
  signal.throwIfAborted();
  if (!job) {
    return actionBadRequest("failed to seed export job");
  }
  return actionOk({ export_job_id: job.id });
}

async function deleteExportJobForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const jobId = readString(body, "export_job_id");
  if (!jobId) {
    return actionBadRequest("export_job_id is required");
  }
  await db.delete(exportJobs).where(eq(exportJobs.id, jobId));
  signal.throwIfAborted();
  return actionOk();
}

async function getRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [run] = await db
    .select({ status: agentRuns.status, error: agentRuns.error })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ run: run ?? null });
}

async function getRunnerJobForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [job] = await db
    .select({ runId: runnerJobQueue.runId })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ runner_job: job ?? null });
}

async function getQueueEntryForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [entry] = await db
    .select({ runId: agentRunQueue.runId })
    .from(agentRunQueue)
    .where(eq(agentRunQueue.runId, runId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ queue_entry: entry ?? null });
}

async function getQueueMarkerRevokerForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const markerId = readString(body, "marker_id");
  if (!markerId) {
    return actionBadRequest("marker_id is required");
  }
  const [revoker] = await db
    .select({
      id: chatEvents.id,
      revokesEventId: chatEvents.revokesEventId,
      runEventId: chatEvents.runEventId,
    })
    .from(chatEvents)
    .where(eq(chatEvents.revokesEventId, markerId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ queue_marker_revoker: revoker ?? null });
}

async function getExportJobForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const jobId = readString(body, "export_job_id");
  if (!jobId) {
    return actionBadRequest("export_job_id is required");
  }
  const [job] = await db
    .select({ status: exportJobs.status, error: exportJobs.error })
    .from(exportJobs)
    .where(eq(exportJobs.id, jobId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ export_job: job ?? null });
}

const TEST_TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const;

async function transitionRunTerminalForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readString(body, "run_id");
  const status = readString(body, "status");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const terminalStatus = TEST_TERMINAL_RUN_STATUSES.find((candidate) => {
    return candidate === status;
  });
  if (!terminalStatus) {
    return actionBadRequest("terminal status is required");
  }
  const updated = await db.transaction(async (tx) => {
    const [run] = await transitionAgentRunsToTerminal(tx, {
      values: {
        status: terminalStatus,
        completedAt: nowDate(),
        error:
          terminalStatus === "completed"
            ? null
            : `Run entered ${terminalStatus} in endpoint integration fixture`,
      },
      conditions: [
        eq(agentRuns.id, runId),
        inArray(agentRuns.status, ["pending", "running"]),
      ],
    });
    return run;
  });
  signal.throwIfAborted();
  return updated ? actionOk() : actionBadRequest("active run not found");
}

const cronCleanupSandboxesActionHandlers = {
  "seed-run": seedRunForAction,
  "seed-run-ownership": seedRunOwnershipForAction,
  "attach-run-thread": attachRunThreadForAction,
  "delete-run": deleteRunForAction,
  "delete-run-ownership": deleteRunOwnershipForAction,
  "delete-run-thread": deleteRunThreadForAction,
  "seed-runner-job": seedRunnerJobForAction,
  "seed-queue-entry": seedQueueEntryForAction,
  "seed-queue-marker": seedQueueMarkerForAction,
  "seed-export-job": seedExportJobForAction,
  "delete-export-job": deleteExportJobForAction,
  "get-run": getRunForAction,
  "get-run-ownership": getRunOwnershipForAction,
  "get-runner-job": getRunnerJobForAction,
  "get-queue-entry": getQueueEntryForAction,
  "get-queue-marker-revoker": getQueueMarkerRevokerForAction,
  "get-export-job": getExportJobForAction,
  "seed-connector-diagnostic-registration":
    seedConnectorDiagnosticRegistrationForAction,
  "get-connector-diagnostic-registration":
    getConnectorDiagnosticRegistrationForAction,
  "corrupt-connector-diagnostic-registration":
    corruptConnectorDiagnosticRegistrationForAction,
  "delete-connector-diagnostic-registration":
    deleteConnectorDiagnosticRegistrationForAction,
  "transition-run-terminal": transitionRunTerminalForAction,
} satisfies Record<
  CronCleanupSandboxesAction,
  CronCleanupSandboxesActionHandler
>;

const mutateTestCronCleanupSandboxesState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.data as Record<string, unknown>;
    const db = set(writeDb$);
    const handler = cronCleanupSandboxesActionHandlers[bodyResult.data.action];
    return await handler(db, body, signal);
  },
);

const cleanupTestCronCleanupSandboxesState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(cleanupBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = await set(
      cleanupSandboxes$,
      { kind: "fixtures", ...bodyResult.data },
      signal,
    );
    return { status: 200 as const, body };
  },
);

export const testCronCleanupSandboxesStateRoutes: readonly RouteEntry[] = [
  {
    route: testCronCleanupSandboxesStateContract.action,
    handler: mutateTestCronCleanupSandboxesState$,
  },
  {
    route: testCronCleanupSandboxesStateContract.cleanup,
    handler: cleanupTestCronCleanupSandboxesState$,
  },
];
