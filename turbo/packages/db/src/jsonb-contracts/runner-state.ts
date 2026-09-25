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
  };
}

export type RunnerHeldSandboxStates = RunnerHeldSandboxState[];

interface RunnerHeldWorkspaceCache {
  readonly profile: string;
  readonly workspaceAffinityVersion: 1;
}

export interface RunnerHeldWorkspaceState {
  readonly reuseKey: string;
  readonly lastCompletedAt: string;
  readonly workspaceCaches: readonly [
    RunnerHeldWorkspaceCache,
    ...RunnerHeldWorkspaceCache[],
  ];
}

export type RunnerHeldWorkspaceStates = RunnerHeldWorkspaceState[];
