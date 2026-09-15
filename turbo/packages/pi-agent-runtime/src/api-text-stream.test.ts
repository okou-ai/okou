import { expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  PI_MEMORY_CITATION_OPEN,
  PI_MEMORY_CITATION_CLOSE,
} from "@okouai/api-contracts/contracts/pi-memory-citations";
import { createPiApiTextStream } from "./api-text-stream";
import { projectPiApiAssistantMessage } from "./api-turn";

it("does not read a later delta from a Bedrock block's mutable start event", () => {
  const chunks: { runEventId: string; chunkIndex: number; delta: string }[] =
    [];
  const onEvent = createPiApiTextStream({
    eventIdPrefix: "api-first:attempt",
    onDelta(chunk) {
      chunks.push(chunk);
    },
  });
  // Bedrock emits start and delta synchronously using the same partial object.
  const partial = {
    ...fauxAssistantMessage("Hello"),
    api: "bedrock-converse-stream" as const,
  };
  onEvent({ type: "text_start", contentIndex: 0, partial });
  expect(chunks).toEqual([]);
  onEvent({ type: "text_delta", contentIndex: 0, delta: "Hello", partial });
  expect(chunks).toEqual([
    { runEventId: "api-first:attempt:0", chunkIndex: 0, delta: "Hello" },
  ]);
});

it("preserves initial text carried by an Anthropic Messages block start", () => {
  const chunks: { runEventId: string; chunkIndex: number; delta: string }[] =
    [];
  const onEvent = createPiApiTextStream({
    eventIdPrefix: "api-first:attempt",
    onDelta(chunk) {
      chunks.push(chunk);
    },
  });
  const partial = {
    ...fauxAssistantMessage("Hello"),
    api: "anthropic-messages" as const,
  };
  onEvent({ type: "text_start", contentIndex: 0, partial });
  onEvent({ type: "text_delta", contentIndex: 0, delta: " world", partial });
  expect(chunks).toEqual([
    { runEventId: "api-first:attempt:0", chunkIndex: 0, delta: "Hello" },
    { runEventId: "api-first:attempt:0", chunkIndex: 1, delta: " world" },
  ]);
});

it("filters fragmented private markup across text blocks without shifting their identities", () => {
  const chunks: { runEventId: string; chunkIndex: number; delta: string }[] =
    [];
  const onEvent = createPiApiTextStream({
    eventIdPrefix: "api-first:attempt",
    onDelta(chunk) {
      chunks.push(chunk);
    },
  });
  const partial = fauxAssistantMessage([
    { type: "thinking", thinking: "Private thinking" },
    { type: "text", text: "" },
    { type: "toolCall", id: "call", name: "read", arguments: {} },
    { type: "text", text: "" },
  ]);
  onEvent({
    type: "thinking_delta",
    contentIndex: 0,
    delta: "Private thinking",
    partial,
  });
  onEvent({
    type: "text_delta",
    contentIndex: 1,
    delta: `Hello${PI_MEMORY_CITATION_OPEN.slice(0, 5)}`,
    partial,
  });
  expect(chunks).toEqual([
    { runEventId: "api-first:attempt:1", chunkIndex: 0, delta: "Hello" },
  ]);
  onEvent({
    type: "text_delta",
    contentIndex: 1,
    delta: PI_MEMORY_CITATION_OPEN.slice(5) + "private",
    partial,
  });
  onEvent({
    type: "text_delta",
    contentIndex: 3,
    delta: PI_MEMORY_CITATION_CLOSE + "World",
    partial,
  });
  onEvent({ type: "text_delta", contentIndex: 3, delta: "!", partial });
  expect(chunks).toEqual([
    { runEventId: "api-first:attempt:1", chunkIndex: 0, delta: "Hello" },
    { runEventId: "api-first:attempt:3", chunkIndex: 0, delta: "World" },
    { runEventId: "api-first:attempt:3", chunkIndex: 1, delta: "!" },
  ]);
  const final = projectPiApiAssistantMessage(
    partial,
    undefined,
    "api-first:attempt",
  );
  expect(
    final.content
      .filter((block) => {
        return block.type === "text";
      })
      .map((block) => {
        return block.runEventId;
      }),
  ).toEqual(["api-first:attempt:1", "api-first:attempt:3"]);
});
