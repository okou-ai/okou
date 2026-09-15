import {
  artifactDeliveryKey,
  artifactDeliveryRegistrationKey,
} from "@okouai/api-contracts/contracts/artifact-delivery";
import { afterEach, expect, test, vi, onTestFinished } from "vitest";
import { type ArtifactSharePolicy } from "@okouai/api-contracts/contracts/artifact-shares";
import worker from "./index";
import { fetchWorker, memoryCache } from "./test-helpers";

type Env = Parameters<typeof worker.fetch>[1];
const id = "00000000-0000-4000-8000-000000000010";
const fileId = "00000000-0000-4000-8000-000000000011";
const snapshotId = "00000000-0000-4000-8000-000000000012";
const siteId = "00000000-0000-4000-8000-000000000013";
const publicToken = "a".repeat(24);
const origin = `https://a.okou.io/${publicToken}.pdf`;
const siteOrigin = `https://${publicToken}.okou.app`;
const policyKey = `artifact-shares/okou/${id}.json`;

function fixture(html = false, extension = "pdf", token = publicToken) {
  const files = {
    "/index.html": {
      path: "/index.html",
      size: 16,
      sha256: "a",
      contentType: "text/html",
    },
    "/style.css": {
      path: "/style.css",
      size: 12,
      sha256: "b",
      contentType: "text/css",
    },
    "/app.js": {
      path: "/app.js",
      size: 8,
      sha256: "c",
      contentType: "application/javascript",
    },
    "/image.png": {
      path: "/image.png",
      size: 3,
      sha256: "d",
      contentType: "image/png",
    },
    "/download.csv": {
      path: "/download.csv",
      size: 3,
      sha256: "e",
      contentType: "text/csv",
    },
  };
  const policy: ArtifactSharePolicy = {
    version: 1,
    revision: snapshotId,
    shareId: id,
    ownerId: "owner",
    orgId: "org",
    publicBrand: "okou",
    audience: "public",
    status: "active",
    publicToken: token,
    target: html
      ? {
          kind: "html",
          id: fileId,
          siteId,
          snapshotId,
          deploymentVersion: 1,
          manifest: {
            version: 1,
            access: "owner-private-v1",
            publicBrand: "okou",
            deploymentId: fileId,
            siteId,
            publicSlug: "private-report",
            createdAt: "2026-09-08T00:00:00Z",
            spaFallback: true,
            files,
          },
        }
      : {
          kind: "file",
          id: fileId,
          key: `private-artifacts/${fileId}/shares/${snapshotId}/report.${extension}`,
          filename: `report.${extension}`,
          contentType: "application/pdf",
        },
  };
  const prefix = `shared-artifacts/okou/${snapshotId}/${fileId}`;
  const objects = new Map<string, string>([
    [policyKey, JSON.stringify(policy)],
    [
      artifactDeliveryKey(
        "okou",
        html ? "html" : "file",
        html ? token : `${token}.${extension}`,
      ),
      JSON.stringify({
        version: 1,
        kind: "publication",
        publicBrand: "okou",
        shareId: id,
        publicToken: token,
        targetKind: html ? "html" : "file",
      }),
    ],
  ]);
  if (policy.target.kind === "html") {
    objects.set(
      `${prefix}/manifest.json`,
      JSON.stringify(policy.target.manifest),
    );
    for (const path of Object.keys(files))
      objects.set(`${prefix}${path}`, `Content ${path}`);
  } else objects.set(policy.target.key, "Private PDF bytes");
  const reads: string[] = [];
  const bucket: Env["HOSTED_SITES_BUCKET"] = {
    head: async (key) => {
      const value = objects.get(key);
      return value === undefined
        ? null
        : { size: new TextEncoder().encode(value).length, httpEtag: '"file"' };
    },
    get: async (key, options) => {
      reads.push(key);
      const value = objects.get(key);
      return value === undefined
        ? null
        : {
            size: new TextEncoder().encode(value).length,
            body: new Response(
              options
                ? new TextEncoder()
                    .encode(value)
                    .slice(
                      options.range.offset,
                      options.range.offset + options.range.length,
                    )
                : value,
            ).body!,
            httpEtag: '"file"',
            writeHttpMetadata() {},
          };
    },
  };
  const env: Env = {
    HOST_DOMAIN: "sites.vm0.io",
    OKOU_HOST_DOMAIN: "okou.app",
    HOSTED_SITES_BUCKET: bucket,
    PRIVATE_ARTIFACTS_BUCKET: bucket,
    PUBLIC_ARTIFACT_HOST: "a.okou.io",
  };
  const bytes = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: Request) => {
      return bytes.get(key.url)?.clone();
    }),
    put: vi.fn(async (key: Request, response: Response) => {
      bytes.set(key.url, response);
    }),
  };
  const registryCache = memoryCache();
  vi.stubGlobal("caches", {
    default: cache,
    open: async () => {
      return registryCache;
    },
  });
  return { env, objects, reads, policy, cache };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function imageFixture(token = publicToken) {
  const f = fixture(false, "png", token);
  if (f.policy.target.kind !== "file") throw new Error("Expected file fixture");
  f.policy.target.contentType = "image/png";
  f.objects.set(policyKey, JSON.stringify(f.policy));
  const render = vi.fn(async (body: ReadableStream) => {
    return new Response(`Thumbnail of ${await new Response(body).text()}`);
  });
  const transforms: { readonly width?: number; readonly height?: number }[] =
    [];
  const images: NonNullable<Env["IMAGES"]> = {
    input: (body) => {
      return {
        transform: (options) => {
          transforms.push(options);
          return {
            output: async () => {
              const response = await render(body);
              return {
                response: () => {
                  return response;
                },
              };
            },
          };
        },
      };
    },
  };
  return {
    ...f,
    env: { ...f.env, IMAGES: images },
    render,
    transforms,
    url: `https://a.okou.io/${token}.png?thumbnail=1&width=400`,
  };
}

