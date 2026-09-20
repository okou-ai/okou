import { describe, expect, it } from "vitest";

import {
  mcpChatLifecycleSchema,
  mcpGetChatStatusOutputSchema,
  type McpGetChatStatusOutput,
} from "./mcp-chat-status";

const threadId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const otherThreadId = "00000000-0000-4000-8000-000000000003";
const otherRunId = "00000000-0000-4000-8000-000000000004";
const messages = {
  tool: "get_chat_messages" as const,
  arguments: { threadId, runId, limit: 20 as const },
};
const pageMessage = {
  ref: {
    threadId,
    eventId: "00000000-0000-4000-8000-000000000005",
    seqId: 1,
  },
  role: "assistant" as const,
  eventType: "output.message" as const,
  createdAt: "2026-09-20T00:00:00.000Z",
  runId,
  text: "Ready output",
  textOffset: 0,
  textComplete: true,
  files: [],
  fileOffset: 0,
  filesComplete: true,
  nextContentCursor: null,
  url: "https://app.okou.ai/messages/00000000-0000-4000-8000-000000000005",
};
const messagePage = {
  messages: [pageMessage],
  olderCursor: null,
  newerCursor: null,
};
const waitMetrics = {
  requestedMs: 1000,
  effectiveMs: 1000,
  elapsedMs: 500,
  observations: 2,
};

function statusOutput(overrides: Partial<McpGetChatStatusOutput>): unknown {
  return {
    threadId,
    observedAt: "2026-09-20T00:00:00.000Z",
    lifecycle: { phase: "idle", outcome: null, output: "none" },
    messages: null,
    wait: null,
    messagePage: null,
    retryAfterMs: null,
    ...overrides,
  };
}

const validLifecycles = [
  { phase: "idle", outcome: null, output: "none" },
  { phase: "queued", outcome: null, output: "pending" },
  { phase: "queued", outcome: null, output: "partial" },
  { phase: "running", outcome: null, output: "pending" },
  { phase: "running", outcome: null, output: "partial" },
  { phase: "finalizing", outcome: "completed", output: "pending" },
  { phase: "finalizing", outcome: "failed", output: "partial" },
  { phase: "finalizing", outcome: "timeout", output: "pending" },
  { phase: "finalizing", outcome: "cancelled", output: "partial" },
  { phase: "settled", outcome: "completed", output: "ready" },
  { phase: "settled", outcome: "failed", output: "none" },
  { phase: "settled", outcome: "timeout", output: "ready" },
  { phase: "settled", outcome: "cancelled", output: "none" },
  { phase: "settled", outcome: "rejected", output: "none" },
  { phase: "settled", outcome: "revoked", output: "none" },
  { phase: "unavailable", outcome: null, output: "unavailable" },
] as const;

const invalidLifecycles = [
  { phase: "idle", outcome: "failed", output: "none" },
  { phase: "queued", outcome: null, output: "ready" },
  { phase: "running", outcome: "completed", output: "partial" },
  { phase: "finalizing", outcome: "completed", output: "ready" },
  { phase: "settled", outcome: null, output: "none" },
  { phase: "settled", outcome: "rejected", output: "ready" },
  { phase: "unavailable", outcome: null, output: "pending" },
] as const;

describe("MCP chat lifecycle contract", () => {
  it.each(validLifecycles)("accepts $phase/$outcome/$output", (lifecycle) => {
    expect(mcpChatLifecycleSchema.parse(lifecycle)).toStrictEqual(lifecycle);
  });

  it.each(invalidLifecycles)("rejects $phase/$outcome/$output", (lifecycle) => {
    expect(mcpChatLifecycleSchema.safeParse(lifecycle).success).toBeFalsy();
  });
});

