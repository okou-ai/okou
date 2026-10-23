import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { ARTIFACT_OG_BRAND } from "@okouai/core/artifact-og";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import worker from "./index";
import { fetchWorker } from "./test-helpers";

type Env = Parameters<typeof worker.fetch>[1];
const server = setupServer(
  http.get("https://authority.test/api/host/aliases/:publicSlug", () => {
    return HttpResponse.json({ pointer: null });
  }),
);
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
  html: string | Uint8Array<ArrayBuffer> = "<p>ok</p>",
  encoding?: string,
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
    ...(encoding === undefined ? { immutableContent: true } : {}),
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
      "/report-12345678.js": {
        path: "/report-12345678.js",
        size: 25,
        sha256: "c".repeat(64),
        contentType: "application/javascript",
        immutable: true,
      },
    },
  };
  const objects = new Map<string, string | Uint8Array<ArrayBuffer>>([
    [`${pointerRoot}/demo/active.json`, JSON.stringify(pointer)],
    [
      `${pointerRoot}/deployments/${deploymentId}.json`,
      JSON.stringify(pointer),
    ],
    [`${storedPrefix}/manifest.json`, JSON.stringify(manifest)],
    [`${storedPrefix}/index.html`, html],
    [`${storedPrefix}/style-12345678.css`, "a{color:red}"],
    [`${storedPrefix}/report-12345678.js`, "window.privateReport = 42;"],
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
    ...(configured
      ? {
          HOSTED_SITE_API_ORIGIN: "https://authority.test",
        }
      : {}),
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
          writeHttpMetadata: (headers) => {
            if (encoding) headers.set("Content-Encoding", encoding);
          },
        };
      },
    },
  };
}

it("fails closed when the authority omits its access decision", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({ allowed: true });
    }),
  );
  expect(
    (await fetchWorker(new Request("https://demo.okou.app/"), environment()))
      .status,
  ).toBe(503);
});

it("decorates authorized standalone HTML with a shared banner and a credential-free App CTA", async () => {
  server.use(
    http.get(endpoint, ({ request }) => {
      expect(new URL(request.url).searchParams.get("presentation")).toBe(
        "banner",
      );
      return HttpResponse.json({
        allowed: true,
        decision: "allow",
        presentation: {
          showBanner: true,
          title: 'Weekly <report> "Q4"',
          siteUrl: "https://demo.okou.app/",
        },
      });
    }),
  );
  const env = {
    ...environment(
      true,
      undefined,
      "okou",
      true,
      "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'self'; worker-src 'none'\"></head><body><h1>Original report</h1><script src=\"/report-12345678.js\"></script></body></html>",
    ),
    HOSTED_SITE_AUTH_URL: "https://app.okou.ai/hosted-site-authorize",
  };
  const response = await fetchWorker(
    new Request("https://demo.okou.app/?private_parameter=secret", {
      headers: { "Sec-Fetch-Dest": "document" },
    }),
    env,
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('shadowrootmode="open"');
  expect(html).toContain("Weekly &lt;report&gt; &quot;Q4&quot;");
  expect(html).toContain("Continue with Okou");
  expect(html).toContain(
    'href="https://app.okou.ai/artifacts?downloadSite=demo"',
  );
  expect(html).toContain("<h1>Original report</h1>");
  expect(html).toContain('<script src="/report-12345678.js"></script>');
  expect(html).not.toContain("private_parameter");
  expect(html).not.toContain("unsafe-inline");
  expect(html).toContain("nonce-");
  expect(response.headers.get("Content-Length")).toBeNull();
  expect(response.headers.get("ETag")).toBeNull();
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

it.each([
  { path: "/", destination: "document", showBanner: false },
  { path: "/", destination: "iframe", showBanner: true },
  { path: "/style-12345678.css", destination: "style", showBanner: true },
])(
  "does not inject disabled banners, iframe previews or assets: $path/$destination/$showBanner",
  async ({ path, destination, showBanner }) => {
    server.use(
      http.get(endpoint, () => {
        return HttpResponse.json({
          allowed: true,
          decision: "allow",
          presentation: {
            showBanner,
            title: "Report",
            siteUrl: "https://demo.okou.app/",
          },
        });
      }),
    );
    const response = await fetchWorker(
      new Request(`https://demo.okou.app${path}`, {
        headers: { "Sec-Fetch-Dest": destination },
      }),
      {
        ...environment(),
        HOSTED_SITE_AUTH_URL: "https://app.okou.ai/hosted-site-authorize",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("okou-site-banner");
  },
);

it("delivers the original document when the rollout omits presentation metadata", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({ allowed: true, decision: "allow" });
    }),
  );
  const original =
    "<!doctype html><html><body><h1>Business report</h1></body></html>";
  const response = await fetchWorker(
    new Request("https://demo.okou.app/", {
      headers: { "Sec-Fetch-Dest": "document" },
    }),
    {
      ...environment(true, undefined, "okou", false, original),
      HOSTED_SITE_AUTH_URL: "https://app.okou.ai/hosted-site-authorize",
    },
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(original);
});

it("fetches the latest banner preference on refresh without republishing", async () => {
  let showBanner = true;
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({
        allowed: true,
        decision: "allow",
        presentation: {
          showBanner,
          title: "Report",
          siteUrl: "https://demo.okou.app/",
        },
      });
    }),
  );
  const env = {
    ...environment(),
    HOSTED_SITE_AUTH_URL: "https://app.okou.ai/hosted-site-authorize",
  };
  const request = () => {
    return new Request("https://demo.okou.app/", {
      headers: { Accept: "text/html" },
    });
  };
  expect(await (await fetchWorker(request(), env)).text()).toContain(
    'id="okou-site-banner"',
  );
  showBanner = false;
  expect(await (await fetchWorker(request(), env)).text()).toBe("<p>ok</p>");
});

