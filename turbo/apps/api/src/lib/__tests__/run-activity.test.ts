import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../event-consumer/verify";
import {
  activityExcerpt,
  activityRevision,
  mergeActivity,
} from "../run-activity";

const NUL = String.fromCharCode(0);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd8_3d);
const LONE_LOW_SURROGATE = String.fromCharCode(0xde_00);
const ASTRAL = String.fromCodePoint(0x1_f6_00);
/**
 * `JSON.stringify` emits a `\uXXXX` escape for `U+0000` and for an unpaired
 * surrogate, and leaves a paired surrogate as a literal character. Those two
 * escapes are exactly what PostgreSQL refuses when parsing a jsonb parameter.
 */
const REJECTED_BY_JSONB = /\\u0000|\\ud[0-9a-f]{3}/iu;

function toolEvent(
  name: string,
  callId: string,
  input: unknown,
  sequenceNumber = 1,
): AgentEvent {
  return {
    type: "assistant",
    sequenceNumber,
    message: {
      content: [{ type: "tool_use", name, id: callId, input }],
    },
  };
}

describe("activityExcerpt", () => {
  it("drops code points that PostgreSQL refuses inside jsonb", () => {
    const excerpt = activityExcerpt(
      `a${NUL}b${LONE_HIGH_SURROGATE}c${LONE_LOW_SURROGATE}d`,
    );

    expect(excerpt).toBe("abcd");
  });

  it("keeps a paired surrogate intact and counts it as one code point", () => {
    const excerpt = activityExcerpt(`${ASTRAL}tail`);

    expect(excerpt).toBe(`${ASTRAL}tail`);
  });

  it("bounds long input by code points rather than UTF-16 units", () => {
    expect(Array.from(activityExcerpt(ASTRAL.repeat(800)))).toHaveLength(700);
  });
});

describe("mergeActivity", () => {
  it("truncates a tool name without splitting a surrogate pair", () => {
    const name = `${"n".repeat(99)}${ASTRAL}${"x".repeat(20)}`;

    const [entry] = mergeActivity([], [toolEvent(name, "call-1", "input")]);

    expect(entry?.name).toBe(`${"n".repeat(99)}${ASTRAL}`);
    expect(JSON.stringify(entry)).not.toMatch(REJECTED_BY_JSONB);
  });

  it("truncates a call identifier without splitting a surrogate pair", () => {
    const callId = `${"c".repeat(159)}${ASTRAL}${"x".repeat(20)}`;

    const [entry] = mergeActivity([], [toolEvent("tool", callId, "input")]);

    expect(entry?.callId).toBe(`${"c".repeat(159)}${ASTRAL}`);
    expect(JSON.stringify(entry)).not.toMatch(REJECTED_BY_JSONB);
  });

  it("removes jsonb-rejected code points from projected tool arguments", () => {
    const entries = mergeActivity(
      [],
      [
        toolEvent("tool", "call-1", {
          command: `cat${NUL}binary${LONE_HIGH_SURROGATE}`,
        }),
      ],
    );

    expect(JSON.stringify(entries)).not.toMatch(REJECTED_BY_JSONB);
    expect(entries[0]?.excerpt).toContain("catbinary");
  });

  it("is idempotent for a repeated batch so a failed write can be replayed", () => {
    const events = [
      toolEvent("tool", "call-1", "first", 1),
      toolEvent("tool", "call-2", "second", 2),
    ];

    const once = mergeActivity([], events);
    const twice = mergeActivity(once, events);

    expect(twice).toStrictEqual(once);
    expect(activityRevision(twice)).toBe(activityRevision(once));
  });
});
