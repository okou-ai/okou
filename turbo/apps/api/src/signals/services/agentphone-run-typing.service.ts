import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { now } from "../../lib/time";
import {
  isAgentPhoneApiError,
  sendAgentPhoneTypingIndicator,
} from "../external/agentphone-client";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { onRejection } from "../utils";

const L = logger("AgentPhoneRunTyping");

export const AGENTPHONE_TYPING_REQUEST_TIMEOUT_MS = 2000;
const TYPING_REPEAT_HOLD_MS = 1000;
const MAX_TYPING_ENTRIES = 1000;

interface TypingContext {
  readonly conversationId: string;
  readonly phase: "admission" | "refresh";
  readonly messageId?: string;
  readonly apiStartTime?: number;
  readonly runId?: string;
}

// Process-local only: independent API instances may each send once. Never
// evict in-flight ownership; each request is bounded by its own timeout.
const typingInFlight = singleton(() => {
  return new Set<string>();
});
const recentTyping = singleton(() => {
  return new Map<string, number>();
});

function recordTypingOutcome(
  context: TypingContext,
  outcome: "sent" | "skipped" | "failed",
  fields: {
    readonly durationMs?: number;
    readonly reason?: string;
    readonly status?: number;
  },
): void {
  recordSandboxOperation({
    sandboxType: "chat",
    actionType: "agentphone_typing",
    runId: context.runId,
    durationMs: fields.durationMs ?? 0,
    success: outcome !== "failed",
    dimensions: {
      phase: context.phase,
      outcome,
      conversation_id: context.conversationId,
      message_id: context.messageId,
      webhook_age_ms:
        context.apiStartTime === undefined
          ? undefined
          : now() - context.apiStartTime,
      reason: fields.reason,
      status: fields.status,
    },
  });
}

/** Cosmetic progress must not block admission or suppress recovery on failure. */
export async function sendAgentPhoneRunTyping(
  context: TypingContext,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const inFlight = typingInFlight();
  const recent = recentTyping();
  const reason = inFlight.has(context.conversationId)
    ? "in_flight"
    : (recent.get(context.conversationId) ?? 0) > now()
      ? "recent_success"
      : inFlight.size >= MAX_TYPING_ENTRIES
        ? "in_flight_capacity"
        : undefined;
  if (reason) {
    recordTypingOutcome(context, "skipped", { reason });
    return;
  }

  inFlight.add(context.conversationId);
  const startedAt = now();
  await onRejection(
    sendAgentPhoneTypingIndicator(
      { conversationId: context.conversationId },
      AbortSignal.any([
        signal,
        AbortSignal.timeout(AGENTPHONE_TYPING_REQUEST_TIMEOUT_MS),
      ]),
    ),
    (error) => {
      inFlight.delete(context.conversationId);
      const status = isAgentPhoneApiError(error) ? error.status : undefined;
      recordTypingOutcome(context, "failed", {
        durationMs: now() - startedAt,
        status,
        reason:
          error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : "provider_failed",
      });
      L.warn("AgentPhone typing indicator was not sent", {
        conversationId: context.conversationId,
        phase: context.phase,
        runId: context.runId,
        status,
        error_name: error instanceof Error ? error.name : undefined,
        duration_ms: now() - startedAt,
      });
    },
  );
  inFlight.delete(context.conversationId);

  // Install the short repeat hold only after the provider accepts the request.
  recent.delete(context.conversationId);
  if (recent.size >= MAX_TYPING_ENTRIES) {
    for (const [conversationId, until] of recent) {
      if (until <= now()) {
        recent.delete(conversationId);
      }
    }
    const oldest = recent.keys().next();
    if (recent.size >= MAX_TYPING_ENTRIES && !oldest.done) {
      recent.delete(oldest.value);
    }
  }
  recent.set(context.conversationId, now() + TYPING_REPEAT_HOLD_MS);
  recordTypingOutcome(context, "sent", { durationMs: now() - startedAt });
}
