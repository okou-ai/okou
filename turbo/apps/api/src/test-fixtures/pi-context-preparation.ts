import { onTestFinished } from "vitest";

import {
  clearRunContextParallelHookForTest,
  setRunContextParallelHookForTest,
  type RunContextParallelStage,
} from "../signals/services/agent-run-create.service";
import {
  clearAgentRunPreCreateParallelHookForTest,
  setAgentRunPreCreateParallelHookForTest,
  type AgentRunPreCreateParallelStage,
} from "../signals/services/agent-runs-create.service";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";

type PiContextPreparationStage =
  | AgentRunPreCreateParallelStage
  | RunContextParallelStage;

const STAGES: readonly PiContextPreparationStage[] = [
  "subscription-account",
  "post-authorization-context",
  "thread-session",
  "connector-contexts",
  "model-provider",
  "user-timezone",
  "media-models",
  "official-workflow",
];

function createPreparationGate(signal: AbortSignal) {
  let waiting = false;
  let arrivalCount = 0;
  let failure: { readonly reason: unknown } | undefined;
  return {
    arrived: createDeferredPromise<void>(signal),
    released: createDeferredPromise<void>(signal),
    departed: createDeferredPromise<void>(signal),
    isWaiting: () => {
      return waiting;
    },
    setWaiting: (value: boolean) => {
      waiting = value;
    },
    arrivalCount: () => {
      return arrivalCount;
    },
    recordArrival: () => {
      arrivalCount += 1;
    },
    getFailure: () => {
      return failure;
    },
    setFailure: (reason: unknown) => {
      failure = { reason };
    },
  };
}

/**
 * Hold real Agent-run preparation branches after their captured inputs are
 * available. Public APIs cannot pause these internal dependency boundaries, so
 * route tests use this fixture only to prove branch ownership and settlement.
 */
export function holdPiContextPreparationStagesFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly signal: AbortSignal;
  /** Keep dependency holds alive after request cancellation when supplied. */
  readonly gateSignal?: AbortSignal;
}) {
  const gateSignal = args.gateSignal ?? args.signal;
  const gates = new Map(
    STAGES.map((stage) => {
      return [stage, createPreparationGate(gateSignal)] as const;
    }),
  );
  const waitAtStage = async (input: {
    readonly stage: PiContextPreparationStage;
    readonly userId: string;
    readonly orgId: string;
  }) => {
    if (input.userId !== args.userId || input.orgId !== args.orgId) {
      return;
    }
    const gate = gates.get(input.stage);
    if (!gate) {
      throw new Error(`Unexpected Pi preparation stage: ${input.stage}`);
    }
    gate.recordArrival();
    if (!gate.arrived.settled()) {
      gate.arrived.resolve(undefined);
    }
    gate.setWaiting(true);
    const released = await settleIncludingAbort(gate.released.promise);
    gate.setWaiting(false);
    if (!gate.departed.settled()) {
      gate.departed.resolve(undefined);
    }
    if (!released.ok) {
      throw released.error;
    }
    const failure = gate.getFailure();
    if (failure) {
      throw failure.reason;
    }
  };
  setAgentRunPreCreateParallelHookForTest(waitAtStage);
  setRunContextParallelHookForTest(waitAtStage);

  const release = (stage: PiContextPreparationStage): void => {
    const gate = gates.get(stage);
    if (!gate) {
      throw new Error(`Unexpected Pi preparation stage: ${stage}`);
    }
    if (!gate.released.settled()) {
      gate.released.resolve(undefined);
    }
  };
  const reject = (stage: PiContextPreparationStage, reason: unknown): void => {
    const gate = gates.get(stage);
    if (!gate) {
      throw new Error(`Unexpected Pi preparation stage: ${stage}`);
    }
    if (!gate.released.settled()) {
      gate.setFailure(reason);
      gate.released.resolve(undefined);
    }
  };
  const releaseAll = (): void => {
    clearAgentRunPreCreateParallelHookForTest();
    clearRunContextParallelHookForTest();
    for (const stage of STAGES) {
      const gate = gates.get(stage);
      if (!gate) {
        throw new Error(`Unexpected Pi preparation stage: ${stage}`);
      }
      const neverArrived = !gate.arrived.settled();
      if (neverArrived) {
        gate.arrived.resolve(undefined);
      }
      release(stage);
      if (neverArrived && !gate.isWaiting() && !gate.departed.settled()) {
        gate.departed.resolve(undefined);
      }
    }
  };
  onTestFinished(releaseAll);

  return {
    arrival(stage: PiContextPreparationStage): Promise<void> {
      const gate = gates.get(stage);
      if (!gate) {
        throw new Error(`Unexpected Pi preparation stage: ${stage}`);
      }
      return gate.arrived.promise;
    },
    hasArrived(stage: PiContextPreparationStage): boolean {
      const gate = gates.get(stage);
      if (!gate) {
        throw new Error(`Unexpected Pi preparation stage: ${stage}`);
      }
      return gate.arrived.settled();
    },
    arrivalCount(stage: PiContextPreparationStage): number {
      const gate = gates.get(stage);
      if (!gate) {
        throw new Error(`Unexpected Pi preparation stage: ${stage}`);
      }
      return gate.arrivalCount();
    },
    departure(stage: PiContextPreparationStage): Promise<void> {
      const gate = gates.get(stage);
      if (!gate) {
        throw new Error(`Unexpected Pi preparation stage: ${stage}`);
      }
      return gate.departed.promise;
    },
    release,
    reject,
    releaseAll,
  };
}
