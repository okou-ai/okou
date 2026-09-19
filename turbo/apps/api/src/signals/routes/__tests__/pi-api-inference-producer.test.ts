import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getCustomConnectorSkillStorageName,
  getCustomSkillStorageName,
} from "@okouai/core/storage-names";
import { DISABLED_PAID_TOOLS_ENV_VAR } from "@okouai/api-contracts/contracts/paid-tools";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import {
  CHAT_RUN_CONTENT_POLICY_REJECTED_MESSAGE,
  CHAT_RUN_USAGE_LIMIT_MESSAGE,
  CHAT_RUN_UNSUPPORTED_MODEL_MESSAGE,
} from "@okouai/api-contracts/contracts/errors";
import { testPiResourceIndexWorkContract } from "@okouai/api-contracts/contracts/test-pi-resource-index-work";
import {
  OFFICIAL_RUNNER_TOKEN_PREFIX,
  PI_DEFERRED_SANDBOX_HEADER,
  runnersJobClaimContract,
} from "@okouai/api-contracts/contracts/runners";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { UsagePricingResolution } from "../../context/usage-pricing-resolution";
import { createDeferredPromise, settle } from "../../utils";
import { runnersRoutes } from "../runners";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { testPiResourceIndexWorkRoutes } from "../test-pi-resource-index-work";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { setPaidToolDisabled } from "./helpers/paid-tools";
import {
  configureNativeCliArtifact,
  createChatEventsFixture,
  createPiApiFirstTurnUsagePricingResolution,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
  USER_OWNED_GPT_FAST_BDD_ROUTES,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import {
  piResponsesContentSse,
  piResponsesTextSse,
  nativeCodexSseResponse,
} from "./helpers/pi-responses";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import {
  removePiInferenceFixture,
  removePiInferenceFixtures,
} from "../../../test-fixtures/pi-inference-lifecycle";
import { waitForDeferredBlocker } from "../../../test-fixtures/pi-deferred-lock";
import {
  captureApiTestConnectorCatalogCleanup,
  installApiTestConnectorCatalog,
  invalidateApiTestConnectorCatalogCompatibility,
  withApiTestConnectorCatalogSource,
} from "../../../test-fixtures/connector-catalog";
import { withStableAgentPromptBuildCountFixture } from "../../../test-fixtures/pi-stable-context";

const context = testContext();
const billing = createBillingMediaApi(context);
const workflows = createWorkflowsBddApi(context);
const {
  api,
  bdd,
  chat,
  misc,
  webhooks,
  entitledChatActor,
  configureBuiltInPiModel,
  configureUserOwnedGptPiModel,
  upsertOrgModelProvider,
  sendChatRun,
  waitForRunStatus,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
  publishPendingPiInstructions,
  claimChatRun,
  failChatRun,
  completeChatRunOk,
  queueCapabilityProvenPiRun,
} = createChatEventsFixture(context);

const SELECTED_MODEL = "deepseek-v4.1-flash";
const PROVIDER_URL = "https://api.deepseek.com/responses";

async function requestStateAction(body: Record<string, unknown>) {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testCronCleanupSandboxesStateRoutes,
  });
  const response = await app.request(
    "/api/test/cron-cleanup-sandboxes-state/action",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Scoped state action failed with ${response.status}: ${await response.text()}`,
    );
  }
  return z
    .object({ ok: z.literal(true) })
    .passthrough()
    .parse(await response.json());
}

async function cleanupRuns(
  runIds: readonly string[],
  orgIds: readonly string[],
  usagePricingResolution: UsagePricingResolution,
) {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testCronCleanupSandboxesStateRoutes,
    usagePricingResolution,
  });
  const response = await app.request(
    "/api/test/cron-cleanup-sandboxes-state/cleanup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runIds,
        orgIds,
        chatThreadIds: [],
        exportJobIds: [],
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Scoped cleanup failed with ${response.status}: ${await response.text()}`,
    );
  }
  return {
    status: response.status,
    body: z
      .object({ cleaned: z.number(), errors: z.number() })
      .passthrough()
      .parse(await response.json()),
  };
}

async function cleanupRun(
  runId: string,
  orgId: string,
  usagePricingResolution: UsagePricingResolution,
) {
  return await cleanupRuns([runId], [orgId], usagePricingResolution);
}

async function enableDurablePi(
  actor: Awaited<ReturnType<typeof entitledChatActor>>["actor"],
) {
  const orgId = requireOrgId(actor);
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId },
    {
      [FeatureSwitchKey.PiLoop]: true,
      [FeatureSwitchKey.PiDeferredSandbox]: true,
    },
  );
  return orgId;
}

// Infrastructure exception: the synthetic process-loss fixture must observe the
// transient ownership clock to prove each sequential recovery claim uses fresh time.
async function readRecoveryDeadline(runId: string): Promise<number> {
  const response = await requestStateAction({
    action: "get-pi-inference-recovery-deadline",
    run_id: runId,
  });
  const deadline = z
    .object({ recovery_deadline: z.string().datetime() })
    .parse(response).recovery_deadline;
  return new Date(deadline).getTime();
}

async function seedProducerRecoveryRun(
  sourceRunId: string,
  kind: "ready" | "publishing",
  options?: {
    readonly omitBillingCapture?: boolean;
    readonly missingModelKey?: boolean;
    readonly deadlineAt?: Date;
  },
): Promise<string> {
  const response = await requestStateAction({
    action: "seed-pi-inference-recovery",
    source_run_id: sourceRunId,
    kind,
    ...(options?.omitBillingCapture ? { omit_billing_capture: true } : {}),
    ...(options?.missingModelKey ? { missing_model_key: true } : {}),
    ...(options?.deadlineAt
      ? { deadline_at: options.deadlineAt.toISOString() }
      : {}),
  });
  return z.object({ run_id: z.string().uuid() }).parse(response).run_id;
}

async function expirePiInference(runId: string, deadlineAt = new Date(0)) {
  await requestStateAction({
    action: "expire-pi-inference",
    run_id: runId,
    deadline_at: deadlineAt.toISOString(),
  });
}

