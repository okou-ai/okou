import { randomBytes } from "node:crypto";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import {
  isQueueFirstRunClaimLost,
  type DispatchFailedRunCallbacks,
} from "./agent-run-create.service";
import type { PersistWorkflowQueueSourceTransition } from "./workflow-chat-event-queue.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  finalizeClaimedRunUserMessage,
  resolveRunChatThreadModelContext,
} from "./chat-run-event.service";
import {
  modelProviderWriteTypeForLaunch,
  type ModelFirstPin,
} from "./model-selection.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import { createQueueFirstAgentRun$ } from "./agent-runs-create.service";
import { workflowAutomationCanFire } from "./workflow-automation-access.service";
import { loadComputerUseHostGrantForAutoSend } from "./chat-computer-use-host.service";
import { shouldUsePiExecution } from "./pi-sandbox-config";
import { resolveReasoningEffortForDispatch } from "./chat-reasoning-effort.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import type { ChatAgentRunSourceAnnotation } from "./chat-user-message.service";
import {
  resolveBuiltInModelRuntimeRoute,
  type BuiltInModelRuntimeRoute,
} from "./built-in-model-runtime-route.service";

export type AutomationRow = typeof workflowAutomations.$inferSelect;

export interface DueWorkflowAutomation {
  readonly automation: AutomationRow;
  // The owning agent is derived from the workflow row (hard 1:N); automations no
  // longer carry an agentId column, so callers resolve it and pass it here.
  readonly agentId: string;
  readonly chatThreadId: string;
  // One-time schedule automations are disabled as part of the optimistic claim.
  // That claimed row can still proceed through the run-start readability gate.
  readonly allowClaimedOnceScheduleAutomation?: boolean;
}

type RunErrorResponse = {
  readonly status: number;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

export type RunWorkflowAutomationResult =
  | { readonly kind: "ok"; readonly runId: string }
  // The event was accepted into the workflow queue instead of starting a run.
  | { readonly kind: "enqueued" }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "run_error"; readonly response: RunErrorResponse };

export type RunFailure = Exclude<
  RunWorkflowAutomationResult,
  { kind: "ok" } | { kind: "enqueued" }
>;
type ActivePreviousRunPolicy = "block" | "allow";

interface InternalRunCallbackInput {
  readonly internalKind: InternalRunCallbackKind;
  readonly secret: string;
  readonly payload: unknown;
}

function workflowModelProviderBody(modelProvider: string | null | undefined) {
  return modelProvider
    ? { modelProvider: modelProviderWriteTypeForLaunch(modelProvider) }
    : {};
}

type ModelContext =
  | {
      readonly ok: true;
      readonly modelPin: ModelFirstPin;
      readonly effectiveModelProvider: string | null | undefined;
      readonly builtInModelRuntimeRoute: BuiltInModelRuntimeRoute | undefined;
      readonly cliAgentType: string | null;
      readonly codexServiceTier: "fast" | undefined;
      readonly reasoningEffort: ReasoningEffort | null;
      readonly piExecution: boolean;
    }
  | { readonly ok: false; readonly failure: RunFailure };

export interface RunWorkflowAutomationNowArgs {
  readonly due: DueWorkflowAutomation;
  readonly automationContext: WorkflowAutomationContext;
  readonly publicBrand?: PublicBrand;
  readonly apiStartTime: number;
  readonly agentRunSource?: ChatAgentRunSourceAnnotation;
  /** Exact member connector that durably delivered this provider event. */
  readonly connectorSourceId?: string;
  // Display-only trigger summary used by workflow annotations and run history.
  readonly triggerBrief?: string;
  readonly triggerSource?: TriggerSource;
  // Automated schedule ticks coalesce while pending. Explicit manual runs set
  // this false so every user action remains a distinct queue item.
  readonly coalescePendingScheduleRun?: boolean;
  /**
   * Admission-only source transition. This callback is never serialized into
   * the durable workflow queue payload.
   */
  readonly persistSourceTransition?: PersistWorkflowQueueSourceTransition;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly timing?: ApiDispatchTimingCollector;
}

