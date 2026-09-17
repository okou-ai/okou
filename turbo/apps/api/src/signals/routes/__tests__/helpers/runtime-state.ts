import { randomUUID } from "node:crypto";

import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import type { ConnectorRuntimeTargetRegistration } from "@okouai/api-contracts/contracts/runners";
import type {
  TestRuntimeStateActionBody,
  TestRuntimeStateActionResponse,
} from "@okouai/api-contracts/contracts/test-runtime-state";
import { onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import type { UsagePricingResolution } from "../../../context/usage-pricing-resolution";
import { testRuntimeStateRoutes } from "../../test-runtime-state";

const RUNTIME_STATE_ROUTE = "/api/test/runtime-state";

function requestRuntimeState(
  context: TestContext,
  path: string,
  init?: RequestInit,
  usagePricingResolution?: UsagePricingResolution,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testRuntimeStateRoutes,
    usagePricingResolution,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  context: TestContext,
  body: TestRuntimeStateActionBody,
  usagePricingResolution?: UsagePricingResolution,
): Promise<TestRuntimeStateActionResponse> {
  const response = await requestRuntimeState(
    context,
    `${RUNTIME_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    usagePricingResolution,
  );
  await expectOk(response, `runtime state action ${body.action}`);
  return await readJson<TestRuntimeStateActionResponse>(response);
}

export async function reconcileSocialKitDownloadsForTest(
  context: TestContext,
  downloadIds: readonly string[],
  usagePricingResolution: UsagePricingResolution,
): Promise<number> {
  const response = await postAction(
    context,
    {
      action: "reconcile-socialkit-downloads",
      download_ids: [...downloadIds],
    },
    usagePricingResolution,
  );
  if (response.processed === undefined) {
    throw new Error("SocialKit reconciliation fixture returned no count");
  }
  return response.processed;
}

interface BuiltInModelKeyFixture {
  readonly selectedModel: string;
  release(): Promise<void>;
}

function builtInModelKeyFixture(
  context: TestContext,
  fixtureId: string,
  selectedModel: string,
): BuiltInModelKeyFixture {
  let released = false;
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    await postAction(context, {
      action: "delete-built-in-model-key",
      fixture_id: fixtureId,
    });
    released = true;
  };
  onTestFinished(release);
  return { selectedModel, release };
}

export async function seedBuiltInDefaultModelKey(
  context: TestContext,
): Promise<BuiltInModelKeyFixture> {
  const fixtureId = randomUUID();
  const response = await postAction(context, {
    action: "seed-built-in-default-model-key",
    fixture_id: fixtureId,
  });
  if (!response.selected_model) {
    throw new Error("seedBuiltInDefaultModelKey missing selected_model");
  }
  return builtInModelKeyFixture(context, fixtureId, response.selected_model);
}

export async function seedBuiltInModelKey(
  context: TestContext,
  selectedModel: string,
): Promise<BuiltInModelKeyFixture> {
  const fixtureId = randomUUID();
  const response = await postAction(context, {
    action: "seed-built-in-model-key",
    fixture_id: fixtureId,
    selected_model: selectedModel,
  });
  if (!response.selected_model) {
    throw new Error("seedBuiltInModelKey missing selected_model");
  }
  return builtInModelKeyFixture(context, fixtureId, response.selected_model);
}

export async function seedBuiltInModelCandidateKeys(
  context: TestContext,
  selectedModel: string,
): Promise<BuiltInModelKeyFixture> {
  const fixtureId = randomUUID();
  const response = await postAction(context, {
    action: "seed-built-in-model-candidate-keys",
    fixture_id: fixtureId,
    selected_model: selectedModel,
  });
  if (!response.selected_model) {
    throw new Error("seedBuiltInModelCandidateKeys missing selected_model");
  }
  return builtInModelKeyFixture(context, fixtureId, response.selected_model);
}

type BuiltInModelRuntimeRouteFixture = NonNullable<
  TestRuntimeStateActionResponse["built_in_model_route"]
>;

export async function resolveBuiltInModelRouteFixture(
  context: TestContext,
  selectedModel: string,
): Promise<BuiltInModelRuntimeRouteFixture | null> {
  const response = await postAction(context, {
    action: "resolve-built-in-model-route",
    selected_model: selectedModel,
  });
  return response.built_in_model_route ?? null;
}

export async function setBuiltInCandidateCooldownFixture(
  context: TestContext,
  selectedModel: string,
  route: BuiltInModelRuntimeRouteFixture,
  unavailableUntil: Date,
): Promise<void> {
  await postAction(context, {
    action: "set-built-in-candidate-cooldown",
    selected_model: selectedModel,
    provider_type: route.provider_type,
    upstream_model: route.upstream_model,
    unavailable_until: unavailableUntil.toISOString(),
  });
  registerBuiltInCandidateCooldownCleanup(context, selectedModel, route);
}

export async function deleteBuiltInCandidateCooldownFixture(
  context: TestContext,
  selectedModel: string,
  route: BuiltInModelRuntimeRouteFixture,
): Promise<void> {
  await postAction(context, {
    action: "delete-built-in-candidate-cooldown",
    selected_model: selectedModel,
    provider_type: route.provider_type,
    upstream_model: route.upstream_model,
  });
}

export function registerBuiltInCandidateCooldownCleanup(
  context: TestContext,
  selectedModel: string,
  route: BuiltInModelRuntimeRouteFixture,
): void {
  onTestFinished(async () => {
    await deleteBuiltInCandidateCooldownFixture(context, selectedModel, route);
  });
}

export async function readBrowserScreenshotSchemaAvailable(
  context: TestContext,
): Promise<boolean> {
  const response = await postAction(context, {
    action: "read-browser-screenshot-schema-state",
  });
  if (response.browser_screenshot_schema_available === undefined) {
    throw new Error(
      "readBrowserScreenshotSchemaAvailable missing schema availability",
    );
  }
  return response.browser_screenshot_schema_available;
}

export async function readUsagePackInvitationSchemaAvailable(
  context: TestContext,
): Promise<boolean> {
  const response = await postAction(context, {
    action: "read-usage-pack-invitation-schema-state",
  });
  if (response.usage_pack_invitation_schema_available === undefined) {
    throw new Error(
      "readUsagePackInvitationSchemaAvailable missing schema availability",
    );
  }
  return response.usage_pack_invitation_schema_available;
}

export async function readUsagePackPurchaseSerializationSchemaAvailable(
  context: TestContext,
): Promise<boolean> {
  const response = await postAction(context, {
    action: "read-usage-pack-purchase-serialization-schema-state",
  });
  if (
    response.usage_pack_purchase_serialization_schema_available === undefined
  ) {
    throw new Error(
      "readUsagePackPurchaseSerializationSchemaAvailable missing schema availability",
    );
  }
  return response.usage_pack_purchase_serialization_schema_available;
}

export async function setCustomConnectorAuthTemplateFixture(
  context: TestContext,
  args: {
    readonly connectorId: string;
    readonly valueTemplate: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-custom-connector-auth-template-fixture",
    connector_id: args.connectorId,
    value_template: args.valueTemplate,
  });
}

export async function readRunAutonomyBudgetFixture(
  context: TestContext,
  runId: string,
): Promise<number | null> {
  const response = await postAction(context, {
    action: "read-run-autonomy-budget",
    run_id: runId,
  });
  if (!("autonomy_budget" in response)) {
    throw new Error("readRunAutonomyBudgetFixture missing autonomy_budget");
  }
  return response.autonomy_budget ?? null;
}

export async function readRunFailureReasonFixture(
  context: TestContext,
  runId: string,
): Promise<RunFailureReasonToken | null> {
  const response = await postAction(context, {
    action: "read-run-failure-reason",
    run_id: runId,
  });
  if (!("failure_reason" in response)) {
    throw new Error("readRunFailureReasonFixture missing failure_reason");
  }
  return response.failure_reason ?? null;
}

export async function setRunModelProviderStateFixture(
  context: TestContext,
  runId: string,
  modelProvider: string | null,
): Promise<void> {
  await postAction(context, {
    action: "set-run-model-provider",
    run_id: runId,
    model_provider: modelProvider,
  });
}

/**
 * Launch snapshots are intentionally writer-only in Stage 2, so persistence
 * cannot be observed through a production API. Keep this test-only exception
 * bounded to snapshot, historical-NULL, and no-row retry assertions.
 */
export async function readRunLaunchSnapshotFixture(
  context: TestContext,
  runId: string,
): Promise<NonNullable<TestRuntimeStateActionResponse["run_launch_snapshot"]>> {
  const response = await postAction(context, {
    action: "read-run-launch-snapshot",
    run_id: runId,
  });
  if (!response.run_launch_snapshot) {
    throw new Error("readRunLaunchSnapshotFixture missing run_launch_snapshot");
  }
  return response.run_launch_snapshot;
}

export async function setRunAutonomyBudgetFixture(
  context: TestContext,
  runId: string,
  autonomyBudget: number,
): Promise<void> {
  await postAction(context, {
    action: "set-run-autonomy-budget",
    run_id: runId,
    autonomy_budget: autonomyBudget,
  });
}

export async function readWorkflowAutomationAutonomyFixture(
  context: TestContext,
  automationId: string,
): Promise<{
  readonly autonomyBudget: number;
  readonly enabled: boolean;
  readonly eventConnectorId: string | null;
  readonly lastRunId: string | null;
  readonly officialBlueprintKey: string | null;
  readonly officialResultEmailEnabled: boolean | null;
} | null> {
  const response = await postAction(context, {
    action: "read-workflow-automation-autonomy-state",
    automation_id: automationId,
  });
  if (!("workflow_automation_state" in response)) {
    throw new Error(
      "readWorkflowAutomationAutonomyFixture missing workflow_automation_state",
    );
  }
  const state = response.workflow_automation_state;
  return state
    ? {
        autonomyBudget: state.autonomy_budget,
        enabled: state.enabled,
        eventConnectorId: state.event_connector_id,
        lastRunId: state.last_run_id,
        officialBlueprintKey: state.official_blueprint_key,
        officialResultEmailEnabled: state.official_result_email_enabled,
      }
    : null;
}

export async function setWorkflowAutomationAutonomyBudgetFixture(
  context: TestContext,
  automationId: string,
  autonomyBudget: number,
): Promise<void> {
  await postAction(context, {
    action: "set-workflow-automation-autonomy-budget",
    automation_id: automationId,
    autonomy_budget: autonomyBudget,
  });
}

export async function readLatestWorkflowAutomationRunFixture(
  context: TestContext,
  automationId: string,
): Promise<{
  readonly runId: string;
  readonly autonomyBudget: number;
} | null> {
  const response = await postAction(context, {
    action: "read-latest-workflow-automation-run",
    automation_id: automationId,
  });
  if (!("workflow_automation_run" in response)) {
    throw new Error(
      "readLatestWorkflowAutomationRunFixture missing workflow_automation_run",
    );
  }
  const run = response.workflow_automation_run;
  return run
    ? { runId: run.run_id, autonomyBudget: run.autonomy_budget }
    : null;
}

export async function readOfficialWorkflowRunStateFixture(
  context: TestContext,
  runId: string,
): Promise<
  NonNullable<TestRuntimeStateActionResponse["official_workflow_run_state"]>
> {
  const response = await postAction(context, {
    action: "read-official-workflow-run-state",
    run_id: runId,
  });
  if (!("official_workflow_run_state" in response)) {
    throw new Error(
      "readOfficialWorkflowRunStateFixture missing official_workflow_run_state",
    );
  }
  if (!response.official_workflow_run_state) {
    throw new Error("Official Workflow Run is unavailable");
  }
  return response.official_workflow_run_state;
}

export async function readAgentRunFamilyCountsFixture(
  context: TestContext,
  agentId: string,
): Promise<
  NonNullable<TestRuntimeStateActionResponse["agent_run_family_counts"]>
> {
  const response = await postAction(context, {
    action: "read-agent-run-family-counts",
    agent_id: agentId,
  });
  if (!("agent_run_family_counts" in response)) {
    throw new Error(
      "readAgentRunFamilyCountsFixture missing agent_run_family_counts",
    );
  }
  if (!response.agent_run_family_counts) {
    throw new Error("Agent Run-family count is unavailable");
  }
  return response.agent_run_family_counts;
}

export async function readChatEventRowsAsPreviousApiFixture(
  context: TestContext,
  threadId: string,
): Promise<
  NonNullable<TestRuntimeStateActionResponse["previous_api_chat_event_rows"]>
> {
  const response = await postAction(context, {
    action: "read-chat-event-rows-as-previous-api",
    thread_id: threadId,
  });
  if (!("previous_api_chat_event_rows" in response)) {
    throw new Error(
      "readChatEventRowsAsPreviousApiFixture missing previous_api_chat_event_rows",
    );
  }
  return response.previous_api_chat_event_rows ?? [];
}

export async function corruptOfficialWorkflowRevisionPayloadFixture(
  context: TestContext,
  definitionName: string,
): Promise<void> {
  await postAction(context, {
    action: "corrupt-official-workflow-revision-payload",
    definition_name: definitionName,
  });
}

export async function setOfficialWorkflowAutomationAdmissionStateFixture(
  context: TestContext,
  automationId: string,
  reconciliationStatus:
    | "current"
    | "reconciling"
    | "needs_reconfiguration"
    | "failed",
  appliedFingerprint?: string,
): Promise<void> {
  await postAction(context, {
    action: "set-official-workflow-automation-admission-state",
    automation_id: automationId,
    reconciliation_status: reconciliationStatus,
    ...(appliedFingerprint === undefined
      ? {}
      : { applied_fingerprint: appliedFingerprint }),
  });
}

export async function stageOfficialWorkflowAutomationFixture(
  context: TestContext,
  automationId: string,
  blueprintKey: string,
): Promise<void> {
  await postAction(context, {
    action: "set-official-workflow-automation-admission-state",
    automation_id: automationId,
    blueprint_key: blueprintKey,
    reconciliation_status: "reconciling",
  });
}

export async function retargetWorkflowAutomationFixture(
  context: TestContext,
  automationId: string,
  workflowId: string,
): Promise<void> {
  await postAction(context, {
    action: "retarget-workflow-automation",
    automation_id: automationId,
    workflow_id: workflowId,
  });
}

export async function assertOfficialWorkflowAutomationFinalAdmissionRejectedFixture(
  context: TestContext,
  automationId: string,
  officialWorkflowId: string,
): Promise<void> {
  await postAction(context, {
    action: "assert-official-workflow-automation-final-admission-rejected",
    automation_id: automationId,
    official_workflow_id: officialWorkflowId,
  });
}

type OfficialWorkflowRunGateKind =
  | "observation"
  | "final-admission"
  | "bootstrap-requirement";

type OfficialWorkflowRunGateState = NonNullable<
  TestRuntimeStateActionResponse["official_workflow_run_gate_state"]
>;

interface OfficialWorkflowRunGateFixture {
  read(): Promise<OfficialWorkflowRunGateState>;
  release(): Promise<void>;
}

async function readOfficialWorkflowRunGateStateFixture(
  context: TestContext,
): Promise<OfficialWorkflowRunGateState | null> {
  const response = await postAction(context, {
    action: "read-official-workflow-run-gate-state",
  });
  if (!("official_workflow_run_gate_state" in response)) {
    throw new Error(
      "readOfficialWorkflowRunGateStateFixture missing gate state",
    );
  }
  return response.official_workflow_run_gate_state ?? null;
}

export async function installOfficialWorkflowRunGateFixture(
  context: TestContext,
  gate: OfficialWorkflowRunGateKind,
): Promise<OfficialWorkflowRunGateFixture> {
  const held = postAction(context, {
    action: "hold-official-workflow-run-gate",
    gate,
  }).then(
    () => {
      return { ok: true as const };
    },
    (error: unknown) => {
      return { ok: false as const, error };
    },
  );
  let released = false;
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    await postAction(context, {
      action: "release-official-workflow-run-gate",
    });
    const outcome = await held;
    if (!outcome.ok && !context.signal.aborted) {
      throw outcome.error;
    }
  };
  onTestFinished(release);
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await readOfficialWorkflowRunGateStateFixture(context);
    if (state?.gate === gate) {
      return {
        async read(): Promise<OfficialWorkflowRunGateState> {
          const current =
            await readOfficialWorkflowRunGateStateFixture(context);
          if (!current || current.gate !== gate) {
            throw new Error("Official Workflow Run gate is unavailable");
          }
          return current;
        },
        release,
      };
    }
  }
  await release();
  throw new Error("Official Workflow Run gate did not become active");
}

export async function resetDatabasePool(context: TestContext): Promise<void> {
  await postAction(context, { action: "reset-database-pool" });
}

export async function mutateRunnerJobSecretValueEnvironmentKeys(
  context: TestContext,
  runId: string,
  mode: "remove" | "invalid",
): Promise<void> {
  await postAction(context, {
    action: "mutate-runner-job-secret-value-environment-keys",
    run_id: runId,
    mode,
  });
}

export async function setRunnerJobPiContextAsVersionedWriter(
  context: TestContext,
  runId: string,
  piModelConfig: Readonly<Record<string, unknown>>,
): Promise<void> {
  await postAction(context, {
    action: "set-runner-job-pi-context-as-versioned-writer",
    run_id: runId,
    pi_model_config: piModelConfig,
  });
}

export async function mutateRunnerJobConnectorPermissionBaseline(
  context: TestContext,
  runId: string,
  mode:
    | "remove"
    | "malformed"
    | "capability-mismatch"
    | "catalog-mismatch"
    | "authority-mismatch"
    | "inconsistent"
    | "incomplete",
): Promise<void> {
  await postAction(context, {
    action: "mutate-runner-job-connector-permission-baseline",
    run_id: runId,
    mode,
  });
}

export async function setRunnerJobConnectorRuntimeTargets(
  context: TestContext,
  runId: string,
  connectorRuntimeTargets: readonly ConnectorRuntimeTargetRegistration[],
): Promise<void> {
  await postAction(context, {
    action: "set-runner-job-connector-runtime-targets",
    run_id: runId,
    connector_runtime_targets: [...connectorRuntimeTargets],
  });
}

export async function setRunnerJobContextProfileAsPreviousApi(
  context: TestContext,
  runId: string,
  profile: string,
): Promise<void> {
  await postAction(context, {
    action: "set-runner-job-context-profile-as-previous-api",
    run_id: runId,
    profile,
  });
}

export async function removeRunCanonicalStorageState(
  context: TestContext,
  runId: string,
): Promise<void> {
  await postAction(context, {
    action: "remove-run-canonical-storage-state",
    run_id: runId,
  });
}

export async function readRunnerJobStorageState(
  context: TestContext,
  runId: string,
): Promise<
  NonNullable<TestRuntimeStateActionResponse["runner_job_storage_state"]>
> {
  const response = await postAction(context, {
    action: "read-runner-job-storage-state",
    run_id: runId,
  });
  if (!response.runner_job_storage_state) {
    throw new Error(
      "readRunnerJobStorageState missing runner_job_storage_state",
    );
  }
  return response.runner_job_storage_state;
}

export async function readRunClaimOwner(
  context: TestContext,
  runId: string,
): Promise<NonNullable<TestRuntimeStateActionResponse["runner_claim_owner"]>> {
  const response = await postAction(context, {
    action: "read-run-claim-owner",
    run_id: runId,
  });
  if (!response.runner_claim_owner) {
    throw new Error("readRunClaimOwner missing runner_claim_owner");
  }
  return response.runner_claim_owner;
}

export async function readStoragePersistenceState(
  context: TestContext,
  ids: {
    readonly runId: string;
    readonly sessionId: string;
    readonly checkpointId: string;
  },
): Promise<NonNullable<TestRuntimeStateActionResponse["storage_persistence"]>> {
  const response = await postAction(context, {
    action: "read-storage-persistence-state",
    run_id: ids.runId,
    session_id: ids.sessionId,
    checkpoint_id: ids.checkpointId,
  });
  if (!response.storage_persistence) {
    throw new Error("readStoragePersistenceState missing storage_persistence");
  }
  return response.storage_persistence;
}

export async function holdOrgAdmissionLock(
  context: TestContext,
  orgId: string,
): Promise<void> {
  await postAction(context, {
    action: "hold-org-admission-lock",
    org_id: orgId,
  });
}

export async function readOrgAdmissionLockState(
  context: TestContext,
): Promise<{ readonly held: boolean; readonly waiting: boolean }> {
  const response = await postAction(context, {
    action: "read-org-admission-lock-state",
  });
  if (
    response.admission_lock_held === undefined ||
    response.admission_lock_waiting === undefined
  ) {
    throw new Error("readOrgAdmissionLockState missing lock state");
  }
  return {
    held: response.admission_lock_held,
    waiting: response.admission_lock_waiting,
  };
}

export async function releaseOrgAdmissionLock(
  context: TestContext,
): Promise<void> {
  await postAction(context, { action: "release-org-admission-lock" });
}

export async function readRunUploadedFileSources(
  context: TestContext,
  runId: string,
): Promise<readonly string[]> {
  const response = await postAction(context, {
    action: "read-run-uploaded-file-sources",
    run_id: runId,
  });
  return response.uploaded_file_sources ?? [];
}

export async function updateChatEventSnapshotHead(
  context: TestContext,
  threadId: string,
  ...[objectKey, lastSeqId, lastEventId]: [
    objectKey?: string,
    lastSeqId?: number,
    lastEventId?: string,
  ]
): Promise<void> {
  await postAction(context, {
    action: "update-chat-event-snapshot-head",
    thread_id: threadId,
    ...(objectKey === undefined ? {} : { object_key: objectKey }),
    ...(lastSeqId === undefined ? {} : { last_seq_id: lastSeqId }),
    ...(lastEventId === undefined ? {} : { last_event_id: lastEventId }),
  });
}

export async function advanceChatEventSequenceAsPreviousApi(
  context: TestContext,
  threadId: string,
  count: number,
): Promise<void> {
  await postAction(context, {
    action: "advance-chat-event-sequence-as-previous-api",
    thread_id: threadId,
    count,
  });
}

export async function readChatEventSnapshotHead(
  context: TestContext,
  threadId: string,
): Promise<
  NonNullable<TestRuntimeStateActionResponse["chat_event_snapshot_head"]>
> {
  const response = await postAction(context, {
    action: "read-chat-event-snapshot-head",
    thread_id: threadId,
  });
  if (!response.chat_event_snapshot_head) {
    throw new Error("readChatEventSnapshotHead missing snapshot head");
  }
  return response.chat_event_snapshot_head;
}

export async function clearRunApiStart(
  context: TestContext,
  runId: string,
): Promise<void> {
  await postAction(context, {
    action: "clear-run-api-start",
    run_id: runId,
  });
}

export async function readRunApiStart(
  context: TestContext,
  runId: string,
): Promise<string | null> {
  const response = await postAction(context, {
    action: "read-run-api-start",
    run_id: runId,
  });
  if (!("api_started_at" in response)) {
    throw new Error("readRunApiStart missing api_started_at");
  }
  return response.api_started_at ?? null;
}

/**
 * Move one owned running run to an elapsed-time boundary and execute the
 * production steering flow without scanning rows owned by other test files.
 */
export async function steerRunTimeBudgetFixture(
  context: TestContext,
  runId: string,
  elapsedMs: number,
): Promise<NonNullable<TestRuntimeStateActionResponse["run_time_budget"]>> {
  const response = await postAction(context, {
    action: "steer-run-time-budget",
    run_id: runId,
    elapsed_ms: elapsedMs,
  });
  if (!response.run_time_budget) {
    throw new Error("steerRunTimeBudgetFixture missing run_time_budget");
  }
  return response.run_time_budget;
}

export async function readThreadSessionBinding(
  context: TestContext,
  threadId: string,
): Promise<
  NonNullable<TestRuntimeStateActionResponse["thread_session_binding"]>
> {
  const response = await postAction(context, {
    action: "read-thread-session-binding",
    thread_id: threadId,
  });
  if (!response.thread_session_binding) {
    throw new Error("readThreadSessionBinding missing thread_session_binding");
  }
  return response.thread_session_binding;
}

export async function readThreadSessionConversation(
  context: TestContext,
  threadId: string,
): Promise<
  NonNullable<TestRuntimeStateActionResponse["thread_session_conversation"]>
> {
  const response = await postAction(context, {
    action: "read-thread-session-conversation",
    thread_id: threadId,
  });
  if (!response.thread_session_conversation) {
    throw new Error(
      "readThreadSessionConversation missing thread_session_conversation",
    );
  }
  return response.thread_session_conversation;
}

export async function insertLegacyArtifactCatalogFile(
  context: TestContext,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly filename: string;
    readonly url: string;
  },
): Promise<string> {
  const response = await postAction(context, {
    action: "insert-legacy-artifact-catalog-file",
    user_id: args.userId,
    org_id: args.orgId,
    filename: args.filename,
    url: args.url,
  });
  if (!response.file_id) {
    throw new Error("insertLegacyArtifactCatalogFile missing file_id");
  }
  return response.file_id;
}

export async function setComputerUseHostAsPreviousApi(
  context: TestContext,
  args: {
    readonly threadId: string;
    readonly computerUseHostId: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-computer-use-host-as-previous-api",
    thread_id: args.threadId,
    computer_use_host_id: args.computerUseHostId,
  });
}

export async function setBrowserTabSnapshotAsPreviousApi(
  context: TestContext,
  args: {
    readonly threadId: string;
    readonly tabUrls: readonly string[];
  },
): Promise<void> {
  await postAction(context, {
    action: "set-browser-tab-snapshot-as-previous-api",
    thread_id: args.threadId,
    tab_urls: [...args.tabUrls],
  });
}

export async function clearWorkflowAutomationEventConnectorAsPreviousApi(
  context: TestContext,
  automationId: string,
): Promise<void> {
  await postAction(context, {
    action: "clear-workflow-automation-event-connector-as-previous-api",
    automation_id: automationId,
  });
}
