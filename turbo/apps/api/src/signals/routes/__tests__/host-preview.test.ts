import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { artifactAccessRoutes } from "../artifact-access";
import { artifactOgRoutes } from "../artifact-og";
import { artifactReferenceRoutes } from "../artifact-references";
import { hostRoutes } from "../host";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const COVER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
]);

interface StoredObject {
  readonly body: Buffer;
  readonly contentType?: string;
}

interface StoragePut {
  readonly bucket: string;
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: unknown;
  readonly ifNoneMatch: unknown;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return headers;
}

function storageError(name: string, status: number): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

/** In-memory R2: presigned PUT URLs address the object a browser writes. */
function installStorage() {
  const objects = new Map<string, StoredObject>();
  const puts: StoragePut[] = [];
  const signed = new Map<string, { bucket: string; key: string }>();
  const id = (bucket: unknown, key: unknown) => {
    return `${String(bucket)}/${String(key)}`;
  };

  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      const { constructor, input } = command as {
        readonly constructor: { readonly name: string };
        readonly input: { readonly Bucket: string; readonly Key: string };
      };
      const url = `https://r2.example.test/${input.Bucket}/${input.Key}?op=${constructor.name}&n=${String(signed.size)}`;
      signed.set(url, { bucket: input.Bucket, key: input.Key });
      return Promise.resolve(url);
    },
  );

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const { constructor, input } = command as {
      readonly constructor: { readonly name: string };
      readonly input: Record<string, unknown>;
    };
    const stored = objects.get(id(input.Bucket, input.Key));
    switch (constructor.name) {
      case "PutObjectCommand": {
        if (input.IfNoneMatch === "*" && stored) {
          return Promise.reject(storageError("PreconditionFailed", 412));
        }
        const body = Buffer.from(input.Body as string | Uint8Array);
        objects.set(id(input.Bucket, input.Key), {
          body,
          contentType: input.ContentType as string | undefined,
        });
        puts.push({
          bucket: String(input.Bucket),
          key: String(input.Key),
          body,
          contentType: input.ContentType,
          ifNoneMatch: input.IfNoneMatch,
        });
        return Promise.resolve({ ETag: `"${sha256(body)}"` });
      }
      case "GetObjectCommand": {
        if (!stored) {
          return Promise.reject(storageError("NoSuchKey", 404));
        }
        return Promise.resolve({
          Body: Readable.from([stored.body]),
          ContentLength: stored.body.byteLength,
          ContentType: stored.contentType,
          ETag: `"${sha256(stored.body)}"`,
        });
      }
      case "HeadObjectCommand": {
        if (!stored) {
          return Promise.reject(storageError("NotFound", 404));
        }
        return Promise.resolve({
          ContentLength: stored.body.byteLength,
          ContentType: stored.contentType,
          LastModified: new Date("2026-01-01T00:00:00.000Z"),
          ETag: `"${sha256(stored.body)}"`,
        });
      }
      case "DeleteObjectsCommand": {
        const deleted = (input.Delete as { Objects?: { Key: string }[] })
          .Objects;
        for (const entry of deleted ?? []) {
          objects.delete(id(input.Bucket, entry.Key));
        }
        return Promise.resolve({});
      }
      case "ListObjectsV2Command": {
        const prefix = id(input.Bucket, input.Prefix);
        return Promise.resolve({
          Contents: [...objects]
            .filter(([key]) => {
              return key.startsWith(prefix);
            })
            .map(([key, object]) => {
              return {
                Key: key.slice(String(input.Bucket).length + 1),
                Size: object.body.byteLength,
                LastModified: new Date("2026-01-01T00:00:00.000Z"),
              };
            }),
          IsTruncated: false,
        });
      }
      default: {
        return Promise.resolve({});
      }
    }
  });

  return {
    puts,
    /** The browser PUTs bytes to a presigned upload URL. */
    upload(uploadUrl: string, body: Buffer, contentType: string) {
      const target = signed.get(uploadUrl);
      if (!target) {
        throw new Error(`Unknown upload URL ${uploadUrl}`);
      }
      objects.set(id(target.bucket, target.key), { body, contentType });
    },
    read(bucket: string, key: string) {
      return objects.get(id(bucket, key))?.body;
    },
    /** Bytes behind a presigned GET URL issued by this storage. */
    readSigned(url: string) {
      const [bucket = "", ...key] = new URL(url).pathname.slice(1).split("/");
      return objects.get(id(bucket, key.join("/")))?.body;
    },
    /** The bucket and key a presigned upload URL addresses. */
    target(uploadUrl: string) {
      const target = signed.get(uploadUrl);
      if (!target) {
        throw new Error(`Unknown upload URL ${uploadUrl}`);
      }
      return target;
    },
  };
}