it("preserves publisher inline scripts and styles already permitted by CSP", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({
        allowed: true,
        decision: "allow",
        presentation: {
          showBanner: true,
          title: "Report",
          siteUrl: "https://demo.okou.app/",
        },
      });
    }),
  );
  const source =
    "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'unsafe-inline'; style-src 'unsafe-inline'\"><style>body{color:teal}</style></head><body><script>window.publisherReady=true</script></body></html>";
  const response = await fetchWorker(
    new Request("https://demo.okou.app/", { headers: { Accept: "text/html" } }),
    {
      ...environment(true, undefined, "okou", true, source),
      HOSTED_SITE_AUTH_URL: "https://app.okou.ai/hosted-site-authorize",
    },
  );
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain('id="okou-site-banner"');
  expect(html).not.toContain("script-src-elem");
  expect(html).not.toContain("style-src-elem");
  expect(html).toContain("<style>body{color:teal}</style>");
  expect(html).toContain("<script>window.publisherReady=true</script>");
});

it("keeps an unsupported compressed document readable without rewriting its bytes", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({
        allowed: true,
        decision: "allow",
        presentation: {
          showBanner: true,
          title: "Report",
          siteUrl: "https://demo.okou.app/",
        },
      });
    }),
  );
  // A Brotli-encoded HTML document from the external storage boundary.
  const body = new Uint8Array([
    27, 25, 0, 248, 141, 148, 171, 171, 83, 205, 227, 51, 132, 38, 99, 218, 222,
    114, 16, 66, 106, 73, 64, 136, 169, 231, 204, 238, 78, 244,
  ]);
  const env = {
    ...environment(true, undefined, "okou", true, body, "br"),
    HOSTED_SITE_AUTH_URL: "https://app.okou.ai/hosted-site-authorize",
  };
  const response = await fetchWorker(
    new Request("https://demo.okou.app/", { headers: { Accept: "text/html" } }),
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Encoding")).toBe("br");
  expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(body);
});

it("fails closed without a configured authority", async () => {
  expect(
    (
      await fetchWorker(
        new Request("https://demo.okou.app/"),
        environment(false),
      )
    ).status,
  ).toBe(503);
});

it.each(["/", "/style-12345678.css"])(
  "never reads restricted content without a site session: %s",
  async (path) => {
    let reads = 0;
    server.use(
      http.get(endpoint, () => {
        return HttpResponse.json({ allowed: false, decision: "authenticate" });
      }),
    );
    const response = await fetchWorker(
      new Request(`https://demo.okou.app${path}`),
      environment(true, async () => {
        reads++;
      }),
    );
    expect(response.status).toBe(401);
    expect(reads).toBe(0);
  },
);

it.each(["GET", "HEAD"])(
  "isolates restricted scripts from sibling hosts while preserving Public embedding: %s",
  async (method) => {
    const token = `okou_site_${"a".repeat(64)}`;
    for (const restricted of [true, false]) {
      server.use(
        http.get(endpoint, ({ request }) => {
          return HttpResponse.json(
            restricted &&
              request.headers.get("Authorization") !== `Bearer ${token}`
              ? { allowed: false, decision: "authenticate" }
              : { allowed: true, decision: "allow" },
          );
        }),
      );
      const response = await fetchWorker(
        new Request("https://demo.okou.app/report-12345678.js", {
          method,
          headers: {
            Cookie: `__Host-okou-site-session=${token}`,
            Origin: "https://another-publisher.okou.app",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "no-cors",
            "Sec-Fetch-Dest": "script",
          },
        }),
        environment(),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "application/javascript",
      );
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
        restricted ? "same-origin" : null,
      );
      expect(await response.text()).toBe(
        method === "GET" ? "window.privateReport = 42;" : "",
      );
    }
  },
);