async function withPiTestLock<T>(
  kind: "org-sandbox-capacity" | "agent-run-row",
  key: string,
  operation: (lock: {
    readonly waitForBlocked: (minimum?: number) => Promise<number>;
  }) => Promise<T>,
): Promise<T> {
  const lockId = randomUUID();
  const holding = requestStateAction({
    action: "hold-pi-inference-test-lock",
    lock_id: lockId,
    lock_kind: kind,
    key,
  });
  let holderPid: number | undefined;
  await expect
    .poll(async () => {
      const state = z
        .object({ held: z.boolean(), pid: z.number().nullable() })
        .parse(
          await requestStateAction({
            action: "get-pi-inference-test-lock",
            lock_id: lockId,
          }),
        );
      holderPid = state.pid ?? undefined;
      return state.held;
    })
    .toBe(true);
  if (holderPid === undefined) {
    throw new Error("Expected Pi test lock backend pid");
  }
  const blockerPid = holderPid;
  const result = await settle(
    operation({
      waitForBlocked: async (minimum) => {
        return await waitForDeferredBlocker(blockerPid, minimum);
      },
    }),
    context.signal,
  );
  await requestStateAction({
    action: "release-pi-inference-test-lock",
    lock_id: lockId,
  });
  await holding;
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function expectNoDeferredPiRun(runId: string, runnerGroup: string) {
  const runnerId = randomUUID();
  await api.requestHeartbeatRunner(true, [200], {
    runnerId,
    group: runnerGroup,
  });
  const response = await accept(
    setupApp({ context, routes: runnersRoutes })(runnersJobClaimContract).claim(
      {
        params: { id: runId },
        headers: {
          authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        extraHeaders: { [PI_DEFERRED_SANDBOX_HEADER]: "1" },
        body: {
          runnerIdentity: { runnerId, heartbeatGeneration: 1 },
          capabilities: { piModelConfigGenerations: [1, 2, 3, 4] },
        },
      },
    ),
    [404],
  );
  expect(response.body.error.message).toBe("Job not found in queue");
}

async function claimDeferredPiRun(runId: string, runnerGroup: string) {
  const runnerId = randomUUID();
  await api.requestHeartbeatRunner(true, [200], {
    runnerId,
    group: runnerGroup,
  });
  const response = await accept(
    setupApp({ context, routes: runnersRoutes })(runnersJobClaimContract).claim(
      {
        params: { id: runId },
        headers: {
          authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        extraHeaders: { [PI_DEFERRED_SANDBOX_HEADER]: "1" },
        body: {
          runnerIdentity: { runnerId, heartbeatGeneration: 1 },
          capabilities: { piModelConfigGenerations: [1, 2, 3, 4] },
        },
      },
    ),
    [200],
  );
  return { claim: response.body, runnerId };
}

async function releaseDeferredPiRun(
  runId: string,
  runnerId: string,
  claim: Awaited<ReturnType<typeof claimDeferredPiRun>>["claim"],
) {
  const handoff = claim.piLaunchConfig?.apiFirstTurn;
  if (!handoff || handoff.schemaVersion !== 2) {
    throw new Error("Expected a deferred Pi claim fence");
  }
  await accept(
    setupApp({ context, routes: runnersRoutes })(
      runnersJobClaimContract,
    ).release({
      params: { id: runId },
      headers: {
        authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
      },
      body: {
        runnerId,
        ownerEpoch: handoff.ownerEpoch,
        generation: handoff.generation,
        proof: "destroyed",
      },
    }),
    [200],
  );
}

describe("durable Pi API producer", () => {
  it("uses complete published context after permission expiry and revocation", async () => {
    const capturedAt = Date.parse("2026-09-17T00:00:00.000Z");
    mockNow(capturedAt);
    configureNativeCliArtifact();
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const providerBodies: string[] = [];
    const resourceArchiveReadsAtProvider: number[] = [];
    let resourceArchiveReads = 0;
    let providerCalls = 0;
    server.use(
      http.post(PROVIDER_URL, async ({ request }) => {
        resourceArchiveReadsAtProvider.push(resourceArchiveReads);
        providerCalls += 1;
        providerBodies.push(JSON.stringify(await request.json()));
        return new HttpResponse(
          piResponsesTextSse("stable context answer", providerCalls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const first = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "seed the stable context projection",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, first.runId, "completed", 10_000);

    const workflowId = await workflows.createWorkflow(actor, {
      agentId,
      name: `stable-membership-${randomUUID()}`,
    });
    const creationWork = await accept(
      setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
        testPiResourceIndexWorkContract,
      ).run({
        body: {
          versionIds: ["0".repeat(64)],
          stableContextOwner: { orgId, userId: actor.userId, agentId },
        },
      }),
      [200],
    );
    expect(creationWork.body.stableContext.ready).toBeGreaterThanOrEqual(1);
    let archiveReadsAfterWorkflowCreate = 0;
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, () => {
        archiveReadsAfterWorkflowCreate += 1;
        return HttpResponse.json(
          { error: "workflow-add publication unexpectedly fetched an archive" },
          { status: 503 },
        );
      }),
    );
    const workflowAdded = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "use the workflow-add publication",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, workflowAdded.runId, "completed", 10_000);
    expect(archiveReadsAfterWorkflowCreate).toBe(0);
    mockPiResourceArchiveDownloads();

    const sourceAgent = await bdd.createAgent(actor, {
      displayName: `Stable Copy Source ${randomUUID()}`,
      visibility: "private",
    });
    onTestFinished(async () => {
      await bdd.deleteAgent(actor, sourceAgent.agentId);
    });
    const copiedWorkflowName = `stable-copy-${randomUUID()}`;
    const sourceWorkflowId = await workflows.createWorkflow(actor, {
      agentId: sourceAgent.agentId,
      name: copiedWorkflowName,
      visibility: "private",
      description: `Published copy description ${randomUUID()}`,
      instruction: `Published copy instruction ${randomUUID()}`,
    });
    const copiedWorkflowId = await workflows.copyWorkflow(
      actor,
      sourceWorkflowId,
      agentId,
    );
    const copyWork = await accept(
      setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
        testPiResourceIndexWorkContract,
      ).run({
        body: {
          versionIds: ["0".repeat(64)],
          stableContextOwner: { orgId, userId: actor.userId, agentId },
        },
      }),
      [200],
    );
    expect(copyWork.body.stableContext.ready).toBeGreaterThanOrEqual(1);
    mockPiResourceArchiveDownloads(false, () => {
      resourceArchiveReads += 1;
    });
    resourceArchiveReads = 0;
    const copyProviderIndex = providerCalls;
    const workflowCopied = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "use the workflow-copy publication",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, workflowCopied.runId, "completed", 10_000);
    expect(resourceArchiveReadsAtProvider[copyProviderIndex]).toBe(0);
    expect(providerBodies.at(-1)).toContain(copiedWorkflowName);

    await workflows.publishWorkflow(actor, copiedWorkflowId);
    const publishWork = await accept(
      setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
        testPiResourceIndexWorkContract,
      ).run({
        body: {
          versionIds: ["0".repeat(64)],
          stableContextOwner: { orgId, userId: actor.userId, agentId },
        },
      }),
      [200],
    );
    expect(publishWork.body.stableContext.ready).toBeGreaterThanOrEqual(1);
    resourceArchiveReads = 0;
    const publishProviderIndex = providerCalls;
    const workflowPublished = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "use the workflow-publish publication",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, workflowPublished.runId, "completed", 10_000);
    expect(resourceArchiveReadsAtProvider[publishProviderIndex]).toBe(0);
    expect(providerBodies.at(-1)).toContain(copiedWorkflowName);

    await workflows.demoteWorkflow(actor, copiedWorkflowId);
    const demoteWork = await accept(
      setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
        testPiResourceIndexWorkContract,
      ).run({
        body: {
          versionIds: ["0".repeat(64)],
          stableContextOwner: { orgId, userId: actor.userId, agentId },
        },
      }),
      [200],
    );
    expect(demoteWork.body.stableContext.ready).toBeGreaterThanOrEqual(1);
    resourceArchiveReads = 0;
    const demoteProviderIndex = providerCalls;
    const workflowDemoted = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "use the workflow-demotion publication",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, workflowDemoted.runId, "completed", 10_000);
    expect(resourceArchiveReadsAtProvider[demoteProviderIndex]).toBe(0);
    expect(providerBodies.at(-1)).toContain(copiedWorkflowName);
    mockPiResourceArchiveDownloads();

    await misc.deleteWorkflow(actor, workflowId, [204]);
    await api.applyUserPermissionGrant(actor, {
      agentId,
      connectorSlug: "slack",
      permission: "conversations:read",
      action: "allow",
      expiresIn: "1h",
    });
    await api.enableAgentConnectors(actor, agentId, ["slack"]);
    const expiringInstructions = `Expiring projection ${randomUUID()}`;
    await bdd.updateAgentInstructions(actor, agentId, expiringInstructions);
    const firstWork = await accept(
      setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
        testPiResourceIndexWorkContract,
      ).run({
        body: {
          versionIds: ["0".repeat(64)],
          stableContextOwner: { orgId, userId: actor.userId, agentId },
        },
      }),
      [200],
    );
    expect(firstWork.body.stableContext.ready).toBeGreaterThanOrEqual(1);

    let archiveReadsAfterWorkflowDelete = 0;
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, () => {
        archiveReadsAfterWorkflowDelete += 1;
        return HttpResponse.json(
          { error: "write-published context unexpectedly fetched an archive" },
          { status: 503 },
        );
      }),
    );
    const workflowDeleted = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "use the workflow-deletion publication",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, workflowDeleted.runId, "completed", 10_000);
    expect(archiveReadsAfterWorkflowDelete).toBe(0);

    const catalogSourceId = randomUUID().replaceAll("-", "").repeat(2);
    await withApiTestConnectorCatalogSource(
      {
        bucket: `stable-context-authority-${randomUUID()}`,
        sourceId: catalogSourceId,
      },
      async () => {
        const cleanupCatalog = captureApiTestConnectorCatalogCleanup();
        onTestFinished(cleanupCatalog);
        await installApiTestConnectorCatalog({
          catalogVersion: `stable-context-authority-${randomUUID()}`,
        });
        await invalidateApiTestConnectorCatalogCompatibility();
        await expect(
          updateFeatureSwitchesForUser(
            context,
            { ...actor, orgId },
            { [FeatureSwitchKey.DeliveryFormatGuidance]: true },
          ),
        ).resolves.toBeUndefined();
        const callsBeforeCatalogRejection = providerCalls;
        await expect(
          sendChatRun(
            actor,
            {
              agentId,
              prompt: "reject invalid catalog authority before transport",
              model: SELECTED_MODEL,
            },
            usagePricingResolution,
          ),
        ).rejects.toThrow(
          "Unknown response status 500 for POST /api/chat/events",
        );
        expect(providerCalls).toBe(callsBeforeCatalogRejection);
      },
    );

    mockPiResourceArchiveDownloads();
    // Cross the one-hour grant horizon while retaining the captured fixture
    // timeline. Runner queue expiry is owned by PostgreSQL's clock.
    mockNow(capturedAt + 24 * 60 * 60 * 1000);
    const expired = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "reject the expired warm permission",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, expired.runId, "completed", 10_000);

    const expiredBoundary = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "/native-command",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();
    await expirePiInference(expiredBoundary.runId);
    await expect(
      cleanupRun(expiredBoundary.runId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({ body: { errors: 0 } });
    const expiredClaim = await claimDeferredPiRun(
      expiredBoundary.runId,
      runnerGroup,
    );
    expect(
      expiredClaim.claim.networkPolicies?.slack?.allow ?? [],
    ).not.toContain("conversations:read");
    await api.requestCancelRun(
      actor,
      expiredBoundary.runId,
      [200],
      usagePricingResolution,
    );
    await releaseDeferredPiRun(
      expiredBoundary.runId,
      expiredClaim.runnerId,
      expiredClaim.claim,
    );
    await waitForRunStatus(actor, expiredBoundary.runId, "cancelled", 10_000);

    await api.applyUserPermissionGrant(actor, {
      agentId,
      connectorSlug: "slack",
      permission: "conversations:read",
      action: "allow",
    });
    const refreshedWork = await accept(
      setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
        testPiResourceIndexWorkContract,
      ).run({
        body: {
          versionIds: ["0".repeat(64)],
          stableContextOwner: { orgId, userId: actor.userId, agentId },
        },
      }),
      [200],
    );
    expect(refreshedWork.body.stableContext.ready).toBeGreaterThanOrEqual(1);
    await api.replaceUserPermissionGrants(actor, {
      agentId,
      connectorSlug: "slack",
      grants: [],
    });
    const revokedBoundary = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "/native-command",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();
    await expirePiInference(revokedBoundary.runId);
    await expect(
      cleanupRun(revokedBoundary.runId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({ body: { errors: 0 } });
    const revokedClaim = await claimDeferredPiRun(
      revokedBoundary.runId,
      runnerGroup,
    );
    expect(
      revokedClaim.claim.networkPolicies?.slack?.allow ?? [],
    ).not.toContain("conversations:read");
    await api.requestCancelRun(
      actor,
      revokedBoundary.runId,
      [200],
      usagePricingResolution,
    );
    await releaseDeferredPiRun(
      revokedBoundary.runId,
      revokedClaim.runnerId,
      revokedClaim.claim,
    );
    await waitForRunStatus(actor, revokedBoundary.runId, "cancelled", 10_000);
    await api.enableAgentConnectors(actor, agentId, []);
    const instructions = `Worker-published instructions ${randomUUID()}`;
    const displayName = `Published identity ${randomUUID()}`;
    await bdd.updateAgentInstructions(actor, agentId, instructions);
    await bdd.updateAgentMetadata(actor, agentId, { displayName });
    const secondWork = await accept(
      setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
        testPiResourceIndexWorkContract,
      ).run({
        body: {
          versionIds: ["0".repeat(64)],
          stableContextOwner: { orgId, userId: actor.userId, agentId },
          removeStableContextResourceIndexes: {
            ownedStorageNames: [getCustomSkillStorageName(copiedWorkflowId)],
          },
        },
      }),
      [200],
    );
    expect(secondWork.body.stableContext.ready).toBeGreaterThanOrEqual(1);

    let archiveReadsAfterWorker = 0;
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, () => {
        archiveReadsAfterWorker += 1;
        return HttpResponse.json(
          { error: "ready context unexpectedly fetched an archive" },
          { status: 503 },
        );
      }),
    );
    const { buildCount, result: ready } =
      await withStableAgentPromptBuildCountFixture(async () => {
        return await sendChatRun(
          actor,
          {
            agentId,
            prompt: "use the worker-published projection",
            model: SELECTED_MODEL,
          },
          usagePricingResolution,
        );
      });
    expect(buildCount).toBe(0);
    onTestFinished(async () => {
      await flushWaitUntilForTest();
      await removePiInferenceFixtures({
        runIds: [
          first.runId,
          workflowAdded.runId,
          workflowCopied.runId,
          workflowPublished.runId,
          workflowDemoted.runId,
          workflowDeleted.runId,
          expired.runId,
          expiredBoundary.runId,
          revokedBoundary.runId,
          ready.runId,
        ],
        agentId,
        orgId,
      });
    });
    await waitForRunStatus(actor, ready.runId, "completed", 10_000);
    expect(archiveReadsAfterWorker).toBe(0);
    expect(providerCalls).toBe(8);
    expect(providerBodies.at(-1)).toContain(instructions);
    expect(providerBodies.at(-1)).toContain(displayName);
    expect(providerBodies.at(-1)).toContain(
      "Pick the delivery format before authoring",
    );
    expect(providerBodies.at(-1)).toContain("# Restricted Explicit Content");
  }, 45_000);

  it("keeps canonical and recaptured mount order aligned for two reverse-granted custom skills", async () => {
    configureNativeCliArtifact();
    bdd.acceptAgentStorageWrites();
    mockEnv(
      "R2_USER_STORAGES_BUCKET_NAME",
      `stable-custom-order-${randomUUID()}`,
    );
    const connectors = createConnectorBddApi(context);
    const storages = createStoragesBddApi(context);
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    const cleanupCatalog = captureApiTestConnectorCatalogCleanup();
    onTestFinished(cleanupCatalog);
    await installApiTestConnectorCatalog({
      catalogVersion: `stable-custom-order-${randomUUID()}`,
    });
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    let providerCalls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        providerCalls += 1;
        return new HttpResponse(
          piResponsesTextSse("ordered custom context", providerCalls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const suffix = randomUUID().slice(0, 8);
    const first = await connectors.createCustomConnector(actor, {
      kind: "http",
      displayName: "Stable Custom Order First",
      prefixTemplates: [`https://first-${suffix}.example.test/api/`],
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "none",
      skillMarkdown: "Use the first deterministic custom skill.",
    });
    const second = await connectors.createCustomConnector(actor, {
      kind: "http",
      displayName: "Stable Custom Order Second",
      prefixTemplates: [`https://second-${suffix}.example.test/api/`],
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "none",
      skillMarkdown: "Use the second deterministic custom skill.",
    });
    const ordered = [first, second].sort((left, right) => {
      return left.id.localeCompare(right.id);
    });
    await connectors.updateAgentCustomConnectors(
      actor,
      agentId,
      [...ordered].reverse().map((connector) => {
        return connector.id;
      }),
    );
    const skillVersions = await Promise.all(
      ordered.map(async (connector) => {
        return await storages.downloadStorage(actor, {
          name: getCustomConnectorSkillStorageName(connector.id),
          owner: "organization",
        });
      }),
    );

    const seeded = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "seed reverse-granted custom skills",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, seeded.runId, "completed", 10_000);
    await bdd.updateAgentInstructions(
      actor,
      agentId,
      `Recapture ordered custom skills ${randomUUID()}`,
    );
    const work = await accept(
      setupApp({ context, routes: testPiResourceIndexWorkRoutes })(
        testPiResourceIndexWorkContract,
      ).run({
        body: {
          versionIds: skillVersions.map((skill) => {
            return skill.versionId;
          }),
          stableContextOwner: { orgId, userId: actor.userId, agentId },
        },
      }),
      [200],
    );
    expect(work.body.stableContext.ready).toBeGreaterThanOrEqual(1);

    const { buildCount, result: ready } =
      await withStableAgentPromptBuildCountFixture(async () => {
        return await sendChatRun(
          actor,
          {
            agentId,
            prompt: "consume ordered custom skills",
            model: SELECTED_MODEL,
          },
          usagePricingResolution,
        );
      });
    expect(buildCount).toBe(0);
    await waitForRunStatus(actor, ready.runId, "completed", 10_000);
    expect(providerCalls).toBe(2);
    onTestFinished(async () => {
      await flushWaitUntilForTest();
      await removePiInferenceFixtures({
        runIds: [seeded.runId, ready.runId],
        agentId,
        orgId,
      });
    });
  }, 30_000);

  it.each(
    (
      [
        {
          provider: "codex-oauth-token",
          status: 429,
          code: "rate_limit_exceeded",
          reason: "provider_rate_limited",
        },
        {
          provider: "codex-oauth-token",
          status: 429,
          code: "usage_limit_reached",
          reason: "usage_limit",
        },
        {
          provider: "openai-api-key",
          status: 400,
          code: "model_not_found",
          reason: "unsupported_model",
        },
        {
          provider: "aws-bedrock",
          status: 429,
          code: "ThrottlingException",
          reason: "provider_rate_limited",
        },
        {
          provider: "aws-bedrock",
          status: 503,
          code: "ServiceUnavailableException",
          reason: "provider_server_error",
        },
        {
          provider: "openai-api-key",
          status: 429,
          code: "rate_limit_exceeded",
          reason: "provider_rate_limited",
        },
        {
          provider: "built-in",
          status: 503,
          code: "overloaded_error",
          reason: "provider_overloaded",
        },
        {
          provider: "built-in",
          status: 400,
          code: "unknown_error",
          reason: undefined,
        },
        ...(
          ["codex-oauth-token", "openai-api-key", "built-in"] as const
        ).flatMap((provider) => {
          return [
            {
              provider,
              status: 200,
              code: "stream_overload",
              message:
                "Our servers are currently overloaded. Please try again later.",
              reason: "provider_overloaded" as const,
            },
            {
              provider,
              status: 200,
              code: "stream_safety_refusal",
              message:
                "Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://example.invalid/policy",
              reason: "safety_policy_refusal" as const,
            },
          ];
        }),
      ] as const
    ).flatMap((scenario) => {
      return [
        { ...scenario, execution: "api" },
        ...("message" in scenario
          ? [{ ...scenario, execution: "sandbox" }]
          : []),
      ];
    }),
  )(
    "completes $execution $provider $code with its canonical reason without provider replay",
    async (scenario) => {
      configureNativeCliArtifact();
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const selectedModel =
        scenario.provider === "built-in"
          ? SELECTED_MODEL
          : scenario.provider === "aws-bedrock"
            ? "claude-sonnet-4-6"
            : "gpt-5.6-terra";
      let providerUrl = PROVIDER_URL;
      if (scenario.provider === "built-in") {
        await configureBuiltInPiModel(actor, selectedModel);
      } else if (scenario.provider === "aws-bedrock") {
        const { providerId } = await upsertOrgModelProvider(actor, {
          type: "aws-bedrock",
          authMethod: "api-key",
          selectedModel:
            "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/production",
          secrets: {
            AWS_BEARER_TOKEN_BEDROCK: "selected-bedrock-bearer",
            AWS_REGION: "us-east-1",
          },
        });
        await api.updateOrgModelPolicies(actor, [
          {
            model: selectedModel,
            isDefault: true,
            defaultProviderType: "aws-bedrock",
            credentialScope: "org",
            modelProviderId: providerId,
          },
        ]);
        providerUrl = "https://bedrock-runtime.us-east-1.amazonaws.com/*";
      } else {
        const route = USER_OWNED_GPT_FAST_BDD_ROUTES.find((candidate) => {
          return (
            candidate.type === scenario.provider &&
            candidate.selectedModel === selectedModel
          );
        });
        if (!route) {
          throw new Error("Expected a personal-provider Pi route fixture");
        }
        await configureUserOwnedGptPiModel(actor, route);
        providerUrl = route.endpoint;
      }
      const orgId = await enableDurablePi(actor);
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      let calls = 0;
      server.use(
        http.post(providerUrl, () => {
          calls += 1;
          if ("message" in scenario) {
            return nativeCodexSseResponse(
              `data: ${JSON.stringify(
                scenario.provider === "codex-oauth-token"
                  ? { type: "error", message: scenario.message }
                  : {
                      type: "response.failed",
                      response: {
                        status: "failed",
                        error: { message: scenario.message },
                      },
                    },
              )}\n\n`,
            );
          }
          if (scenario.provider === "aws-bedrock") {
            return HttpResponse.json(
              { __type: scenario.code, message: "Provider rejected request" },
              {
                status: scenario.status,
                headers: { "x-amzn-errortype": scenario.code },
              },
            );
          }
          return HttpResponse.json(
            {
              error: {
                code: scenario.code,
                message: "Provider rejected request",
              },
            },
            { status: scenario.status },
          );
        }),
      );
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt:
            scenario.execution === "sandbox"
              ? "/native-command"
              : "preserve the provider failure without replaying this turn",
          model: selectedModel,
          ...(scenario.provider === "built-in" ||
          scenario.provider === "aws-bedrock"
            ? {}
            : { runOptions: { codexServiceTier: "fast" as const } }),
        },
        usagePricingResolution,
      );
      onTestFinished(async () => {
        await flushWaitUntilForTest();
        await removePiInferenceFixture({ runId: run.runId, agentId, orgId });
      });
      if (scenario.execution === "sandbox" && "message" in scenario) {
        await flushWaitUntilForTest();
        await expect(
          cleanupRun(run.runId, orgId, usagePricingResolution),
        ).resolves.toMatchObject({
          body: { errors: 0 },
        });
        const { claim } = await claimDeferredPiRun(run.runId, runnerGroup);
        expect(claim.cliAgentType).toBe("pi");
        await webhooks.requestAgentComplete(
          {
            runId: run.runId,
            exitCode: 1,
            error: scenario.message,
            failureReason: scenario.reason,
          },
          { authorization: `Bearer ${claim.sandboxToken}` },
          [200],
        );
      }
      await waitForRunStatus(actor, run.runId, "failed", 10_000);
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "failed",
      });
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      const terminal = events.filter((event) => {
        return (
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      });
      expect(terminal).toMatchObject([{ eventType: "run.failed" }]);
      const failureEvent = terminal.find((event) => {
        return event.eventType === "run.failed";
      });
      expect(failureEvent?.failureReason).toBe(scenario.reason);
      if (scenario.reason === "safety_policy_refusal") {
        expect(failureEvent?.error).toBe(
          CHAT_RUN_CONTENT_POLICY_REJECTED_MESSAGE,
        );
      }
      if (scenario.reason === "usage_limit") {
        expect(failureEvent?.error).toBe(CHAT_RUN_USAGE_LIMIT_MESSAGE);
      }
      if (scenario.reason === "unsupported_model") {
        expect(failureEvent?.error).toBe(CHAT_RUN_UNSUPPORTED_MODEL_MESSAGE);
      }
      await expectNoDeferredPiRun(run.runId, runnerGroup);
      expect(calls).toBe(scenario.execution === "sandbox" ? 0 : 1);
    },
  );

  it("starts provider transport under held Sandbox capacity and completes without demand", async () => {
    configureNativeCliArtifact();
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    const providerBodies: unknown[] = [];
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async ({ request }) => {
        calls += 1;
        providerBodies.push(await request.json());
        if (calls === 1) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("durable direct answer", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const run = await withPiTestLock(
      "org-sandbox-capacity",
      orgId,
      async () => {
        const created = await sendChatRun(
          actor,
          {
            agentId,
            prompt: "answer without allocating a Sandbox",
            model: SELECTED_MODEL,
          },
          usagePricingResolution,
        );
        await expect(providerEntered.promise).resolves.toBeUndefined();
        await expectNoDeferredPiRun(created.runId, runnerGroup);
        return created;
      },
    );
    releaseProvider.resolve(undefined);
    await waitForRunStatus(actor, run.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "completed",
    });
    const firstEvents = (await chat.listThreadEvents(actor, run.threadId))
      .events;
    expect(
      firstEvents.some((event) => {
        return (
          event.runId === run.runId &&
          event.eventType === "output.message" &&
          JSON.stringify(event).includes("durable direct answer")
        );
      }),
    ).toBeTruthy();
    await billing.processOrgUsageEvents(actor, usagePricingResolution);
    const usage = await billing.readUsageRecord(actor);
    expect(usage.body.totalCredits).toBeGreaterThan(0);
    expect(usage.body.pagination.total).toBeGreaterThan(0);

    const followUp = await sendChatRun(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "continue from the durable answer",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, followUp.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(calls).toBe(2);
    expect(JSON.stringify(providerBodies[1])).toContain(
      "durable direct answer",
    );
  }, 90_000);

  it("publishes untouched H0 demand for native input without provider transport", async () => {
    configureNativeCliArtifact();
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(piResponsesTextSse("unexpected", calls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "/native-command",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();
    expect(calls).toBe(0);
    await expect(
      cleanupRun(run.runId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    const { claim, runnerId } = await claimDeferredPiRun(
      run.runId,
      runnerGroup,
    );
    expect(claim.piLaunchConfig).toMatchObject({
      schemaVersion: 2,
      apiFirstTurn: { continuation: { mode: "untouched-h0" } },
    });
    await api.requestCancelRun(actor, run.runId, [200], usagePricingResolution);
    await releaseDeferredPiRun(run.runId, runnerId, claim);
    await waitForRunStatus(actor, run.runId, "cancelled", 10_000);
  }, 90_000);

  it("lets canonical cancellation fence an in-flight provider without demand or replay", async () => {
    configureNativeCliArtifact();
    mockEnv("PI_INFERENCE_ORG_MAX_IN_FLIGHT", "1");
    const { actor, agentId } = await entitledChatActor();
    await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("cancelled late answer", 1),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }),
    );

    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "cancel after the provider fence",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;
    await api.requestCancelRun(actor, run.runId, [200], usagePricingResolution);
    await waitForRunStatus(actor, run.runId, "cancelled", 10_000);
    const protectedWhileUncertain = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "remain protected until late usage settles",
        model: SELECTED_MODEL,
        clientEventId: randomUUID(),
      },
      [429],
      { usagePricingResolution },
    );
    expect(protectedWhileUncertain.status).toBe(429);
    if (protectedWhileUncertain.status === 429) {
      expect(protectedWhileUncertain.body.error.code).toBe("PI_INFERENCE_BUSY");
    }
    releaseProvider.resolve(undefined);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.some((event) => {
        return (
          event.runId === run.runId && event.eventType === "output.message"
        );
      }),
    ).toBeFalsy();
    // Terminal uncertainty releases the technical reservation only after its
    // bounded grace. Expire that clock explicitly instead of waiting 55s.
    await expirePiInference(run.runId);
    const afterSettlement = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "start after the uncertain reservation settles",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, afterSettlement.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(calls).toBe(2);
  }, 90_000);

  it("fences stale output in the write transaction while settling observed usage", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("stale output must not publish", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "cancel at the durable output transaction",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;

    const queued = await withPiTestLock(
      "agent-run-row",
      run.runId,
      async (lock) => {
        const cancellation = api.requestCancelRun(
          actor,
          run.runId,
          [200],
          usagePricingResolution,
        );
        await lock.waitForBlocked();
        releaseProvider.resolve(undefined);
        return { cancellation };
      },
    );
    await queued.cancellation;
    await waitForRunStatus(actor, run.runId, "cancelled", 10_000);
    await expect
      .poll(async () => {
        await billing.processOrgUsageEvents(actor, usagePricingResolution);
        return (await billing.readUsageRecord(actor)).body.pagination.total;
      })
      .toBeGreaterThan(0);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.filter((event) => {
        return (
          event.runId === run.runId &&
          (event.eventType === "output.message" ||
            event.eventType === "run.completed")
        );
      }),
    ).toStrictEqual([]);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await billing.processOrgUsageEvents(actor, usagePricingResolution);
    const usage = await billing.readUsageRecord(actor);
    expect(usage.body.pagination.total).toBeGreaterThan(0);
    // Cancellation deliberately keeps the technical reservation until its
    // bounded grace expires. Move that clock past the deadline so this test's
    // completed ownership proof cannot consume the next test's global slot.
    await expirePiInference(run.runId);
  }, 90_000);

  it("rejects fleet-wide org overload before a second provider attempt", async () => {
    configureNativeCliArtifact();
    mockEnv("PI_INFERENCE_ORG_MAX_IN_FLIGHT", "1");
    const { actor, agentId } = await entitledChatActor();
    await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(piResponsesTextSse("protected answer", calls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const first = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "hold the only durable inference slot",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;
    const rejected = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "must not enter the provider",
        model: SELECTED_MODEL,
        clientEventId: randomUUID(),
      },
      [429],
      { usagePricingResolution },
    );
    expect(rejected.status).toBe(429);
    if (rejected.status === 429) {
      expect(rejected.body.error.code).toBe("PI_INFERENCE_BUSY");
    }
    expect(calls).toBe(1);

    releaseProvider.resolve(undefined);
    await waitForRunStatus(actor, first.runId, "completed", 10_000);
    await flushWaitUntilForTest();
  }, 90_000);

  it("rejects provider-wide overload across organizations before transport", async () => {
    configureNativeCliArtifact();
    mockEnv("PI_INFERENCE_PROVIDER_MAX_IN_FLIGHT", "1");
    const firstActor = await entitledChatActor();
    const secondActor = await entitledChatActor();
    await enableDurablePi(firstActor.actor);
    await enableDurablePi(secondActor.actor);
    await configureBuiltInPiModel(firstActor.actor, SELECTED_MODEL);
    await configureBuiltInPiModel(secondActor.actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("provider protected answer", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const first = await sendChatRun(
      firstActor.actor,
      {
        agentId: firstActor.agentId,
        prompt: "hold the provider-wide durable inference slot",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;
    const rejected = await chat.requestSendEvent(
      secondActor.actor,
      {
        agentId: secondActor.agentId,
        prompt: "must not cross this shared provider boundary",
        model: SELECTED_MODEL,
        clientEventId: randomUUID(),
      },
      [429],
      { usagePricingResolution },
    );
    expect(rejected.status).toBe(429);
    if (rejected.status === 429) {
      expect(rejected.body.error.code).toBe("PI_INFERENCE_BUSY");
    }
    expect(calls).toBe(1);

    releaseProvider.resolve(undefined);
    await waitForRunStatus(firstActor.actor, first.runId, "completed", 10_000);
    await flushWaitUntilForTest();
  }, 90_000);

  it("recovers a lost ready owner through one fresh fenced provider attempt", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesTextSse(`ready recovery answer ${calls}`, calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture a durable recovery recipe",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    const recoveryRunId = await seedProducerRecoveryRun(source.runId, "ready");

    await expect(
      cleanupRun(recoveryRunId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, recoveryRunId, "completed", 10_000);
    await flushWaitUntilForTest();

    expect(calls).toBe(2);
    await expect(api.readRun(actor, recoveryRunId)).resolves.toMatchObject({
      status: "completed",
    });
  }, 90_000);

  it("keeps recoverable owners beyond one maintenance batch out of generic timeout", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesTextSse(`recovery batch answer ${calls}`, calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture a recovery batch recipe",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    const recoveryRunIds: string[] = [];
    for (let index = 0; index < 21; index++) {
      recoveryRunIds.push(
        await seedProducerRecoveryRun(source.runId, "ready", {
          deadlineAt: new Date(index + 1),
        }),
      );
    }
    await expect(
      cleanupRuns(recoveryRunIds, [orgId], usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    expect(calls).toBe(21);
    const overflowRunId = recoveryRunIds.at(-1);
    if (!overflowRunId) {
      throw new Error("Expected one recovery owner beyond the batch");
    }
    await expect(api.readRun(actor, overflowRunId)).resolves.toMatchObject({
      status: "pending",
    });

    await expect(
      cleanupRun(overflowRunId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, overflowRunId, "completed", 10_000);
    expect(calls).toBe(22);
  }, 90_000);

  it("starts each sequential recovery deadline when that owner is claimed", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    server.use(
      http.post(PROVIDER_URL, () => {
        return new HttpResponse(piResponsesTextSse("deadline source", 1), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture sequential recovery deadlines",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    const recoveryRunIds = [
      await seedProducerRecoveryRun(source.runId, "ready", {
        deadlineAt: new Date(1),
      }),
      await seedProducerRecoveryRun(source.runId, "ready", {
        deadlineAt: new Date(2),
      }),
    ];

    const claimedDeadlines: number[] = [];
    let recoveredCalls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        const runId = recoveryRunIds[recoveredCalls];
        if (!runId) {
          throw new Error("Unexpected recovered provider attempt");
        }
        recoveredCalls += 1;
        claimedDeadlines.push(await readRecoveryDeadline(runId));
        if (recoveredCalls === 1) {
          await delay(5000, undefined, { signal: context.signal });
        }
        return new HttpResponse(
          piResponsesTextSse(
            `sequential recovery ${recoveredCalls}`,
            recoveredCalls,
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    await expect(
      cleanupRuns(recoveryRunIds, [orgId], usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    expect(recoveredCalls).toBe(2);
    const [firstDeadline, secondDeadline] = claimedDeadlines;
    if (firstDeadline === undefined || secondDeadline === undefined) {
      throw new Error("Expected both recovered ownership deadlines");
    }
    expect(secondDeadline - firstDeadline).toBeGreaterThan(4500);
    for (const runId of recoveryRunIds) {
      await expect(api.readRun(actor, runId)).resolves.toMatchObject({
        status: "completed",
      });
    }
  }, 90_000);

  it("preserves Sandbox-first recovery when durable resource capture fails", async () => {
    configureNativeCliArtifact();
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const orgId = requireOrgId(actor);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiDeferredSandbox]: true },
    );
    let archiveReads = 0;
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, () => {
        archiveReads += 1;
        return HttpResponse.json(
          { error: "archive unavailable" },
          { status: 503 },
        );
      }),
    );
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(piResponsesTextSse("unexpected", calls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const queued = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: "recover unavailable Pi resources in Sandbox",
      selectedModel: SELECTED_MODEL,
    });
    await completeChatRunOk(
      queued.anchor.runId,
      queued.anchorClaim.sandboxHeaders,
      { usagePricingResolution: queued.usagePricingResolution },
    );
    await flushWaitUntilForTest();
    expect(archiveReads).toBeGreaterThan(0);
    expect(calls).toBe(0);
    const claimed = await claimChatRun(runnerGroup, queued.run.runId);
    expect(claimed.claim.cliAgentType).toBe("pi");
    await api.requestCancelRun(
      actor,
      queued.run.runId,
      [200],
      queued.usagePricingResolution,
    );
    await waitForRunStatus(actor, queued.run.runId, "cancelled", 10_000);
    await failChatRun(
      queued.run.runId,
      claimed.sandboxHeaders,
      "Run cancelled",
    );
  }, 90_000);

  it("rejects a recovered ready owner with a missing model source without disrupting another actor", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const other = await entitledChatActor();
    await enableDurablePi(other.actor);
    await configureBuiltInPiModel(other.actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesTextSse("credential source", calls),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture a source that will be revoked",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(calls).toBe(1);

    // Platform-managed key removal has no product API. Capture an absent key
    // only in the synthetic recovery run while another actor owns the live key.
    const recoveryRunId = await seedProducerRecoveryRun(source.runId, "ready", {
      missingModelKey: true,
    });

    const unaffected = await sendChatRun(
      other.actor,
      {
        agentId: other.agentId,
        prompt: "keep the shared model source available",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(other.actor, unaffected.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(calls).toBe(2);

    await expect(
      cleanupRun(recoveryRunId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, recoveryRunId, "failed", 10_000);
    await flushWaitUntilForTest();

    expect(calls).toBe(2);
    await expect(api.readRun(actor, recoveryRunId)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("[PI_API_MODEL_CREDENTIAL_INVALID]"),
    });
  }, 90_000);

  it("recovers settled H1 publication without another provider attempt", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesTextSse("durable publication source", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture one recoverable settled H1",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    const recoveryRunId = await seedProducerRecoveryRun(
      source.runId,
      "publishing",
    );

    await expect(
      cleanupRun(recoveryRunId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, recoveryRunId, "completed", 10_000);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(api.readRun(actor, recoveryRunId)).resolves.toMatchObject({
      status: "completed",
    });
    const events = (await chat.listThreadEvents(actor, source.threadId)).events;
    expect(
      events.some((event) => {
        return (
          event.runId === recoveryRunId && event.eventType === "output.message"
        );
      }),
    ).toBeTruthy();
    await billing.processOrgUsageEvents(actor, usagePricingResolution);
    const recoveredUsage = await billing.readUsageRecord(actor);
    expect(recoveredUsage.body.totalCredits).toBeGreaterThan(0);
    expect(recoveredUsage.body.pagination.total).toBeGreaterThan(0);
  }, 90_000);

  it("settles a retained H1 receipt after canonical cancellation without publishing output", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesTextSse("terminal accounting receipt", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture terminal accounting recovery",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    await billing.processOrgUsageEvents(actor, usagePricingResolution);
    const before = await billing.readUsageRecord(actor);
    const recoveryRunId = await seedProducerRecoveryRun(
      source.runId,
      "publishing",
    );

    await api.requestCancelRun(
      actor,
      recoveryRunId,
      [200],
      usagePricingResolution,
    );
    await waitForRunStatus(actor, recoveryRunId, "cancelled", 10_000);
    // Finish cancellation's settlement before recovery creates fresh usage.
    await flushWaitUntilForTest();
    await expirePiInference(recoveryRunId);

    await expect(
      cleanupRun(recoveryRunId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(api.readRun(actor, recoveryRunId)).resolves.toMatchObject({
      status: "cancelled",
    });
    const events = (await chat.listThreadEvents(actor, source.threadId)).events;
    expect(
      events.filter((event) => {
        return (
          event.runId === recoveryRunId &&
          (event.eventType === "output.message" ||
            event.eventType === "run.completed")
        );
      }),
    ).toStrictEqual([]);
    await billing.processOrgUsageEvents(actor, usagePricingResolution);
    const after = await billing.readUsageRecord(actor);
    expect(after.body.totalCredits).toBeGreaterThan(before.body.totalCredits);
  }, 90_000);

  it("does not settle terminal usage when the required billing capture is missing", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(piResponsesTextSse("billing source", calls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture required billing identity",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    await billing.processOrgUsageEvents(actor, usagePricingResolution);
    const before = await billing.readUsageRecord(actor);
    const recoveryRunId = await seedProducerRecoveryRun(
      source.runId,
      "publishing",
      { omitBillingCapture: true },
    );
    await api.requestCancelRun(
      actor,
      recoveryRunId,
      [200],
      usagePricingResolution,
    );
    await waitForRunStatus(actor, recoveryRunId, "cancelled", 10_000);
    await flushWaitUntilForTest();
    await expirePiInference(recoveryRunId);

    await expect(
      cleanupRun(recoveryRunId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(api.readRun(actor, recoveryRunId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await billing.processOrgUsageEvents(actor, usagePricingResolution);
    const after = await billing.readUsageRecord(actor);
    expect(after.body.totalCredits).toBe(before.body.totalCredits);
  }, 90_000);

  it("publishes settled H1 demand for one input committed during provider execution", async () => {
    configureNativeCliArtifact();
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("settled before active input", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "start one durable response",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "continue the settled H1 in Sandbox",
        model: SELECTED_MODEL,
        clientEventId: randomUUID(),
      },
      [201],
      { usagePricingResolution },
    );
    releaseProvider.resolve(undefined);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(
      cleanupRun(run.runId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    const { claim, runnerId } = await claimDeferredPiRun(
      run.runId,
      runnerGroup,
    );
    expect(claim.piLaunchConfig).toMatchObject({
      schemaVersion: 2,
      apiFirstTurn: { continuation: { mode: "settled-session" } },
    });
    await api.requestCancelRun(actor, run.runId, [200], usagePricingResolution);
    await releaseDeferredPiRun(run.runId, runnerId, claim);
    await waitForRunStatus(actor, run.runId, "cancelled", 10_000);
  }, 90_000);

  it("terminalizes an expired uncertain provider attempt without replaying H0", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("late uncertain answer", 1),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }),
    );

    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "do not replay this uncertain provider attempt",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;
    await expirePiInference(run.runId);

    await expect(
      cleanupRun(run.runId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, run.runId, "failed", 10_000);

    releaseProvider.resolve(undefined);
    await flushWaitUntilForTest();
    expect(calls).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "failed",
    });
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.some((event) => {
        return (
          event.runId === run.runId && event.eventType === "output.message"
        );
      }),
    ).toBeFalsy();
    await billing.processOrgUsageEvents(actor, usagePricingResolution);
    const lateUsage = await billing.readUsageRecord(actor);
    expect(lateUsage.body.pagination.total).toBeGreaterThan(0);
  }, 90_000);

  it("publishes one durable H1 demand and reaches the accepted consumer without provider replay", async () => {
    configureNativeCliArtifact();
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PaidToolControls]: false },
    );
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesContentSse({
            blocks: [
              {
                type: "toolCall",
                callId: "call_durable_pi_tool",
                name: "bash",
                arguments: { command: "true" },
              },
            ],
            sequence: calls,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "continue this tool call in the Sandbox",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();
    expect(calls).toBe(1);

    // The API first turn is already prepared. The Sandbox should capture the
    // owner's latest preference when it is materialized by the runner claim.
    await setPaidToolDisabled(context, actor, "web-search", true);
    await expect(
      cleanupRun(run.runId, orgId, usagePricingResolution),
    ).resolves.toMatchObject({
      body: { errors: 0 },
    });
    const { claim, runnerId } = await claimDeferredPiRun(
      run.runId,
      runnerGroup,
    );
    expect(claim.platformEnvironment[DISABLED_PAID_TOOLS_ENV_VAR]).toBe(
      '["web-search"]',
    );
    expect(claim.piLaunchConfig).toMatchObject({
      schemaVersion: 2,
      apiFirstTurn: {
        continuation: {
          mode: "pending-tools",
          pendingToolIds: [expect.stringMatching(/^call_durable_pi_tool\|/u)],
        },
      },
    });
    expect(calls).toBe(1);

    await api.requestCancelRun(actor, run.runId, [200], usagePricingResolution);
    await releaseDeferredPiRun(run.runId, runnerId, claim);
    await flushWaitUntilForTest();
  }, 90_000);
});
