import { command } from "ccstate";
import {
  testRuntimeStateContract,
  type TestRuntimeStateActionBody,
} from "@okouai/api-contracts/contracts/test-runtime-state";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { runnerWssTickets } from "@okouai/db/schema/runner-wss-ticket";

import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { AUTO_RUN_KEY_VENDOR } from "@okouai/core/auto-run-model";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  acquireBuiltInModelKeyFixture,
  releaseBuiltInModelKeyFixture,
} from "../services/built-in-model-key-fixture";
import { catalogBuiltInModelRouteUpstream } from "../services/built-in-model-runtime-route.service";
import { writeRunMetadata$ } from "../services/agent-run-metadata-write.service";
import { saveRunSummary$ } from "../services/run-summary.service";
import { resolveRunnerWssTarget$ } from "../services/runner-wss-target.service";
import { reconcileSocialKitDownloads$ } from "../services/socialkit-download.service";
import { steerRunNearTimeBudgetForTest$ } from "../services/cron-steer-run-time-budget.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import {
  modelCatalog$,
  catalogBuiltInRoute,
  type ModelCatalog,
} from "../services/model-catalog.service";

import { PI_MEMORY_BUILTIN_BINDING } from "../services/pi-memory-builtin-config";

/** Infrastructure fixtures seed only the OpenRouter key behind fixed Auto or
 * the independent memory binding; retired vendor keys are never seeded. */
function builtInModelKeyVendor(
  catalogSnapshot: ModelCatalog,
  selectedModel: string,
): string | null {
  if (selectedModel === PI_MEMORY_BUILTIN_BINDING.selectedModel) {
    const route = catalogBuiltInRoute(
      catalogSnapshot,
      selectedModel,
      PI_MEMORY_BUILTIN_BINDING.providerType,
    );
    if (
      !route?.enabled ||
      route.upstreamModel !== PI_MEMORY_BUILTIN_BINDING.upstreamModel
    ) {
      throw new Error("Expected the independent fixed memory binding");
    }
    return AUTO_RUN_KEY_VENDOR;
  }
  return catalogBuiltInModelRouteUpstream(catalogSnapshot, selectedModel) ===
    null
    ? null
    : AUTO_RUN_KEY_VENDOR;
}

// Test-only support actions for generic infrastructure fixtures.

const actionBody$ = bodyResultOf(testRuntimeStateContract.action);
const BUILT_IN_MODEL_KEY_FIXTURE_PREFIX = "built-in-key-runtime-fixture-";
type RunSummaryFixtureAction = Extract<
  TestRuntimeStateActionBody,
  { action: "save-run-summary" }
>;

function isRunSummaryFixtureAction(
  body: TestRuntimeStateActionBody,
): body is RunSummaryFixtureAction {
  return body.action === "save-run-summary";
}

const runSummaryFixtureActionResponse$ = command(
  async ({ set }, body: RunSummaryFixtureAction, signal: AbortSignal) => {
    await set(
      saveRunSummary$,
      {
        runId: body.run_id,
        triggerSource: body.trigger_source,
        prompt: body.prompt,
        resultText: body.result_text,
      },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

async function seedBuiltInDefaultModelKey(
  catalogSnapshot: ModelCatalog,
  db: Db,
  fixtureId: string,
  signal: AbortSignal,
): Promise<string> {
  return await seedBuiltInModelKey(
    catalogSnapshot,
    db,
    fixtureId,
    await catalogSnapshot.systemDefaultModel,
    signal,
  );
}

async function seedBuiltInModelKey(
  catalogSnapshot: ModelCatalog,
  db: Db,
  fixtureId: string,
  selectedModel: string,
  signal: AbortSignal,
): Promise<string> {
  const vendor = builtInModelKeyVendor(catalogSnapshot, selectedModel);
  if (vendor === null) {
    throw new Error(`Expected a Built-in catalog route for ${selectedModel}`);
  }
  await acquireBuiltInModelKeyFixture(db, fixtureId, [
    {
      vendor,
      apiKey: `${BUILT_IN_MODEL_KEY_FIXTURE_PREFIX}${fixtureId}`,
    },
  ]);
  signal.throwIfAborted();
  return selectedModel;
}

async function deleteBuiltInModelKey(
  db: Db,
  fixtureId: string,
  signal: AbortSignal,
): Promise<void> {
  await releaseBuiltInModelKeyFixture(db, fixtureId);
  signal.throwIfAborted();
}

type BuiltInModelAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "seed-built-in-default-model-key"
      | "seed-built-in-model-key"
      | "delete-built-in-model-key";
  }
>;

function isBuiltInModelAction(
  body: TestRuntimeStateActionBody,
): body is BuiltInModelAction {
  return [
    "seed-built-in-default-model-key",
    "seed-built-in-model-key",
    "delete-built-in-model-key",
  ].includes(body.action);
}

async function builtInModelActionResponse(
  catalogSnapshot: ModelCatalog,
  db: Db,
  body: BuiltInModelAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-built-in-default-model-key": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          selected_model: await seedBuiltInDefaultModelKey(
            catalogSnapshot,
            db,
            body.fixture_id,
            signal,
          ),
        },
      };
    }
    case "seed-built-in-model-key": {
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          selected_model: await seedBuiltInModelKey(
            catalogSnapshot,
            db,
            body.fixture_id,
            body.selected_model,
            signal,
          ),
        },
      };
    }
    case "delete-built-in-model-key": {
      await deleteBuiltInModelKey(db, body.fixture_id, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
  }
}

