import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, Response } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const siteId = "00000000-0000-4000-8000-000000000001";
const deploymentId = "00000000-0000-4000-8000-000000000002";
const brandImage = "https://static.okou.io/web/okou-og-image-373c892e.png";
const body = '<body><img src="cover.png">Public report</body>';
const hostedHtml =
  "<!doctype html><html><head><title>Authored report</title>" +
  '<meta property="og:image" content="cover.png">' +
  '<meta name="twitter:image" content="cover.png"></head>' +
  body +
  "</html>";
const metadata = {
  available: true,
  title: "Published report",
  description: "Published summary",
  imageUrl: "https://api.okou.ai/api/artifact-og/image?version=published",
  url: "https://app.okou.ai/artifacts/abc123abcd.html",
};
const workers = {
  host: {
    entry: 'export { default } from "./apps/host-worker/src/index.ts";',
    compatibilityDate: "2026-05-13",
    compatibilityFlags: ["enable_request_signal"],
    url: "https://demo.okou.app/",
  },
  app: {
    entry: `import { createWorker } from "./apps/app-worker/src/worker.js";
      import indexHtml from "./apps/platform/index.html";
      export default createWorker({ indexHtml });`,
    compatibilityDate: "2026-09-02",
    compatibilityFlags: ["global_fetch_strictly_public"],
    url: "https://app.okou.ai/artifacts/abc123abcd.html",
  },
};
const scripts = new Map();

before(async () => {
  for (const [name, worker] of Object.entries(workers)) {
    const result = await build({
      stdin: { contents: worker.entry, resolveDir: root },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      loader: { ".html": "text" },
    });
    scripts.set(name, result.outputFiles[0].text);
  }
});

async function createRuntime(t, name, outboundService, authorize = false) {
  const directory = await mkdtemp(join(tmpdir(), "artifact-og-workers-"));
  const worker = workers[name];
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name,
      script: scripts.get(name),
      modules: true,
      compatibilityDate: worker.compatibilityDate,
      compatibilityFlags: worker.compatibilityFlags,
      cf: false,
      telemetry: { enabled: false },
      resourcePersistencePath: directory,
      r2Buckets: name === "host" ? ["HOSTED_SITES_BUCKET"] : [],
      bindings: {
        HOST_DOMAIN: "sites.vm0.io",
        OKOU_HOST_DOMAIN: "okou.app",
        ARTIFACT_OG_API_ORIGIN: "https://api.okou.ai",
        ...(authorize ? { HOSTED_SITE_API_ORIGIN: "https://api.okou.ai" } : {}),
      },
      // Intercept the API boundary, leaving workerd's native fetch intact.
      outboundService,
    }),
  );
  t.after(async () => {
    try {
      await runtime.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  if (name === "host") {
    const bucket = await runtime.getR2Bucket("HOSTED_SITES_BUCKET");
    const prefix = `sites/brands/okou/publications/${deploymentId}`;
    const pointerKey = "sites/brands/okou/demo/active.json";
    const manifestKey = `${prefix}/manifest.json`;
    await bucket.put(
      "artifact-delivery/okou/html/demo.json",
      JSON.stringify({
        version: 1,
        kind: "legacy-site",
        publicBrand: "okou",
        audience: "public",
        pointerKey,
      }),
    );
    const pointer = {
      version: 1,
      publicBrand: "okou",
      publicSlug: "demo",
      siteId,
      deploymentId,
      prefix,
      manifestKey,
      spaFallback: false,
      updatedAt: "2026-10-10T00:00:00Z",
    };
    await bucket.put(pointerKey, JSON.stringify(pointer));
    await bucket.put(
      manifestKey,
      JSON.stringify({
        version: 1,
        immutableContent: true,
        publicBrand: "okou",
        publicSlug: "demo",
        siteId,
        deploymentId,
        createdAt: pointer.updatedAt,
        spaFallback: false,
        files: {
          "/index.html": {
            path: "/index.html",
            contentType: "text/html; charset=utf-8",
            size: Buffer.byteLength(hostedHtml),
            sha256: createHash("sha256").update(hostedHtml).digest("hex"),
          },
        },
      }),
    );
    await bucket.put(`${prefix}/index.html`, hostedHtml);
  }
  return runtime;
}

for (const [name, worker] of Object.entries(workers)) {
  test(`${name} Worker renders public artifact metadata in workerd`, async (t) => {
    const runtime = await createRuntime(t, name, (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.okou.ai");
      assert.equal(url.pathname, "/api/artifact-og/metadata");
      assert.equal(request.headers.get("Cookie"), null);
      assert.equal(request.headers.get("Authorization"), null);
      return Response.json(metadata);
    });
    const response = await runtime.dispatchFetch(worker.url, {
      headers: { Cookie: "owner-session", Authorization: "Bearer owner-token" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const html = await response.text();
    assert.ok(html.includes('property="og:title" content="Published report"'));
    const imageUrl =
      name === "host" ? "https://demo.okou.app/cover.png" : metadata.imageUrl;
    assert.ok(html.includes(`property="og:image" content="${imageUrl}"`));
    assert.ok(html.includes(`name="twitter:image" content="${imageUrl}"`));
    if (name === "host") assert.ok(html.includes(body));
  });

  test(`${name} Worker uses the brand cover when previews are disabled`, async (t) => {
    const runtime = await createRuntime(t, name, () => {
      return Response.json({ available: false });
    });
    const response = await runtime.dispatchFetch(worker.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(`property="og:image" content="${brandImage}"`));
    assert.ok(html.includes(`name="twitter:image" content="${brandImage}"`));
    assert.ok(!html.includes(metadata.imageUrl));
    if (name === "host") assert.ok(html.includes(body));
  });

  for (const status of [302, 307]) {
    test(`${name} Worker rejects an OG ${status} without following it`, async (t) => {
      const runtime = await createRuntime(t, name, (request) => {
        if (new URL(request.url).hostname === "redirected.example") {
          return Response.json(metadata);
        }
        return new Response(null, {
          status,
          headers: { Location: "https://redirected.example/metadata" },
        });
      });
      const response = await runtime.dispatchFetch(worker.url);
      assert.equal(response.status, 200);
      const html = await response.text();
      if (name === "host") assert.equal(html, hostedHtml);
      else
        assert.ok(html.includes(`property="og:image" content="${brandImage}"`));
      assert.ok(!html.includes("Published report"));
    });
  }
}

for (const state of ["allowed", "denied", "redirect"]) {
  test(`Host Worker handles ${state} delivery authorization in workerd`, async (t) => {
    const runtime = await createRuntime(
      t,
      "host",
      (request) => {
        const url = new URL(request.url);
        if (url.hostname === "redirected.example")
          return Response.json({ allowed: true });
        if (url.pathname === `/api/host/delivery/${siteId}/${deploymentId}`) {
          return state === "redirect"
            ? new Response(null, {
                status: 302,
                headers: { Location: "https://redirected.example/authority" },
              })
            : Response.json({ allowed: state === "allowed" });
        }
        assert.equal(url.pathname, "/api/artifact-og/metadata");
        return Response.json(metadata);
      },
      true,
    );
    const response = await runtime.dispatchFetch(workers.host.url);
    assert.equal(
      response.status,
      state === "allowed" ? 200 : state === "denied" ? 404 : 503,
    );
    const html = await response.text();
    assert.equal(html.includes(body), state === "allowed");
  });
}