it("checks a controlled download grant on every GET and HEAD, without caching the bytes", async () => {
  let allowed = true;
  let reads = 0;
  const token = "a".repeat(48);
  server.use(
    http.get(
      "https://authority.test/api/host/downloads/:token",
      ({ request, params }) => {
        expect(params.token).toBe(token);
        expect(new URL(request.url).searchParams.get("deploymentId")).toBe(
          deploymentId,
        );
        expect(new URL(request.url).searchParams.get("path")).toBe(
          "/index.html",
        );
        return HttpResponse.json({
          file: allowed
            ? { key: `${prefix}/index.html`, contentType: "text/html", size: 9 }
            : null,
        });
      },
    ),
  );
  const env = environment(true, async () => {
    reads++;
  });
  const url = `https://dpl-${deploymentId}.okou.app/.okou/download/${token}?path=%2Findex.html`;
  const first = await fetchWorker(new Request(url), env);
  expect(first.status).toBe(200);
  expect(await first.text()).toBe("<p>ok</p>");
  expect(first.headers.get("Content-Disposition")).toBe(
    "attachment; filename*=UTF-8''index.html",
  );
  expect(first.headers.get("Cache-Control")).toBe("private, no-store");
  const head = await fetchWorker(new Request(url, { method: "HEAD" }), env);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  allowed = false;
  expect((await fetchWorker(new Request(url), env)).status).toBe(404);
  expect(reads).toBe(2);
});

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
        return HttpResponse.json({
          allowed,
          decision: allowed ? "allow" : "deny",
        });
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

it("serves a renamed alias through the current binding without changing immutable URLs", async () => {
  server.use(
    http.get(
      "https://authority.test/api/host/aliases/:publicSlug",
      ({ params }) => {
        return HttpResponse.json({
          pointer:
            params.publicSlug === "renamed"
              ? {
                  version: 1,
                  publicBrand: "okou",
                  publicSlug: "demo",
                  siteId,
                  deploymentId,
                  prefix,
                  manifestKey: `${prefix}/manifest.json`,
                  spaFallback: false,
                  updatedAt: "2026-10-19T00:00:00Z",
                }
              : null,
        });
      },
    ),
    http.get(endpoint, ({ request }) => {
      const alias = new URL(request.url).searchParams.get("alias");
      return HttpResponse.json({
        allowed: alias === "renamed" || alias === `dpl-${deploymentId}`,
        decision:
          alias === "renamed" || alias === `dpl-${deploymentId}`
            ? "allow"
            : "deny",
      });
    }),
  );
  const env = environment(true, undefined, "okou", true);
  const renamed = await fetchWorker(
    new Request("https://renamed.okou.app/"),
    env,
  );
  expect(renamed.status).toBe(200);
  expect(await renamed.text()).toBe("<p>ok</p>");
  expect(renamed.headers.get("Cache-Control")).toContain("no-store");
  expect(
    (await fetchWorker(new Request("https://demo.okou.app/"), env)).status,
  ).toBe(404);
  expect(
    (
      await fetchWorker(
        new Request(`https://dpl-${deploymentId}.okou.app/`),
        env,
      )
    ).status,
  ).toBe(200);
});

it("requires current authority even when an alias resolver returns a pointer", async () => {
  server.use(
    http.get("https://authority.test/api/host/aliases/:publicSlug", () => {
      return HttpResponse.json({
        pointer: {
          version: 1,
          publicBrand: "okou",
          publicSlug: "demo",
          siteId,
          deploymentId,
          prefix,
          manifestKey: `${prefix}/manifest.json`,
          spaFallback: false,
          updatedAt: "2026-10-19T00:00:00Z",
        },
      });
    }),
    http.get(endpoint, () => {
      return HttpResponse.json({ allowed: false, decision: "deny" });
    }),
  );
  const response = await fetchWorker(
    new Request("https://renamed.okou.app/"),
    environment(),
  );
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
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
          { allowed, decision: allowed ? "allow" : "deny" },
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

it("keeps protected assets out of HTTP caches", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({ allowed: true, decision: "allow" });
    }),
  );
  const url = "https://demo.okou.app/style-12345678.css";
  const protectedResponse = await fetchWorker(new Request(url), environment());
  expect(protectedResponse.status).toBe(200);
  expect(protectedResponse.headers.get("Cache-Control")).toContain("no-store");
});

