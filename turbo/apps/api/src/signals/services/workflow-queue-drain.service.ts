import { workflows, workflowAutomations } from "@okouai/db/schema/workflow";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/log";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { writeDb$, type Db } from "../external/db";
import { AUTONOMY_BUDGET_EXHAUSTED_MESSAGE } from "../../lib/error";
import {
  childAutonomyBudget,
  loadRunAutonomyBudget,
} from "./autonomy-budget.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  loadNextWorkflowQueueEvent,
  rejectWorkflowQueueEvent,
  type PendingWorkflowQueueEvent,
} from "./workflow-chat-event-queue.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { buildWorkflowAutomationQueuedLaunchMaterial } from "./workflow-automation-queued-launch-context.service";
import {
  launchQueuedWorkflowAutomation$,
  type RunWorkflowAutomationResult,
} from "./workflow-automation-launch.service";
import {
  dispatchConfiguredOfficialWorkflowReconciliation$,
  type OfficialWorkflowReconciliationArgs,
  type OfficialWorkflowReconciliationResult,
} from "./official-workflow-reconciliation-dispatch.service";

const log = logger("WorkflowQueueDrain");

// Consecutive stale events or claims invalidated by concurrent queue changes
// are retried per drain call; a successful run creation always stops the loop.
const MAX_DRAIN_ATTEMPTS = 5;

interface DequeueTarget {
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly agentId: string;
}

