import { act } from "@testing-library/react";
import { mockMonotonicNow } from "../lib/time.ts";

export function browserRecoveryClock(signal: AbortSignal) {
  let elapsed = 0;
  mockMonotonicNow(() => {
    return elapsed;
  }, signal);
  return (milliseconds: number) => {
    act(() => {
      elapsed += milliseconds;
    });
  };
}
