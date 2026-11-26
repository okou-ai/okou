import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const desktop = createDesktopUpdatePublicApi(context);

function publishOnly(version: string): void {
  desktop.mockDesktopUpdateManifest(
    desktop.stableManifest(version, {
      [version]: desktop.darwinArm64Release(
        version,
        desktop.okouZipUrl(version),
      ),
    }),
  );
}

/** The three update surfaces an installed client or the download page reads. */
async function readUpdateSurfaces() {
  const updates = desktop.client();
  const legacy = await accept(
    updates.productFeed({
      params: {
        product: "ai-okou-desktop",
        channel: "stable",
        platform: "darwin",
        arch: "arm64",
      },
    }),
    [200],
  );
  const appcast = await desktop.appcastRequest();
  const dmg = await accept(
    updates.dmgDownload({
      params: { channel: "stable", platform: "darwin", arch: "arm64" },
    }),
    [302],
  );
  return { legacy, appcast, dmg };
}

test("desktop-updates-28-freezes-the-electron-hop-while-native-updates-advance-001 keeps the Electron hop on 0.52.2 while Native and manual downloads follow the manifest", async () => {
  publishOnly("0.53.0");
  const first = await readUpdateSurfaces();
  mockNow(now() + 60_000);
  publishOnly("0.53.1");
  const second = await readUpdateSurfaces();

  for (const [surfaces, version] of [
    [first, "0.53.0"],
    [second, "0.53.1"],
  ] as const) {
    expect(surfaces.legacy.status).toBe(200);
    expect(surfaces.legacy.headers.get("cache-control")).toBe("no-store");
    expect(surfaces.legacy.body).toStrictEqual({
      currentRelease: "0.52.2",
      releases: [
        {
          version: "0.52.2",
          updateTo: {
            name: "Okou 0.52.2",
            version: "0.52.2",
            pub_date: "2026-10-10T06:04:27.216Z",
            notes: "",
            url: desktop.okouZipUrl("0.52.2"),
          },
        },
      ],
    });

    expect(surfaces.appcast.status).toBe(200);
    const xml = await surfaces.appcast.text();
    expect(xml).toContain(`<sparkle:version>${version}</sparkle:version>`);
    expect(xml).toContain(`<enclosure url="${desktop.okouZipUrl(version)}"`);

    expect(surfaces.dmg.headers.get("location")).toBe(
      `https://github.com/okou-ai/okou/releases/download/okou-desktop-v${version}/Okou-darwin-arm64-${version}.dmg`,
    );
  }
});