interface WorkflowAutomationLaunchArgs {
  readonly due: DueWorkflowAutomation;
  readonly apiStartTime: number;
  readonly prompt: string;
  readonly publicBrand: PublicBrand;
  readonly triggerBrief?: string;
  readonly triggerSource?: TriggerSource;
  readonly connectorSourceId?: string;
  readonly appendSystemPrompt: string | undefined;
  readonly callbacks: readonly InternalRunCallbackInput[];
  readonly activePreviousRunPolicy: ActivePreviousRunPolicy;
  readonly autonomyBudget: number;
  readonly recordLastRunId: boolean;
  readonly recordLastRunAt: boolean;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly timing?: ApiDispatchTimingCollector;
}

interface LaunchQueuedWorkflowAutomationArgs extends WorkflowAutomationLaunchArgs {
  readonly queueEventId: string;
}

interface WorkflowAutomationRunInput {
  readonly prompt: string;
  readonly appendSystemPrompt: string | undefined;
  readonly callbacks: readonly InternalRunCallbackInput[];
  readonly agentRunMetadata: ReturnType<typeof workflowAutomationRunMetadata>;
}

type ComputerUseHostGrant = Awaited<
  ReturnType<typeof loadComputerUseHostGrantForAutoSend>
>;

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function isActivePreviousRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

function workflowAutomationRunMetadata(
  automation: AutomationRow,
  triggerBrief: string | undefined,
  autonomyBudget: number,
) {
  return {
    workflowAutomationId: automation.id,
    triggerBrief,
    autonomyBudget,
  };
}

/**
 * The schedule recurrence callback (when applicable), the launch-snapshotted
 * Official result-email callback, and the chat callback. Cron and once both
 * use the cron callback; once carries no cronExpression so it does not recur.
 */
export function buildWorkflowAutomationCallbacks(
  automation: AutomationRow,
  agentId: string,
  chatThreadId: string,
  publicBrand: PublicBrand,
  workflowName: string,
): InternalRunCallbackInput[] {
  const callbacks: InternalRunCallbackInput[] = [];
  if (automation.kind === "schedule") {
    if (automation.scheduleType === "loop") {
      callbacks.push({
        internalKind: "workflow-automation:loop",
        secret: generateCallbackSecret(),
        payload: {
          automationId: automation.id,
        },
      });
    } else {
      callbacks.push({
        internalKind: "workflow-automation:cron",
        secret: generateCallbackSecret(),
        payload: {
          automationId: automation.id,
          timezone: automation.timezone,
          ...(automation.cronExpression
            ? { cronExpression: automation.cronExpression }
            : {}),
        },
      });
    }
  }
  if (automation.officialResultEmailEnabled === true) {
    callbacks.push({
      internalKind: "workflow-automation:result-email",
      secret: generateCallbackSecret(),
      payload: {
        automationId: automation.id,
        workflowName,
        publicBrand,
      },
    });
  }
  callbacks.push({
    internalKind: "chat",
    secret: generateCallbackSecret(),
    payload: { threadId: chatThreadId, agentId, publicBrand },
  });
  return callbacks;
}

/**
 * Consecutive ticks of the same schedule are otherwise indistinguishable, so the
 * fire time is this run's unique identifier. The scheduler owns the fire time and
 * builds this at admission; the launch fallback below only serves rows enqueued
 * before schedules carried a trigger line.
 */
export function scheduleTriggerContext(args: {
  readonly automation: AutomationRow;
  readonly workflowName: string;
  readonly firedAt: Date;
}): WorkflowAutomationContext {
  const firedAt = args.firedAt.toISOString();
  const recurrence =
    args.automation.scheduleType === "loop"
      ? `every ${args.automation.intervalSeconds}s`
      : args.automation.cronExpression
        ? `cron "${args.automation.cronExpression}" in ${args.automation.timezone}`
        : `once in ${args.automation.timezone}`;
  return {
    workflowName: args.workflowName,
    eventType: "schedule",
    trigger: `schedule fired at ${firedAt} (${recurrence}).`,
    event: {
      automationId: args.automation.id,
      trigger: "schedule",
      scheduleType: args.automation.scheduleType,
      cronExpression: args.automation.cronExpression,
      intervalSeconds: args.automation.intervalSeconds,
      atTime: args.automation.atTime,
      timezone: args.automation.timezone,
      firedAt,
    },
  };
}

