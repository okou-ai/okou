import { describe, expect, it } from "vitest";

import { parseBrowserUserActionPayload } from "./browser-user-action";

const callbackIds = {
  success: {
    clientEventId: "11111111-1111-4111-8111-111111111111",
    chatThreadSortEventId: "22222222-2222-4222-8222-222222222222",
  },
  cancellation: {
    clientEventId: "33333333-3333-4333-8333-333333333333",
    chatThreadSortEventId: "44444444-4444-4444-8444-444444444444",
  },
};

const inputTarget = {
  pageTargetId: "page-target",
  documentLoaderId: "document-loader",
  siteOrigin: "https://example.com",
  pageUrlHash: "a".repeat(64),
};

describe("Browser user-action JSONB payload", () => {
  it("decodes a versioned safe input payload", () => {
    expect(
      parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
        callbackIds,
        target: {
          ...inputTarget,
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 42,
              fingerprint: { tagName: "INPUT", inputType: "text" },
            },
          ],
        },
      }),
    ).toMatchObject({
      kind: "input",
      callbackIds,
      target: { fields: [{ backendNodeId: 42 }] },
    });
  });

  it("accepts genuine number targets but keeps semantic kinds distinct", () => {
    const field = {
      key: "quantity",
      label: "Quantity",
      fieldKind: "number",
      required: false,
      backendNodeId: 45,
      fingerprint: { tagName: "INPUT", inputType: "number" },
    };
    const payload = {
      version: 1,
      kind: "input",
      callbackIds,
      target: { ...inputTarget, fields: [field] },
    };
    expect(
      parseBrowserUserActionPayload(payload).target.fields[0],
    ).toMatchObject(field);
    expect(() => {
      parseBrowserUserActionPayload({
        ...payload,
        target: {
          ...inputTarget,
          fields: [
            { ...field, fingerprint: { tagName: "INPUT", inputType: "text" } },
          ],
        },
      });
    }).toThrow("Invalid Browser user-action payload");
    expect(
      parseBrowserUserActionPayload({
        ...payload,
        target: {
          ...inputTarget,
          fields: [{ ...field, fieldKind: "one_time_code" }],
        },
      }).target.fields[0]?.fieldKind,
    ).toBe("one_time_code");
  });

  it("accepts only exact native date/time subtypes for a semantic date/time request", () => {
    const field = {
      key: "arrival",
      label: "Arrival",
      fieldKind: "date_time",
      required: false,
      backendNodeId: 45,
      fingerprint: { tagName: "INPUT", inputType: "date" },
    };
    const decode = (candidate: Record<string, unknown>) => {
      return parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
        callbackIds,
        target: { ...inputTarget, fields: [candidate] },
      });
    };
    for (const inputType of [
      "date",
      "time",
      "datetime-local",
      "month",
      "week",
    ]) {
      expect(
        decode({ ...field, fingerprint: { tagName: "INPUT", inputType } })
          .target.fields[0]?.fieldKind,
      ).toBe("date_time");
    }
    for (const invalid of [
      { ...field, fingerprint: { tagName: "INPUT", inputType: "text" } },
      { ...field, fingerprint: { tagName: "INPUT", inputType: "color" } },
      { ...field, fingerprint: { tagName: "TEXTAREA", inputType: "date" } },
      { ...field, radioMemberNodeIds: [45] },
    ]) {
      expect(() => {
        return decode(invalid);
      }).toThrow("Invalid Browser user-action payload");
    }
  });

  it("seals only bounded, unique radio group member identities around the anchor", () => {
    const field = {
      key: "delivery",
      label: "Delivery",
      fieldKind: "radio",
      required: false,
      backendNodeId: 45,
      radioMemberNodeIds: [44, 45, 46],
      fingerprint: { tagName: "INPUT", inputType: "radio" },
    };
    const decode = (candidate: Record<string, unknown>) => {
      return parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
        callbackIds,
        target: { ...inputTarget, fields: [candidate] },
      });
    };
    expect(decode(field).target.fields[0]).toMatchObject(field);
    for (const invalid of [
      { ...field, radioMemberNodeIds: undefined },
      { ...field, radioMemberNodeIds: [44, 46] },
      { ...field, radioMemberNodeIds: [45, 45] },
      { ...field, radioMemberNodeIds: [45, -1] },
      {
        ...field,
        radioMemberNodeIds: Array.from({ length: 17 }, (_, i) => {
          return i + 45;
        }),
      },
      {
        ...field,
        fieldKind: "checkbox",
        fingerprint: { tagName: "INPUT", inputType: "checkbox" },
      },
    ]) {
      expect(() => {
        return decode(invalid);
      }).toThrow("Invalid Browser user-action payload");
    }
  });

  it("rejects unknown versions, duplicate keys, and unsafe shapes", () => {
    expect(() => {
      return parseBrowserUserActionPayload({
        version: 2,
        kind: "input",
        callbackIds,
        target: { ...inputTarget, fields: [] },
      });
    }).toThrow("Unsupported Browser user-action payload version");
    expect(() => {
      return parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
        target: { ...inputTarget, fields: [] },
      });
    }).toThrow("Invalid Browser user-action callback identities");
    expect(() => {
      return parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
        callbackIds,
        target: {
          ...inputTarget,
          fields: [
            {
              key: "unsafe",
              label: "Unsafe",
              fieldKind: "text",
              required: true,
              backendNodeId: 4,
              fingerprint: { tagName: "INPUT", inputType: "text" },
              selector: "#must-not-survive",
            },
          ],
        },
      });
    }).toThrow("Invalid Browser user-action payload");
    expect(() => {
      return parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
        callbackIds,
        target: {
          ...inputTarget,
          fields: [
            {
              key: "password",
              label: "Password",
              fieldKind: "password",
              required: true,
              backendNodeId: 5,
              fingerprint: { tagName: "INPUT", inputType: "text" },
            },
          ],
        },
      });
    }).toThrow("Invalid Browser user-action payload");
    const field = {
      key: "same",
      label: "Same",
      fieldKind: "text",
      required: false,
      backendNodeId: 7,
      fingerprint: { tagName: "TEXTAREA", inputType: "textarea" },
    };
    expect(() => {
      return parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
        callbackIds,
        target: { ...inputTarget, fields: [field, field] },
      });
    }).toThrow("Invalid Browser user-action payload");
    expect(() => {
      return parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
        callbackIds,
        target: {
          ...inputTarget,
          fields: [field, { ...field, key: "other" }],
        },
      });
    }).toThrow("Invalid Browser user-action payload");
  });
});
