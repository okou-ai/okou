import { env } from "../../lib/env";
import { monotonicNow } from "../../lib/time";
import { recordSandboxOperation } from "../external/sandbox-op-log";

/** Content-free milestones join ingress to provider acknowledgement by input event. */
export function recordWechatDeliveryPhase(args: {
  readonly phase:
    "message_received" | "reply_prepare" | "send_start" | "provider_send";
  readonly inputEventId: string;
  readonly chatThreadId?: string;
  readonly operationId?: string;
  readonly chunkIndex?: number;
  readonly runId?: string;
  readonly timestamp?: string;
  readonly durationMs: number;
  readonly success: boolean;
}): void {
  recordSandboxOperation({
    sandboxType: "chat",
    actionType: `wechat_${args.phase}`,
    runId: args.runId,
    timestamp: args.timestamp,
    durationMs: args.durationMs,
    success: args.success,
    dimensions: {
      trigger_source: "wechat",
      api_commit_sha: env("GIT_COMMIT_SHA"),
      input_event_id: args.inputEventId,
      chat_thread_id: args.chatThreadId,
      operation_id: args.operationId,
      chunk_index: args.chunkIndex,
    },
  });
}

/** Emit only after the accepted input commits; replays have no new receive event. */
export function recordWechatMessageReceived(
  inputEventId: string,
  chatThreadId: string,
  timestamp: string,
  startedAt: number,
): void {
  recordWechatDeliveryPhase({
    phase: "message_received",
    inputEventId,
    chatThreadId,
    timestamp,
    durationMs: monotonicNow() - startedAt,
    success: true,
  });
}