type Storage = ReturnType<typeof installStorage>;

function hostApi() {
  return setupApp({ context, routes: hostRoutes })(hostContract);
}

const HTML = "<html><head><title>Cover</title></head><body>Hi</body></html>";

async function prepareWithCover(
  owner: ApiTestUser,
  storage: Storage,
  visibility?: "public",
  options: {
    readonly site?: string;
    readonly html?: string;
    readonly cover?: Buffer;
  } = {},
) {
  const site = options.site ?? `cover-${randomUUID().slice(0, 8)}`;
  const html = options.html ?? HTML;
  const cover = options.cover ?? COVER;
  const response = await accept(
    hostApi().prepare({
      headers: signIn(owner),
      body: {
        ...(visibility ? { visibility } : {}),
        site,
        title: "Cover site",
        artifactKind: "hosted-site",
        spaFallback: false,
        files: [
          {
            path: "/index.html",
            size: Buffer.byteLength(html),
            sha256: sha256(html),
            contentType: "text/html; charset=utf-8",
          },
        ],
        preview: {
          size: cover.byteLength,
          sha256: sha256(cover),
          contentType: "image/png",
        },
      },
    }),
    [200],
  );
  for (const upload of response.body.uploads) {
    storage.upload(upload.uploadUrl, Buffer.from(html), "text/html");
  }
  const preview = response.body.preview;
  if (!preview) {
    throw new Error("Expected a preview upload grant");
  }
  return { ...response.body, site, preview };
}

function complete(owner: ApiTestUser, deploymentId: string) {
  return hostApi().complete({
    headers: signIn(owner),
    params: { deploymentId },
    body: {},
  });
}

const OG_HTML =
  '<html><head><title>Quarterly &amp; Annual</title><meta name="description" content="Public summary"></head><body>Q</body></html>';

function ogApi() {
  return setupApp({ context, routes: artifactOgRoutes })(artifactOgContract);
}

function ogImage(
  target: { readonly kind: "host"; readonly id: string },
  version: string,
  variant?: "slack",
) {
  return accept(
    ogApi().image({
      query: { ...target, version, ...(variant ? { variant } : {}) },
    }),
    [302],
  );
}

/** The cover version the anonymous OG metadata advertises in its image URL. */
function advertisedVersion(imageUrl: string): string {
  const advertised = decodeURIComponent(imageUrl).split(
    "/api/artifact-og/image?",
  )[1];
  return new URLSearchParams(advertised).get("version") ?? "";
}

function referenceOf(url: string): string {
  return new URL(url).pathname.split("/").at(-1) ?? "";
}

function coverPuts(storage: Storage) {
  return storage.puts.filter((put) => {
    return (
      put.bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME") &&
      put.body.equals(COVER)
    );
  });
}

