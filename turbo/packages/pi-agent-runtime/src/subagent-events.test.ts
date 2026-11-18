import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { serializePiSubagentEvent } from "./subagent-events";

function streamingOutput(chunks: number): string {
  const delta = "streamed response\n".repeat(256);
  let text = "";
  let output = "";
  for (let index = 0; index < chunks; index++) {
    text += delta;
    const message = fauxAssistantMessage(text);
    output += serializePiSubagentEvent({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta,
        partial: message,
      },
    });
  }
  const message = fauxAssistantMessage(text);
  output += serializePiSubagentEvent({ type: "message_end", message });
  output += serializePiSubagentEvent({
    type: "turn_end",
    message,
    toolResults: [],
  });
  output += serializePiSubagentEvent({
    type: "agent_end",
    messages: [message],
    willRetry: false,
  });
  return output;
}

describe("subagent JSONL output", () => {
  it("grows linearly for a large streamed response and emits one authoritative final snapshot", () => {
    const smaller = streamingOutput(128);
    const larger = streamingOutput(256);
    expect(Buffer.byteLength(larger)).toBeGreaterThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(larger)).toBeLessThan(
      Buffer.byteLength(smaller) * 2.05,
    );

    const lines = larger.trimEnd().split("\n");
    expect(lines).toHaveLength(259);
    const events: unknown[] = lines.map((line) => {
      return JSON.parse(line);
    });
    for (const event of events.slice(0, 256)) {
      expect(event).toEqual({
        type: "message_update",
        usage: fauxAssistantMessage("").usage,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "streamed response\n".repeat(256),
        },
      });
    }
    expect(events.slice(256)).toEqual([
      {
        type: "message_end",
        message: expect.objectContaining({
          role: "assistant",
          content: [
            { type: "text", text: "streamed response\n".repeat(256 * 256) },
          ],
        }),
      },
      { type: "turn_end" },
      { type: "agent_end", willRetry: false },
    ]);
  });

  it("preserves final error diagnostics and tool result content without UI metadata", () => {
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "read-file",
      toolName: "read",
      content: [
        { type: "text" as const, text: "File could not be read.\nRetry?" },
      ],
      details: { nativeUi: "large metadata".repeat(1000) },
      isError: true,
      timestamp: 1,
    };
    const events: AgentSessionEvent[] = [
      {
        type: "tool_execution_end",
        toolCallId: "read-file",
        toolName: "read",
        result: toolResult,
        isError: true,
      },
      { type: "message_end", message: toolResult },
      {
        type: "message_end",
        message: {
          ...fauxAssistantMessage(""),
          stopReason: "error",
          errorMessage: "Provider failed: request diagnostic",
        },
      },
    ];
    const output = events.map(serializePiSubagentEvent).join("");
    const { details: _details, ...result } = toolResult;
    expect(
      output
        .trimEnd()
        .split("\n")
        .map((line) => {
          return JSON.parse(line);
        }),
    ).toEqual([
      {
        type: "tool_execution_end",
        toolCallId: "read-file",
        toolName: "read",
        result,
        isError: true,
      },
      { type: "message_end", message: result },
      {
        type: "message_end",
        message: expect.objectContaining({
          stopReason: "error",
          errorMessage: "Provider failed: request diagnostic",
        }),
      },
    ]);
  });
});
