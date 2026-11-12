import type { AdmittedRunLaunch } from "./direct-run-preparation.service";

export interface PendingRunActivation {
  readonly apiStartTime: number;
  readonly chatThreadId: string | undefined;
  readonly run: AdmittedRunLaunch;
  readonly timing: {
    readonly activationOrigin: "direct";
    readonly commitReturnedAt: number;
    readonly dispatchTimingsRegisteredAt: number;
  };
}
