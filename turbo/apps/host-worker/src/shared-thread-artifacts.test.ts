import { expect, test } from "vitest";
import { artifactDeliveryKey } from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  sharedThreadArtifactPolicyKey,
  type SharedThreadArtifactPolicy,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import worker from "./index";
import { fetchWorker } from "./test-helpers";

type Env = Parameters<typeof worker.fetch>[1];

function fixture(tokenLength = 10) {
  const threadId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();
  const siteId = crypto.randomUUID();
  const fileToken = crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, tokenLength);
  const siteToken = crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, tokenLength);
  const fileKey = `private-artifacts/${fileId}/thread-shares/${threadId}/${fileToken}/video.mp4`;
  const prefix = `shared-artifacts/okou/${threadId}/${deploymentId}`;
  const policy: SharedThreadArtifactPolicy = {
    version: 1,
    threadId,
    ownerId: "owner",
    orgId: "organization",
    publicBrand: "okou",
    status: "active",
    resources: {
      [fileToken]: {
        kind: "file",
        id: fileId,
        key: fileKey,
        filename: "video.mp4",
        contentType: "video/mp4",
      },
      [siteToken]: {
        kind: "html",
        id: deploymentId,
        siteId,
        snapshotId: threadId,
        deploymentVersion: 1,
        manifest: {
          version: 1,
          access: "owner-private-v1",
          publicBrand: "okou",
          deploymentId,
          siteId,
          publicSlug: "private-source",
          createdAt: "2026-09-14T00:00:00Z",
          spaFallback: true,
          files: {
            "/index.html": {
              path: "/index.html",
              size: 21,
              sha256: "html",
              contentType: "text/html",
            },
            "/assets/style.css": {
              path: "/assets/style.css",
              size: 10,
              sha256: "css",
              contentType: "text/css",
            },
          },
        },
      },
    },
  };
  const policyKey = sharedThreadArtifactPolicyKey("okou", threadId);
  const objects = new Map<string, string>([
    [policyKey, JSON.stringify(policy)],
    [fileKey, "0123456789"],
    [`${prefix}/index.html`, "<h1>Snapshot one</h1>"],
    [`${prefix}/assets/style.css`, "body{color:red}"],
  ]);
  for (const [token, kind, alias] of [
    [fileToken, "file", `${fileToken}.mp4`],
    [siteToken, "html", siteToken],
  ] as const) {
    objects.set(
      artifactDeliveryKey("okou", kind, alias),
      JSON.stringify({
        version: 1,
        kind: "thread-resource",
        threadId,
        publicBrand: "okou",
        publicToken: token,
        targetKind: kind,
        ...(tokenLength === 10
          ? { targetId: kind === "file" ? fileId : deploymentId }
          : {}),
      }),
    );
  }
  const bucket: Env["HOSTED_SITES_BUCKET"] = {
    head: async (key) => {
      const value = objects.get(key);
      return value === undefined
        ? null
        : {
            size: new TextEncoder().encode(value).byteLength,
            httpEtag: '"snapshot"',
          };
    },
    get: async (key, options) => {
      const value = objects.get(key);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return {
        size: bytes.length,
        body: new Response(
          options
            ? bytes.slice(
                options.range.offset,
                options.range.offset + options.range.length,
              )
            : bytes,
        ).body!,
        httpEtag: '"snapshot"',
        writeHttpMetadata() {},
      };
    },
  };
  const env: Env = {
    HOSTED_SITES_BUCKET: bucket,
    PRIVATE_ARTIFACTS_BUCKET: bucket,
    PUBLIC_ARTIFACT_HOST: "a.okou.io",
    HOST_DOMAIN: "sites.vm0.io",
    OKOU_HOST_DOMAIN: "okou.app",
  };
  const fileUrl = `https://a.okou.io/${fileToken}.mp4`;
  const siteUrl = `https://${siteToken}.okou.app/`;
  return { env, objects, policy, policyKey, fileUrl, siteUrl };
}

