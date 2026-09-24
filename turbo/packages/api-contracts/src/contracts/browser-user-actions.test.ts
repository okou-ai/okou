import { describe, expect, it } from "vitest";

import {
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
  browserUserActionApplyRequestSchema,
  browserUserActionCreateRequestSchema,
  browserUserActionResponseSchema,
} from "./browser-user-actions";

const uuid = (digit: string) => {
  return `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
};

describe("Browser user-action contracts", () => {
  it("accepts a strict bounded input request", () => {
    expect(
      browserUserActionCreateRequestSchema.parse({
        kind: "input",
        callbackPrompt: "Continue after the user supplies the code",
        pageTargetId: "page-target",
        fields: [
          {
            key: "code",
            label: "Verification code",
            fieldKind: "one_time_code",
            required: true,
            backendNodeId: 42,
          },
        ],
      }),
    ).toMatchObject({ kind: "input", fields: [{ key: "code" }] });
  });

  it("rejects duplicate field and submitted-value keys", () => {
    const field = {
      key: "username",
      label: "Username",
      fieldKind: "username" as const,
      required: true,
      backendNodeId: 42,
    };
    expect(
      browserUserActionCreateRequestSchema.safeParse({
        kind: "input",
        callbackPrompt: "Enter credentials",
        pageTargetId: "page-target",
        fields: [field, field],
      }).success,
    ).toBe(false);
    expect(
      browserUserActionApplyRequestSchema.safeParse({
        values: [
          { key: "username", value: "one" },
          { key: "username", value: "two" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown properties and oversized values", () => {
    expect(
      browserUserActionCreateRequestSchema.safeParse({
        kind: "input",
        callbackPrompt: "Finish verification",
        pageTargetId: "page-target",
        fields: [
          {
            key: "code",
            label: "Code",
            fieldKind: "one_time_code",
            required: true,
            backendNodeId: 42,
          },
        ],
        selector: "#must-not-be-accepted",
      }).success,
    ).toBe(false);
    expect(
      browserUserActionApplyRequestSchema.safeParse({
        values: [
          {
            key: "password",
            value: "x".repeat(BROWSER_USER_ACTION_MAX_VALUE_LENGTH + 1),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps exact target and value data out of public responses", () => {
    const safe = {
      requestToken: "vm0_browser_user_action_public-token",
      kind: "input" as const,
      state: "pending" as const,
      siteOrigin: "https://example.com",
      completedAt: null,
      agentId: uuid("1"),
      threadId: uuid("2"),
      callbackIds: {
        success: {
          clientEventId: uuid("3"),
          chatThreadSortEventId: uuid("4"),
        },
        cancellation: {
          clientEventId: uuid("5"),
          chatThreadSortEventId: uuid("6"),
        },
      },
      fields: [
        {
          key: "password",
          label: "Password",
          fieldKind: "password" as const,
          required: true,
          control: {
            tagName: "INPUT" as const,
            inputType: "password" as const,
          },
        },
      ],
    };
    expect(browserUserActionResponseSchema.parse(safe)).toStrictEqual(safe);
    expect(
      browserUserActionResponseSchema.parse({
        ...safe,
        state: "succeeded",
        completedAt: "2026-09-23T05:00:00.000Z",
        callbackDelivered: true,
      }).callbackDelivered,
    ).toBe(true);
    expect(
      browserUserActionResponseSchema.safeParse({
        ...safe,
        pageTargetId: "target",
        value: "secret",
        fields: [{ ...safe.fields[0], backendNodeId: 42 }],
      }).success,
    ).toBe(false);
  });
});