function appendComputerUseSystemPrompt(
  prompt: string | undefined,
  grant: ComputerUseHostGrant,
): string | undefined {
  if (!grant) {
    return prompt;
  }
  return [
    ...(prompt ? [prompt] : []),
    "# Computer Use",
    `Computer Use is enabled for this run on ${grant.displayName}.`,
  ].join("\n\n");
}

async function resolveModelContext(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
  },
  signal: AbortSignal,
): Promise<ModelContext> {
  const threadModelContext = await resolveRunChatThreadModelContext({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    threadId: args.chatThreadId,
  });
  signal.throwIfAborted();
  if ("status" in threadModelContext) {
    return {
      ok: false,
      failure: {
        kind: "run_error",
        response: {
          status: threadModelContext.status,
          body: threadModelContext.body,
        },
      },
    };
  }

  const { pin, providerAdmission, runCodexServiceTier } = threadModelContext;
  signal.throwIfAborted();
  if (providerAdmission.error) {
    return {
      ok: false,
      failure: { kind: "run_error", response: providerAdmission.error },
    };
  }

  const effectiveModelProvider = providerAdmission.effectiveModelProvider;
  const selectedModel = pin.selectedModel;
  const builtInModelRuntimeRoute =
    isBuiltInModelProviderType(effectiveModelProvider) && selectedModel
      ? await resolveBuiltInModelRuntimeRoute(args.db, selectedModel)
      : undefined;
  signal.throwIfAborted();
  if (
    isBuiltInModelProviderType(effectiveModelProvider) &&
    !builtInModelRuntimeRoute
  ) {
    return {
      ok: false,
      failure: {
        kind: "run_error",
        response: {
          status: 503,
          body: {
            error: {
              code: "MODEL_PROVIDER_UNAVAILABLE",
              message:
                "Every built-in model route for this model is temporarily unavailable",
            },
          },
        },
      },
    };
  }

  const piExecution = shouldUsePiExecution({
    chatThreadId: args.chatThreadId,
    modelProviderType: effectiveModelProvider,
    selectedModel,
    codexServiceTier: runCodexServiceTier,
    builtInModelRuntimeRoute: builtInModelRuntimeRoute ?? undefined,
    featureSwitchContext: threadModelContext.featureSwitchContext,
  });
  return {
    ok: true,
    modelPin: pin,
    effectiveModelProvider,
    builtInModelRuntimeRoute: builtInModelRuntimeRoute ?? undefined,
    cliAgentType: piExecution ? "pi" : providerAdmission.cliAgentType,
    codexServiceTier: runCodexServiceTier,
    reasoningEffort:
      resolveReasoningEffortForDispatch({
        selectedModel,
        effort: threadModelContext.reasoningEffort,
        runtimeProviderType:
          builtInModelRuntimeRoute?.providerType ?? effectiveModelProvider,
        piExecution,
      }) ?? null,
    piExecution,
  };
}

function workflowThreadSessionRoute(
  modelContext: Extract<ModelContext, { readonly ok: true }>,
) {
  return {
    selectedModel: modelContext.modelPin.selectedModel,
    cliAgentType: modelContext.cliAgentType,
  };
}

function workflowAutomationTiming(
  args: LaunchQueuedWorkflowAutomationArgs,
): ApiDispatchTimingCollector {
  const timing = args.timing ?? new ApiDispatchTimingCollector();
  if (!args.timing) {
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap",
      "nested",
      args.apiStartTime,
    );
  }
  return timing;
}

async function checkActivePreviousWorkflowRun(
  args: {
    readonly db: Db;
    readonly automation: AutomationRow;
    readonly activePreviousRunPolicy: ActivePreviousRunPolicy;
    readonly timing: ApiDispatchTimingCollector;
  },
  signal: AbortSignal,
): Promise<RunFailure | undefined> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_workflow_automation_check_active_run",
    "nested",
    async (): Promise<RunFailure | undefined> => {
      if (
        args.activePreviousRunPolicy !== "allow" &&
        args.automation.lastRunId
      ) {
        const [lastRun] = await args.db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, args.automation.lastRunId))
          .limit(1);
        signal.throwIfAborted();
        if (lastRun && isActivePreviousRunStatus(lastRun.status)) {
          return {
            kind: "conflict",
            message: "Previous run is still active",
          };
        }
      }
      return undefined;
    },
  );
}

