import type { PiApiFirstTurnResult } from "@okouai/pi-agent-runtime/api";

import type { AgentEvent } from "./event-consumer/verify";

function projectedAssistantBlocks(
  assistant: PiApiFirstTurnResult["assistantMessage"],
): unknown[] {
  return assistant.content.flatMap((block): unknown[] => {
    if (block.type === "text") {
      const text = block.text.trim();
      return text ? [{ type: "text", text }] : [];
    }
    if (block.type === "toolCall") {
      return [
        {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.arguments,
        },
      ];
    }
    return [];
  });
}

function assistantText(
  assistant: PiApiFirstTurnResult["assistantMessage"],
): string {
  return assistant.content
    .flatMap((block) => {
      return block.type === "text" && block.text.trim()
        ? [block.text.trim()]
        : [];
    })
    .join("\n\n");
}

export function piApiFirstTurnAssistantEvents(
  runId: string,
  assistant: PiApiFirstTurnResult["assistantMessage"],
): AgentEvent[] {
  const blocks = projectedAssistantBlocks(assistant);
  const eventBlocks =
    blocks.length === 0 && assistant.memoryCitation ? [null] : blocks;
  return eventBlocks.map((block, sequenceNumber) => {
    return {
      type: "assistant",
      sequenceNumber,
      message: {
        id:
          assistant.responseId ??
          `${runId}:${assistant.timestamp}:${assistant.model}`,
        role: "assistant",
        content: block === null ? [] : [block],
        ...(sequenceNumber === eventBlocks.length - 1 &&
        assistant.memoryCitation
          ? { memoryCitation: assistant.memoryCitation }
          : {}),
        model: assistant.model,
        usage: {
          input_tokens: assistant.usage.input,
          output_tokens: assistant.usage.output,
          cache_read_input_tokens: assistant.usage.cacheRead,
          cache_creation_input_tokens: assistant.usage.cacheWrite,
        },
      },
    };
  });
}

export function piApiFirstTurnResultEvent(
  assistant: PiApiFirstTurnResult["assistantMessage"],
  startedAt: number,
  sequenceNumber: number,
  observedAt: number,
): AgentEvent {
  return {
    type: "result",
    sequenceNumber,
    subtype: "success",
    is_error: false,
    result: assistantText(assistant),
    duration_ms: Math.max(0, observedAt - startedAt),
  };
}
