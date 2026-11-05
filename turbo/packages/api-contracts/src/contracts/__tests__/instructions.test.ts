import { describe, expect, it } from "vitest";

import {
  instructionsRequestSchema,
  instructionsResponseSchema,
} from "../instructions";
import { singleAgentRuntimeContextSchema } from "../single-agent";

describe("personal Instructions wire contract", () => {
  it("preserves an intentional clear and its conditional-write version", () => {
    expect(
      instructionsRequestSchema.parse({ content: "", ifVersion: "revision-7" }),
    ).toStrictEqual({ content: "", ifVersion: "revision-7" });
    expect(
      instructionsRequestSchema.parse({ content: "Use concise updates." }),
    ).toStrictEqual({ content: "Use concise updates." });
  });

  it("rejects a caller-supplied ownership target", () => {
    expect(
      instructionsRequestSchema.safeParse({
        content: "Replace another member's instructions",
        userId: "another-member",
      }).success,
    ).toBe(false);
  });

  it("returns the saved owner, content and opaque version without an Agent", () => {
    const saved = {
      orgId: "org-current",
      userId: "member-current",
      content: "",
      updatedAt: "2026-11-05T10:00:00.000Z",
      version: "opaque-revision",
    };
    expect(instructionsResponseSchema.parse(saved)).toStrictEqual(saved);
  });

  it("carries a personal Run snapshot while accepting existing legacy tokens", () => {
    expect(
      singleAgentRuntimeContextSchema.parse({ singleAgent: true }),
    ).toStrictEqual({ singleAgent: true });
    expect(singleAgentRuntimeContextSchema.parse({})).toStrictEqual({});
  });
});