async function checkWorkflowAutomationTargetReadable(
  args: {
    readonly db: Db;
    readonly automation: AutomationRow;
    readonly agentId: string;
    readonly allowClaimedOnceScheduleAutomation: boolean;
    readonly timing: ApiDispatchTimingCollector;
  },
  signal: AbortSignal,
): Promise<RunFailure | undefined> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_workflow_automation_check_target_access",
    "nested",
    async (): Promise<RunFailure | undefined> => {
      const canFire = await workflowAutomationCanFire(
        args.db,
        {
          automation: args.automation,
          agentId: args.agentId,
          allowClaimedOnceScheduleAutomation:
            args.allowClaimedOnceScheduleAutomation,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!canFire) {
        return {
          kind: "conflict",
          message: "Workflow automation is paused or no longer readable",
        };
      }
      return undefined;
    },
  );
}

async function resolveTimedWorkflowModelContext(
  args: {
    readonly db: Db;
    readonly automation: AutomationRow;
    readonly chatThreadId: string;
    readonly timing: ApiDispatchTimingCollector;
  },
  signal: AbortSignal,
): Promise<ModelContext> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_workflow_automation_resolve_model_context",
    "nested",
    async () => {
      return await resolveModelContext(
        {
          db: args.db,
          orgId: args.automation.orgId,
          userId: args.automation.ownerUserId,
          chatThreadId: args.chatThreadId,
        },
        signal,
      );
    },
  );
}

async function buildTimedWorkflowAutomationRunInput(args: {
  readonly command: WorkflowAutomationLaunchArgs;
  readonly automation: AutomationRow;
  readonly computerUseHostGrant: ComputerUseHostGrant;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<WorkflowAutomationRunInput> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_workflow_automation_build_run_input",
    "nested",
    () => {
      return {
        prompt: args.command.prompt,
        appendSystemPrompt: appendComputerUseSystemPrompt(
          args.command.appendSystemPrompt,
          args.computerUseHostGrant,
        ),
        callbacks: args.command.callbacks,
        agentRunMetadata: workflowAutomationRunMetadata(
          args.automation,
          args.command.triggerBrief,
          args.command.autonomyBudget,
        ),
      };
    },
  );
}

async function recordWorkflowAutomationRunStart(
  input: {
    readonly db: Db;
    readonly args: WorkflowAutomationLaunchArgs;
    readonly runId: string;
    readonly runStatus: string;
    readonly claimedEventCreatedAt: Date;
  },
  signal: AbortSignal,
): Promise<void> {
  const { db, args, runId } = input;
  const { automation, chatThreadId } = args.due;
  await finalizeClaimedRunUserMessage({
    db,
    orgId: automation.orgId,
    threadId: chatThreadId,
    userId: automation.ownerUserId,
    runId,
    runStatus: input.runStatus,
    createdAt: input.claimedEventCreatedAt,
  });
  signal.throwIfAborted();

  await db
    .update(workflowAutomations)
    .set({
      ...(args.recordLastRunId === false ? {} : { lastRunId: runId }),
      ...(args.recordLastRunAt ? { lastRunAt: nowDate() } : {}),
      ...(args.due.allowClaimedOnceScheduleAutomation
        ? { enabled: false }
        : {}),
      updatedAt: nowDate(),
    })
    .where(eq(workflowAutomations.id, automation.id));
  signal.throwIfAborted();
}

async function checkQueuedWorkflowLaunchReadiness(
  input: {
    readonly db: Db;
    readonly args: LaunchQueuedWorkflowAutomationArgs;
    readonly timing: ReturnType<typeof workflowAutomationTiming>;
  },
  signal: AbortSignal,
): Promise<RunWorkflowAutomationResult | null> {
  const { automation, agentId } = input.args.due;
  const activePreviousRunFailure = await checkActivePreviousWorkflowRun(
    {
      db: input.db,
      automation,
      activePreviousRunPolicy: input.args.activePreviousRunPolicy,
      timing: input.timing,
    },
    signal,
  );
  if (activePreviousRunFailure) {
    return activePreviousRunFailure;
  }
  return (
    (await checkWorkflowAutomationTargetReadable(
      {
        db: input.db,
        automation,
        agentId,
        allowClaimedOnceScheduleAutomation:
          input.args.due.allowClaimedOnceScheduleAutomation === true,
        timing: input.timing,
      },
      signal,
    )) ?? null
  );
}

