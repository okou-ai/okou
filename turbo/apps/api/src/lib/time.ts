import { AsyncLocalStorage } from "node:async_hooks";

import { singleton, testOverride } from "./singleton";

interface ScopedMockNow {
  value: number | undefined;
}

const {
  get: getMockedNow,
  set: setMockedNow,
  clear: clearMockedNow,
} = testOverride<number | undefined>(() => {
  return undefined;
});
const scopedMockNow = singleton(() => {
  return new AsyncLocalStorage<ScopedMockNow>();
});
const {
  get: getMockedMonotonicNow,
  set: setMockedMonotonicNow,
  clear: clearMockedMonotonicNow,
} = testOverride<number | undefined>(() => {
  return undefined;
});

function timestamp(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

function currentScopedMockNow(): ScopedMockNow | undefined {
  return scopedMockNow.peek()?.getStore();
}

export function now(): number {
  const scoped = currentScopedMockNow();
  if (scoped) {
    return scoped.value ?? Date.now();
  }
  return getMockedNow() ?? Date.now();
}

export function nowDate(): Date {
  return new Date(now());
}

/** The non-wall clock used to measure real elapsed I/O time. */
export function monotonicNow(): number {
  return getMockedMonotonicNow() ?? performance.now();
}

export function timestampWithoutTimeZone(value: Date): string {
  // Raw SQL Date params compare as timestamptz; project timestamp columns store
  // UTC wall-clock values without timezone metadata.
  return value.toISOString().replace("T", " ").replace("Z", "");
}

export function mockNow(value: Date | number): void {
  const valueTimestamp = timestamp(value);
  const scoped = currentScopedMockNow();
  if (scoped) {
    scoped.value = valueTimestamp;
    return;
  }
  setMockedNow(valueTimestamp);
}

export function clearMockNow(): void {
  const scoped = currentScopedMockNow();
  if (scoped) {
    scoped.value = undefined;
    return;
  }
  clearMockedNow();
}

export function mockMonotonicNow(value: number): void {
  setMockedMonotonicNow(value);
}

export function clearMockMonotonicNow(): void {
  clearMockedMonotonicNow();
}

export async function withMockNowForTest<T>(
  value: Date | number,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedMockNow().run({ value: timestamp(value) }, work);
}

export async function withNowScopeForTest<T>(
  work: () => Promise<T>,
): Promise<T> {
  return await scopedMockNow().run({ value: undefined }, work);
}
