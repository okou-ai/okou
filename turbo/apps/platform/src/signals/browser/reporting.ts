import { detach, type Reason } from "../utils.ts";

const recoveryOwner = Symbol("browser-recovery-owner");

/** Browser resource recovery owns this failure, including its rejected effects. */
export function claimBrowserFailure(error: Error): void {
  Object.defineProperty(error, recoveryOwner, { value: true });
}

export function ownsBrowserFailure(error: unknown): boolean {
  const visited = new Set<Error>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (recoveryOwner in current && current[recoveryOwner] === true) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

async function handleBrowserFailure(promise: Promise<unknown>): Promise<void> {
  const [result] = await Promise.allSettled([promise]);
  if (result.status === "rejected" && !ownsBrowserFailure(result.reason)) {
    throw result.reason;
  }
}

/** Handle owned resource failures only at Browser's detached business entries. */
export function detachBrowser(
  promise: unknown,
  reason: Reason,
  description?: string,
): void {
  detach(
    promise instanceof Promise ? handleBrowserFailure(promise) : promise,
    reason,
    description,
  );
}
