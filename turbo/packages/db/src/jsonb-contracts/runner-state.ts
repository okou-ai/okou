export type RunnerAdmittableProfiles = string[];

export interface RunnerActiveReuseProducer {
  readonly runId: string;
  readonly reuseKey: string;
  readonly profile: string;
}

export type RunnerActiveReuseProducers = RunnerActiveReuseProducer[];

export interface RunnerHeldSandboxState {
  readonly reuseKey: string;
  readonly lastCompletedAt: string;
  readonly reusableSandbox: {
    readonly profile: string;
    readonly historyGenerationRunId?: string;
    // Older live Runner observations omit provenance until the #41876 drain gate.
    readonly sourceRunId?: string;
  };
}

export type RunnerHeldSandboxStates = RunnerHeldSandboxState[];

interface RunnerHeldHomeCache {
  readonly profile: string;
  readonly homeAffinityVersion: 1;
  // Each profile records its own producer; #41876 retires the missing-source shape.
  readonly sourceRunId?: string;
}

export interface RunnerHeldHomeState {
  readonly reuseKey: string;
  readonly lastCompletedAt: string;
  readonly homeCaches: readonly [RunnerHeldHomeCache, ...RunnerHeldHomeCache[]];
}

export type RunnerHeldHomeStates = RunnerHeldHomeState[];