test.each([10, 24])(
  "%i-character snapshot links deliver fixed file bytes, ranges, and complete site resources",
  async (tokenLength) => {
    const f = fixture(tokenLength);
    const file = await fetchWorker(new Request(f.fileUrl), f.env);
    expect(file.status).toBe(200);
    expect(file.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(await file.text()).toBe("0123456789");
    const range = await fetchWorker(
      new Request(f.fileUrl, { headers: { Range: "bytes=2-5" } }),
      f.env,
    );
    expect(range.status).toBe(206);
    expect(range.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(range.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await range.text()).toBe("2345");
    expect(
      await (await fetchWorker(new Request(f.siteUrl), f.env)).text(),
    ).toBe("<h1>Snapshot one</h1>");
    expect(
      await (
        await fetchWorker(new Request(`${f.siteUrl}assets/style.css`), f.env)
      ).text(),
    ).toBe("body{color:red}");
    expect(
      await (
        await fetchWorker(
          new Request(`${f.siteUrl}nested/page`, {
            headers: { Accept: "text/html" },
          }),
          f.env,
        )
      ).text(),
    ).toBe("<h1>Snapshot one</h1>");
  },
);

test.each(["file", "html"] as const)(
  "a snapshot alias cannot resolve a different %s target",
  async (kind) => {
    const f = fixture();
    const url = kind === "file" ? f.fileUrl : f.siteUrl;
    const parsed = new URL(url);
    const alias =
      kind === "file"
        ? parsed.pathname.slice(1)
        : parsed.hostname.split(".")[0]!;
    const key = artifactDeliveryKey("okou", kind, alias);
    const record = JSON.parse(f.objects.get(key)!) as Record<string, unknown>;
    f.objects.set(
      key,
      JSON.stringify({ ...record, targetId: crypto.randomUUID() }),
    );
    expect((await fetchWorker(new Request(url), f.env)).status).toBe(404);
  },
);

test("hosted resources in one conversation keep independent content caches", async () => {
  const f = fixture();
  const firstTarget = Object.values(f.policy.resources).find((target) => {
    return target.kind === "html";
  });
  if (!firstTarget) {
    throw new Error("Expected a hosted snapshot target");
  }
  const token = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  const deploymentId = crypto.randomUUID();
  const siteId = crypto.randomUUID();
  const content = "<h1>Snapshot two</h1>";
  const target = {
    ...firstTarget,
    id: deploymentId,
    siteId,
    manifest: {
      ...firstTarget.manifest,
      deploymentId,
      siteId,
      publicSlug: "private-source-two",
      files: {
        "/index.html": {
          path: "/index.html",
          size: content.length,
          sha256: "html-two",
          contentType: "text/html",
        },
      },
    },
  };
  f.objects.set(
    f.policyKey,
    JSON.stringify({
      ...f.policy,
      resources: { ...f.policy.resources, [token]: target },
    }),
  );
  f.objects.set(
    artifactDeliveryKey("okou", "html", token),
    JSON.stringify({
      version: 1,
      kind: "thread-resource",
      threadId: f.policy.threadId,
      publicBrand: "okou",
      publicToken: token,
      targetKind: "html",
    }),
  );
  f.objects.set(
    `shared-artifacts/okou/${f.policy.threadId}/${deploymentId}/index.html`,
    content,
  );

  expect(await (await fetchWorker(new Request(f.siteUrl), f.env)).text()).toBe(
    "<h1>Snapshot one</h1>",
  );
  expect(
    await (
      await fetchWorker(new Request(`https://${token}.okou.app/`), f.env)
    ).text(),
  ).toBe(content);
});

test("revoking the parent denies network requests with warm Worker caches, including ranges and HTML subresources", async () => {
  const f = fixture();
  const urls = [f.fileUrl, f.siteUrl, `${f.siteUrl}assets/style.css`];
  for (const url of urls) {
    for (const method of ["GET", "GET", "HEAD"]) {
      const response = await fetchWorker(new Request(url, { method }), f.env);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        "private, max-age=31536000, immutable",
      );
    }
  }
  f.objects.set(
    f.policyKey,
    JSON.stringify({ ...f.policy, status: "revoked" }),
  );
  for (const url of urls) {
    const denied = await fetchWorker(new Request(url), f.env);
    expect(denied.status).toBe(404);
    expect(denied.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(
    (
      await fetchWorker(
        new Request(f.fileUrl, { headers: { Range: "bytes=0-3" } }),
        f.env,
      )
    ).status,
  ).toBe(404);
  expect(
    (await fetchWorker(new Request(f.fileUrl, { method: "HEAD" }), f.env))
      .status,
  ).toBe(404);
});

test("unavailable snapshot content and invalid ranges are not cached by browsers", async () => {
  const f = fixture();
  const missing = await fetchWorker(
    new Request(`${f.siteUrl}assets/missing.css`),
    f.env,
  );
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("private, no-store");
  const range = await fetchWorker(
    new Request(f.fileUrl, { headers: { Range: "bytes=100-200" } }),
    f.env,
  );
  expect(range.status).toBe(416);
  expect(range.headers.get("cache-control")).toBe("private, no-store");
});

test.each([
  "preparing",
  "missing",
  "malformed",
  "wrong-thread",
  "wrong-namespace",
])("an %s parent policy never permits cached bytes", async (state) => {
  const f = fixture();
  expect((await fetchWorker(new Request(f.fileUrl), f.env)).status).toBe(200);
  if (state === "missing") f.objects.delete(f.policyKey);
  else if (state === "malformed") f.objects.set(f.policyKey, "{}");
  else if (state === "wrong-thread")
    f.objects.set(
      f.policyKey,
      JSON.stringify({ ...f.policy, threadId: crypto.randomUUID() }),
    );
  else if (state === "wrong-namespace") {
    const resources = Object.fromEntries(
      Object.entries(f.policy.resources).map(([token, target]) => {
        return [
          token,
          target.kind === "file"
            ? { ...target, key: `private-artifacts/${target.id}/original.mp4` }
            : target,
        ];
      }),
    );
    f.objects.set(f.policyKey, JSON.stringify({ ...f.policy, resources }));
  } else
    f.objects.set(
      f.policyKey,
      JSON.stringify({ ...f.policy, status: "preparing" }),
    );
  expect((await fetchWorker(new Request(f.fileUrl), f.env)).status).toBe(404);
});

test("a policy storage outage fails closed even with a warm file cache", async () => {
  const f = fixture();
  expect((await fetchWorker(new Request(f.fileUrl), f.env)).status).toBe(200);
  const originalGet = f.env.HOSTED_SITES_BUCKET.get;
  const failedEnv: Env = {
    ...f.env,
    HOSTED_SITES_BUCKET: {
      ...f.env.HOSTED_SITES_BUCKET,
      get: (key, options) => {
        if (key === f.policyKey)
          return Promise.reject(new Error("Storage unavailable"));
        return originalGet(key, options);
      },
    },
  };
  const response = await fetchWorker(new Request(f.fileUrl), failedEnv);
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

test("snapshot publication cannot be used as an unrevocable image-transform source", async () => {
  const f = fixture();
  const response = await fetchWorker(
    new Request(f.fileUrl, { headers: { Via: "image-resizing" } }),
    f.env,
  );
  expect(response.status).toBe(404);
});
