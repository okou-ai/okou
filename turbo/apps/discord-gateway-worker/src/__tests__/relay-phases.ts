export function createRelayPhases(signal: AbortSignal) {
  const startedAt = performance.now();
  const elapsedMs = () => {
    return Math.round(performance.now() - startedAt);
  };
  const phases: Array<{
    name: string;
    startedAtMs: number;
    completedAtMs: number | null;
  }> = [];
  const wait = async <T>(name: string, task: () => Promise<T>) => {
    signal.throwIfAborted();
    const phase: (typeof phases)[number] = {
      name,
      startedAtMs: elapsedMs(),
      completedAtMs: null,
    };
    phases.push(phase);
    const result = await task();
    // Teardown precedes failure hooks; late I/O must not rewrite the timed-out phase.
    signal.throwIfAborted();
    phase.completedAtMs = elapsedMs();
    return result;
  };
  return { elapsedMs, phases, wait };
}
