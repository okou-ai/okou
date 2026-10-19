export type RunnerAdmittableProfiles = string[];

export interface RunnerHomeCacheScopes {
  readonly snapshotGeneration: number;
  readonly snapshotSequence: number;
  readonly profiles: Record<string, string>;
}

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
  };
}

export type RunnerHeldSandboxStates = RunnerHeldSandboxState[];

interface RunnerHeldHomeCache {
  readonly profile: string;
  readonly homeAffinityVersion: 1;
}

export interface RunnerHeldHomeState {
  readonly reuseKey: string;
  readonly lastCompletedAt: string;
  readonly homeCaches: readonly [RunnerHeldHomeCache, ...RunnerHeldHomeCache[]];
}

export type RunnerHeldHomeStates = RunnerHeldHomeState[];
