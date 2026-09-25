import { describe, expect, it } from "vitest";

import {
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
  BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH,
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

  it("accepts indexed select choices and rejects duplicate indices or values in place of choices", () => {
    const choice = {
      key: "region",
      optionIndexes: [0, 2],
      optionSetFingerprint: "a".repeat(64),
    };
    expect(
      browserUserActionApplyRequestSchema.safeParse({ values: [choice] })
        .success,
    ).toBe(true);
    expect(
      browserUserActionApplyRequestSchema.safeParse({
        values: [{ ...choice, optionIndexes: [2, 2] }],
      }).success,
    ).toBe(false);
    expect(
      browserUserActionApplyRequestSchema.safeParse({
        values: [{ ...choice, value: "private-option-value" }],
      }).success,
    ).toBe(false);
  });

  it("accepts explicit checkbox booleans bound to observed state and rejects scalar or mixed shapes", () => {
    expect(
      browserUserActionCreateRequestSchema.parse({
        kind: "input",
        callbackPrompt: "Confirm consent",
        pageTargetId: "page-target",
        fields: [
          {
            key: "consent",
            label: "Consent",
            fieldKind: "checkbox",
            required: false,
            backendNodeId: 42,
          },
        ],
      }).fields[0]?.fieldKind,
    ).toBe("checkbox");
    for (const checked of [true, false]) {
      expect(
        browserUserActionApplyRequestSchema.parse({
          values: [{ key: "consent", checked, observedChecked: true }],
        }).values[0],
      ).toMatchObject({ checked, observedChecked: true });
    }
    for (const invalid of [
      { key: "consent", checked: "false", observedChecked: true },
      { key: "consent", checked: false },
      { key: "consent", checked: false, observedChecked: false, value: "on" },
    ]) {
      expect(
        browserUserActionApplyRequestSchema.safeParse({ values: [invalid] })
          .success,
      ).toBe(false);
    }
  });

  it("accepts a bounded radio index including explicit clear and rejects ambiguous scalar values", () => {
    const value = {
      key: "delivery",
      memberIndex: 1,
      observedSelectedIndex: 0,
      groupFingerprint: "b".repeat(64),
    };
    expect(
      browserUserActionApplyRequestSchema.parse({ values: [value] }).values[0],
    ).toMatchObject(value);
    expect(
      browserUserActionApplyRequestSchema.safeParse({
        values: [{ ...value, memberIndex: -1 }],
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...value, memberIndex: 16 },
      { ...value, observedSelectedIndex: -2 },
      { ...value, value: "same" },
      { key: "delivery", memberIndex: 1 },
    ]) {
      expect(
        browserUserActionApplyRequestSchema.safeParse({ values: [bad] })
          .success,
      ).toBe(false);
    }
  });

  it("accepts five native date/time response types and scalar HTML strings without timezone conversion", () => {
    const request = browserUserActionCreateRequestSchema.parse({
      kind: "input",
      callbackPrompt: "Continue after date entry",
      pageTargetId: "page-target",
      fields: [
        {
          key: "arrival",
          label: "Arrival",
          fieldKind: "date_time",
          required: false,
          backendNodeId: 45,
        },
      ],
    });
    expect(request.fields[0]?.fieldKind).toBe("date_time");
    const base = {
      requestToken: "vm0_browser_user_action_public-token",
      kind: "input",
      state: "pending",
      siteOrigin: "https://example.com",
      completedAt: null,
      agentId: uuid("1"),
      threadId: uuid("2"),
      callbackIds: {
        success: { clientEventId: uuid("3"), chatThreadSortEventId: uuid("4") },
        cancellation: {
          clientEventId: uuid("5"),
          chatThreadSortEventId: uuid("6"),
        },
      },
    };
    for (const inputType of [
      "date",
      "time",
      "datetime-local",
      "month",
      "week",
    ]) {
      expect(
        browserUserActionResponseSchema.safeParse({
          ...base,
          fields: [
            {
              key: "arrival",
              label: "Arrival",
              fieldKind: "date_time",
              required: false,
              control: {
                tagName: "INPUT",
                inputType,
                siteRequired: false,
                min: "2025-01",
                max: "2030-12",
                step: "any",
              },
            },
          ],
        }).success,
      ).toBe(true);
    }
    expect(
      browserUserActionApplyRequestSchema.parse({
        values: [
          { key: "arrival", value: "2026-09-25T09:30" },
          { key: "optional", value: "" },
        ],
      }).values,
    ).toHaveLength(2);
  });

  it("keeps number values as strings and bounds observed constraints", () => {
    const request = browserUserActionCreateRequestSchema.parse({
      kind: "input",
      callbackPrompt: "Continue after quantity entry",
      pageTargetId: "page-target",
      fields: [
        {
          key: "quantity",
          label: "Quantity",
          fieldKind: "number",
          required: false,
          backendNodeId: 45,
        },
      ],
    });
    expect(request.fields[0]?.fieldKind).toBe("number");
    expect(
      browserUserActionApplyRequestSchema.parse({
        values: [{ key: "quantity", value: "9007199254740993" }],
      }).values[0],
    ).toMatchObject({ value: "9007199254740993" });
    const field = {
      key: "quantity",
      label: "Quantity",
      fieldKind: "number",
      required: false,
      control: {
        tagName: "INPUT",
        inputType: "number",
        min: "0.5",
        max: "100",
        step: "any",
      },
    };
    expect(
      browserUserActionResponseSchema.safeParse({
        requestToken: "vm0_browser_user_action_public-token",
        kind: "input",
        state: "pending",
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
        fields: [field],
      }).success,
    ).toBe(true);
    expect(
      browserUserActionResponseSchema.safeParse({
        requestToken: "vm0_browser_user_action_public-token",
        kind: "input",
        state: "pending",
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
            ...field,
            control: {
              ...field.control,
              step: "x".repeat(
                BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH + 1,
              ),
            },
          },
        ],
      }).success,
    ).toBe(false);
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
