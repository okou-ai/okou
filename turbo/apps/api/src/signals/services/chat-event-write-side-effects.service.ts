import { settleIncludingAbort } from "../utils";
import { logger } from "../../lib/log";

const L = logger("ChatEventWrite");

/** The event already committed; an auxiliary failure must not reject that send. */
export async function attemptChatEventSideEffect(
  operation: string,
  chatThreadId: string,
  work: () => Promise<unknown>,
): Promise<void> {
  const startedAt = performance.now();
  const result = await settleIncludingAbort(work());
  const timing = {
    operation,
    chatThreadId,
    durationMs: performance.now() - startedAt,
  };
  if (result.ok) {
    L.debug("Chat event auxiliary write completed", timing);
    if (timing.durationMs >= 250) {
      L.warn("Chat event auxiliary write exceeded 250 ms", timing);
    }
  } else {
    L.error("Chat event auxiliary write failed", {
      ...timing,
      error: result.error,
    });
  }
}
