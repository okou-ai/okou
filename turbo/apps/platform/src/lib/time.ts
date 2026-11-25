type NowValue = number | (() => number);

interface NowOverride {
  readonly value: NowValue;
  readonly signal: AbortSignal;
}

function createNowOverride() {
  let current: NowOverride | undefined;
  let writes: EventTarget | undefined;

  function get(): number | undefined {
    const value = current?.value;
    return typeof value === "function" ? value() : value;
  }

  function onNextWrite(notify: () => void, signal: AbortSignal): void {
    writes ??= new EventTarget();
    writes.addEventListener("change", notify, { once: true, signal });
  }

  function clear(event: Event): void {
    if (current?.signal === event.target) {
      current = undefined;
      writes?.dispatchEvent(new Event("change"));
    }
  }

  return {
    get,
    readTestClock: () => {
      return { now: get() ?? 0, onNextWrite };
    },
    set: (value: NowValue, signal: AbortSignal) => {
      signal.throwIfAborted();
      current?.signal.removeEventListener("abort", clear);
      current = { value, signal };
      signal.addEventListener("abort", clear, { once: true });
      writes?.dispatchEvent(new Event("change"));
    },
  };
}

const { get: getMockedNow, set: setMockedNow } = createNowOverride();
const monotonicOverride = createNowOverride();

export function now(): number {
  return getMockedNow() ?? Date.now();
}

export function nowDate(): Date {
  return new Date(now());
}

export function mockNow(value: Date | NowValue, signal: AbortSignal): void {
  setMockedNow(value instanceof Date ? value.getTime() : value, signal);
}

/** Elapsed-time deadlines must not move when the system clock is corrected. */
export function monotonicNow(): number {
  return monotonicOverride.get() ?? performance.now();
}

export function mockMonotonicNow(value: NowValue, signal: AbortSignal): void {
  monotonicOverride.set(value, signal);
}

/** Background refreshes wake when a test publishes a new elapsed time. */
export function readTestMonotonicClock() {
  return monotonicOverride.readTestClock();
}
