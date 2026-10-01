import { command } from "ccstate";
import { now } from "../../lib/time";
import { activatePendingRun$ } from "./agent-run-activation.service";
import { recordThreadRunActivationMarkers } from "./chat-first-assistant-event-metric.service";
import {
  createAgentRunExecutionObjects,
  createSelectedAgentRunObjects,
  isQueueFirstRunClaimLost,
} from "./agent-run-execution.service";
import {
  ApiDispatchPhaseCollector,
  ApiDispatchTimingCollector,
} from "./api-dispatch-timing.service";
import type {
  CreateAgentRunArgs,
  CreateRunRouteResult,
} from "./execution-launch-persistence.service";
import { isRouteError } from "./run-execution-body.service";
import type { CreateAgentRunCommandArgs } from "./run-model-provider-environment.service";

const { prepareSelectedAgentRun$, completeAgentRun$ } =
  createSelectedAgentRunObjects();

/** Test-only direct entry, composed from the same execution graph as chat. */
export const createTestFixtureAgentRun$ = command(
  async ({ set }, args: CreateAgentRunCommandArgs, signal: AbortSignal) => {
    const prepared = await set(prepareSelectedAgentRun$, args, signal);
    if (!prepared) {
      throw new Error("Direct fixture preparation returned no input");
    }
    if (isRouteError(prepared)) {
      return prepared;
    }
    const result = await set(
      completeAgentRun$,
      {
        prepared,
        finalAppendSystemPrompt: prepared.args.body.appendSystemPrompt,
      },
      signal,
    );
    if (isQueueFirstRunClaimLost(result)) {
      throw new Error("Agent run without a queue association lost a claim");
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

const {
  prepareAgentRun$: prepareDirectAgentRun$,
  completeAgentRun$: completeDirectAgentRun$,
} = createAgentRunExecutionObjects();

/**
 * Test-only direct run fixture over the legacy prepared-run graph. Production
 * has no direct-run entrypoint; remaining fixtures are being migrated to the
 * real Thread and Pi maintenance entrypoints.
 */
export const createDirectFixtureAgentRun$ = command(
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
      prepareDirectAgentRun$,
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
      completeDirectAgentRun$,
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
