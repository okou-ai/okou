import { describe, expect, it } from "vitest";
import {
  mcpGetChatInputInputSchema,
  mcpGetChatInputOutputSchema,
} from "../mcp-chat-input";
import { ALL_RUN_STATUSES } from "../runs";

const identity = {
  threadId: "00000000-0000-4000-8000-000000000001",
  eventId: "00000000-0000-4000-8000-000000000002",
  createdAt: "2026-10-05T00:00:00.123000Z",
};
describe("MCP original input metadata", () => {
  it("selects an original input by thread and event identity", () => {
    const { threadId, eventId } = identity;
    expect(mcpGetChatInputInputSchema.parse({ threadId, eventId })).toEqual({
      threadId,
      eventId,
    });
  });
  it.each(["queued", "recalled"])(
    "observes %s without a Run or hidden content",
    (inputStatus) => {
      const output = { ...identity, inputStatus, run: null, error: null };
      expect(mcpGetChatInputOutputSchema.parse(output)).toEqual(output);
    },
  );
  it.each(ALL_RUN_STATUSES)(
    "keeps native Run status %s separate from consumption",
    (status) => {
      const output = {
        ...identity,
        inputStatus: "consumed",
        run: { runId: identity.eventId, status },
        error: null,
      };
      expect(mcpGetChatInputOutputSchema.parse(output)).toEqual(output);
    },
  );
  it("requires rejection metadata without inventing execution", () => {
    const output = {
      ...identity,
      inputStatus: "rejected",
      run: null,
      error: {
        code: "input_rejected",
        message: "The input was rejected before execution.",
      },
    };
    expect(mcpGetChatInputOutputSchema.parse(output)).toEqual(output);
    expect(
      mcpGetChatInputOutputSchema.safeParse({ ...output, error: null }).success,
    ).toBe(false);
    expect(
      mcpGetChatInputOutputSchema.safeParse({
        ...output,
        run: { runId: identity.eventId, status: "failed" },
      }).success,
    ).toBe(false);
  });
  it("does not label an unbound input as consumed", () => {
    expect(
      mcpGetChatInputOutputSchema.safeParse({
        ...identity,
        inputStatus: "consumed",
        run: null,
        error: null,
      }).success,
    ).toBe(false);
  });
});