async function loadDequeueTarget(
  db: Db,
  automationId: string,
): Promise<DequeueTarget | null> {
  const [row] = await db
    .select({
      automation: workflowAutomationColumns(),
      agentId: workflows.agentId,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
    .where(eq(workflowAutomations.id, automationId))
    .limit(1);
  return row ?? null;
}

async function reconcileDequeueTarget(
  reconcile: (
    args: OfficialWorkflowReconciliationArgs,
  ) => Promise<OfficialWorkflowReconciliationResult>,
  db: Db,
  event: LaunchableQueueEvent,
  target: DequeueTarget,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "current"; readonly target: DequeueTarget }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "retry" }
> {
  if (target.automation.officialBlueprintKey === null) {
    return { kind: "current", target };
  }
  const reconciled = await reconcile({
    orgId: target.automation.orgId,
    member: { userId: target.automation.ownerUserId, role: "member" },
    workflowId: target.automation.workflowId,
    targetAutomationId: target.automation.id,
  });
  signal.throwIfAborted();
  if (reconciled.kind === "retry") {
    return { kind: "retry" };
  }
  if (reconciled.kind !== "current") {
    return {
      kind: "conflict",
      message:
        reconciled.kind === "needs-reconfiguration"
          ? reconciled.message
          : "Official Workflow automation no longer exists",
    };
  }
  const refreshed = await loadDequeueTarget(db, target.automation.id);
  signal.throwIfAborted();
  return refreshed
    ? { kind: "current", target: refreshed }
    : {
        kind: "conflict",
        message: "Official Workflow automation no longer exists",
      };
}

type WorkflowRunAutonomyBudget =
  | { readonly kind: "ok"; readonly autonomyBudget: number }
  | { readonly kind: "invalid"; readonly message: string };

async function resolveWorkflowRunAutonomyBudget(
  db: Db,
  event: PendingWorkflowQueueEvent,
  automation: typeof workflowAutomations.$inferSelect,
): Promise<WorkflowRunAutonomyBudget> {
  const sourceRunId =
    event.workflowAutomationEventType === "chat-run-finished"
      ? event.workflowAutomationEventPayload?.["runId"]
      : event.workflowAutomationEventType === "manual"
        ? event.workflowAutomationEventPayload?.["sourceRunId"]
        : undefined;
  if (
    event.workflowAutomationEventType !== "chat-run-finished" &&
    sourceRunId === undefined
  ) {
    return { kind: "ok", autonomyBudget: automation.autonomyBudget };
  }
  if (typeof sourceRunId !== "string") {
    return {
      kind: "invalid",
      message: `${event.workflowAutomationEventType === "manual" ? "Manual automation" : "Chat run finished"} event is missing its source run`,
    };
  }
  const sourceAutonomyBudget = await loadRunAutonomyBudget(db, sourceRunId);
  if (sourceAutonomyBudget === null) {
    return {
      kind: "invalid",
      message: `${event.workflowAutomationEventType === "manual" ? "Manual automation" : "Chat run finished"} source run no longer exists`,
    };
  }
  const derived = childAutonomyBudget(sourceAutonomyBudget);
  if (derived.kind === "exhausted") {
    return { kind: "invalid", message: AUTONOMY_BUDGET_EXHAUSTED_MESSAGE };
  }
  return {
    kind: "ok",
    autonomyBudget: derived.autonomyBudget,
  };
}

/**
 * Advance the thread's workflow queue: as long as user queued messages always
 * win (enforced inside `loadNextWorkflowQueueEvent`), prepare the oldest event
 * and turn it into a run. The final run persistence transaction consumes the
 * event. Stale events and failed run creations reject only their own trigger.
 */
export interface WorkflowQueueDrainResult {
  readonly eventId: string;
  readonly result: RunWorkflowAutomationResult;
}

interface AutomationEventLaunch {
  readonly eventId: string;
  readonly apiStartTime: number;
  readonly timing: ApiDispatchTimingCollector;
}

interface DrainWorkflowQueueArgs {
  readonly apiStartTime: number;
  readonly chatThreadId: string;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly queueItemCreatedBefore?: Date;
  readonly automationEventLaunch?: AutomationEventLaunch;
}

async function loadNextDrainEvent(
  db: Db,
  args: DrainWorkflowQueueArgs,
  signal: AbortSignal,
) {
  const event = await loadNextWorkflowQueueEvent(
    db,
    args.chatThreadId,
    args.queueItemCreatedBefore,
  );
  signal.throwIfAborted();
  return event;
}

const CONTINUE_DRAIN = Symbol("continue-workflow-queue-drain");
type WorkflowQueueDrainStep =
  | WorkflowQueueDrainResult
  | null
  | typeof CONTINUE_DRAIN;

async function publishQueueEventChanged(
  event: PendingWorkflowQueueEvent,
  signal: AbortSignal,
): Promise<void> {
  await publishChatThreadMessageCreatedSafely({
    userId: event.userId,
    orgId: event.orgId,
    threadId: event.chatThreadId,
  });
  signal.throwIfAborted();
}

async function consumeInvalidAutomationEvent(
  db: Db,
  event: PendingWorkflowQueueEvent,
  conflictMessage: string,
  launchHint: AutomationEventLaunch | undefined,
  signal: AbortSignal,
): Promise<WorkflowQueueDrainStep> {
  const consumed = await rejectWorkflowQueueEvent(db, {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
    reason: conflictMessage,
  });
  signal.throwIfAborted();
  if (!consumed) {
    return null;
  }
  await publishQueueEventChanged(event, signal);
  if (launchHint?.eventId !== event.id) {
    return CONTINUE_DRAIN;
  }
  return {
    eventId: event.id,
    result: { kind: "conflict", message: conflictMessage },
  };
}

function consumeUnavailableAutomationEvent(
  db: Db,
  event: PendingWorkflowQueueEvent,
  launchHint: AutomationEventLaunch | undefined,
  signal: AbortSignal,
): Promise<WorkflowQueueDrainStep> {
  const conflictMessage =
    event.automationId === null || event.publicBrand === null
      ? "Workflow queue event payload is unreadable"
      : "Workflow automation no longer exists";
  log.debug("Consuming workflow queue event without automation", {
    eventId: event.id,
    automationId: event.automationId,
  });
  return consumeInvalidAutomationEvent(
    db,
    event,
    conflictMessage,
    launchHint,
    signal,
  );
}

async function handleWorkflowLaunchResult(
  args: {
    readonly db: Db;
    readonly event: PendingWorkflowQueueEvent;
    readonly result: RunWorkflowAutomationResult;
    readonly launchHint: AutomationEventLaunch | undefined;
  },
  signal: AbortSignal,
): Promise<WorkflowQueueDrainStep> {
  const { db, event, result, launchHint } = args;
  if (result.kind === "ok") {
    await publishQueueEventChanged(event, signal);
    return { eventId: event.id, result };
  }
  if (result.kind === "enqueued") {
    await publishQueueEventChanged(event, signal);
    return CONTINUE_DRAIN;
  }
  if (result.kind === "conflict") {
    log.debug("Consuming unfireable workflow queue event", {
      eventId: event.id,
      automationId: event.automationId,
      message: result.message,
    });
    const consumed = await rejectWorkflowQueueEvent(db, {
      eventId: event.id,
      chatThreadId: event.chatThreadId,
      reason: result.message,
    });
    signal.throwIfAborted();
    if (!consumed) {
      return null;
    }
    await publishQueueEventChanged(event, signal);
    return launchHint ? { eventId: event.id, result } : CONTINUE_DRAIN;
  }

  const failed = await rejectWorkflowQueueEvent(db, {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
    reason: result.response.body.error.message,
  });
  signal.throwIfAborted();
  if (!failed) {
    return null;
  }
  const logRejection =
    result.response.body.error.code === "INSUFFICIENT_CREDITS"
      ? log.debug
      : log.warn;
  logRejection("Workflow queue event rejected after run creation failure", {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
    code: result.response.body.error.code,
  });
  await publishQueueEventChanged(event, signal);
  return {
    eventId: event.id,
    result,
  };
}

function matchingLaunch(
  launch: AutomationEventLaunch | undefined,
  eventId: string,
): AutomationEventLaunch | undefined {
  return launch?.eventId === eventId ? launch : undefined;
}

function queuedWorkflowLaunchMaterial(
  event: PendingWorkflowQueueEvent,
  target: DequeueTarget,
  publicBrand: PublicBrand,
) {
  return buildWorkflowAutomationQueuedLaunchMaterial({
    workflowName: event.workflowName,
    eventType: event.workflowAutomationEventType,
    eventPayload: event.workflowAutomationEventPayload,
    automation: target.automation,
    agentId: target.agentId,
    chatThreadId: event.chatThreadId,
    publicBrand,
  });
}

type LaunchableQueueEvent = PendingWorkflowQueueEvent & {
  readonly automationId: string;
  readonly triggerSource: NonNullable<
    PendingWorkflowQueueEvent["triggerSource"]
  >;
  readonly publicBrand: PublicBrand;
};

function isLaunchableQueueEvent(
  event: PendingWorkflowQueueEvent,
): event is LaunchableQueueEvent {
  return (
    event.automationId !== null &&
    event.triggerSource !== null &&
    event.publicBrand !== null
  );
}

type PreparedDequeueTarget =
  | { readonly kind: "target"; readonly target: DequeueTarget }
  | { readonly kind: "drain-step"; readonly step: WorkflowQueueDrainStep };

async function prepareDequeueTarget(
  args: {
    readonly db: Db;
    readonly event: LaunchableQueueEvent;
    readonly launchHint: AutomationEventLaunch | undefined;
    readonly reconcile: (
      reconcileArgs: OfficialWorkflowReconciliationArgs,
    ) => Promise<OfficialWorkflowReconciliationResult>;
  },
  signal: AbortSignal,
): Promise<PreparedDequeueTarget> {
  const loaded = await loadDequeueTarget(args.db, args.event.automationId);
  signal.throwIfAborted();
  if (!loaded) {
    return {
      kind: "drain-step",
      step: await consumeUnavailableAutomationEvent(
        args.db,
        args.event,
        args.launchHint,
        signal,
      ),
    };
  }
  const reconciled = await reconcileDequeueTarget(
    args.reconcile,
    args.db,
    args.event,
    loaded,
    signal,
  );
  if (reconciled.kind === "retry") {
    return { kind: "drain-step", step: null };
  }
  if (reconciled.kind === "conflict") {
    return {
      kind: "drain-step",
      step: await consumeInvalidAutomationEvent(
        args.db,
        args.event,
        reconciled.message,
        args.launchHint,
        signal,
      ),
    };
  }
  return { kind: "target", target: reconciled.target };
}

export const drainWorkflowQueueForThread$ = command(
  async (
    { set },
    args: DrainWorkflowQueueArgs,
    signal: AbortSignal,
  ): Promise<WorkflowQueueDrainResult | null> => {
    const db = set(writeDb$);
    for (let attempt = 0; attempt < MAX_DRAIN_ATTEMPTS; attempt++) {
      const event = await loadNextDrainEvent(db, args, signal);
      if (!event) {
        return null;
      }

      if (!isLaunchableQueueEvent(event)) {
        const step = await consumeUnavailableAutomationEvent(
          db,
          event,
          args.automationEventLaunch,
          signal,
        );
        if (step !== CONTINUE_DRAIN) {
          return step;
        }
        continue;
      }

      const preparedTarget = await prepareDequeueTarget(
        {
          db,
          event,
          launchHint: args.automationEventLaunch,
          reconcile: async (reconcileArgs) => {
            return await set(
              dispatchConfiguredOfficialWorkflowReconciliation$,
              reconcileArgs,
              signal,
            );
          },
        },
        signal,
      );
      if (preparedTarget.kind === "drain-step") {
        if (preparedTarget.step !== CONTINUE_DRAIN) {
          return preparedTarget.step;
        }
        continue;
      }
      const launchMaterial = queuedWorkflowLaunchMaterial(
        event,
        preparedTarget.target,
        event.publicBrand,
      );
      signal.throwIfAborted();
      if (!launchMaterial) {
        log.error("Consuming workflow queue event with incomplete context", {
          eventId: event.id,
          automationId: event.automationId,
        });
        const step = await consumeInvalidAutomationEvent(
          db,
          event,
          "Workflow queue event payload is unreadable",
          args.automationEventLaunch,
          signal,
        );
        if (step !== CONTINUE_DRAIN) {
          return step;
        }
        continue;
      }

      const autonomyBudget = await resolveWorkflowRunAutonomyBudget(
        db,
        event,
        preparedTarget.target.automation,
      );
      signal.throwIfAborted();
      if (autonomyBudget.kind === "invalid") {
        const step = await consumeInvalidAutomationEvent(
          db,
          event,
          autonomyBudget.message,
          args.automationEventLaunch,
          signal,
        );
        if (step !== CONTINUE_DRAIN) {
          return step;
        }
        continue;
      }

      const launchHint = matchingLaunch(args.automationEventLaunch, event.id);
      const result = await set(
        launchQueuedWorkflowAutomation$,
        {
          due: {
            automation: preparedTarget.target.automation,
            agentId: preparedTarget.target.agentId,
            chatThreadId: event.chatThreadId,
            allowClaimedOnceScheduleAutomation:
              launchMaterial.allowClaimedOnceScheduleAutomation,
          },
          queueEventId: event.id,
          apiStartTime: launchHint?.apiStartTime ?? args.apiStartTime,
          prompt: launchMaterial.prompt,
          publicBrand: event.publicBrand,
          triggerBrief: event.triggerBrief ?? undefined,
          triggerSource: event.triggerSource,
          ...(event.connectorSourceId
            ? { connectorSourceId: event.connectorSourceId }
            : {}),
          appendSystemPrompt: launchMaterial.appendSystemPrompt,
          callbacks: launchMaterial.callbacks,
          autonomyBudget: autonomyBudget.autonomyBudget,
          activePreviousRunPolicy: launchMaterial.activePreviousRunPolicy,
          recordLastRunId: launchMaterial.recordLastRunId,
          recordLastRunAt: launchMaterial.recordLastRunAt,
          dispatchFailedCallbacks: args.dispatchFailedCallbacks,
          timing: launchHint?.timing,
        },
        signal,
      );
      signal.throwIfAborted();
      const step = await handleWorkflowLaunchResult(
        { db, event, result, launchHint },
        signal,
      );
      if (step !== CONTINUE_DRAIN) {
        return step;
      }
    }
    return null;
  },
);
