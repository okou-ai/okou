import type { TestContext } from "../../../../__tests__/test-context";

/** Expire a sequential provider operation when its withheld request arrives. */
export function controlBrowserDeadline(context: TestContext): () => void {
  let current: AbortController | undefined;
  context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
    if (milliseconds !== 15_000) {
      return undefined;
    }
    current = new AbortController();
    return current.signal;
  });
  return () => {
    if (!current) {
      throw new Error("Expected a pending Browser operation deadline");
    }
    const deadline = current;
    current = undefined;
    // Cleanup and follow-up requests must receive fresh native deadlines.
    context.mocks.abortSignal.timeout.mockReset();
    deadline.abort(new DOMException("Browser deadline", "TimeoutError"));
  };
}
