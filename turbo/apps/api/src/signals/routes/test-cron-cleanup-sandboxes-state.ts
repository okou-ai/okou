import { randomUUID } from "node:crypto";

import {
  type TestCronCleanupSandboxesStateActionBody,
  testCronCleanupSandboxesStateContract,
} from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { triggerSourceSchema } from "@okouai/api-contracts/contracts/logs";
import { agentRunConnectorDiagnosticRegistrationPayloadSchema } from "@okouai/api-contracts/contracts/runners";
import { agents } from "@okouai/db/schema/agent";
import { artifacts } from "@okouai/db/schema/artifact";
import { browserSessions } from "@okouai/db/schema/browser-session";
import { builtInGenerationJobs } from "@okouai/db/schema/built-in-generation-job";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { hostedDeployments, hostedSites } from "@okouai/db/runtime/hosted-site";
import {
  assertHostedDeploymentScope,
  canonicalizeHostedSiteScope,
} from "../services/hosted-site-scope.service";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import {
  billingRunAttributionWrite,
  type BillingRun,
} from "../services/managed-usage-attribution";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { command } from "ccstate";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import { normalizeRunMetadata } from "../services/agent-run-metadata-write.service";
import {
  releaseNeverStartedRunSlots,
  transitionAgentRunsToTerminal,
} from "../services/agent-run-terminal-transition.service";
import { deleteArtifactCatalogForHostedSiteId } from "../services/artifact-catalog-deletion.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { ensureOrgMetadataPlanEntitlement } from "../services/org-plan-entitlements.service";

const actionBody$ = bodyResultOf(testCronCleanupSandboxesStateContract.action);

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
  ReturnType<typeof actionOk> | ReturnType<typeof actionBadRequest>;
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

  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0027; new non-billing transactions are prohibited.
  await db.transaction(async (tx) => {
    const metadataRows = await tx
      .insert(orgMetadataCanonicalWrites)
      .values({
        orgId,
        tier: "limited-free-1",
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
  // Lifecycle-only fixtures intentionally keep null run metadata.
  const runMetadata = threadless
    ? normalizeRunMetadata({ triggerSource: triggerSource.data })
    : null;
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0028; new non-billing transactions are prohibited.
  const run = await db.transaction(async (tx) => {
    const [created] = await tx
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
        runnerGroup: readOptionalString(body, "runner_group"),
        cancellationRecoveryCompleted: readOptionalBoolean(
          body,
          "cancellation_recovery_completed",
        ),
        ...runMetadata,
      })
      .returning({
        id: agentRuns.id,
        sandboxId: agentRuns.sandboxId,
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        startedAt: sql`${agentRuns.createdAt}::text`.mapWith(pgTextDecoder),
        triggerSource: agentRuns.triggerSource,
        threadId: agentRuns.chatThreadId,
      });
    signal.throwIfAborted();
    if (!created) {
      return undefined;
    }
    const capture = billingRunAttributionWrite(created);
    await tx
      .insert(billingRunAttribution)
      .values(capture.values)
      .onConflictDoNothing();
    signal.throwIfAborted();
    return created;
  });
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("failed to seed run");
  }
  if (["pending", "running"].includes(status)) {
    await db.insert(activeAgentRuns).values({
      runId: run.id,
      orgId,
      userId,
      lastHeartbeatAt:
        readDate(body, "last_heartbeat_at") ??
        readDate(body, "created_at") ??
        nowDate(),
    });
    signal.throwIfAborted();
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
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0029; new non-billing transactions are prohibited.
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
      linkLayoutSegment: "okou",
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
      linkLayoutSegment: "okou",
      status: "ready",
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

async function seedOwnershipUsage(
  db: Db,
  run: BillingRun,
  signal: AbortSignal,
): Promise<string> {
  const usageEventId = randomUUID();
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0030; new non-billing transactions are prohibited.
  await db.transaction(async (tx) => {
    const capture = billingRunAttributionWrite(run);
    await tx
      .insert(billingRunAttribution)
      .values(capture.values)
      .onConflictDoNothing();
    await tx.insert(usageEvent).values({
      id: usageEventId,
      runId: run.id,
      idempotencyKey: randomUUID(),
      orgId: run.orgId,
      userId: run.userId,
      kind: "model",
      provider: `cleanup-test-${run.id}`,
      category: "tokens.input",
      quantity: 1,
      status: "pending",
      billingRunId: run.id,
      billingContext: "run",
      billingAnchorAt: sql`${run.startedAt}::timestamp`,
    });
    await tx
      .update(billingRunAttribution)
      .set({ usageObserved: true })
      .where(
        and(
          eq(billingRunAttribution.runId, run.id),
          eq(billingRunAttribution.orgId, run.orgId),
          eq(billingRunAttribution.userId, run.userId),
          eq(billingRunAttribution.usageObserved, false),
        ),
      );
    signal.throwIfAborted();
  });
  signal.throwIfAborted();

  return usageEventId;
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
      startedAt: sql`${agentRuns.createdAt}::text`.mapWith(pgTextDecoder),
      triggerSource: agentRuns.triggerSource,
      threadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("run not found");
  }

  const usageEventId = await seedOwnershipUsage(db, run, signal);

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
    billingRunId: run.id,
    billingContext: "run",
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
    .select({
      id: runUploadedFiles.id,
      runId: runUploadedFiles.runId,
      userId: runUploadedFiles.userId,
      orgId: runUploadedFiles.orgId,
    })
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
  const uploadedFileId = readString(body, "uploaded_file_id");
  if (uploadedFileId) {
    await db
      .delete(runUploadedFiles)
      .where(eq(runUploadedFiles.id, uploadedFileId));
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0031; new non-billing transactions are prohibited.
    await db.transaction(async (tx) => {
      await deleteArtifactCatalogForHostedSiteId(tx, hostedSiteId);
      await tx.delete(hostedSites).where(eq(hostedSites.id, hostedSiteId));
    });
  }
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
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0032; new non-billing transactions are prohibited.
  const updated = await db.transaction(async (tx) => {
    const transitions = await transitionAgentRunsToTerminal(tx, {
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
    await releaseNeverStartedRunSlots(tx, transitions);
    return transitions[0];
  });
  signal.throwIfAborted();
  return updated ? actionOk() : actionBadRequest("active run not found");
}

const cronCleanupSandboxesActionHandlers = {
  "seed-run": seedRunForAction,
  "seed-run-ownership": seedRunOwnershipForAction,
  "delete-run": deleteRunForAction,
  "delete-run-ownership": deleteRunOwnershipForAction,
  "get-run": getRunForAction,
  "get-run-ownership": getRunOwnershipForAction,
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

export const testCronCleanupSandboxesStateRoutes: readonly RouteEntry[] = [
  {
    route: testCronCleanupSandboxesStateContract.action,
    handler: mutateTestCronCleanupSandboxesState$,
  },
];
