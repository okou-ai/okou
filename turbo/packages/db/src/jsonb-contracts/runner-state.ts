export type RunnerAdmittableProfiles = string[];

/** Official ordered endpoint observation; never a public reachability proof. */
export interface RunnerIngressObservation {
  readonly processNonce: string;
  readonly caddyServiceActive: boolean;
  readonly listenerReady: boolean;
  readonly protocolVersion: 1;
  readonly dispatchProtocolVersion: number;
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
    readonly sourceRunId: string;
  };
}

export type RunnerHeldSandboxStates = RunnerHeldSandboxState[];

interface RunnerHeldHomeCache {
  readonly profile: string;
  readonly homeAffinityVersion: 1;
  readonly sourceRunId: string;
}

export interface RunnerHeldHomeState {
  readonly reuseKey: string;
  readonly lastCompletedAt: string;
  readonly homeCaches: readonly [RunnerHeldHomeCache, ...RunnerHeldHomeCache[]];
}

export type RunnerHeldHomeStates = RunnerHeldHomeState[];
