import type { settleIncludingAbort } from "../utils";
import { logger } from "../../lib/log";

const L = logger("ChatEventWrite");

/** Report a settled owned operation; takes facts, never execution callbacks. */
export function reportChatEventSideEffect(
  operation: string,
  chatThreadId: string,
  startedAt: number,
  result: Awaited<ReturnType<typeof settleIncludingAbort>>,
): void {
  const timing = {
    operation,
    chatThreadId,
    durationMs: performance.now() - startedAt,
  };
  if (result.ok) {
    L.debug("Chat event auxiliary write completed", timing);
  } else {
    L.error("Chat event auxiliary write failed", {
      ...timing,
      error: result.error,
    });
  }
}
