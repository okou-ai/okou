import { desktopUpdatesContract } from "@okouai/api-contracts/contracts/desktop-updates";
import { testDesktopUpdateManifestStateContract } from "@okouai/api-contracts/contracts/test-desktop-update-manifest-state";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { desktopUpdateRoutes } from "../desktop-updates";
import { testDesktopUpdateManifestStateRoutes } from "../test-desktop-update-manifest-state";

const TEST_APP_ROUTES = Object.freeze([...desktopUpdateRoutes]);

const context = testContext();
const OKOU_DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/vm0-ai/vm0/releases/download/ai-okou-desktop-updates/ai-okou-desktop-update-manifest.json";
const LEGACY_OKOU_DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-updates/okou-desktop-update-manifest.json";

interface DesktopUpdateRelease {
  readonly version: string;
  readonly name?: string;
  readonly notes?: string;
  readonly pubDate: string;
  readonly platforms: Record<string, Record<string, { readonly url: string }>>;
}

interface DesktopUpdateManifest {
  readonly schemaVersion: 1;
  readonly product?: "okou";
  readonly channels: Record<
    string,
    { readonly latest: string; readonly blocked?: readonly string[] }
  >;
  readonly releases: Record<string, DesktopUpdateRelease>;
}

function client() {
  return setupApp({ context, routes: desktopUpdateRoutes })(
    desktopUpdatesContract,
  );
}

