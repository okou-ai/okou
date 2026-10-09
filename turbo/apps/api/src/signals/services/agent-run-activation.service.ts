import { command, type Command } from "ccstate";
import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  notifyRunnerJob$,
  type RunnerJobNotification,
  type RunnerJobPreActivationTiming,
} from "./runner-dispatch.service";

export type PendingRunnerJobNotification = RunnerJobNotification;
export type ActivationTiming =
  DirectActivationTiming | PromotionActivationTiming;
export type DirectActivationTiming = Extract<
  RunnerJobPreActivationTiming,
  { activationOrigin: "direct" }
>;
export type PromotionActivationTiming = Extract<
  RunnerJobPreActivationTiming,
  { activationOrigin: "promotion" }
>;

export interface PendingRunActivationRequest {
  readonly notification: PendingRunnerJobNotification;
  readonly timing: ActivationTiming;
  readonly activationScheduledAt: number;
}

/** Publish an already-durable job; false is not a failed creation transaction. */
export const activatePendingRun$: Command<
  Promise<boolean>,
  [input: PendingRunActivationRequest, signal: AbortSignal]
> = command(
  async (
    { set },
    input: PendingRunActivationRequest,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const activationEnteredAt = now();
    // Preserve the connection-ready milestone before notification entry.
    set(writeDb$);
    const databaseReadyAt = now();
    const published = await set(notifyRunnerJob$, input.notification, {
      preActivation: input.timing,
      activationScheduledAt: input.activationScheduledAt,
      activationEnteredAt,
      databaseReadyAt,
    });
    signal.throwIfAborted();
    return published;
  },
);