const runMetadataFixtureAction$ = command(
  async (
    { set },
    body: Extract<
      TestRuntimeStateActionBody,
      { action: "clear-run-api-start" | "set-run-autonomy-budget" }
    >,
    signal: AbortSignal,
  ) => {
    const rows = await set(
      writeRunMetadata$,
      {
        patch:
          body.action === "clear-run-api-start"
            ? { apiStartedAt: null }
            : { autonomyBudget: body.autonomy_budget },
        where: eq(agentRuns.id, body.run_id),
      },
      signal,
    );
    if (rows.length === 0) {
      throw new Error(
        body.action === "clear-run-api-start"
          ? "Expected an agent run timing row"
          : "Expected the autonomy-budget run fixture",
      );
    }
    return { status: 200 as const, body: { ok: true as const } };
  },
);

/**
 * A running run cannot reach the time-budget boundary during an integration
 * test, so the test-only route moves exactly its owned run into that state.
 */
async function setRunTimeBudgetElapsed(
  db: Db,
  runId: string,
  elapsedMs: number,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = new Date(nowDate().getTime() - elapsedMs);
  const [updated] = await db
    .update(agentRuns)
    .set({ startedAt })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected one running time-budget run fixture");
  }
}

type AutonomyBudgetFixtureAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "read-run-autonomy-budget"
      | "set-workflow-automation-autonomy-budget"
      | "read-workflow-automation-autonomy-state"
      | "read-latest-workflow-automation-run";
  }
>;

function isAutonomyBudgetFixtureAction(
  body: TestRuntimeStateActionBody,
): body is AutonomyBudgetFixtureAction {
  return [
    "read-run-autonomy-budget",
    "set-workflow-automation-autonomy-budget",
    "read-workflow-automation-autonomy-state",
    "read-latest-workflow-automation-run",
  ].includes(body.action);
}

async function autonomyBudgetFixtureActionResponse(
  db: Db,
  body: AutonomyBudgetFixtureAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "read-run-autonomy-budget": {
      const [run] = await db
        .select({ autonomyBudget: agentRuns.autonomyBudget })
        .from(agentRuns)
        .where(eq(agentRuns.id, body.run_id))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          autonomy_budget: run?.autonomyBudget ?? null,
        },
      };
    }
    case "set-workflow-automation-autonomy-budget": {
      const [automation] = await db
        .update(workflowAutomations)
        .set({ autonomyBudget: body.autonomy_budget })
        .where(eq(workflowAutomations.id, body.automation_id))
        .returning({ id: workflowAutomations.id });
      signal.throwIfAborted();
      if (!automation) {
        throw new Error("Expected the autonomy-budget automation fixture");
      }
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-workflow-automation-autonomy-state": {
      const [automation] = await db
        .select({
          autonomyBudget: workflowAutomations.autonomyBudget,
          enabled: workflowAutomations.enabled,
          eventConnectorId: workflowAutomations.eventConnectorId,
          lastRunId: workflowAutomations.lastRunId,
          officialBlueprintKey: workflowAutomations.officialBlueprintKey,
          officialResultEmailEnabled:
            workflowAutomations.officialResultEmailEnabled,
        })
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, body.automation_id))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          workflow_automation_state: automation
            ? {
                autonomy_budget: automation.autonomyBudget,
                enabled: automation.enabled,
                event_connector_id: automation.eventConnectorId,
                last_run_id: automation.lastRunId,
                official_blueprint_key: automation.officialBlueprintKey,
                official_result_email_enabled:
                  automation.officialResultEmailEnabled,
              }
            : null,
        },
      };
    }
    case "read-latest-workflow-automation-run": {
      const [run] = await db
        .select({
          runId: agentRuns.id,
          autonomyBudget: agentRuns.autonomyBudget,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.workflowAutomationId, body.automation_id),
            isNotNull(agentRuns.triggerSource),
          ),
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          workflow_automation_run: run
            ? {
                run_id: run.runId,
                autonomy_budget: run.autonomyBudget,
              }
            : null,
        },
      };
    }
  }
}

