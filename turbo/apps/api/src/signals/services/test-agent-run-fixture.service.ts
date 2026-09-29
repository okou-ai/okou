import { command } from "ccstate";
import { now } from "../../lib/time";
import { activatePendingRun$ } from "./agent-run-activation.service";
import {
  createSelectedAgentRunObjects,
  isRouteError,
  isQueueFirstRunClaimLost,
  type CreateAgentRunCommandArgs,
} from "./agent-run-execution.service";

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
      await set(
        activatePendingRun$,
        {
          activation: result.pendingActivation,
          activationScheduledAt: now(),
        },
        signal,
      );
    }
    return result;
  },
);
