import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import worker from "./index";
import { fetchWorker } from "./test-helpers";

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const deploymentId = "00000000-0000-4000-8000-000000000009";
const token = "a".repeat(48);
const origin = `https://pv-${token}.okou.app`;
const prefix = `private-sites/okou/${deploymentId}`;
const grantKey = `private-previews/okou/${token}.json`;
const server = setupServer();
beforeAll(() => {
  return server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  return server.resetHandlers();
});
afterAll(() => {
  return server.close();
});

function fixture(immutableContent = true) {
  const files = {
    "/index.html": ["<h1>Private report</h1>", "text/html"],
    "/assets/site.css": ["h1 { color: green }", "text/css"],
    "/assets/app.js": ["window.loaded = true", "application/javascript"],
    "/assets/image.svg": [
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      "image/svg+xml",
    ],
    "/nested/page.html": ["<h1>Private nested page</h1>", "text/html"],
    "/download.csv": ["name,value\nprivate,1", "text/csv"],
  };
  const manifest = {
    version: 1,
    ...(immutableContent ? { immutableContent: true } : {}),
    publicBrand: "okou",
    access: "owner-private-v1",
    siteId: "site",
    deploymentId,
    publicSlug: "private-report",
    spaFallback: true,
    files: Object.fromEntries(
      Object.entries(files).map(([path, [body, contentType]]) => {
        return [
          path,
          {
            path,
            size: body!.length,
            sha256: "a".repeat(64),
            contentType,
            immutable: true,
          },
        ];
      }),
    ),
  };
  const grant = {
    version: 1,
    ...(immutableContent ? { immutableContent: true } : {}),
    publicBrand: "okou",
    deploymentId,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const objects = new Map<string, string>([
    [grantKey, JSON.stringify(grant)],
    [`${prefix}/manifest.json`, JSON.stringify(manifest)],
    ...Object.entries(files).map(([path, [body]]) => {
      return [`${prefix}${path}`, body!] as const;
    }),
  ]);
  const reads: string[] = [];
  const objectHeaders = new Headers();
  const env: WorkerEnv = {
    HOST_DOMAIN: "sites.vm0.io",
    OKOU_HOST_DOMAIN: "okou.app",
    HOSTED_SITES_BUCKET: {
      head: async (key) => {
        const body = objects.get(key);
        return body === undefined
          ? null
          : {
              size: new TextEncoder().encode(body).length,
              httpEtag: '"private-test"',
            };
      },
      get: async (key) => {
        reads.push(key);
        const body = objects.get(key);
        return body === undefined
          ? null
          : {
              size: new TextEncoder().encode(body).length,
              body: new Response(body).body!,
              httpEtag: '"private-test"',
              writeHttpMetadata(headers) {
                headers.set("Content-Type", "application/octet-stream");
                objectHeaders.forEach((value, name) => {
                  headers.set(name, value);
                });
              },
            };
      },
    },
  };
  return { env, objects, reads, grant, manifest, files, objectHeaders };
}

describe("private HTML preview gateway", () => {
  it("enforces Site policy before preview assets and disables long browser caching", async () => {
    const f = fixture();
    const env = {
      ...f.env,
      HOSTED_SITE_API_ORIGIN: "https://authority.test",
      HOSTED_SITE_ACCESS_ENABLED: "true",
    };
    let allowed = true;
    server.use(
      http.get("https://authority.test/api/host/sites/site/access", () => {
        return HttpResponse.json(
          allowed
            ? { allowed: true, decision: "allow" }
            : { allowed: false, decision: "deny" },
        );
      }),
    );
    const first = await fetchWorker(
      new Request(`${origin}/assets/site.css`),
      env,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    allowed = false;
    f.reads.length = 0;
    expect(
      (await fetchWorker(new Request(`${origin}/assets/site.css`), env)).status,
    ).toBe(404);
    expect(f.reads).not.toContain(`${prefix}/assets/site.css`);
  });

  it("preserves preview credentials and asset caching before activation when the API is unavailable", async () => {
    const f = fixture();
    server.use(
      http.get("https://authority.test/*", () => {
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const env = { ...f.env, HOSTED_SITE_API_ORIGIN: "https://authority.test" };
    const response = await fetchWorker(
      new Request(`${origin}/assets/site.css`),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=31536000, must-revalidate",
    );
    f.grant.expiresAt = "2000-01-01T00:00:00.000Z";
    f.objects.set(grantKey, JSON.stringify(f.grant));
    expect(
      (await fetchWorker(new Request(`${origin}/assets/site.css`), env)).status,
    ).toBe(404);
  });

  it("serves every bundled resource and navigation with a deployment credential, without cookies", async () => {
    const { env, files } = fixture();
    for (const [path, [body, contentType]] of Object.entries(files)) {
      const response = await fetchWorker(new Request(`${origin}${path}`), env);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(contentType);
      // Documents follow their site's newest publication; assets never change.
      expect(response.headers.get("Cache-Control")).toBe(
        contentType === "text/html"
          ? "private, no-store"
          : "private, max-age=31536000, must-revalidate",
      );
      expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "worker-src 'none'",
      );
      expect(response.headers.has("Set-Cookie")).toBe(false);
      expect(await response.text()).toBe(body);
    }
    const navigation = await fetchWorker(
      new Request(`${origin}/nested/route`, {
        headers: { Accept: "text/html" },
      }),
      env,
    );
    expect(await navigation.text()).toBe(files["/index.html"][0]);
    const missingAsset = await fetchWorker(
      new Request(`${origin}/assets/missing.js`, {
        headers: { Accept: "*/*" },
      }),
      env,
    );
    expect(missingAsset.status).toBe(404);
    expect(missingAsset.headers.get("cache-control")).toBe("private, no-store");
    const head = await fetchWorker(
      new Request(`${origin}/index.html`, { method: "HEAD" }),
      env,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await head.text()).toBe("");
  });

  it("keeps legacy deployment content uncacheable", async () => {
    const { env, files } = fixture(false);
    for (const path of Object.keys(files)) {
      const response = await fetchWorker(new Request(`${origin}${path}`), env);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("does not trust a legacy upload's manifest to enable browser caching", async () => {
    const { env, objects, manifest } = fixture(false);
    // Legacy uploads could target /manifest.json; only the server-issued
    // grant can attest that all upload credentials were checksum-bound.
    objects.set(
      `${prefix}/manifest.json`,
      JSON.stringify({ ...manifest, immutableContent: true }),
    );
    const response = await fetchWorker(new Request(`${origin}/`), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("does not let upload metadata change immutable content delivery", async () => {
    const { env, files, objectHeaders } = fixture();
    objectHeaders.set("Content-Encoding", "gzip");
    objectHeaders.set("Content-Disposition", "attachment");
    objectHeaders.set("Cache-Control", "public, max-age=31536000");
    const response = await fetchWorker(new Request(`${origin}/`), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.has("Content-Encoding")).toBe(false);
    expect(response.headers.has("Content-Disposition")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toBe(files["/index.html"][0]);
    const asset = await fetchWorker(
      new Request(`${origin}/assets/site.css`),
      env,
    );
    expect(asset.headers.has("Content-Encoding")).toBe(false);
    expect(asset.headers.get("Cache-Control")).toBe(
      "private, max-age=31536000, must-revalidate",
    );
  });

  it("does not cache a missing object from an immutable manifest", async () => {
    const { env, objects } = fixture();
    objects.delete(`${prefix}/assets/site.css`);
    const response = await fetchWorker(
      new Request(`${origin}/assets/site.css`),
      env,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rechecks an expired credential on network requests after a successful request", async () => {
    const { env, objects, reads, grant } = fixture();
    const first = await fetchWorker(
      new Request(`${origin}/assets/site.css`),
      env,
    );
    expect(first.status).toBe(200);
    await first.text();
    objects.set(
      grantKey,
      JSON.stringify({ ...grant, expiresAt: "2000-01-01T00:00:00.000Z" }),
    );
    reads.length = 0;
    for (const path of [
      "/",
      "/assets/site.css",
      "/assets/app.js",
      "/assets/image.svg",
      "/nested/route",
      "/download.csv",
    ]) {
      const denied = await fetchWorker(
        new Request(`${origin}${path}`, {
          headers: { "If-None-Match": '"private-test"' },
        }),
        env,
      );
      expect(denied.status).toBe(404);
      expect(denied.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(
      reads.every((key) => {
        return key === grantKey;
      }),
    ).toBe(true);
  });

  it.each([
    { version: 2 },
    { publicBrand: "vm0" },
    { expiresAt: "invalid" },
    { deploymentId: "../other" },
  ])(
    "rejects invalid credentials %j without reading content",
    async (invalid) => {
      const { env, objects, reads, grant } = fixture();
      objects.set(grantKey, JSON.stringify({ ...grant, ...invalid }));
      const response = await fetchWorker(new Request(`${origin}/`), env);
      expect(response.status).toBe(404);
      expect(reads).toEqual([grantKey]);
    },
  );

  it("serves previews issued in the legacy layout on the legacy host", async () => {
    const { env, objects, grant, manifest } = fixture();
    const legacyPrefix = `private-sites/vm0/${deploymentId}`;
    objects.clear();
    objects.set(
      `private-previews/vm0/${token}.json`,
      JSON.stringify({ ...grant, publicBrand: "vm0" }),
    );
    objects.set(
      `${legacyPrefix}/manifest.json`,
      JSON.stringify({ ...manifest, publicBrand: "vm0" }),
    );
    objects.set(`${legacyPrefix}/index.html`, "<h1>Legacy report</h1>");

    const legacy = await fetchWorker(
      new Request(`https://pv-${token}.sites.vm0.io/`),
      env,
    );
    const current = await fetchWorker(new Request(`${origin}/`), env);

    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toBe("<h1>Legacy report</h1>");
    expect(current.status).toBe(404);
  });

  it("denies reconstructed aliases, immutable URLs, raw storage paths, wrong tokens and hosts", async () => {
    const { env } = fixture();
    for (const url of [
      "https://private-report.okou.app/",
      `https://dpl-${deploymentId}.okou.app/`,
      `https://private-report.okou.app/${prefix}/index.html`,
      `https://pv-${"b".repeat(48)}.okou.app/`,
      `https://pv-${token}.sites.vm0.io/`,
      `${origin}/../private-sites/okou/other/index.html`,
    ]) {
      const response = await fetchWorker(new Request(url), env);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Private report");
    }
  });

  it.each(["null", "{invalid", "[]", "42"])(
    "rejects malformed stored credentials %s without reading content",
    async (stored) => {
      const { env, objects, reads } = fixture();
      objects.set(grantKey, stored);
      const response = await fetchWorker(new Request(`${origin}/`), env);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(reads).toEqual([grantKey]);
    },
  );

  it("preserves an existing public alias with the preview hostname shape", async () => {
    const { env, objects, manifest } = fixture();
    objects.delete(grantKey);
    const publicPrefix = "sites/public-report/v1";
    const publicManifest = { ...manifest, access: undefined };
    objects.set(
      `${publicPrefix}/manifest.json`,
      JSON.stringify(publicManifest),
    );
    objects.set(
      `${publicPrefix}/index.html`,
      "<h1>Existing public report</h1>",
    );
    objects.set(
      `sites/brands/okou/pv-${token}/active.json`,
      JSON.stringify({
        version: 1,
        publicBrand: "okou",
        publicSlug: `pv-${token}`,
        siteId: "site",
        deploymentId,
        prefix: publicPrefix,
        manifestKey: `${publicPrefix}/manifest.json`,
        spaFallback: true,
      }),
    );
    const response = await fetchWorker(new Request(`${origin}/`), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>Existing public report</h1>");
  });

  it("refuses a private manifest even if a public pointer is accidentally written", async () => {
    const { env, objects } = fixture();
    const pointer = {
      version: 1,
      publicBrand: "okou",
      publicSlug: "private-report",
      siteId: "site",
      deploymentId,
      prefix,
      manifestKey: `${prefix}/manifest.json`,
      spaFallback: true,
    };
    objects.set(
      "sites/brands/okou/private-report/active.json",
      JSON.stringify(pointer),
    );
    objects.set(
      `sites/brands/okou/deployments/${deploymentId}.json`,
      JSON.stringify(pointer),
    );
    for (const hostname of ["private-report", `dpl-${deploymentId}`]) {
      expect(
        (await fetchWorker(new Request(`https://${hostname}.okou.app/`), env))
          .status,
      ).toBe(404);
    }
  });
});

describe("Site preview resource capabilities", () => {
  function capabilityFixture() {
    const f = fixture();
    const siteId = "00000000-0000-4000-8000-000000000008";
    const grant = { ...f.grant, version: 2, siteId, prefix };
    const manifest = { ...f.manifest, siteId };
    f.objects.set(grantKey, JSON.stringify(grant));
    f.objects.set(`${prefix}/manifest.json`, JSON.stringify(manifest));
    return {
      ...f,
      grant,
      manifest,
      env: {
        ...f.env,
        HOSTED_SITE_ACCESS_ENABLED: "true",
        HOSTED_SITE_API_ORIGIN: "https://authority.test",
      },
    };
  }

  it("renders an isolated iframe and its assets without a browser session", async () => {
    const f = capabilityFixture();
    for (const path of [
      "/",
      "/assets/site.css",
      "/assets/app.js",
      "/assets/image.svg",
    ]) {
      const response = await fetchWorker(
        new Request(`${origin}${path}`, {
          headers: {
            "Sec-Fetch-Dest": path === "/" ? "iframe" : "script",
            "Sec-Fetch-Site": "cross-site",
          },
        }),
        f.env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe(
        path === "/"
          ? "private, no-store"
          : "private, max-age=31536000, must-revalidate",
      );
      expect(await response.text()).toContain(
        path === "/"
          ? "Private report"
          : f.files[path as keyof typeof f.files][0],
      );
    }
    const head = await fetchWorker(
      new Request(`${origin}/assets/app.js`, { method: "HEAD" }),
      f.env,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("serves an API-issued public-publication target through the isolated preview origin", async () => {
    const f = capabilityFixture();
    const publication = `sites/brands/okou/publications/${deploymentId}`;
    for (const [key, value] of f.objects) {
      if (key.startsWith(prefix))
        f.objects.set(key.replace(prefix, publication), value);
    }
    f.objects.set(
      `${publication}/manifest.json`,
      JSON.stringify({ ...f.manifest, access: undefined }),
    );
    f.objects.set(
      grantKey,
      JSON.stringify({ ...f.grant, prefix: publication }),
    );
    const response = await fetchWorker(new Request(`${origin}/`), f.env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Private report");
  });

  it("checks credential expiry before serving a previously read resource", async () => {
    const f = capabilityFixture();
    expect(
      (await fetchWorker(new Request(`${origin}/assets/app.js`), f.env)).status,
    ).toBe(200);
    f.objects.set(
      grantKey,
      JSON.stringify({ ...f.grant, expiresAt: "2000-01-01T00:00:00Z" }),
    );
    const response = await fetchWorker(
      new Request(`${origin}/assets/app.js`),
      f.env,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("does not authorize another deployment's manifest", async () => {
    const f = capabilityFixture();
    f.objects.set(
      grantKey,
      JSON.stringify({
        ...f.grant,
        siteId: "00000000-0000-4000-8000-000000000007",
      }),
    );
    const response = await fetchWorker(new Request(`${origin}/`), f.env);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Private report");
  });
});
