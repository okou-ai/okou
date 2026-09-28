import type {
  RunnerJobNotification,
  RunnerJobPreActivationTiming,
} from "./runner-dispatch.service";

export interface PendingRunActivation {
  readonly apiStartTime: number;
  readonly chatThreadId: string | undefined;
  readonly runnerNotification: RunnerJobNotification;
  readonly timing: RunnerJobPreActivationTiming;
}