function workflowAutomationAgentRunAuth(automation: {
  readonly orgId: string;
  readonly ownerUserId: string;
}) {
  return {
    orgId: automation.orgId,
    orgRole: "member" as const,
    userId: automation.ownerUserId,
    tokenType: "session" as const,
  };
}

export const launchQueuedWorkflowAutomation$ = command(
  async (
    { set },
    args: LaunchQueuedWorkflowAutomationArgs,
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const db = set(writeDb$);
    const { automation, agentId, chatThreadId } = args.due;
    const timing = workflowAutomationTiming(args);

    const readinessFailure = await checkQueuedWorkflowLaunchReadiness(
      { db, args, timing },
      signal,
    );
    if (readinessFailure) {
      return readinessFailure;
    }

    const modelContext = await resolveTimedWorkflowModelContext(
      {
        db,
        automation,
        chatThreadId,
        timing,
      },
      signal,
    );
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const {
      modelPin,
      effectiveModelProvider,
      builtInModelRuntimeRoute,
      codexServiceTier,
      reasoningEffort,
    } = modelContext;

    const computerUseHostGrant = await loadComputerUseHostGrantForAutoSend({
      db,
      threadId: chatThreadId,
      orgId: automation.orgId,
      userId: automation.ownerUserId,
    });
    signal.throwIfAborted();

    const runInput = await buildTimedWorkflowAutomationRunInput({
      command: args,
      automation,
      computerUseHostGrant,
      timing,
    });
    signal.throwIfAborted();
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_workflow_automation_create_run",
      "nested",
      now(),
    );
    const result = await set(
      createQueueFirstAgentRun$,
      {
        auth: workflowAutomationAgentRunAuth(automation),
        body: {
          prompt: runInput.prompt,
          agentId,
          ...workflowModelProviderBody(effectiveModelProvider),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: args.triggerSource ?? "automation-schedule",
        chatThreadId,
        ...(args.connectorSourceId
          ? { connectorSourceId: args.connectorSourceId }
          : {}),
        computerUseHostId: computerUseHostGrant?.hostId,
        modelProviderId: modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: modelPin.selectedModel ?? undefined,
        ...(builtInModelRuntimeRoute ? { builtInModelRuntimeRoute } : {}),
        threadSessionRoute: workflowThreadSessionRoute(modelContext),
        codexServiceTier,
        reasoningEffort,
        appendSystemPrompt: runInput.appendSystemPrompt,
        callbacks: runInput.callbacks,
        agentRunMetadata: runInput.agentRunMetadata,
        ...(automation.officialBlueprintKey === null
          ? {}
          : { requiredOfficialWorkflowIds: [automation.workflowId] }),
        queueFirstAssociation: {
          kind: "automation_event",
          threadId: chatThreadId,
          eventId: args.queueEventId,
          prompt: runInput.prompt,
          automationId: automation.id,
        },
        agentRunModelPin: {
          modelProvider: effectiveModelProvider ?? null,
          modelProviderId: modelPin.modelProviderId,
          modelProviderCredentialScope: modelPin.modelProviderCredentialScope,
          selectedModel: modelPin.selectedModel,
        },
        piExecution: modelContext.piExecution,
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
        timing,
      },
      signal,
    );

    if (isQueueFirstRunClaimLost(result)) {
      signal.throwIfAborted();
      return { kind: "enqueued" };
    }
    if (result.status !== 201) {
      signal.throwIfAborted();
      return { kind: "run_error", response: result };
    }
    await recordWorkflowAutomationRunStart(
      {
        db,
        args,
        runId: result.body.runId,
        runStatus: result.body.status,
        claimedEventCreatedAt: result.queueFirstClaim.createdAt,
      },
      signal,
    );

    return {
      kind: "ok",
      runId: result.body.runId,
    };
  },
);