type SetRunnerJobPiContextAsVersionedWriterAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-runner-job-pi-context-as-versioned-writer" }
>;

async function setRunnerJobPiContextAsVersionedWriter(
  db: Db,
  body: SetRunnerJobPiContextAsVersionedWriterAction,
  signal: AbortSignal,
): Promise<void> {
  // This private infrastructure fixture models stored contexts to exercise
  // the real claim API without changing production admission.
  const piContext = {
    cliAgentType: "pi",
    piSessionId: body.run_id,
    piLaunchConfig: { schemaVersion: 2 },
    piModelConfig: body.pi_model_config,
  };
  const [updated] = await db
    .update(runnerJobQueue)
    .set({
      executionContext: sql`${runnerJobQueue.executionContext} || ${JSON.stringify(piContext)}::jsonb`,
    })
    .where(eq(runnerJobQueue.runId, body.run_id))
    .returning({ runId: runnerJobQueue.runId });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a queued runner job for Pi context update");
  }
}

type ReadRunLaunchSnapshotAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-run-launch-snapshot" }
>;

function isReadRunLaunchSnapshotAction(
  body: TestRuntimeStateActionBody,
): body is ReadRunLaunchSnapshotAction {
  return body.action === "read-run-launch-snapshot";
}

async function readRunLaunchSnapshotActionResponse(
  db: Db,
  body: ReadRunLaunchSnapshotAction,
  signal: AbortSignal,
) {
  const [run] = await db
    .select({ launchSnapshot: agentRuns.launchSnapshot })
    .from(agentRuns)
    .where(eq(agentRuns.id, body.run_id))
    .limit(1);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      run_launch_snapshot: {
        exists: run !== undefined,
        launch_snapshot: run?.launchSnapshot ?? null,
      },
    },
  };
}

type PreviousApiRunnerJobContextProfileAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-runner-job-context-profile-as-previous-api" }
>;

type PreviousApiWorkflowAutomationEventConnectorAction = Extract<
  TestRuntimeStateActionBody,
  { action: "clear-workflow-automation-event-connector-as-previous-api" }
>;

