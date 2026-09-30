import { command } from "ccstate";
import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { PendingRunActivation } from "./agent-run-activation.types";
import { recordFirstAssistantEventEligibility } from "./chat-first-assistant-event-metric.service";
import { notifyRunnerJob } from "./runner-dispatch.service";
import { recordSameThreadRunnerJobPersisted } from "./runner-job-queue-lifecycle.service";

interface PendingRunActivationRequest {
  readonly activation: PendingRunActivation;
  readonly activationScheduledAt: number;
}

/** Common post-commit activation for direct and promoted pending runs. */
export const activatePendingRun$ = command(
  async (
    { set },
    input: PendingRunActivationRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const activationEnteredAt = now();
    const activation = input.activation;
    // Activation follows a durable run/job commit and therefore must finish
    // under the caller's background-work lifetime.
    if (activation.chatThreadId !== undefined) {
      recordSameThreadRunnerJobPersisted({
        runId: activation.runnerNotification.runId,
        createdAt: activation.runnerNotification.createdAt,
      });
      recordFirstAssistantEventEligibility({
        runId: activation.runnerNotification.runId,
        apiStartedAt: activation.apiStartTime,
      });
    }
    const sameThreadMarkersCompletedAt = now();

    const db = set(writeDb$);
    const databaseReadyAt = now();
    await notifyRunnerJob(db, activation.runnerNotification, {
      preActivation: activation.timing,
      activationScheduledAt: input.activationScheduledAt,
      activationEnteredAt,
      sameThreadMarkersCompletedAt,
      databaseReadyAt,
      sameThreadMarkers:
        activation.chatThreadId === undefined ? "not_applicable" : "recorded",
    });
    signal.throwIfAborted();
  },
);
