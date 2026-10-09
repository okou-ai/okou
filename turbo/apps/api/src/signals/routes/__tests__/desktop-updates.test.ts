import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const { appRequest } = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("exposes the deployment floor without authentication and leaves enforcement disabled by default", async () => {
    const disabled = await appRequest("/api/desktop/compatibility");
    expect(disabled.status).toBe(200);
    expect(disabled.headers.get("cache-control")).toBe("no-store");
    await expect(disabled.json()).resolves.toStrictEqual({
      minimumSupportedVersion: null,
    });
    mockEnv("OKOU_DESKTOP_MINIMUM_SUPPORTED_VERSION", "0.51.0");
    const enabled = await appRequest("/api/desktop/compatibility");
    await expect(enabled.json()).resolves.toStrictEqual({
      minimumSupportedVersion: "0.51.0",
    });
  });
});
