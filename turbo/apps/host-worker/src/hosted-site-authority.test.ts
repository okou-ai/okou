import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import worker from "./index";
import { fetchWorker } from "./test-helpers";

type Env = Parameters<typeof worker.fetch>[1];
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

const siteId = "00000000-0000-4000-8000-000000000001";
const deploymentId = "00000000-0000-4000-8000-000000000002";
const prefix = `sites/brands/okou/publications/${deploymentId}`;
const endpoint =
  "https://authority.test/api/host/delivery/:siteId/:deploymentId";

function environment(
  configured = true,
  readFile?: () => Promise<void>,
  segment: "okou" | "vm0" = "okou",
  registered = false,
  html = "<p>ok</p>",
): Env {
  const pointerRoot = segment === "okou" ? "sites/brands/okou" : "sites";
  const storedPrefix = `${pointerRoot}/publications/${deploymentId}`;
  const pointer = {
    version: 1,
    publicBrand: segment,
    publicSlug: "demo",
    siteId,
    deploymentId,
    prefix: storedPrefix,
    manifestKey: `${storedPrefix}/manifest.json`,
    spaFallback: false,
    updatedAt: "2026-10-08T00:00:00Z",
  };
  const manifest = {
    version: 1,
    immutableContent: true,
    publicBrand: segment,
    publicSlug: "demo",
    siteId,
    deploymentId,
    createdAt: pointer.updatedAt,
    spaFallback: false,
    files: {
      "/index.html": {
        path: "/index.html",
        size: 9,
        sha256: "a".repeat(64),
        contentType: "text/html",
      },
      "/style-12345678.css": {
        path: "/style-12345678.css",
        size: 12,
        sha256: "b".repeat(64),
        contentType: "text/css",
        immutable: true,
      },
    },
  };
  const objects = new Map([
    [`${pointerRoot}/demo/active.json`, JSON.stringify(pointer)],
    [
      `${pointerRoot}/deployments/${deploymentId}.json`,
      JSON.stringify(pointer),
    ],
    [`${storedPrefix}/manifest.json`, JSON.stringify(manifest)],
    [`${storedPrefix}/index.html`, html],
    [`${storedPrefix}/style-12345678.css`, "a{color:red}"],
  ]);
  if (registered) {
    for (const alias of ["demo", `dpl-${deploymentId}`]) {
      objects.set(
        `artifact-delivery/${segment}/html/${alias}.json`,
        JSON.stringify({
          version: 1,
          kind: "legacy-site",
          publicBrand: segment,
          audience: "public",
          pointerKey:
            alias === "demo"
              ? `${pointerRoot}/demo/active.json`
              : `${pointerRoot}/deployments/${deploymentId}.json`,
        }),
      );
    }
  }
  return {
    HOST_DOMAIN: "sites.vm0.io",
    OKOU_HOST_DOMAIN: "okou.app",
    ...(configured ? { HOSTED_SITE_API_ORIGIN: "https://authority.test" } : {}),
    HOSTED_SITES_BUCKET: {
      head: async () => {
        return null;
      },
      get: async (key) => {
        const body = objects.get(key);
        if (body === undefined) return null;
        if (key === `${storedPrefix}/index.html` && readFile) await readFile();
        const stream = new Response(body).body;
        if (!stream) throw new Error("Expected hosted fixture bytes");
        return {
          size: body.length,
          body: stream,
          httpEtag: '"hosted"',
          writeHttpMetadata: () => {},
        };
      },
    },
  };
}

it.each([
  { segment: "okou" as const, domain: "okou.app", registered: false },
  { segment: "okou" as const, domain: "okou.app", registered: true },
  { segment: "vm0" as const, domain: "sites.vm0.io", registered: false },
  { segment: "vm0" as const, domain: "sites.vm0.io", registered: true },
])(
  "checks $segment pointers with registration=$registered through the same owner",
  async ({ segment, domain, registered }) => {
    let allowed = true;
    server.use(
      http.get(endpoint, ({ request }) => {
        expect(new URL(request.url).searchParams.get("publicBrand")).toBe(
          segment,
        );
        return HttpResponse.json({ allowed });
      }),
    );
    const env = environment(true, undefined, segment, registered);
    for (const alias of ["demo", `dpl-${deploymentId}`]) {
      const url = `https://${alias}.${domain}/`;
      allowed = true;
      expect((await fetchWorker(new Request(url), env)).status).toBe(200);
      allowed = false;
      expect((await fetchWorker(new Request(url), env)).status).toBe(404);
    }
  },
);

