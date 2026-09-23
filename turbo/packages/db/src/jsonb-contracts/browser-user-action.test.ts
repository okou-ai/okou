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