test.each([
  { dimensions: "", width: undefined, height: undefined },
  { dimensions: "&width=1200", width: 1200, height: undefined },
  { dimensions: "&height=900", width: undefined, height: 900 },
])(
  "image embeds resize only when dimensions are requested (%j)",
  async ({ dimensions, width, height }) => {
    const f = imageFixture("a1b2c3d4e5");
    const url = f.url.replace("&width=400", dimensions);
    const response = await fetchWorker(new Request(url), f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(await response.text()).toBe("Thumbnail of Private PDF bytes");
    // The Images binding is the external renderer. An authoring embed with
    // no bounds must retain its source dimensions; cards pass explicit bounds.
    expect(f.transforms).toStrictEqual([{ width, height, fit: "scale-down" }]);
  },
);

test.each(["a".repeat(24), "a1b2c3d4e5"])(
  "cached thumbnails recheck public authorization for %s",
  async (token) => {
    const f = imageFixture(token);
    const request = () => {
      return new Request(f.url);
    };
    const cold = await fetchWorker(request(), f.env);
    expect(await cold.text()).toBe("Thumbnail of Private PDF bytes");
    expect(cold.headers.get("Content-Type")).toBe("image/webp");
    expect(cold.headers.get("Cache-Control")).toBe("private, no-store");
    f.reads.length = 0;
    const warm = await fetchWorker(request(), f.env);
    expect(await warm.text()).toBe("Thumbnail of Private PDF bytes");
    expect(f.reads).toStrictEqual([policyKey]);
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(
      await (
        await fetchWorker(new Request(f.url, { method: "HEAD" }), f.env)
      ).text(),
    ).toBe("");
    expect(
      await (
        await fetchWorker(new Request(`https://a.okou.io/${token}.png`), f.env)
      ).text(),
    ).toBe("Private PDF bytes");
    const cacheReads = f.cache.match.mock.calls.length;
    for (const audience of ["organization", "private"] as const) {
      f.objects.set(
        policyKey,
        JSON.stringify({
          ...f.policy,
          audience,
          status: audience === "private" ? "revoked" : "active",
          publicToken: null,
        }),
      );
      const denied = await fetchWorker(request(), f.env);
      expect(denied.status).toBe(404);
      expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(f.cache.match).toHaveBeenCalledTimes(cacheReads);
  },
);

test("thumbnail caches cannot hide missing policy or feed external Image Resizing", async () => {
  const f = imageFixture();
  await fetchWorker(new Request(f.url), f.env);
  expect(
    (
      await fetchWorker(
        new Request(f.url, { headers: { Via: "1.1 image-resizing" } }),
        f.env,
      )
    ).status,
  ).toBe(404);
  f.objects.set(policyKey, "malformed");
  expect((await fetchWorker(new Request(f.url), f.env)).status).toBe(503);
  f.objects.delete(policyKey);
  expect((await fetchWorker(new Request(f.url), f.env)).status).toBe(404);
  expect(f.render).toHaveBeenCalledTimes(1);
});

test("legacy ten-character image thumbnails retain public caching and original bytes", async () => {
  const f = imageFixture("a1b2c3d4e5");
  const key = "artifacts/a1b2c3d4e5.png";
  // The same shape as a new share is classified by its immutable registration.
  f.objects.set(
    artifactDeliveryKey(null, "file", "a1b2c3d4e5.png"),
    JSON.stringify({
      version: 1,
      kind: "legacy-file",
      publicBrand: "okou",
      audience: "public",
      key,
      filename: "old.png",
      contentType: "image/png",
    }),
  );
  f.objects.set(key, "Historical image");
  f.env.PUBLIC_ARTIFACTS_BUCKET = f.env.HOSTED_SITES_BUCKET;
  f.objects.delete(policyKey);
  const thumbnail = await fetchWorker(new Request(f.url), f.env);
  expect(await thumbnail.text()).toBe("Thumbnail of Historical image");
  expect(thumbnail.headers.get("Cache-Control")).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(
    await (
      await fetchWorker(new Request("https://a.okou.io/a1b2c3d4e5.png"), f.env)
    ).text(),
  ).toBe("Historical image");
});

test("thumbnail variants and immutable source versions do not share cached images", async () => {
  const f = imageFixture();
  await fetchWorker(new Request(f.url), f.env);
  await fetchWorker(new Request(f.url.replace("400", "800")), f.env);
  if (f.policy.target.kind !== "file") throw new Error("Expected file fixture");
  f.policy.target.key = `private-artifacts/${fileId}/shares/next/image.png`;
  f.objects.set(f.policy.target.key, "New image");
  f.objects.set(policyKey, JSON.stringify(f.policy));
  expect(await (await fetchWorker(new Request(f.url), f.env)).text()).toBe(
    "Thumbnail of New image",
  );
  expect(f.render).toHaveBeenCalledTimes(3);
});

test.each(["0", "2049", "NaN", "12.5", "400&width=500"])(
  "invalid thumbnail width %s never starts a transform",
  async (width) => {
    const f = imageFixture();
    const response = await fetchWorker(
      new Request(f.url.replace("400", width)),
      f.env,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(f.render).not.toHaveBeenCalled();
  },
);

test("unsupported images keep the authorized original and remain revocable", async () => {
  const f = imageFixture();
  if (f.policy.target.kind !== "file") throw new Error("Expected file fixture");
  f.policy.target.contentType = "image/svg+xml";
  f.objects.set(policyKey, JSON.stringify(f.policy));
  const response = await fetchWorker(new Request(f.url), f.env);
  expect(await response.text()).toBe("Private PDF bytes");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(f.render).not.toHaveBeenCalled();
  f.objects.delete(policyKey);
  expect((await fetchWorker(new Request(f.url), f.env)).status).toBe(404);
});

test("images larger than the binding limit keep their authorized original", async () => {
  const f = imageFixture();
  const bucket = f.env.PRIVATE_ARTIFACTS_BUCKET!;
  f.env.PRIVATE_ARTIFACTS_BUCKET = {
    ...bucket,
    get: async (key, options) => {
      const object = await bucket.get(key, options);
      return object ? { ...object, size: 20_000_000 + 1 } : null;
    },
  };
  const response = await fetchWorker(new Request(f.url), f.env);
  expect(await response.text()).toBe("Private PDF bytes");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(f.render).not.toHaveBeenCalled();
});

test("a failed transform never populates the thumbnail cache or exposes an original", async () => {
  const f = imageFixture();
  f.render.mockRejectedValue(new Error("Image service unavailable"));
  const response = await fetchWorker(new Request(f.url), f.env);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("Private PDF");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(f.cache.put).not.toHaveBeenCalled();
});

test.each([false, true])(
  "previously emitted public links remain policy-checked after the URL change (html=%s)",
  async (html) => {
    const f = fixture(html);
    const legacy = `https://sh-${id.replaceAll("-", "")}-${publicToken}.okou.app/`;
    const request = new Request(legacy);
    const response = await fetchWorker(request, f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    f.objects.set(
      policyKey,
      JSON.stringify({
        ...f.policy,
        audience: "organization",
        publicToken: null,
      }),
    );
    expect((await fetchWorker(request, f.env)).status).toBe(404);
  },
);

test("warm public bytes still require authoritative permission, and revocation defeats cache hits", async () => {
  const f = fixture();
  const request = () => {
    return new Request(origin);
  };
  expect(await (await fetchWorker(request(), f.env)).text()).toBe(
    "Private PDF bytes",
  );
  f.reads.length = 0;
  const warm = await fetchWorker(request(), f.env);
  expect(await warm.text()).toBe("Private PDF bytes");
  expect(warm.headers.get("cache-control")).toBe("private, no-store");
  expect(f.reads).toStrictEqual([policyKey]);
  expect(f.reads).not.toContain(
    f.policy.target.kind === "file" ? f.policy.target.key : "",
  );
  const cacheReads = f.cache.match.mock.calls.length;
  f.objects.set(
    policyKey,
    JSON.stringify({
      ...f.policy,
      audience: "organization",
      publicToken: null,
    }),
  );
  const denied = await fetchWorker(request(), f.env);
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain("Private PDF");
  expect(f.cache.match).toHaveBeenCalledTimes(cacheReads);
});

test("missing, malformed and unavailable publication state never serve cached bytes", async () => {
  const f = fixture();
  await fetchWorker(new Request(origin), f.env);
  f.objects.set(policyKey, "broken");
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(503);
  f.objects.delete(policyKey);
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(404);
  f.env.HOSTED_SITES_BUCKET.get = async () => {
    throw new Error("Storage unavailable");
  };
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(503);
  expect(f.cache.match).toHaveBeenCalledTimes(1);
});

test("republishing does not reactivate earlier public URLs or canonical private aliases", async () => {
  const f = fixture();
  f.objects.set(
    policyKey,
    JSON.stringify({ ...f.policy, publicToken: "b".repeat(24) }),
  );
  f.objects.set(
    artifactDeliveryKey("okou", "file", `${"b".repeat(24)}.pdf`),
    JSON.stringify({
      version: 1,
      kind: "publication",
      publicBrand: "okou",
      shareId: id,
      publicToken: "b".repeat(24),
      targetKind: "file",
    }),
  );
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(404);
  expect(
    (await fetchWorker(new Request(`https://dpl-${fileId}.okou.app/`), f.env))
      .status,
  ).toBe(404);
  expect(
    (
      await fetchWorker(
        new Request(origin.replace(publicToken, "b".repeat(24))),
        f.env,
      )
    ).status,
  ).toBe(200);
});

test("named public site aliases retain snapshot delivery and revoked aliases never revive", async () => {
  const f = fixture(true);
  const alias = "business-report";
  const record = {
    version: 1,
    kind: "publication",
    publicBrand: "okou",
    shareId: id,
    publicToken,
    targetKind: "html",
  };
  f.objects.set(
    artifactDeliveryKey("okou", "html", alias),
    JSON.stringify(record),
  );
  const address = `https://${alias}.okou.app`;
  for (const path of ["/", "/style.css", "/app.js", "/image.png"]) {
    const response = await fetchWorker(new Request(`${address}${path}`), f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
  }
  expect((await fetchWorker(new Request(siteOrigin), f.env)).status).toBe(200);
  f.objects.set(
    policyKey,
    JSON.stringify({
      ...f.policy,
      audience: "private",
      status: "revoked",
      publicToken: null,
    }),
  );
  expect((await fetchWorker(new Request(address), f.env)).status).toBe(404);
  const nextToken = "b".repeat(24);
  f.objects.set(
    policyKey,
    JSON.stringify({
      ...f.policy,
      publicToken: nextToken,
      publicSlug: "business-report-abcd",
    }),
  );
  f.objects.set(
    artifactDeliveryKey("okou", "html", "business-report-abcd"),
    JSON.stringify({ ...record, publicToken: nextToken }),
  );
  expect((await fetchWorker(new Request(address), f.env)).status).toBe(404);
  expect((await fetchWorker(new Request(siteOrigin), f.env)).status).toBe(404);
  expect(
    (
      await fetchWorker(
        new Request("https://business-report-abcd.okou.app"),
        f.env,
      )
    ).status,
  ).toBe(200);
});

test("html snapshots protect every resource and navigation on an isolated origin", async () => {
  const f = fixture(true);
  for (const path of [
    "/",
    "/style.css",
    "/app.js",
    "/image.png",
    "/download.csv",
    "/nested/route",
  ]) {
    const response = await fetchWorker(
      new Request(`${siteOrigin}${path}`, { headers: { accept: "text/html" } }),
      f.env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "worker-src 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
  }
  const head = await fetchWorker(
    new Request(`${siteOrigin}/app.js`, { method: "HEAD" }),
    f.env,
  );
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  f.objects.set(
    policyKey,
    JSON.stringify({
      ...f.policy,
      audience: "private",
      status: "revoked",
      publicToken: null,
    }),
  );
  for (const path of [
    "/",
    "/style.css",
    "/app.js",
    "/image.png",
    "/download.csv",
    "/nested/route",
  ]) {
    expect(
      (await fetchWorker(new Request(`${siteOrigin}${path}`), f.env)).status,
    ).toBe(404);
  }
});

test("organization snapshot credentials remain bearer capabilities only until their exact expiry", async () => {
  const f = fixture(true);
  const token = "c".repeat(48);
  const key = `shared-previews/okou/${token}.json`;
  const grant = {
    version: 1,
    publicBrand: "okou",
    deploymentId: fileId,
    snapshotId,
    expiresAt: "2099-01-01T00:00:00Z",
  };
  f.objects.set(key, JSON.stringify(grant));
  const request = (path: string) => {
    return new Request(`https://ps-${token}.okou.app${path}`);
  };
  expect((await fetchWorker(request("/"), f.env)).status).toBe(200);
  const rewritten = new Request(`https://pv-${token}.okou.app/`);
  expect((await fetchWorker(rewritten, f.env)).status).toBe(404);
  expect(f.objects.has(`private-previews/okou/${token}.json`)).toBeFalsy();
  // Stopping the share does not promise invalidation of previously issued credentials.
  f.objects.set(
    policyKey,
    JSON.stringify({
      ...f.policy,
      audience: "private",
      status: "revoked",
      publicToken: null,
    }),
  );
  expect((await fetchWorker(request("/style.css"), f.env)).status).toBe(200);
  f.objects.set(
    key,
    JSON.stringify({ ...grant, expiresAt: "2000-01-01T00:00:00Z" }),
  );
  expect((await fetchWorker(request("/"), f.env)).status).toBe(404);
  expect((await fetchWorker(request("/style.css"), f.env)).status).toBe(404);
});

test("a cold cache write runs in the Worker lifetime without delaying content delivery", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  onTestFinished(() => {
    return gate.resolve();
  });
  f.cache.put.mockImplementation(async () => {
    await gate.promise;
  });
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request(origin), f.env, {
    waitUntil(promise) {
      pending.push(promise);
    },
  });
  expect(await response.text()).toBe("Private PDF bytes");
  expect(pending).toHaveLength(2);
  gate.resolve();
  await Promise.all(pending);
});

test("an unregistered public hash cannot use a private object or bypass a revoked record", async () => {
  const f = fixture();
  f.objects.delete(artifactDeliveryKey("okou", "file", `${publicToken}.pdf`));
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(404);
  expect(
    (
      await fetchWorker(
        new Request(`https://a.okou.io/private-artifacts/${fileId}/report.pdf`),
        f.env,
      )
    ).status,
  ).toBe(404);
  expect(f.cache.match).not.toHaveBeenCalled();
});

test("a publication registry cannot change a policy's delivery type", async () => {
  const f = fixture(true);
  f.objects.set(
    artifactDeliveryKey("okou", "file", `${publicToken}.html`),
    JSON.stringify({
      version: 1,
      kind: "publication",
      publicBrand: "okou",
      shareId: id,
      publicToken,
      targetKind: "file",
    }),
  );
  const response = await fetchWorker(
    new Request(`https://a.okou.io/${publicToken}.html`),
    f.env,
  );
  expect(response.status).toBe(404);
  expect(f.cache.match).not.toHaveBeenCalled();
});

test("malformed alias and registration state fails closed", async () => {
  const f = fixture();
  f.objects.set(
    artifactDeliveryKey("okou", "file", `${publicToken}.pdf`),
    "null",
  );
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(503);
  f.objects.set(artifactDeliveryRegistrationKey("okou"), "null");
  expect(
    (await fetchWorker(new Request("https://unknown.okou.app/"), f.env)).status,
  ).toBe(503);
  expect(f.cache.match).not.toHaveBeenCalled();
});

test.each([
  "0123456789.pdf",
  "user_historical/00000000-0000-4000-8000-000000000014/report.pdf",
])(
  "historical Public file %s keeps its URL, bytes, cache and range access",
  async (legacy) => {
    const f = fixture();
    const key = `artifacts/${legacy}`;
    f.objects.set(key, "Historical public PDF");
    f.objects.set(
      artifactDeliveryKey("okou", "file", legacy),
      JSON.stringify({
        version: 1,
        kind: "legacy-file",
        publicBrand: "okou",
        audience: "public",
        key,
        filename: "old.pdf",
        contentType: "application/pdf",
      }),
    );
    const env = {
      ...f.env,
      PUBLIC_ARTIFACTS_BUCKET: f.env.HOSTED_SITES_BUCKET,
    };
    const response = await fetchWorker(
      new Request(`https://a.okou.io/${legacy}`),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Historical public PDF");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const head = await fetchWorker(
      new Request(`https://a.okou.io/${legacy}`, { method: "HEAD" }),
      env,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const ranged = await fetchWorker(
      new Request(`https://a.okou.io/${legacy}`, {
        headers: { Range: "bytes=0-9" },
      }),
      env,
    );
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("Historical");
    // Cloudflare's existing rewrite can still be active during the route cutover.
    const rewritten = await fetchWorker(
      new Request(`https://a.okou.io/artifacts/${legacy}`),
      env,
    );
    expect(rewritten.status).toBe(200);
    expect(await rewritten.text()).toBe("Historical public PDF");
    const imageSource = await fetchWorker(
      new Request(`https://a.okou.io/${legacy}`, {
        headers: { Via: "image-resizing" },
      }),
      env,
    );
    expect(imageSource.status).toBe(200);
    expect(
      (
        await fetchWorker(
          new Request("https://a.okou.io/unregistered.pdf"),
          env,
        )
      ).status,
    ).toBe(404);
  },
);

test.each(["", "artifacts/"])(
  "public file shares reject noncanonical %s paths outside cache exclusions",
  async (prefix) => {
    const extension = "presentation";
    const f = fixture(false, extension);
    const path = `${publicToken}.${extension}`;
    const url = `https://a.okou.io/${prefix}${path}`;
    const canonical = await fetchWorker(new Request(url), f.env);
    expect(canonical.status).toBe(200);
    expect(await canonical.text()).toBe("Private PDF bytes");
    expect(canonical.headers.get("Cache-Control")).toBe("private, no-store");
    for (const variant of [
      `${path}/`,
      `${publicToken}%2E${extension}`,
      `%61${publicToken.slice(1)}.${extension}`,
    ]) {
      const response = await fetchWorker(
        new Request(`https://a.okou.io/${prefix}${variant}`),
        f.env,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).not.toContain("Private PDF");
    }
    f.objects.set(
      policyKey,
      JSON.stringify({
        ...f.policy,
        audience: "private",
        status: "revoked",
        publicToken: null,
      }),
    );
    const revoked = await fetchWorker(new Request(url), f.env);
    expect(revoked.status).toBe(404);
    expect(revoked.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await revoked.text()).not.toContain("Private PDF");
  },
);

test("public file shares cannot feed an image cache outside their revocation checks", async () => {
  const f = fixture();
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(200);
  const resized = await fetchWorker(
    new Request(origin, { headers: { Via: "1.1 image-resizing" } }),
    f.env,
  );
  expect(resized.status).toBe(404);
  expect(resized.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await resized.text()).not.toContain("Private PDF");
});

test("media byte ranges remain authorized after a full response warms the cache", async () => {
  const f = fixture();
  await fetchWorker(new Request(origin), f.env);
  for (const [range, content, contentRange] of [
    ["bytes=0-6", "Private", "bytes 0-6/17"],
    ["bytes=-5", "bytes", "bytes 12-16/17"],
  ]) {
    const response = await fetchWorker(
      new Request(origin, { headers: { Range: range! } }),
      f.env,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toBe(content);
  }
  expect(
    (
      await fetchWorker(
        new Request(origin, { headers: { Range: "bytes=99-" } }),
        f.env,
      )
    ).status,
  ).toBe(416);
  f.objects.set(
    policyKey,
    JSON.stringify({
      ...f.policy,
      status: "revoked",
      audience: "private",
      publicToken: null,
    }),
  );
  expect(
    (
      await fetchWorker(
        new Request(origin, { headers: { Range: "bytes=0-6" } }),
        f.env,
      )
    ).status,
  ).toBe(404);
});

test("registered historical sites preserve mutable aliases after the migration closes unknown lookup", async () => {
  const f = fixture(true);
  const alias = "legacy-report";
  const prefix = `sites/${alias}/deployments/${fileId}`;
  const pointerKey = `sites/brands/okou/${alias}/active.json`;
  const registryKey = artifactDeliveryKey("okou", "html", alias);
  if (f.policy.target.kind !== "html") throw new Error("Expected HTML fixture");
  const { access: _access, ...manifest } = f.policy.target.manifest;
  f.objects.set(`${prefix}/manifest.json`, JSON.stringify(manifest));
  f.objects.set(`${prefix}/index.html`, "Historical site one");
  f.objects.set(
    pointerKey,
    JSON.stringify({
      version: 1,
      publicBrand: "okou",
      publicSlug: alias,
      deploymentId: fileId,
      siteId,
      prefix,
      manifestKey: `${prefix}/manifest.json`,
      spaFallback: true,
    }),
  );
  f.objects.set(
    registryKey,
    JSON.stringify({
      version: 1,
      kind: "legacy-site",
      publicBrand: "okou",
      audience: "public",
      pointerKey,
    }),
  );
  f.objects.set(
    artifactDeliveryRegistrationKey("okou"),
    JSON.stringify({ version: 1, complete: true }),
  );
  const url = `https://${alias}.okou.app/`;
  expect(await (await fetchWorker(new Request(url), f.env)).text()).toBe(
    "Historical site one",
  );
  f.objects.set(`${prefix}/index.html`, "Historical site two");
  expect(await (await fetchWorker(new Request(url), f.env)).text()).toBe(
    "Historical site two",
  );
  f.objects.set(
    "sites/brands/okou/unregistered/active.json",
    f.objects.get(pointerKey)!,
  );
  expect(
    (await fetchWorker(new Request("https://unregistered.okou.app/"), f.env))
      .status,
  ).toBe(404);
});
