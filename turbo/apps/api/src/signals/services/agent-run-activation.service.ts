import { command } from "ccstate";

import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { notifyRunnerJob } from "./runner-dispatch.service";
import { recordSameThreadRunnerJobPersisted } from "./runner-job-queue-lifecycle.service";
import { recordFirstAssistantEventEligibility } from "./chat-first-assistant-event-metric.service";
import { waitUntil } from "../context/wait-until";
import type { PendingRunActivation } from "./agent-run-activation.types";
import { dispatchConfiguredPiApiFirstTurn$ } from "./pi-api-first-turn-dispatch.service";

import type { PiApiFirstTurnPreparation } from "./pi-api-first-turn-preparation";

interface PendingRunActivationRequest {
  readonly activation: PendingRunActivation;
  readonly activationScheduledAt: number;
  readonly preparation?: PiApiFirstTurnPreparation;
}

const startPiApiFirstTurn$ = command(function startPiApiFirstTurn(
  { set },
  activation: NonNullable<PendingRunActivation["piApiFirstTurn"]>,
  preparation: PiApiFirstTurnPreparation | undefined,
): void {
  const coordinationDeadlineAt =
    activation.executionContext.piLaunchConfig.apiFirstTurn.deadlineAt;
  // waitUntil owns only the bounded API-to-Sandbox coordination window.
  // A successful Sandbox transfer continues under the runner lifecycle.
  waitUntil(
    set(
      dispatchConfiguredPiApiFirstTurn$,
      activation,
      preparation,
      AbortSignal.timeout(Math.max(1, coordinationDeadlineAt - now())),
    ),
  );
});

/** Common post-commit activation for direct and promoted pending runs. */
export const activatePendingRun$ = command(
  async ({ set }, input: PendingRunActivationRequest): Promise<void> => {
    const activationEnteredAt = now();
    const activation = input.activation;
    // Activation follows a durable run/job commit and therefore must finish
    // independently from the request that initiated that commit.
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

    const apiFirstTurn = activation.piApiFirstTurn;
    if (apiFirstTurn) {
      set(startPiApiFirstTurn$, apiFirstTurn, input.preparation);
    }

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
  },
);