it("retains the existing reader until owner validation is configured", async () => {
  const response = await fetchWorker(
    new Request("https://demo.okou.app/"),
    environment(false),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("<p>ok</p>");
});

it.each(["demo", `dpl-${deploymentId}`])(
  "checks current authority on every request to %s even when bytes remain",
  async (alias) => {
    let allowed = true;
    server.use(
      http.get(endpoint, ({ params, request }) => {
        expect(params).toMatchObject({ siteId, deploymentId });
        const query = new URL(request.url).searchParams;
        expect(query.get("alias")).toBe(alias);
        expect(query.get("publicSlug")).toBe("demo");
        expect(query.get("publicBrand")).toBe("okou");
        expect(query.get("prefix")).toBe(prefix);
        expect(query.get("manifestKey")).toBe(`${prefix}/manifest.json`);
        return HttpResponse.json(
          { allowed },
          { headers: { "Cache-Control": "private, no-store" } },
        );
      }),
    );
    const env = environment();
    const url = `https://${alias}.okou.app/`;
    expect((await fetchWorker(new Request(url), env)).status).toBe(200);
    allowed = false;
    for (const method of ["GET", "HEAD"]) {
      const denied = await fetchWorker(new Request(url, { method }), env);
      expect(denied.status).toBe(404);
      expect(denied.headers.get("Cache-Control")).toContain("no-store");
    }
  },
);

it("keeps protected assets out of HTTP caches while the old reader keeps its cache policy", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({ allowed: true });
    }),
  );
  const url = "https://demo.okou.app/style-12345678.css";
  const protectedResponse = await fetchWorker(new Request(url), environment());
  expect(protectedResponse.status).toBe(200);
  expect(protectedResponse.headers.get("Cache-Control")).toContain("no-store");
  const oldResponse = await fetchWorker(new Request(url), environment(false));
  expect(oldResponse.headers.get("Cache-Control")).toBe(
    "public, max-age=31536000, immutable",
  );
});

it("rejects new requests after revocation but lets an already admitted read finish", async () => {
  let allowed = true;
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({ allowed });
    }),
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const env = environment(true, async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = fetchWorker(new Request("https://demo.okou.app/"), env);
  onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled([pending]);
  });
  await entered.promise;
  allowed = false;
  expect(
    (await fetchWorker(new Request("https://demo.okou.app/"), env)).status,
  ).toBe(404);
  release.resolve();
  const admitted = await pending;
  expect(admitted.status).toBe(200);
  expect(await admitted.text()).toBe("<p>ok</p>");
});

it("cancels a pending authority request with the incoming request", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  server.use(
    http.get(endpoint, async () => {
      entered.resolve();
      await release.promise;
      return HttpResponse.json({ allowed: true });
    }),
  );
  const controller = new AbortController();
  const pending = fetchWorker(
    new Request("https://demo.okou.app/", { signal: controller.signal }),
    environment(),
  );
  onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled([pending]);
  });
  await entered.promise;
  controller.abort();
  expect((await pending).status).toBe(503);
  release.resolve();
});

it.each([404, 500])(
  "keeps a missing or failed authority endpoint (%s) unavailable",
  async (status) => {
    server.use(
      http.get(endpoint, () => {
        return new HttpResponse(null, { status });
      }),
    );
    const response = await fetchWorker(
      new Request("https://demo.okou.app/"),
      environment(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  },
);

it("treats a malformed authority response as unavailable", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({});
    }),
  );
  expect(
    (await fetchWorker(new Request("https://demo.okou.app/"), environment()))
      .status,
  ).toBe(503);
});

it("serves version-bound OG in the initial HTML while preserving authored metadata", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({ allowed: true });
    }),
    http.get(
      "https://authority.test/api/artifact-og/metadata",
      ({ request }) => {
        expect(new URL(request.url).searchParams.get("id")).toBe(deploymentId);
        expect(request.headers.get("cookie")).toBeNull();
        return HttpResponse.json({
          available: true,
          title: "Published report",
          description: "Published summary",
          url: "https://demo.okou.app/",
          imageUrl: `https://authority.test/api/artifact-og/image?kind=host&id=${deploymentId}&version=one`,
        });
      },
    ),
  );
  const env = {
    ...environment(
      true,
      undefined,
      "okou",
      true,
      '<html><head><title>Authored</title><meta property="og:title" content="Custom title"></head><body>Public report</body></html>',
    ),
    ARTIFACT_OG_API_ORIGIN: "https://authority.test",
  };
  const response = await fetchWorker(
    new Request("https://demo.okou.app/?tracking=secret", {
      headers: { Cookie: "session=owner" },
    }),
    env,
  );
  const html = await response.text();
  expect(html).toContain('property="og:title" content="Custom title"');
  expect(html).toContain(`id=${deploymentId}&amp;version=one`);
  expect(html).not.toContain("tracking");
  expect(html.indexOf('property="og:image"')).toBeLessThan(
    html.indexOf("</head>"),
  );
  expect(response.headers.get("ETag")).toBeNull();
  expect(response.headers.get("Content-Length")).toBeNull();
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