function manifestStateClient() {
  return setupApp({ context, routes: testDesktopUpdateManifestStateRoutes })(
    testDesktopUpdateManifestStateContract,
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
  return `https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v${version}/Okou-darwin-arm64-${version}.zip`;
}

describe("desktop update routes", () => {
  beforeEach(async () => {
    await accept(manifestStateClient().reset({ body: {} }), [200]);
  });

  it("serves the no-store hard Zero migration policy", async () => {
    const response = await appRequest(
      "http://api.test/api/desktop/migration-policy",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toStrictEqual({
      schemaVersion: 1,
      mode: "hard",
    });
  });

  // The neutral release and DMG routes must serve the current
  // `ai-okou-desktop` line. Both Okou manifests are mocked at different
  // versions, so reading the wrong one resolves to the wrong release. Every
  // expectation is explicit rather than derived from the path under test.
  //
  // The unqualified DMG route is what the Zero migration wall's `Download Okou`
  // button opens and what the bridge compiled into installed Zero builds
  // hard-codes, so this case guards a live migration dependency.
  it("serves the current Okou desktop line on the neutral routes", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.12.0", {
        "0.12.0": darwinArm64Release("0.12.0", okouZipUrl("0.12.0")),
      }),
      LEGACY_OKOU_DESKTOP_UPDATE_MANIFEST_URL,
    );
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
      }),
    );

    const releaseResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/release",
    );

    expect(releaseResponse.status).toBe(302);
    expect(releaseResponse.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/tag/okou-desktop-v1.2.3",
    );
    expect(releaseResponse.headers.get("Cache-Control")).toBe("no-store");

    const dmgResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );

    expect(dmgResponse.status).toBe(302);
    expect(dmgResponse.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
    );
    expect(dmgResponse.headers.get("Cache-Control")).toBe("no-store");
  });

  it("caches the desktop manifest until the 60-second ttl expires", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("0.2.1", {
          "0.2.1": darwinArm64Release("0.2.1", okouZipUrl("0.2.1")),
        }),
      );

      const firstResponse = await accept(
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
      expect(firstResponse.body.currentRelease).toBe("0.2.1");

      mockDesktopUpdateManifest(
        stableManifest("0.2.2", {
          "0.2.2": darwinArm64Release("0.2.2", okouZipUrl("0.2.2")),
        }),
      );
      mockNow(initialNow + 59_999);

      const cachedResponse = await accept(
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
      expect(cachedResponse.body.currentRelease).toBe("0.2.1");

      mockNow(initialNow + 60_000);

      const refreshedResponse = await accept(
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
      expect(refreshedResponse.body.currentRelease).toBe("0.2.2");
    });
  });

  it("serves an Okou release only from the isolated Okou manifest", async () => {
    const zipUrl = okouZipUrl("1.2.3");
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release("1.2.3", zipUrl),
      }),
    );

    const response = await accept(
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

    expect(response.body).toStrictEqual({
      currentRelease: "1.2.3",
      releases: [
        {
          version: "1.2.3",
          updateTo: {
            name: "Okou 1.2.3",
            version: "1.2.3",
            pub_date: "2026-06-08T00:00:00.000Z",
            url: zipUrl,
            notes: "Release 1.2.3",
          },
        },
      ],
    });
  });

  it("redirects the final Okou line to final-identity release assets", async () => {
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
      }),
    );

    const releaseResponse = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/release",
    );
    expect(releaseResponse.status).toBe(302);
    expect(releaseResponse.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/tag/okou-desktop-v1.2.3",
    );

    const dmgResponse = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/dmg",
    );
    expect(dmgResponse.status).toBe(302);
    expect(dmgResponse.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
    );
  });

  it("does not serve a Zero artifact from the final Okou feed", async () => {
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release(
          "1.2.3",
          "https://github.com/vm0-ai/vm0/releases/download/desktop-v1.2.3/Zero-darwin-arm64-1.2.3.zip",
        ),
      }),
    );

    const response = await accept(
      client().productFeed({
        params: {
          product: "ai-okou-desktop",
          channel: "stable",
          platform: "darwin",
          arch: "arm64",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("does not return a blocked latest release", async () => {
    const previousUrl = okouZipUrl("0.2.1");
    mockDesktopUpdateManifest(
      stableManifest(
        "0.2.2",
        {
          "0.2.1": darwinArm64Release("0.2.1", previousUrl),
          "0.2.2": darwinArm64Release("0.2.2", okouZipUrl("0.2.2")),
          "0.3.0": darwinArm64Release("0.3.0", okouZipUrl("0.3.0")),
        },
        ["0.2.2"],
      ),
    );

    const response = await accept(
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

    expect(response.body.currentRelease).toBe("0.2.1");
    expect(response.body.releases[0]?.updateTo.url).toBe(previousUrl);
  });

  it("returns not found when the manifest has no matching asset", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.2.1", {
        "0.2.1": {
          version: "0.2.1",
          pubDate: "2026-06-08T00:00:00.000Z",
          platforms: {
            darwin: {},
          },
        },
      }),
    );

    const response = await accept(
      client().productFeed({
        params: {
          product: "ai-okou-desktop",
          channel: "stable",
          platform: "darwin",
          arch: "arm64",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  // The manifest lives on a host we do not control. A request that only
  // failed to read it must not look like "no release exists": a Squirrel
  // updater treats 404 as up to date and the migration wall's download button
  // would dead-end. The cases below pin that separation, and pin that a
  // genuinely broken manifest still fails loudly.
  function feedRequest() {
    return client().productFeed({
      params: {
        product: "ai-okou-desktop",
        channel: "stable",
        platform: "darwin",
        arch: "arm64",
      },
    });
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

  it("still serves a release after transient upstream failures", async () => {
    const upstream = countingManifestHandler((attempt) => {
      if (attempt < 3) {
        return new HttpResponse(null, { status: 502 });
      }
      return HttpResponse.json(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
    });

    const response = await accept(feedRequest(), [200]);

    expect(response.body.currentRelease).toBe("1.2.3");
    expect(upstream.attempts()).toBe(3);
    // Absorbed, so it must not reach the error channel that pages a human.
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("stops retrying at the attempt bound and reports the feed as unavailable", async () => {
    const upstream = countingManifestHandler(() => {
      return new HttpResponse(null, { status: 500 });
    });

    const response = await accept(feedRequest(), [503]);

    expect(response.body.error.code).toBe("DESKTOP_UPDATE_UNAVAILABLE");
    expect(upstream.attempts()).toBe(3);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("keeps an unavailable feed uncacheable and tells the caller to retry", async () => {
    countingManifestHandler(() => {
      return HttpResponse.error();
    });

    const response = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("bounds each attempt so a hanging upstream cannot hold the request", async () => {
    // A real deadline would make this test wait for it. Firing it immediately
    // proves the same thing that matters: the fetch is bound to a deadline
    // signal, and tripping it is retried and then reported as unavailable
    // rather than surfacing as an unhandled error.
    context.mocks.abortSignal.timeout.mockImplementation(() => {
      const controller = new AbortController();
      controller.abort(
        new DOMException("The operation timed out", "TimeoutError"),
      );
      return controller.signal;
    });
    countingManifestHandler(() => {
      return HttpResponse.json(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
    });

    const response = await accept(feedRequest(), [503]);

    expect(response.body.error.code).toBe("DESKTOP_UPDATE_UNAVAILABLE");
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("reports every manifest-backed route as unavailable, including the wall's download", async () => {
    countingManifestHandler(() => {
      return HttpResponse.error();
    });

    const feedResponse = await accept(feedRequest(), [503]);
    expect(feedResponse.body.error.code).toBe("DESKTOP_UPDATE_UNAVAILABLE");

    // The redirect routes read the same manifest, so they share the status.
    // This one is the migration wall's `Download Okou` target.
    const dmgResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );
    expect(dmgResponse.status).toBe(503);

    const releaseResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/release",
    );
    expect(releaseResponse.status).toBe(503);

    const productDmgResponse = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/dmg",
    );
    expect(productDmgResponse.status).toBe(503);

    const productReleaseResponse = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/release",
    );
    expect(productReleaseResponse.status).toBe(503);
  });

  it("serves the cached release while the manifest host is unreachable", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );

      const warmed = await accept(feedRequest(), [200]);
      expect(warmed.body.currentRelease).toBe("1.2.3");

      countingManifestHandler(() => {
        return HttpResponse.error();
      });
      mockNow(initialNow + 30 * 60_000 - 1);

      const stale = await accept(feedRequest(), [200]);

      expect(stale.body.currentRelease).toBe("1.2.3");
    });
  });

  // The window is anchored to the fetch, so a run of stale hits cannot renew
  // it. Without that, a long outage would serve one manifest forever and a
  // blocked release would keep being offered.
  it("expires the cached release instead of renewing it on each stale hit", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
      await accept(feedRequest(), [200]);

      countingManifestHandler(() => {
        return HttpResponse.error();
      });

      for (const minutes of [10, 20, 29]) {
        mockNow(initialNow + minutes * 60_000);
        const stale = await accept(feedRequest(), [200]);
        expect(stale.body.currentRelease).toBe("1.2.3");
      }

      mockNow(initialNow + 30 * 60_000);
      const expired = await accept(feedRequest(), [503]);

      expect(expired.body.error.code).toBe("DESKTOP_UPDATE_UNAVAILABLE");
    });
  });

  it("does not serve stale after retries carry it past the stale deadline", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
      await accept(feedRequest(), [200]);

      mockNow(initialNow + 30 * 60_000 - 1);
      countingManifestHandler(() => {
        // The retry began inside the stale window, but completes after it.
        // The service must evaluate stale eligibility when it is about to
        // answer, not when the request started.
        mockNow(initialNow + 30 * 60_000);
        return HttpResponse.error();
      });

      const response = await accept(feedRequest(), [503]);

      expect(response.body.error.code).toBe("DESKTOP_UPDATE_UNAVAILABLE");
    });
  });

  it("keeps the cached release usable across a failed refresh", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
      await accept(feedRequest(), [200]);

      countingManifestHandler(() => {
        return HttpResponse.error();
      });
      mockNow(initialNow + 5 * 60_000);
      await accept(feedRequest(), [200]);

      // A failed refresh must not evict or age the entry, and a later success
      // must replace it outright rather than merge with it.
      mockDesktopUpdateManifest(
        stableManifest("1.2.4", {
          "1.2.4": darwinArm64Release("1.2.4", okouZipUrl("1.2.4")),
        }),
      );
      mockNow(initialNow + 10 * 60_000);
      const refreshed = await accept(feedRequest(), [200]);

      expect(refreshed.body.currentRelease).toBe("1.2.4");
    });
  });

  it("fails loudly when the manifest is missing or unreadable", async () => {
    const missing = countingManifestHandler(() => {
      return new HttpResponse(null, { status: 404 });
    });

    const missingResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );

    expect(missingResponse.status).toBe(500);
    // A manifest our own release pipeline publishes is not an outage, so it
    // is neither retried nor downgraded.
    expect(missing.attempts()).toBe(1);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Desktop update manifest fetch failed with 404",
      }),
    );

    countingManifestHandler(() => {
      return HttpResponse.json({ schemaVersion: 1 });
    });

    const invalidResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );
    expect(invalidResponse.status).toBe(500);
  });

  // Invalid JSON is not an unreadable host. The bytes arrived and they are not
  // a manifest, so it must not be retried, absorbed, or answered from cache.
  it("fails loudly when the manifest body is not json", async () => {
    const upstream = countingManifestHandler(() => {
      return new HttpResponse("not-a-manifest", {
        headers: { "content-type": "application/json" },
      });
    });

    const response = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json",
    );

    expect(response.status).toBe(500);
    expect(upstream.attempts()).toBe(1);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: "SyntaxError" }),
    );
  });

  // A cached manifest must not paper over a broken release: the loud failures
  // above stay loud even when an older copy is sitting in the cache.
  it("does not answer a broken manifest from the cache", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
      await accept(feedRequest(), [200]);

      countingManifestHandler(() => {
        return new HttpResponse(null, { status: 404 });
      });
      mockNow(initialNow + 5 * 60_000);

      const response = await appRequest(
        "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json",
      );

      expect(response.status).toBe(500);
    });
  });

  it("returns not found when no dmg release is available", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.11.2", {
        "0.11.2": darwinArm64Release("0.11.2", okouZipUrl("0.11.2")),
      }),
    );

    const response = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );

    expect(response.status).toBe(404);
  });
});
