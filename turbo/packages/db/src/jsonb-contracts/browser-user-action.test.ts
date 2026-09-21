import { describe, expect, it } from "vitest";

import { parseBrowserUserActionPayload } from "./browser-user-action";

describe("Browser user-action JSONB payload", () => {
  it("decodes a versioned safe input payload", () => {
    expect(
      parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
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
      }),
    ).toMatchObject({ kind: "input", fields: [{ backendNodeId: 42 }] });
  });

  it("rejects unknown versions, duplicate keys, and unsafe shapes", () => {
    expect(() => {
      return parseBrowserUserActionPayload({
        version: 2,
        kind: "direct_interaction",
        reason: "New shape",
      });
    }).toThrow("Unsupported Browser user-action payload version");
    expect(() => {
      return parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
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
      });
    }).toThrow("Invalid Browser user-action input payload");
    expect(() => {
      return parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
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
      });
    }).toThrow("Invalid Browser user-action input payload");
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
        fields: [field, field],
      });
    }).toThrow("Duplicate Browser user-action input field key");
    expect(() => {
      return parseBrowserUserActionPayload({
        version: 1,
        kind: "input",
        fields: [field, { ...field, key: "other" }],
      });
    }).toThrow("Duplicate Browser user-action backend node ID");
  });
});