async function setRunnerJobContextProfileAsPreviousApi(
  db: Db,
  body: PreviousApiRunnerJobContextProfileAction,
  signal: AbortSignal,
) {
  // The previous API stored the routing profile in both the dedicated queue
  // column and execution-context JSON. The current reader must strip the
  // internal routing field before publishing the claim.
  const [updated] = await db
    .update(runnerJobQueue)
    .set({
      executionContext: sql`jsonb_set(
        ${runnerJobQueue.executionContext},
        '{experimentalProfile}',
        to_jsonb(${body.profile}::text),
        true
      )`,
    })
    .where(eq(runnerJobQueue.runId, body.run_id))
    .returning({ runId: runnerJobQueue.runId });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a runner job for previous API profile update");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

async function clearWorkflowAutomationEventConnectorAsPreviousApi(
  db: Db,
  body: PreviousApiWorkflowAutomationEventConnectorAction,
  signal: AbortSignal,
) {
  // The previous API did not populate the additive Gmail account projection.
  // No current production endpoint can reproduce that mixed-version row.
  const [updated] = await db
    .update(workflowAutomations)
    .set({ eventConnectorId: null })
    .where(eq(workflowAutomations.id, body.automation_id))
    .returning({ id: workflowAutomations.id });
  signal.throwIfAborted();
  if (!updated) {
    throw new Error("Expected a Workflow Automation for previous API update");
  }
  return { status: 200 as const, body: { ok: true as const } };
}
type CompatibilityFixtureAction =
  | AutonomyBudgetFixtureAction
  | PreviousApiRunnerJobContextProfileAction
  | PreviousApiWorkflowAutomationEventConnectorAction;

function isCompatibilityFixtureAction(
  body: TestRuntimeStateActionBody,
): body is CompatibilityFixtureAction {
  return [
    "read-run-autonomy-budget",
    "set-workflow-automation-autonomy-budget",
    "read-workflow-automation-autonomy-state",
    "read-latest-workflow-automation-run",
    "set-runner-job-context-profile-as-previous-api",
    "clear-workflow-automation-event-connector-as-previous-api",
  ].includes(body.action);
}

async function compatibilityFixtureActionResponse(
  db: Db,
  body: CompatibilityFixtureAction,
  signal: AbortSignal,
) {
  if (isAutonomyBudgetFixtureAction(body)) {
    return await autonomyBudgetFixtureActionResponse(db, body, signal);
  }
  switch (body.action) {
    case "set-runner-job-context-profile-as-previous-api": {
      return await setRunnerJobContextProfileAsPreviousApi(db, body, signal);
    }
    case "clear-workflow-automation-event-connector-as-previous-api": {
      return await clearWorkflowAutomationEventConnectorAsPreviousApi(
        db,
        body,
        signal,
      );
    }
  }
}

type ReadOfficialWorkflowRunStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "read-official-workflow-run-state" }
>;
type SetOfficialWorkflowAutomationAdmissionStateAction = Extract<
  TestRuntimeStateActionBody,
  { action: "set-official-workflow-automation-admission-state" }
>;
type OfficialWorkflowRunFixtureAction = Extract<
  TestRuntimeStateActionBody,
  {
    action:
      | "read-official-workflow-run-state"
      | "set-official-workflow-automation-admission-state";
  }
>;

function isOfficialWorkflowRunFixtureAction(
  body: TestRuntimeStateActionBody,
): body is OfficialWorkflowRunFixtureAction {
  return [
    "read-official-workflow-run-state",
    "set-official-workflow-automation-admission-state",
  ].includes(body.action);
}

async function readOfficialWorkflowRunStateActionResponse(
  db: Db,
  body: ReadOfficialWorkflowRunStateAction,
  signal: AbortSignal,
) {
  const [run] = await db
    .select({
      status: agentRuns.status,
      modelProvider: agentRuns.modelProvider,
      provenance: agentRuns.officialWorkflowProvenance,
      storageMounts: agentRuns.storageMounts,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, body.run_id))
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return {
      status: 200 as const,
      body: { ok: true as const, official_workflow_run_state: null },
    };
  }
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      official_workflow_run_state: {
        status: run.status,
        model_provider: run.modelProvider,
        provenance: run.provenance,
        storage_mounts:
          run.storageMounts?.map((mount) => {
            return {
              org_id: mount.orgId,
              user_id: mount.userId,
              name: mount.name,
              storage_id: mount.storageId,
              ...(mount.version ? { version: mount.version } : {}),
              mount_path: mount.mountPath,
              ...(mount.writeback === undefined
                ? {}
                : { writeback: mount.writeback }),
            };
          }) ?? null,
      },
    },
  };
}

async function setOfficialWorkflowAutomationAdmissionStateActionResponse(
  db: Db,
  body: SetOfficialWorkflowAutomationAdmissionStateAction,
  signal: AbortSignal,
) {
  const updated = await db
    .update(workflowAutomations)
    .set({
      ...(body.blueprint_key === undefined
        ? {}
        : {
            officialBlueprintKey: body.blueprint_key,
            officialAppliedFingerprint:
              body.applied_fingerprint ?? "0".repeat(64),
            officialParameterBindings: [],
            officialIntendedEnabled: true,
            officialResultEmailEnabled: false,
          }),
      officialReconciliationStatus: body.reconciliation_status,
      ...(body.applied_fingerprint
        ? { officialAppliedFingerprint: body.applied_fingerprint }
        : {}),
    })
    .where(eq(workflowAutomations.id, body.automation_id))
    .returning({ id: workflowAutomations.id });
  signal.throwIfAborted();
  if (updated.length !== 1) {
    throw new Error("Official Workflow Automation is unavailable");
  }
  return { status: 200 as const, body: { ok: true as const } };
}