it.each(["demo", `dpl-${deploymentId}`])(
  "normalizes authored image URLs on %s without enabling platform previews",
  async (alias) => {
    server.use(
      http.get(endpoint, () => {
        return HttpResponse.json({ allowed: true });
      }),
      http.get("https://authority.test/api/artifact-og/metadata", () => {
        return HttpResponse.json({
          available: false,
          normalizeImageUrls: true,
        });
      }),
    );
    const response = await fetchWorker(
      new Request(`https://${alias}.okou.app/`),
      {
        ...environment(
          true,
          undefined,
          "okou",
          true,
          '<html><head><meta property="og:image" content="cover.png"><meta property="og:image:width" content="1200"></head><body><img src="cover.png"></body></html>',
        ),
        ARTIFACT_OG_API_ORIGIN: "https://authority.test",
      },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      `property="og:image" content="https://${alias}.okou.app/cover.png"`,
    );
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('<body><img src="cover.png"></body>');
    expect(html).not.toContain("artifact-og/image");
    expect(html).not.toContain("og:title");
    expect(response.headers.get("ETag")).toBeNull();
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  },
);

it("preserves exact bytes and validators when enabled normalization makes no edits", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({ allowed: true });
    }),
    http.get("https://authority.test/api/artifact-og/metadata", () => {
      return HttpResponse.json({ available: false, normalizeImageUrls: true });
    }),
  );
  const original =
    '\uFEFF<head><meta property="og:image" content="https://cdn.example/cover.png"></head><body>Report</body>';
  const response = await fetchWorker(new Request("https://demo.okou.app/"), {
    ...environment(true, undefined, "okou", true, original),
    ARTIFACT_OG_API_ORIGIN: "https://authority.test",
  });
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new TextEncoder().encode(original),
  );
  expect(response.headers.get("ETag")).toBe('"hosted"');
});

it("preserves the authored relative cover when both OG features are enabled", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({ allowed: true });
    }),
    http.get("https://authority.test/api/artifact-og/metadata", () => {
      return HttpResponse.json({
        available: true,
        normalizeImageUrls: true,
        title: "Report",
        description: "Summary",
        url: "https://demo.okou.app/",
        imageUrl: "https://authority.test/platform-cover.png",
      });
    }),
  );
  const response = await fetchWorker(new Request("https://demo.okou.app/"), {
    ...environment(
      true,
      undefined,
      "okou",
      true,
      '<head><meta property="og:image" content="cover.png"></head><body>Report</body>',
    ),
    ARTIFACT_OG_API_ORIGIN: "https://authority.test",
  });
  const html = await response.text();
  expect(html).toContain(
    'property="og:image" content="https://demo.okou.app/cover.png"',
  );
  expect(html).toContain(
    'name="twitter:image" content="https://demo.okou.app/cover.png"',
  );
  expect(html).toContain('property="og:title" content="Report"');
  expect(html).not.toContain("platform-cover.png");
});

it.each(["disabled", "unavailable"])(
  "keeps public HTML readable when OG is %s",
  async (state) => {
    server.use(
      http.get(endpoint, () => {
        return HttpResponse.json({ allowed: true });
      }),
      http.get("https://authority.test/api/artifact-og/metadata", () => {
        return state === "disabled"
          ? HttpResponse.json({ available: false })
          : new HttpResponse(null, { status: 503 });
      }),
    );
    const original =
      '<head><meta property="og:image" content="cover.png"></head><body>Report</body>';
    const response = await fetchWorker(new Request("https://demo.okou.app/"), {
      ...environment(true, undefined, "okou", true, original),
      ARTIFACT_OG_API_ORIGIN: "https://authority.test",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(original);
    expect(response.headers.get("ETag")).toBe('"hosted"');
  },
);
