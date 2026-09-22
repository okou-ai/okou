import { describe, expect, it } from "vitest";

import worker from "./index";
import { fetchWorker } from "./test-helpers";

type WorkerEnv = Parameters<typeof worker.fetch>[1];
type R2Object = NonNullable<
  Awaited<ReturnType<WorkerEnv["HOSTED_SITES_BUCKET"]["get"]>>
>;

interface TestFile {
  readonly body: string;
  readonly contentType: string;
}

type PublicBrand = "vm0" | "okou";

interface TestEnvOptions {
  readonly files?: Record<string, TestFile>;
  readonly publicBrand?: PublicBrand;
  readonly manifestPublicBrand?: PublicBrand;
  readonly hostDomain?: string;
  readonly okouHostDomain?: string;
  readonly immutableDeployment?: {
    readonly deploymentId: string;
    readonly body: string;
  };
}

const DEFAULT_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

function textStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function objectBody(body: string, contentType = "application/json"): R2Object {
  return {
    size: byteLength(body),
    body: textStream(body),
    httpEtag: '"test-etag"',
    writeHttpMetadata(headers: Headers): void {
      headers.set("Content-Type", contentType);
    },
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function env(options: TestEnvOptions = {}): WorkerEnv {
  const publicSlug = "demo";
  const deploymentId = "00000000-0000-4000-8000-000000000001";
  const pointerRoot =
    options.publicBrand === "okou" ? "sites/brands/okou" : "sites";
  const prefix = `sites/${publicSlug}/deployments/${deploymentId}`;
  const manifestKey = `${prefix}/manifest.json`;
  const files: Record<string, TestFile> = {
    "/index.html": {
      body: "<!doctype html>ok",
      contentType: "text/html; charset=utf-8",
    },
    ...options.files,
  };
  const manifestFiles = Object.fromEntries(
    Object.entries(files).map(([path, file]) => {
      return [
        path,
        {
          path,
          size: byteLength(file.body),
          sha256: "a".repeat(64),
          contentType: file.contentType,
        },
      ];
    }),
  );
  const fileObjects: [string, R2Object][] = Object.entries(files).map(
    ([path, file]) => {
      return [`${prefix}${path}`, objectBody(file.body, file.contentType)];
    },
  );
  const objects = new Map<string, R2Object>([
    [
      `${pointerRoot}/${publicSlug}/active.json`,
      objectBody(
        JSON.stringify({
          version: 1,
          ...(options.publicBrand ? { publicBrand: options.publicBrand } : {}),
          publicSlug,
          siteId: "site_1",
          deploymentId,
          prefix,
          manifestKey,
          spaFallback: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ],
    [
      manifestKey,
      objectBody(
        JSON.stringify({
          version: 1,
          ...((options.manifestPublicBrand ?? options.publicBrand)
            ? {
                publicBrand: options.manifestPublicBrand ?? options.publicBrand,
              }
            : {}),
          deploymentId,
          siteId: "site_1",
          publicSlug,
          createdAt: "2026-01-01T00:00:00.000Z",
          spaFallback: false,
          files: manifestFiles,
        }),
      ),
    ],
    ...fileObjects,
  ]);

  if (options.immutableDeployment) {
    const immutable = options.immutableDeployment;
    const immutablePrefix = `sites/orgs/org_test/demo/versions/1`;
    const immutableManifestKey = `${immutablePrefix}/manifest.json`;
    objects.set(
      `${pointerRoot}/deployments/${immutable.deploymentId}.json`,
      objectBody(
        JSON.stringify({
          version: 1,
          ...(options.publicBrand ? { publicBrand: options.publicBrand } : {}),
          publicSlug,
          siteId: "site_1",
          deploymentId: immutable.deploymentId,
          deploymentVersion: 1,
          artifactUrl: `https://dpl-${immutable.deploymentId}.${
            options.publicBrand === "okou" ? "okou.app" : "sites.vm0.io"
          }`,
          prefix: immutablePrefix,
          manifestKey: immutableManifestKey,
          spaFallback: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    objects.set(
      immutableManifestKey,
      objectBody(
        JSON.stringify({
          version: 1,
          ...((options.manifestPublicBrand ?? options.publicBrand)
            ? {
                publicBrand: options.manifestPublicBrand ?? options.publicBrand,
              }
            : {}),
          deploymentId: immutable.deploymentId,
          deploymentVersion: 1,
          siteId: "site_1",
          site: "demo",
          publicSlug,
          createdAt: "2026-01-01T00:00:00.000Z",
          spaFallback: false,
          files: {
            "/index.html": {
              path: "/index.html",
              size: byteLength(immutable.body),
              sha256: "b".repeat(64),
              contentType: "text/html; charset=utf-8",
            },
          },
        }),
      ),
    );
    objects.set(
      `${immutablePrefix}/index.html`,
      objectBody(immutable.body, "text/html; charset=utf-8"),
    );
  }

  return {
    HOST_DOMAIN: options.hostDomain ?? "sites.vm0.io",
    OKOU_HOST_DOMAIN: options.okouHostDomain ?? "okou.app",
    HOSTED_SITES_BUCKET: {
      head: async (key) => {
        return objects.get(key) ?? null;
      },
      get(key: string): Promise<R2Object | null> {
        return Promise.resolve(objects.get(key) ?? null);
      },
    },
  };
}

describe("hosted site worker", () => {
  it("allows the okou apex origin on preflight responses", async () => {
    const response = await fetchWorker(
      new Request("https://demo.sites.vm0.io/", {
        method: "OPTIONS",
        headers: { Origin: "https://okou.ai" },
      }),
      env(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://okou.ai",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD, OPTIONS",
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it.each([
    "https://okou.ai",
    "https://app.okou.ai",
    "https://staging-app.omby.ai",
  ])("allows product origin %s on hosted file responses", async (origin) => {
    const response = await fetchWorker(
      new Request("https://demo.sites.vm0.io/", {
        headers: { Origin: origin },
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("omits allow-origin for disallowed origins", async () => {
    const response = await fetchWorker(
      new Request("https://demo.sites.vm0.io/", {
        headers: { Origin: "https://attacker.example" },
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("marks hosted site responses as noindex", async () => {
    const response = await fetchWorker(
      new Request("https://demo.sites.vm0.io/"),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("does not expose legacy unbranded sites on the Okou domain", async () => {
    const response = await fetchWorker(
      new Request("https://demo.okou.app/"),
      env(),
    );

    expect(response.status).toBe(404);
  });

  it("serves Okou pointers only on the Okou domain", async () => {
    const workerEnv = env({ publicBrand: "okou" });

    const okouResponse = await fetchWorker(
      new Request("https://demo.okou.app/"),
      workerEnv,
    );
    const vm0Response = await fetchWorker(
      new Request("https://demo.sites.vm0.io/"),
      workerEnv,
    );

    expect(okouResponse.status).toBe(200);
    expect(await okouResponse.text()).toBe("<!doctype html>ok");
    expect(vm0Response.status).toBe(404);
  });

  it("rejects a manifest whose brand disagrees with its pointer", async () => {
    const response = await fetchWorker(
      new Request("https://demo.okou.app/"),
      env({ publicBrand: "okou", manifestPublicBrand: "vm0" }),
    );

    expect(response.status).toBe(404);
  });

  it("allows branded pointers on the shared preview host", async () => {
    const response = await fetchWorker(
      new Request("https://demo.sites.vm7.io/"),
      env({
        publicBrand: "okou",
        hostDomain: "sites.vm7.io",
        okouHostDomain: "sites.vm7.io",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>ok");
  });

  it("never caches documents while content-hashed assets stay immutable", async () => {
    // Every stored object streams once, so each request needs its own store.
    const site = () => {
      return env({
        files: {
          "/assets/app-4f3a9c12.js": {
            body: "window.loaded = true",
            contentType: "application/javascript; charset=utf-8",
          },
          "/nested/page.html": {
            body: "<!doctype html>nested",
            contentType: "text/html; charset=utf-8",
          },
        },
      });
    };
    for (const path of ["/", "/index.html", "/nested/page.html"]) {
      const document = await fetchWorker(
        new Request(`https://demo.sites.vm0.io${path}`),
        site(),
      );
      expect(document.status).toBe(200);
      expect(document.headers.get("Cache-Control")).toBe("no-store");
    }
    const asset = await fetchWorker(
      new Request("https://demo.sites.vm0.io/assets/app-4f3a9c12.js"),
      site(),
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("serves default robots.txt when the active deployment omits it", async () => {
    const response = await fetchWorker(
      new Request("https://demo.sites.vm0.io/robots.txt"),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe(DEFAULT_ROBOTS_TXT);
  });

  it("serves an uploaded robots.txt when present", async () => {
    const customRobots = "User-agent: *\nAllow: /\n";
    const response = await fetchWorker(
      new Request("https://demo.sites.vm0.io/robots.txt"),
      env({
        files: {
          "/robots.txt": {
            body: customRobots,
            contentType: "text/plain; charset=utf-8",
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(customRobots);
  });

  it("keeps immutable artifact hosts pinned when the alias points at a newer deployment", async () => {
    const immutableDeploymentId = "00000000-0000-4000-8000-000000000002";
    const workerEnv = env({
      immutableDeployment: {
        deploymentId: immutableDeploymentId,
        body: "<!doctype html>version one",
      },
    });

    const immutableResponse = await fetchWorker(
      new Request(
        `https://dpl-${immutableDeploymentId}.sites.vm0.io/index.html`,
      ),
      workerEnv,
    );
    const aliasResponse = await fetchWorker(
      new Request("https://demo.sites.vm0.io/index.html"),
      workerEnv,
    );

    expect(immutableResponse.status).toBe(200);
    expect(await immutableResponse.text()).toBe("<!doctype html>version one");
    expect(aliasResponse.status).toBe(200);
    expect(await aliasResponse.text()).toBe("<!doctype html>ok");
  });

  it("serves immutable Okou deployments only on the Okou domain", async () => {
    const immutableDeploymentId = "00000000-0000-4000-8000-000000000003";
    const workerEnv = env({
      publicBrand: "okou",
      immutableDeployment: {
        deploymentId: immutableDeploymentId,
        body: "<!doctype html>okou version",
      },
    });

    const okouResponse = await fetchWorker(
      new Request(`https://dpl-${immutableDeploymentId}.okou.app/`),
      workerEnv,
    );
    const vm0Response = await fetchWorker(
      new Request(`https://dpl-${immutableDeploymentId}.sites.vm0.io/`),
      workerEnv,
    );

    expect(okouResponse.status).toBe(200);
    expect(await okouResponse.text()).toBe("<!doctype html>okou version");
    expect(vm0Response.status).toBe(404);
  });
});
