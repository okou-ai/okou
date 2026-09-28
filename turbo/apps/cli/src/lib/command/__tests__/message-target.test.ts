import { describe, expect, it } from "vitest";
import { parseMessageTarget } from "../message-target";

function isUserId(id: string): boolean {
  return id.startsWith("U");
}

describe("parseMessageTarget", () => {
  it.each([
    { value: "me", expected: { kind: "me" } },
    { value: "U123", expected: { kind: "user", id: "U123" } },
    { value: "C123", expected: { kind: "chat", id: "C123" } },
    { value: "user:C123", expected: { kind: "user", id: "C123" } },
    { value: "chat:U123", expected: { kind: "chat", id: "U123" } },
    { value: " C123 ", expected: { kind: "chat", id: "C123" } },
  ])("parses $value", ({ value, expected }) => {
    expect(parseMessageTarget(value, isUserId)).toStrictEqual(expected);
  });

  it.each(["", "user:", "chat: "])("rejects %j", (value) => {
    expect(() => {
      return parseMessageTarget(value, isUserId);
    }).toThrow("--to");
  });
});
