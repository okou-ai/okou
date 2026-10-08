import { describe, expect, it } from "vitest";

import { apiBackendUrl } from "../api-backend-url";
import { mockEnv } from "../env";
import { getOAuthApiOrigin } from "../oauth-origin";

const CANONICAL_API_BACKEND_URL_KEY = "OKOU_API_BACKEND_URL";

function configureApiBackendUrl(value: string | undefined): void {
  mockEnv(CANONICAL_API_BACKEND_URL_KEY, value);
}

describe("API backend URL", () => {
  it("returns the canonical URL byte-for-byte", () => {
    const value =
      "https://canonical-only.example.test/path?query=preserved#fragment";
    configureApiBackendUrl(value);

    expect(apiBackendUrl()).toBe(value);
  });

  it("returns undefined when the canonical input is absent", () => {
    configureApiBackendUrl(undefined);

    expect(apiBackendUrl()).toBeUndefined();
  });

  it("rejects an empty canonical input", () => {
    expect(() => {
      configureApiBackendUrl("");
    }).toThrow(/Invalid URL/u);
  });
});

describe("OAuth API origin", () => {
  it("keeps OAuth configured-origin normalization and sibling/web fallbacks", () => {
    const request = new Request("https://request.example.test/oauth");
    configureApiBackendUrl("https://api.okou.ai/configured/path");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    expect(getOAuthApiOrigin(request)).toBe("https://api.okou.ai");

    configureApiBackendUrl(undefined);
    mockEnv("OKOU_WEB_URL", "https://www.vm6.ai");
    expect(getOAuthApiOrigin(request)).toBe("https://api.vm6.ai");

    mockEnv("OKOU_WEB_URL", "https://external.example.test/path");
    expect(getOAuthApiOrigin(request)).toBe("https://external.example.test");
  });
});
