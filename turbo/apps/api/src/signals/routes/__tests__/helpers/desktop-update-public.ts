import { desktopUpdatesContract } from "@okouai/api-contracts/contracts/desktop-updates";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../../app-factory";
import type { TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";

import { server } from "../../../../mocks/server";
import { desktopUpdateRoutes } from "../../desktop-updates";

const TEST_APP_ROUTES = Object.freeze([...desktopUpdateRoutes]);

const OKOU_DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/okou-ai/okou/releases/download/ai-okou-desktop-updates/ai-okou-desktop-update-manifest.json";
const LEGACY_OKOU_DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/okou-ai/okou/releases/download/okou-desktop-updates/okou-desktop-update-manifest.json";

interface DesktopUpdateRelease {
  readonly version: string;
  readonly name?: string;
  readonly notes?: string;
  readonly pubDate: string;
  readonly platforms: Record<string, Record<string, { readonly url: string }>>;
}

interface DesktopUpdateManifest {
  readonly schemaVersion: 1;
  readonly product: "okou";
  readonly channels: Record<
    string,
    { readonly latest: string; readonly blocked?: readonly string[] }
  >;
  readonly releases: Record<string, DesktopUpdateRelease>;
}

export function createDesktopUpdatePublicApi(context: TestContext) {
  function client() {
    return setupApp({ context, routes: desktopUpdateRoutes })(
      desktopUpdatesContract,
    );
  }

  function appRequest(path: string): Promise<Response> {
    return Promise.resolve(
      createApp({ signal: context.signal, routes: TEST_APP_ROUTES }).request(
        path,
        { method: "GET" },
      ),
    );
  }

  function mockDesktopUpdateManifest(
    manifest: DesktopUpdateManifest,
    manifestUrl = OKOU_DESKTOP_UPDATE_MANIFEST_URL,
  ): void {
    server.use(
      http.get(manifestUrl, () => {
        return HttpResponse.json(manifest);
      }),
    );
  }

  function stableManifest(
    latest: string,
    releases: DesktopUpdateManifest["releases"],
    blocked: readonly string[] = [],
  ): DesktopUpdateManifest {
    return {
      schemaVersion: 1,
      product: "okou",
      channels: {
        stable: { latest, blocked: [...blocked] },
      },
      releases,
    };
  }

  function darwinArm64Release(version: string, url: string) {
    return {
      version,
      name: `Okou ${version}`,
      notes: `Release ${version}`,
      pubDate: "2026-06-08T00:00:00.000Z",
      platforms: {
        darwin: {
          arm64: { url },
        },
      },
    };
  }

  function okouZipUrl(version: string): string {
    return `https://github.com/okou-ai/okou/releases/download/okou-desktop-v${version}/Okou-darwin-arm64-${version}.zip`;
  }

  function appcastRequest() {
    return appRequest(
      "/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml",
    );
  }
  function countingManifestHandler(respond: (attempt: number) => Response): {
    readonly attempts: () => number;
  } {
    let attempts = 0;
    server.use(
      http.get(OKOU_DESKTOP_UPDATE_MANIFEST_URL, () => {
        attempts += 1;
        return respond(attempts);
      }),
    );
    return {
      attempts: () => {
        return attempts;
      },
    };
  }
  return {
    client,
    appcastRequest,
    countingManifestHandler,
    appRequest,
    mockDesktopUpdateManifest,
    stableManifest,
    darwinArm64Release,
    okouZipUrl,
    OKOU_DESKTOP_UPDATE_MANIFEST_URL,
    LEGACY_OKOU_DESKTOP_UPDATE_MANIFEST_URL,
  };
}