it("rejects new requests after revocation but lets an already admitted read finish", async () => {
  let allowed = true;
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({
        allowed,
        decision: allowed ? "allow" : "deny",
      });
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
      return HttpResponse.json({ allowed: true, decision: "allow" });
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
      return HttpResponse.json({ allowed: true, decision: "allow" });
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
  "normalizes authored image URLs on %s when artifact previews are enabled",
  async (alias) => {
    server.use(
      http.get(endpoint, () => {
        return HttpResponse.json({ allowed: true, decision: "allow" });
      }),
      http.get("https://authority.test/api/artifact-og/metadata", () => {
        return HttpResponse.json({
          available: true,
          title: "Report",
          description: "Summary",
          url: `https://${alias}.okou.app/`,
          imageUrl: "https://authority.test/platform-cover.png",
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
    expect(html).not.toContain("platform-cover.png");
    expect(html).toContain('property="og:title" content="Report"');
    expect(html).toContain(
      `name="twitter:image" content="https://${alias}.okou.app/cover.png"`,
    );
    expect(response.headers.get("ETag")).toBeNull();
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  },
);

it.each(["disabled", "unavailable"])(
  "keeps public HTML readable when OG is %s",
  async (state) => {
    server.use(
      http.get(endpoint, () => {
        return HttpResponse.json({ allowed: true, decision: "allow" });
      }),
      http.get("https://authority.test/api/artifact-og/metadata", () => {
        return state === "disabled"
          ? HttpResponse.json({ available: false })
          : new HttpResponse(null, { status: 503 });
      }),
    );
    const body = '<body><img src="cover.png">Report</body>';
    const documentMetadata =
      '<title>Report</title><meta name="description" content="Authored summary"><link rel="canonical" href="https://reports.example/report">';
    const original =
      "<head>" +
      documentMetadata +
      '<meta property="og:image" content="cover.png"><meta property="og:image:width" content="1200"><meta property="og:image:secure_url" content="https://images.example/cover.png"><meta name="twitter:image" content="https://images.example/twitter.png"></head>' +
      body;
    const response = await fetchWorker(new Request("https://demo.okou.app/"), {
      ...environment(true, undefined, "okou", true, original),
      ARTIFACT_OG_API_ORIGIN: "https://authority.test",
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    if (state === "disabled") {
      expect(html).toContain(
        `property="og:image" content="${ARTIFACT_OG_BRAND.imageUrl}"`,
      );
      expect(html).toContain(
        `name="twitter:image" content="${ARTIFACT_OG_BRAND.imageUrl}"`,
      );
      expect(html).not.toContain('property="og:image:width"');
      expect(html).not.toContain('property="og:image:secure_url"');
      expect(html).not.toContain("images.example");
      expect(html).toContain(documentMetadata);
      expect(html).toContain('property="og:title" content="Okou"');
      expect(html).toContain(body);
      expect(response.headers.get("ETag")).toBeNull();
      expect(response.headers.get("Content-Length")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
      expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
        "no-store",
      );
    } else {
      expect(html).toBe(original);
      expect(response.headers.get("ETag")).toBe('"hosted"');
    }
  },
);

it("handles a real alias's authorization callback before reading hosted HTML", async () => {
  server.use(
    http.get(endpoint, () => {
      return HttpResponse.json({ allowed: false, decision: "authenticate" });
    }),
  );
  const env = {
    ...environment(),
    HOSTED_SITE_AUTH_URL: "https://app.okou.ai/hosted-site-authorize",
  };
  const initial = await fetchWorker(
    new Request("https://demo.okou.app/", { headers: { Accept: "text/html" } }),
    env,
  );
  expect(initial.status).toBe(302);
  expect(new URL(initial.headers.get("Location")!).pathname).toBe(
    "/hosted-site-access",
  );
  const resumed = await fetchWorker(
    new Request("https://demo.okou.app/.okou/auth/start?returnTo=%2F", {
      headers: { Accept: "text/html" },
    }),
    env,
  );
  const bridge = new URL(resumed.headers.get("Location")!);
  expect(bridge.searchParams.get("siteId")).toBe(siteId);
  const pending = resumed.headers.getSetCookie()[0]!.split(";")[0]!;
  server.use(
    http.post(
      `https://authority.test/api/host/sites/${siteId}/sessions`,
      () => {
        return HttpResponse.json({
          sessionToken: `okou_site_${"a".repeat(64)}`,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      },
    ),
  );
  const response = await fetchWorker(
    new Request(
      `https://demo.okou.app/.okou/auth/callback?code=${"b".repeat(64)}&state=${bridge.searchParams.get("state")}`,
      { headers: { Cookie: pending } },
    ),
    env,
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("https://demo.okou.app/");
  expect(response.headers.getSetCookie().join(";")).toContain(
    "__Host-okou-site-session=",
  );
  expect(await response.text()).toBe("");
});
