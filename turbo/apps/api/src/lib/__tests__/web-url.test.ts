import { afterEach, describe, expect, it, vi } from "vitest";

import { stubTestWebUrlEnvironment } from "../../__tests__/env-stub";
import { mockEnv } from "../env";
import {
  getOAuthApiOrigin,
  getOAuthCanonicalRedirectUrl,
  getOAuthWebOrigin,
} from "../oauth-origin";
import { webUrl } from "../web-url";

async function importEnvWithRawWebUrl(
  value: string | undefined,
): Promise<void> {
  // Environment validation happens during module initialization, so reloading
  // the module is the production boundary for exercising raw process input.
  vi.resetModules();
  stubTestWebUrlEnvironment(value);
  await import("../env");
}

describe("web URL", () => {
  afterEach(() => {
    stubTestWebUrlEnvironment("http://localhost:3001");
    vi.resetModules();
  });

  it.each([
    { state: "missing", value: undefined },
    { state: "invalid", value: "not-a-url" },
  ])("rejects $state raw OKOU_WEB_URL input", async ({ value }) => {
    await expect(importEnvWithRawWebUrl(value)).rejects.toThrow(
      /Invalid environment variables/u,
    );
  });

  it("accepts valid raw OKOU_WEB_URL input", async () => {
    await expect(
      importEnvWithRawWebUrl("https://configured.example.test/path"),
    ).resolves.toBeUndefined();
  });

  it("preserves Web URL bytes and OAuth origins", () => {
    const configuredWebUrl = "https://www.vm6.ai/configured/path";
    mockEnv("OKOU_WEB_URL", configuredWebUrl);
    mockEnv("OKOU_API_BACKEND_URL", undefined);
    const request = new Request(
      "https://api.vm6.ai/api/connectors/github/callback?code=test",
    );

    expect(webUrl()).toBe(configuredWebUrl);
    expect(getOAuthWebOrigin(request)).toBe("https://www.vm6.ai");
    expect(getOAuthApiOrigin(request)).toBe("https://api.vm6.ai");
    expect(getOAuthCanonicalRedirectUrl(request)).toBe(
      "https://www.vm6.ai/api/connectors/github/callback?code=test",
    );
  });
});
