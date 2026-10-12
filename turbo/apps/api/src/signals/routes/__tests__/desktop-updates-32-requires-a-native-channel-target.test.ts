import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  appcastRequest,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
} = createDesktopUpdatePublicApi(context);

describe("Native Desktop channel target", () => {
  it("reports unavailable for a channel targeting an Electron release", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.49.75", {
        "0.49.75": darwinArm64Release("0.49.75", okouZipUrl("0.49.75")),
        "0.50.0": darwinArm64Release("0.50.0", okouZipUrl("0.50.0")),
      }),
    );
    const response = await appcastRequest();
    expect(response.status).toBe(404);
  });
});
