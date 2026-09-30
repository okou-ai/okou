import { command } from "ccstate";
import { now } from "../../lib/time";
import {
  ApiDispatchTimingCollector,
  ApiDispatchPhaseCollector,
} from "./api-dispatch-timing.service";
import { activatePendingRun$ } from "./agent-run-activation.service";
import { recordThreadRunActivationMarkers } from "./chat-first-assistant-event-metric.service";
import {
  createAgentRunExecutionObjects,
  isRouteError,
  isQueueFirstRunClaimLost,
  type CreateAgentRunArgs,
  type CreateRunRouteResult,
} from "./agent-run-execution.service";

const { prepareAgentRun$, completeAgentRun$ } =
  createAgentRunExecutionObjects();

/** Non-chat execution used by the Pi memory background worker. */
export const createAgentRun$ = command(
  async (
    { set },
    args: CreateAgentRunArgs,
    signal: AbortSignal,
  ): Promise<CreateRunRouteResult> => {
    if (args.queueFirstAssociation !== undefined) {
      throw new Error("Background run cannot consume a chat input");
    }
    const timing = args.timing ?? new ApiDispatchTimingCollector();
    const phaseTiming = new ApiDispatchPhaseCollector(args.apiStartTime);
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_run",
      "top_level",
      args.apiStartTime,
    );
    phaseTiming.checkpoint("api_dispatch_phase_pre_create", now());
    const prepared = await set(
      prepareAgentRun$,
      {
        args,
        timing,
        phaseTiming,
        checkOrgPlanStatusBeforeContext: true,
      },
      signal,
    );
    if (isRouteError(prepared)) {
      return prepared;
    }
    const result = await set(
      completeAgentRun$,
      {
        prepared,
        finalAppendSystemPrompt: args.body.appendSystemPrompt,
      },
      signal,
    );
    if (isQueueFirstRunClaimLost(result)) {
      throw new Error("Direct run unexpectedly lost a queue-first claim");
    }
    if (result.status === 201 && result.pendingActivation) {
      if (result.pendingActivation.chatThreadId !== undefined) {
        recordThreadRunActivationMarkers(
          result.pendingActivation.runnerNotification,
          result.pendingActivation.apiStartTime,
          result.pendingActivation.timing.activationOrigin,
        );
      }
      await set(
        activatePendingRun$,
        {
          notification: result.pendingActivation.runnerNotification,
          timing: result.pendingActivation.timing,
          activationScheduledAt: now(),
        },
        signal,
      );
    }
    return result;
  },
);