describe("MCP chat status response coherence", () => {
  it.each([
    statusOutput({}),
    statusOutput({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
      retryAfterMs: 2000,
    }),
    statusOutput({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
      messages,
      retryAfterMs: 2000,
    }),
    statusOutput({
      lifecycle: { phase: "queued", outcome: null, output: "partial" },
      messages,
      retryAfterMs: 2000,
    }),
    statusOutput({
      lifecycle: { phase: "settled", outcome: "completed", output: "ready" },
      messages,
    }),
    statusOutput({
      lifecycle: { phase: "settled", outcome: "completed", output: "ready" },
      messages,
      wait: {
        ...waitMetrics,
        outcome: "ready",
        returnReason: "output_ready",
      },
      messagePage,
    }),
    statusOutput({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
      retryAfterMs: 2000,
      wait: {
        ...waitMetrics,
        outcome: "deadline",
        returnReason: "application_deadline",
      },
    }),
    statusOutput({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
      retryAfterMs: 2000,
      wait: {
        ...waitMetrics,
        outcome: "status",
        returnReason: "waiter_limit",
      },
    }),
    statusOutput({
      lifecycle: { phase: "settled", outcome: "failed", output: "none" },
      messages,
      wait: {
        ...waitMetrics,
        outcome: "status",
        returnReason: "non_retryable_state",
      },
    }),
  ])("accepts a coherent complete response", (status) => {
    expect(mcpGetChatStatusOutputSchema.safeParse(status).success).toBeTruthy();
  });

  it.each([
    statusOutput({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
    }),
    statusOutput({
      lifecycle: { phase: "queued", outcome: null, output: "partial" },
      retryAfterMs: 2000,
    }),
    statusOutput({ retryAfterMs: 2000 }),
    statusOutput({
      lifecycle: { phase: "settled", outcome: "completed", output: "ready" },
    }),
    statusOutput({ messages }),
    statusOutput({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
      messages: {
        ...messages,
        arguments: { ...messages.arguments, threadId: otherThreadId },
      },
      retryAfterMs: 2000,
    }),
    statusOutput({ messagePage }),
    statusOutput({
      lifecycle: { phase: "settled", outcome: "completed", output: "ready" },
      messages,
      wait: {
        ...waitMetrics,
        outcome: "ready",
        returnReason: "output_ready",
      },
    }),
    statusOutput({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
      retryAfterMs: 2000,
      wait: {
        ...waitMetrics,
        outcome: "ready",
        returnReason: "output_ready",
      },
      messagePage,
    }),
    statusOutput({
      lifecycle: { phase: "settled", outcome: "completed", output: "ready" },
      messages,
      wait: {
        ...waitMetrics,
        outcome: "ready",
        returnReason: "output_ready",
      },
      messagePage: {
        ...messagePage,
        messages: [],
      },
    }),
    statusOutput({
      lifecycle: { phase: "settled", outcome: "completed", output: "ready" },
      messages,
      wait: {
        ...waitMetrics,
        outcome: "ready",
        returnReason: "output_ready",
      },
      messagePage: {
        ...messagePage,
        messages: Array.from({ length: 21 }, () => {
          return pageMessage;
        }),
      },
    }),
    statusOutput({
      lifecycle: { phase: "settled", outcome: "completed", output: "ready" },
      messages,
      wait: {
        ...waitMetrics,
        outcome: "ready",
        returnReason: "output_ready",
      },
      messagePage: {
        ...messagePage,
        messages: [
          {
            ...pageMessage,
            ref: { ...pageMessage.ref, threadId: otherThreadId },
          },
        ],
      },
    }),
    statusOutput({
      lifecycle: { phase: "settled", outcome: "completed", output: "ready" },
      messages,
      wait: {
        ...waitMetrics,
        outcome: "ready",
        returnReason: "output_ready",
      },
      messagePage: {
        ...messagePage,
        messages: [{ ...pageMessage, runId: otherRunId }],
      },
    }),
    statusOutput({
      wait: {
        ...waitMetrics,
        outcome: "ready",
        returnReason: "application_deadline",
      },
    }),
    statusOutput({
      lifecycle: { phase: "queued", outcome: null, output: "pending" },
      retryAfterMs: 2000,
      wait: {
        ...waitMetrics,
        outcome: "status",
        returnReason: "non_retryable_state",
      },
    }),
    statusOutput({
      wait: {
        ...waitMetrics,
        outcome: "status",
        returnReason: "waiter_limit",
      },
    }),
  ])("rejects a contradictory complete response", (status) => {
    expect(mcpGetChatStatusOutputSchema.safeParse(status).success).toBeFalsy();
  });
});
