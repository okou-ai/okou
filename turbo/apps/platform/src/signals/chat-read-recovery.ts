import { isNetworkRequestError } from "../lib/network-error.ts";
import { waitLoopUntil } from "./utils.ts";

/** Retry only the read transport, before its caller applies events or effects. */
export async function readChatWithRecovery<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let attempts = 0;
  let result: { readonly value: T } | undefined;
  await waitLoopUntil(
    async (attemptSignal) => {
      attempts += 1;
      result = { value: await read(attemptSignal) };
      attemptSignal.throwIfAborted();
      return true;
    },
    0,
    signal,
    {
      shouldRetryError: (error) => {
        return attempts < 3 && isNetworkRequestError(error);
      },
      logTransientErrors: false,
    },
  );
  signal.throwIfAborted();
  if (result === undefined) {
    throw new Error("Chat read did not complete");
  }
  return result.value;
}
