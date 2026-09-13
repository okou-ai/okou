import { recordSandboxOperations } from "../external/sandbox-op-log";
import { publishRunnerJobNotification } from "../external/realtime";
import { now } from "../../lib/time";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import {
  runnerPreferenceTelemetryDimensions,
  runnerReuseKeyTelemetryKind,
  runnerReusePreferenceLookupError,
  resolveRunnerReusePreference,
} from "./runner-reuse-preference";
import { tapError } from "../utils";

const L = logger("RunnerDispatch");

export interface RunnerJobNotification {
  readonly runnerGroup: string;
  readonly runId: string;
  readonly profile: string;
  readonly reuseKey: string | null;
  readonly cliAgentSessionId: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly createdAt: Date;
}

export type RunnerJobPreActivationTiming =
  | {
      readonly activationOrigin: "direct";
      readonly commitReturnedAt: number;
      readonly runContextRegisteredAt: number;
      readonly dispatchTimingsRegisteredAt: number;
    }
  | {
      readonly activationOrigin: "promotion";
      readonly commitReturnedAt: number;
      readonly promotionSideEffectsRegisteredAt: number;
    };

interface RunnerJobNotificationTiming {
  readonly preActivation: RunnerJobPreActivationTiming;
  readonly activationScheduledAt: number;
  readonly activationEnteredAt: number;
  readonly sameThreadMarkersCompletedAt: number;
  readonly databaseReadyAt: number;
  readonly sameThreadMarkers: "recorded" | "not_applicable";
}

interface RunnerNotificationAttributionMilestone {
  readonly actionType: string;
  readonly completedAt: number;
}

interface RunnerNotificationAttributionEvent {
  readonly sandboxType: "runner";
  readonly actionType: string;
  readonly durationMs: number;
  readonly success: true;
  readonly runId: string;
  readonly dimensions: Record<string, string>;
}

function runnerNotificationAttributionEvents(
  notification: RunnerJobNotification,
  timing: RunnerJobNotificationTiming,
  dimensions: Record<string, string>,
): readonly RunnerNotificationAttributionEvent[] {
  const preActivationMilestones: readonly RunnerNotificationAttributionMilestone[] =
    timing.preActivation.activationOrigin === "direct"
      ? [
          {
            actionType: "runner_notification_queue_to_commit_return",
            completedAt: timing.preActivation.commitReturnedAt,
          },
          {
            actionType: "runner_notification_queue_to_run_context_registered",
            completedAt: timing.preActivation.runContextRegisteredAt,
          },
          {
            actionType:
              "runner_notification_queue_to_dispatch_timings_registered",
            completedAt: timing.preActivation.dispatchTimingsRegisteredAt,
          },
        ]
      : [
          {
            actionType: "runner_notification_queue_to_commit_return",
            completedAt: timing.preActivation.commitReturnedAt,
          },
          {
            actionType:
              "runner_notification_queue_to_promotion_side_effects_registered",
            completedAt: timing.preActivation.promotionSideEffectsRegisteredAt,
          },
        ];
  const milestones: readonly RunnerNotificationAttributionMilestone[] = [
    ...preActivationMilestones,
    {
      actionType: "runner_notification_queue_to_activation_scheduled",
      completedAt: timing.activationScheduledAt,
    },
    {
      actionType: "runner_notification_queue_to_activation_entry",
      completedAt: timing.activationEnteredAt,
    },
    {
      actionType: "runner_notification_queue_to_same_thread_markers_complete",
      completedAt: timing.sameThreadMarkersCompletedAt,
    },
    {
      actionType: "runner_notification_queue_to_database_ready",
      completedAt: timing.databaseReadyAt,
    },
  ];
  return milestones.map((milestone): RunnerNotificationAttributionEvent => {
    return {
      sandboxType: "runner",
      actionType: milestone.actionType,
      durationMs: Math.max(
        0,
        milestone.completedAt - notification.createdAt.getTime(),
      ),
      success: true,
      runId: notification.runId,
      dimensions: {
        ...dimensions,
        logical_queue_created_at: notification.createdAt.toISOString(),
        boundary_at: new Date(milestone.completedAt).toISOString(),
      },
    };
  });
}

export async function notifyRunnerJob(
  db: Pick<Db, "select">,
  args: RunnerJobNotification,
  timing: RunnerJobNotificationTiming,
): Promise<boolean> {
  const notificationEnteredAt = now();
  const currentDate = new Date(notificationEnteredAt);
  let preferenceLookupSucceeded = true;
  const runnerPreference =
    (await tapError(
      resolveRunnerReusePreference({
        db,
        runnerGroup: args.runnerGroup,
        profile: args.profile,
        reuseKey: args.reuseKey,
        historyGenerationRunId: args.historyGenerationRunId,
        createdAt: args.createdAt,
        currentDate,
      }),
      (error) => {
        preferenceLookupSucceeded = false;
        L.warn(
          "Failed to resolve runner reuse preference for job notification",
          {
            runId: args.runId,
            runnerGroup: args.runnerGroup,
            profile: args.profile,
            error,
          },
        );
      },
    )) ?? runnerReusePreferenceLookupError();
  const preferenceFinishedAt = now();
  const publishStartedAt = now();
  const published = await publishRunnerJobNotification({
    group: args.runnerGroup,
    runId: args.runId,
    profile: args.profile,
    runnerPreference,
    metadata: {
      reuseKey: args.reuseKey,
      cliAgentSessionId: args.cliAgentSessionId,
      historyGenerationRunId: args.historyGenerationRunId,
    },
  });
  const publishFinishedAt = now();

  const attributionDimensions: Record<string, string> = {
    runner_group: args.runnerGroup,
    profile: args.profile,
    notification_target: "broadcast",
    activation_origin: timing.preActivation.activationOrigin,
    same_thread_markers: timing.sameThreadMarkers,
  };
  const dimensions: Record<string, string> = {
    ...attributionDimensions,
    reuse_key_kind: runnerReuseKeyTelemetryKind(args.reuseKey),
    ...runnerPreferenceTelemetryDimensions(runnerPreference),
  };
  if (args.historyGenerationRunId) {
    dimensions.history_generation_run_id = args.historyGenerationRunId;
  }
  // Queue-relative actions are cumulative boundaries. Preference lookup and
  // publish durations are nested children and must not be added to them.
  recordSandboxOperations([
    ...runnerNotificationAttributionEvents(args, timing, attributionDimensions),
    {
      sandboxType: "runner",
      actionType: "runner_notification_queue_to_entry",
      durationMs: Math.max(0, notificationEnteredAt - args.createdAt.getTime()),
      success: true,
      runId: args.runId,
      dimensions,
    },
    {
      sandboxType: "runner",
      actionType: "runner_notification_affinity_lookup",
      durationMs: Math.max(0, preferenceFinishedAt - notificationEnteredAt),
      success: preferenceLookupSucceeded,
      runId: args.runId,
      dimensions,
    },
    {
      sandboxType: "runner",
      actionType: "runner_notification_queue_to_publish_start",
      durationMs: Math.max(0, publishStartedAt - args.createdAt.getTime()),
      success: true,
      runId: args.runId,
      dimensions,
    },
    {
      sandboxType: "runner",
      actionType: "runner_notification_realtime_publish",
      durationMs: Math.max(0, publishFinishedAt - publishStartedAt),
      success: published,
      runId: args.runId,
      dimensions,
    },
  ]);

  return published;
}