async function officialWorkflowRunFixtureActionResponse(
  db: Db,
  body: OfficialWorkflowRunFixtureAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "read-official-workflow-run-state": {
      return await readOfficialWorkflowRunStateActionResponse(db, body, signal);
    }
    case "set-official-workflow-automation-admission-state": {
      return await setOfficialWorkflowAutomationAdmissionStateActionResponse(
        db,
        body,
        signal,
      );
    }
  }
}

const specializedRuntimeFixtureAction$ = command(
  async ({ set }, body: TestRuntimeStateActionBody, signal: AbortSignal) => {
    const db = set(writeDb$);
    if (isOfficialWorkflowRunFixtureAction(body)) {
      return await officialWorkflowRunFixtureActionResponse(db, body, signal);
    }
    if (body.action === "reconcile-socialkit-downloads") {
      const processed = await set(
        reconcileSocialKitDownloads$,
        { candidateIds: body.download_ids },
        signal,
      );
      return {
        status: 200 as const,
        body: { ok: true as const, processed },
      };
    }
    if (body.action === "resolve-runner-wss-target") {
      const target = await set(
        resolveRunnerWssTarget$,
        {
          runId: body.run_id,
          owner: { userId: body.user_id, orgId: body.org_id },
          now: body.now ? new Date(body.now) : nowDate(),
          purpose: "issue",
        },
        signal,
      );
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          wss_target: target
            ? { ...target, observedAt: target.observedAt.toISOString() }
            : null,
        },
      };
    }
    if (body.action === "expire-runner-wss-tickets") {
      await db
        .update(runnerWssTickets)
        .set({
          expiresAt: sql`timezone('UTC', clock_timestamp()) - interval '1 second'`,
        })
        .where(eq(runnerWssTickets.runId, body.run_id));
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const } };
    }
    if (body.action === "read-run-failure-reason") {
      const [run] = await db
        .select({ failureReason: agentRuns.failureReason })
        .from(agentRuns)
        .where(eq(agentRuns.id, body.run_id))
        .limit(1);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          failure_reason: run?.failureReason ?? null,
        },
      };
    }
    return null;
  },
);

const postRuntimeStateAction$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    if (
      body.action === "clear-run-api-start" ||
      body.action === "set-run-autonomy-budget"
    ) {
      return await set(runMetadataFixtureAction$, body, signal);
    }
    const db = set(writeDb$);
    if (isReadRunLaunchSnapshotAction(body)) {
      return await readRunLaunchSnapshotActionResponse(db, body, signal);
    }
    if (body.action === "steer-run-time-budget") {
      await setRunTimeBudgetElapsed(db, body.run_id, body.elapsed_ms, signal);
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          run_time_budget: await set(
            steerRunNearTimeBudgetForTest$,
            body.run_id,
            signal,
          ),
        },
      };
    }
    if (isRunSummaryFixtureAction(body)) {
      return await set(runSummaryFixtureActionResponse$, body, signal);
    }
    if (isCompatibilityFixtureAction(body)) {
      return await compatibilityFixtureActionResponse(db, body, signal);
    }
    if (isBuiltInModelAction(body)) {
      return await builtInModelActionResponse(
        await get(modelCatalog$),
        db,
        body,
        signal,
      );
    }
    const specializedFixture = await set(
      specializedRuntimeFixtureAction$,
      body,
      signal,
    );
    if (specializedFixture) {
      return specializedFixture;
    }
    switch (body.action) {
      case "set-runner-job-pi-context-as-versioned-writer": {
        await setRunnerJobPiContextAsVersionedWriter(db, body, signal);
        return { status: 200 as const, body: { ok: true as const } };
      }
    }
  },
);

export const testRuntimeStateRoutes: readonly RouteEntry[] = [
  {
    route: testRuntimeStateContract.action,
    handler: postRuntimeStateAction$,
  },
];
