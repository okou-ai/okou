import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  client,
  appRequest,
  appcastRequest,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
} = createDesktopUpdatePublicApi(context);

describe("desktop update routes", () => {
  it("keeps dormant Electron clients on the retained bridge-bearing hop while Native and manual downloads advance", async () => {
    const initialNow = Date.parse("2026-10-10T08:00:00Z");
    await withMockNowForTest(initialNow, async () => {
      for (const [index, version] of ["0.53.0", "0.53.1"].entries()) {
        // New publisher output may omit historical releases entirely.
        mockDesktopUpdateManifest(
          stableManifest(version, {
            [version]: darwinArm64Release(version, okouZipUrl(version)),
          }),
        );
        mockNow(initialNow + index * 60_000);
        const legacy = await accept(
          client().productFeed({
            params: {
              product: "ai-okou-desktop",
              channel: "stable",
              platform: "darwin",
              arch: "arm64",
            },
          }),
          [200],
        );
        expect(legacy.headers.get("cache-control")).toBe("no-store");
        expect(legacy.body).toStrictEqual({
          currentRelease: "0.52.2",
          releases: [
            {
              version: "0.52.2",
              updateTo: {
                name: "Okou 0.52.2",
                version: "0.52.2",
                notes: "",
                pub_date: "2026-10-10T06:04:27.216Z",
                url: okouZipUrl("0.52.2"),
              },
            },
          ],
        });
        const native = await appcastRequest();
        expect(native.status).toBe(200);
        const nativeXml = await native.text();
        expect(nativeXml).toContain(
          `<sparkle:version>${version}</sparkle:version>`,
        );
        expect(nativeXml).toContain(`<enclosure url="${okouZipUrl(version)}"`);
        const manual = await appRequest(
          "/api/desktop/updates/stable/darwin/arm64/dmg",
        );
        expect(manual.status).toBe(302);
        expect(manual.headers.get("location")).toBe(
          okouZipUrl(version).replace(".zip", ".dmg"),
        );
      }
    });
  });
});