describe("sandbox hosted previews", () => {
  it("host-preview-001 preserves original image/png bytes and file identity", async () => {
    const storage = installStorage();
    const owner = bdd.user();
    const prepared = await prepareWithCover(owner, storage);
    storage.upload(prepared.preview.uploadUrl, COVER, "image/png");

    const completed = await accept(
      complete(owner, prepared.deploymentId),
      [200],
    );
    const previewImageUrl = completed.body.previewImageUrl ?? "";
    const resolved = await accept(
      setupApp({ context, routes: artifactReferenceRoutes })(
        artifactReferencesContract,
      ).resolve({
        headers: signIn(owner),
        params: { reference: referenceOf(previewImageUrl) },
        query: {},
      }),
      [200],
    );
    const repeated = await accept(
      complete(owner, prepared.deploymentId),
      [200],
    );

    expect(prepared.preview.sha256).toBe(sha256(COVER));
    expect(previewImageUrl).toMatch(/\.png$/u);
    expect(
      coverPuts(storage).map((put) => {
        return {
          contentType: put.contentType,
          ifNoneMatch: put.ifNoneMatch,
        };
      }),
    ).toStrictEqual([{ contentType: "image/png", ifNoneMatch: "*" }]);
    expect(resolved.body).toMatchObject({
      contentType: "image/png",
      filename: `preview-${sha256(COVER)}.png`,
    });
    expect(repeated.body.previewImageUrl).toBe(previewImageUrl);
    expect(coverPuts(storage)).toHaveLength(1);
    const sealed = coverPuts(storage)[0];
    expect(
      sealed ? storage.read(sealed.bucket, sealed.key) : undefined,
    ).toStrictEqual(COVER);
  });

  it("host-preview-003 authorizes published covers through the current Site policy", async () => {
    const storage = installStorage();
    const owner = bdd.user();
    const outsider = bdd.user();
    const prepared = await prepareWithCover(owner, storage, "public");
    storage.upload(prepared.preview.uploadUrl, COVER, "image/png");
    await accept(complete(owner, prepared.deploymentId), [200]);
    const preview = (actor: ApiTestUser) => {
      return hostApi().sitePreview({
        headers: signIn(actor),
        params: { publicSlug: prepared.publicSlug },
        query: { hostname: `${prepared.publicSlug}.okou.app` },
      });
    };

    const ownerFirst = await accept(preview(owner), [200]);
    const ownerRepeat = await accept(preview(owner), [200]);
    const outsiderPublic = await accept(preview(outsider), [200]);
    const accessApi = setupApp({ context, routes: artifactAccessRoutes })(
      artifactAccessContract,
    );
    await accept(
      accessApi.updateVisibility({
        headers: signIn(owner),
        params: { artifactId: prepared.siteId },
        body: { visibility: "private" },
      }),
      [200],
    );
    const ownerPrivate = await accept(preview(owner), [200]);
    const outsiderPrivate = await accept(preview(outsider), [404]);

    const cover = ownerFirst.body.previewImageUrl ?? "";
    expect(ownerFirst.body.url).toMatch(/^https:\/\/pv-/u);
    expect(ownerFirst.body.expiresAt).not.toBeNull();
    expect(cover).toContain(`/${env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")}/`);
    expect(ownerRepeat.body).toStrictEqual(ownerFirst.body);
    expect(outsiderPublic.body).toStrictEqual({
      url: `https://${prepared.publicSlug}.okou.app/`,
      expiresAt: null,
      previewImageUrl: cover,
    });
    expect(ownerPrivate.body.url).toMatch(/^https:\/\/pv-/u);
    expect(ownerPrivate.body.previewImageUrl).toBe(cover);
    expect(outsiderPrivate.status).toBe(404);
  });

  it("host-preview-005 (1/2) advertises the published cover and redirects to its original bytes", async () => {
    const storage = installStorage();
    const owner = bdd.user();
    const first = await prepareWithCover(owner, storage, "public", {
      html: OG_HTML,
    });
    const target = { kind: "host", id: first.deploymentId } as const;

    const pending = await accept(ogApi().metadata({ query: target }), [200]);
    storage.upload(first.preview.uploadUrl, COVER, "image/png");
    await accept(complete(owner, first.deploymentId), [200]);
    const published = await accept(ogApi().metadata({ query: target }), [200]);
    if (!published.body.available) {
      throw new Error("Expected published OG metadata");
    }
    const version = advertisedVersion(published.body.imageUrl);
    const original = await ogImage(target, version);
    const slack = await ogImage(target, version, "slack");
    const brand = await accept(ogApi().defaultImage(), [302]);
    const wrongVersion = await ogImage(target, `${version}-stale`);

    expect(pending.body).toStrictEqual({ available: false });
    expect(published.body).toMatchObject({
      title: "Quarterly & Annual",
      description: "Public summary",
    });
    expect(published.body.imageUrl).toContain("/cdn-cgi/image/");
    expect(JSON.stringify(published.body)).not.toContain(
      env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME"),
    );
    expect(
      storage.readSigned(original.headers.get("location") ?? ""),
    ).toStrictEqual(COVER);
    expect(new URL(slack.headers.get("location") ?? "").pathname).toBe(
      new URL(original.headers.get("location") ?? "").pathname,
    );
    expect(original.headers.get("cache-control")).toBe("private, no-store");
    expect(original.headers.get("cdn-cache-control")).toBe("no-store");
    expect(brand.headers.get("location")).toBeTruthy();
    expect(wrongVersion.headers.get("location")).toBe(
      brand.headers.get("location"),
    );
  });

  it("host-preview-005 (2/2) retains the older cover version and revokes OG on deletion", async () => {
    const storage = installStorage();
    const owner = bdd.user();
    const first = await prepareWithCover(owner, storage, "public", {
      html: OG_HTML,
    });
    const target = { kind: "host", id: first.deploymentId } as const;
    storage.upload(first.preview.uploadUrl, COVER, "image/png");
    await accept(complete(owner, first.deploymentId), [200]);
    const published = await accept(ogApi().metadata({ query: target }), [200]);
    if (!published.body.available) {
      throw new Error("Expected published OG metadata");
    }
    const version = advertisedVersion(published.body.imageUrl);
    const brand = await accept(ogApi().defaultImage(), [302]);

    const newerCover = Buffer.concat([COVER, Buffer.from([0x01])]);
    const second = await prepareWithCover(owner, storage, "public", {
      site: first.site,
      html: OG_HTML,
      cover: newerCover,
    });
    storage.upload(second.preview.uploadUrl, newerCover, "image/png");
    await accept(complete(owner, second.deploymentId), [200]);
    const retained = await ogImage(target, version);
    await accept(
      hostApi().deleteSite({
        headers: signIn(owner),
        params: { publicSlug: first.publicSlug },
      }),
      [200],
    );
    const deleted = await accept(ogApi().metadata({ query: target }), [200]);
    const revoked = await ogImage(target, version);

    expect(
      storage.readSigned(retained.headers.get("location") ?? ""),
    ).toStrictEqual(COVER);
    expect(deleted.body).toStrictEqual({ available: false });
    expect(revoked.headers.get("location")).toBe(brand.headers.get("location"));
  });

  it("host-preview-008 does not activate missing or mismatched covers and permits repair", async () => {
    const storage = installStorage();
    const owner = bdd.user();
    const prepared = await prepareWithCover(owner, storage);
    const staging = storage.target(prepared.preview.uploadUrl);
    const tampered = Buffer.from(COVER);
    tampered[0] = 0x00;

    const missing = await accept(complete(owner, prepared.deploymentId), [400]);
    storage.upload(
      prepared.preview.uploadUrl,
      COVER.subarray(0, COVER.byteLength - 4),
      "image/png",
    );
    const incomplete = await accept(
      complete(owner, prepared.deploymentId),
      [400],
    );
    storage.upload(prepared.preview.uploadUrl, tampered, "image/png");
    const mismatched = await accept(
      complete(owner, prepared.deploymentId),
      [400],
    );
    const pending = await accept(
      hostApi().deployments({
        headers: signIn(owner),
        params: { site: prepared.site },
      }),
      [200],
    );
    storage.upload(prepared.preview.uploadUrl, COVER, "image/png");
    const repaired = await accept(
      complete(owner, prepared.deploymentId),
      [200],
    );
    const stagingAfterRepair = storage.read(staging.bucket, staging.key);
    storage.upload(prepared.preview.uploadUrl, tampered, "image/png");
    const replayed = await accept(
      complete(owner, prepared.deploymentId),
      [200],
    );

    expect([
      missing.status,
      incomplete.status,
      mismatched.status,
    ]).toStrictEqual([400, 400, 400]);
    expect(pending.body.activeDeploymentId).toBeNull();
    expect(
      pending.body.deployments.map((deployment) => {
        return [deployment.deploymentId, deployment.status];
      }),
    ).toStrictEqual([[prepared.deploymentId, "uploading"]]);
    expect(repaired.body.previewImageUrl).toBeTruthy();
    expect(stagingAfterRepair).toBeUndefined();
    expect(replayed.body.previewImageUrl).toBe(repaired.body.previewImageUrl);
    const sealed = coverPuts(storage);
    expect(sealed).toHaveLength(1);
    expect(
      sealed[0] ? storage.read(sealed[0].bucket, sealed[0].key) : undefined,
    ).toStrictEqual(COVER);
  });
});
