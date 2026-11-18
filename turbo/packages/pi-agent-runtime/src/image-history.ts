import type {
  Message,
  ToolResultMessage,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

// Bound encoded bytes conservatively below the observed 30 MB image limit.
// The lower target retires a batch instead of changing the prefix every turn.
const IMAGE_HISTORY_TRIGGER = 25 * 1024 * 1024;
const IMAGE_HISTORY_TARGET = 15 * 1024 * 1024;
const OMITTED_IMAGE = {
  type: "text" as const,
  text: "[Tool image omitted to limit accumulated image data. Reopen the original file or rerun the tool if needed.]",
};

function imageBytes(message: Message): number {
  if (
    (message.role !== "user" && message.role !== "toolResult") ||
    typeof message.content === "string"
  ) {
    return 0;
  }
  return message.content.reduce((bytes, block) => {
    return bytes + (block.type === "image" ? block.data.length : 0);
  }, 0);
}

function omitImages(message: ToolResultMessage): ToolResultMessage {
  if (
    !message.content.some((block) => {
      return block.type === "image";
    })
  ) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((block) => {
      return block.type === "image" ? OMITTED_IMAGE : block;
    }),
  };
}

/** Request projections and native retention share one session's retirements. */
export class PiImageHistory {
  private readonly retiredToolCalls = new Set<string>();

  private retire(messages: readonly Message[]): boolean {
    let bytes = 0;
    let changed = false;
    const candidates: Array<{ toolCallId: string; bytes: number }> = [];
    for (const message of messages) {
      const size = imageBytes(message);
      if (size === 0) continue;
      if (message.role === "toolResult") {
        if (this.retiredToolCalls.has(message.toolCallId)) {
          changed = true;
          continue;
        }
        candidates.push({ toolCallId: message.toolCallId, bytes: size });
      }
      // User uploads count toward the budget but are never retired here.
      bytes += size;
    }
    if (bytes > IMAGE_HISTORY_TRIGGER) {
      for (const candidate of candidates) {
        this.retiredToolCalls.add(candidate.toolCallId);
        bytes -= candidate.bytes;
        changed = true;
        if (bytes <= IMAGE_HISTORY_TARGET) break;
      }
    }
    return changed;
  }

  boundContext(context: TranscriptContext): TranscriptContext {
    if (!this.retire(context.messages)) return context;
    return {
      ...context,
      messages: context.messages.map((message) => {
        return message.role === "toolResult" &&
          this.retiredToolCalls.has(message.toolCallId)
          ? omitImages(message)
          : message;
      }),
    };
  }

  /** Append only effective content changes on the active, compacted branch. */
  retain(sessionManager: SessionManager): void {
    const projection = sessionManager.buildSessionProjection();
    this.retire(
      projection.messages.filter((message) => {
        return message.role === "user" || message.role === "toolResult";
      }),
    );
    for (const { sourceEntry, messages } of projection.entries) {
      if (sourceEntry.type !== "message") continue;
      for (const message of messages) {
        if (
          message.role !== "toolResult" ||
          !this.retiredToolCalls.has(message.toolCallId)
        ) {
          continue;
        }
        const replacement = omitImages(message);
        if (replacement !== message) {
          sessionManager.appendContextEdit(sourceEntry.id, {
            content: replacement.content,
          });
        }
      }
    }
  }
}
