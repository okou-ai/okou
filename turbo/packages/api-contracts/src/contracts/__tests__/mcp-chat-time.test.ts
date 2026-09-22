import { describe, expect, it } from "vitest";

import {
  formatMcpChatTimestamp,
  mcpChatOutputTimestampSchema,
  mcpFilterTimestampSchema,
  mcpTimestampKey,
} from "../mcp-chat-time";

describe("MCP chat timestamps", () => {
  it.each([
    ["2026-09-21T01:02:03Z", "2026-09-21T01:02:03.000000Z"],
    ["2026-09-21T01:02:03.1Z", "2026-09-21T01:02:03.100000Z"],
    ["2026-09-21T01:02:03.123Z", "2026-09-21T01:02:03.123000Z"],
    ["2026-09-21T01:02:03.123456Z", "2026-09-21T01:02:03.123456Z"],
  ])("normalizes %s to fixed microsecond precision", (input, expected) => {
    expect(formatMcpChatTimestamp(input)).toBe(expected);
    expect(mcpTimestampKey(input)).toBe(expected.slice(0, -1));
    expect(mcpChatOutputTimestampSchema.parse(expected)).toBe(expected);
  });

  it("normalizes JavaScript dates to fixed microsecond precision", () => {
    expect(formatMcpChatTimestamp(new Date("2026-09-21T01:02:03.123Z"))).toBe(
      "2026-09-21T01:02:03.123000Z",
    );
  });

  it.each([
    "2026-09-21T01:02:03.1234567Z",
    "2026-09-21T01:02:03+00:00",
    "not-a-timestamp",
  ])("rejects unsupported filter timestamp %s", (input) => {
    expect(mcpFilterTimestampSchema.safeParse(input).success).toBe(false);
    expect(() => {
      return formatMcpChatTimestamp(input);
    }).toThrow();
  });

  it.each([
    "2026-09-21T01:02:03Z",
    "2026-09-21T01:02:03.123Z",
    "2026-09-21T01:02:03.1234567Z",
  ])("rejects non-six-digit output timestamp %s", (input) => {
    expect(mcpChatOutputTimestampSchema.safeParse(input).success).toBe(false);
  });
});
