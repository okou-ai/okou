import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { ARTIFACT_OG_BRAND } from "@okouai/core/artifact-og";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactOgRoutes } from "../artifact-og";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactShareRoutes } from "../artifact-shares";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { webFileUrlRoutes } from "../web-file-url";
import { ClerkTransportTestError } from "./helpers/clerk-transport-error";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const directory = createStore();
const headers = { authorization: "Bearer clerk-session" };
const APP_URL = "https://app.okou.ai";
const shortReportUrl =
  /^https:\/\/app\.okou\.ai\/artifacts\/[a-z0-9]{10}\.pdf$/u;

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

interface StoredObject {
  readonly body: Buffer;
  readonly etag: string;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

interface SignedUrl {
  readonly url: string;
  readonly operation: string;
  readonly bucket: string;
  readonly key: string;
  readonly expiresIn: number;
  readonly cacheControl: unknown;
  readonly signingDate: unknown;
}

function storageError(name: string, status: number): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

/** In-memory R2 with conditional writes; presigned PUT URLs name the object the browser writes. */
function installStorage() {
  const objects = new Map<string, StoredObject>();
  const signed: SignedUrl[] = [];
  let revision = 0;
  const id = (bucket: unknown, key: unknown) => {
    return `${String(bucket)}/${String(key)}`;
  };
  const write = (
    objectId: string,
    object: Omit<StoredObject, "etag">,
  ): string => {
    revision += 1;
    const etag = `"r${String(revision)}"`;
    objects.set(objectId, { ...object, etag });
    return etag;
  };
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown, options: unknown) => {
      const { constructor, input } = command as {
        readonly constructor: { readonly name: string };
        readonly input: {
          readonly Bucket: string;
          readonly Key: string;
          readonly ResponseCacheControl?: unknown;
        };
      };
      const signing = (options ?? {}) as {
        readonly expiresIn?: number;
        readonly signingDate?: unknown;
      };
      const url = new URL(
        `https://r2.example.test/${input.Bucket}/${input.Key}`,
      );
      url.searchParams.set("op", constructor.name);
      url.searchParams.set("signature", "temporary");
      url.searchParams.set("n", String(signed.length));
      signed.push({
        url: url.toString(),
        operation: constructor.name,
        bucket: input.Bucket,
        key: input.Key,
        expiresIn: signing.expiresIn ?? 0,
        cacheControl: input.ResponseCacheControl,
        signingDate: signing.signingDate,
      });
      return Promise.resolve(url.toString());
    },
  );
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const { constructor, input } = command as {
      readonly constructor: { readonly name: string };
      readonly input: Record<string, unknown>;
    };
    const objectId = id(input.Bucket, input.Key);
    const stored = objects.get(objectId);
    switch (constructor.name) {
      case "PutObjectCommand": {
        if (
          (input.IfNoneMatch === "*" && stored) ||
          (typeof input.IfMatch === "string" && stored?.etag !== input.IfMatch)
        ) {
          return Promise.reject(storageError("PreconditionFailed", 412));
        }
        const etag = write(objectId, {
          body: Buffer.from(input.Body as string | Uint8Array),
          contentType: input.ContentType as string | undefined,
        });
        return Promise.resolve({ ETag: etag });
      }
      case "CopyObjectCommand": {
        const source = String(input.CopySource);
        const bucket = String(input.Bucket);
        const sourceKey = source
          .slice(bucket.length + 1)
          .split("/")
          .map(decodeURIComponent)
          .join("/");
        const original = objects.get(id(bucket, sourceKey));
        if (!original) {
          return Promise.reject(storageError("NoSuchKey", 404));
        }
        const etag = write(objectId, {
          body: original.body,
          contentType: original.contentType,
          metadata: original.metadata,
        });
        return Promise.resolve({ CopyObjectResult: { ETag: etag } });
      }
      case "GetObjectCommand": {
        if (!stored) {
          return Promise.reject(storageError("NoSuchKey", 404));
        }
        return Promise.resolve({
          Body: Readable.from([stored.body]),
          ContentLength: stored.body.byteLength,
          ContentType: stored.contentType,
          ETag: stored.etag,
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
          Metadata: stored.metadata ?? {},
          ETag: stored.etag,
        });
      }
      case "DeleteObjectCommand": {
        objects.delete(objectId);
        return Promise.resolve({});
      }
      case "DeleteObjectsCommand": {
        const removal = input.Delete as {
          readonly Objects?: readonly { readonly Key?: string }[];
        };
        const deleted = (removal.Objects ?? []).map((object) => {
          objects.delete(id(input.Bucket, object.Key));
          return { Key: object.Key };
        });
        return Promise.resolve({ Deleted: deleted });
      }
      case "ListObjectsV2Command": {
        const prefix = id(input.Bucket, input.Prefix ?? "");
        return Promise.resolve({
          Contents: [...objects]
            .filter(([key]) => {
              return key.startsWith(prefix);
            })
            .map(([key, object]) => {
              return {
                Key: key.slice(String(input.Bucket).length + 1),
                Size: object.body.byteLength,
                ETag: object.etag,
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
    signed,
    /** Objects written under a key prefix of any bucket. */
    keys(prefix: string): string[] {
      return [...objects.keys()].filter((key) => {
        return key.split("/").slice(1).join("/").startsWith(prefix);
      });
    },
    /** The share policy object R2 received for a share ID. */
    policy(shareId: string): Record<string, unknown> {
      const key = [...objects.keys()].find((candidate) => {
        return candidate.endsWith(`/${shareId}.json`);
      });
      const stored = key ? objects.get(key) : undefined;
      if (!stored) {
        throw new Error(`No share policy object for ${shareId}`);
      }
      return JSON.parse(stored.body.toString("utf8")) as Record<
        string,
        unknown
      >;
    },
    /** The browser PUTs bytes to a presigned upload URL. */
    upload(
      uploadUrl: string,
      body: Buffer,
      contentType: string,
      uploadHeaders: Readonly<Record<string, string>>,
    ) {
      const target = signed.find((entry) => {
        return entry.url === uploadUrl;
      });
      if (!target) {
        throw new Error(`Unknown upload URL ${uploadUrl}`);
      }
      write(id(target.bucket, target.key), {
        body,
        contentType,
        metadata: Object.fromEntries(
          Object.entries(uploadHeaders).map(([name, value]) => {
            return [name.replace(/^x-amz-meta-/u, ""), value];
          }),
        ),
      });
    },
  };
}

type Storage = ReturnType<typeof installStorage>;

async function member(
  options: { readonly orgId?: string; readonly name?: string } = {},
): Promise<Actor> {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: options.orgId ?? `org_${randomUUID()}`,
  };
  await join(actor, options.name);
  return actor;
}

async function join(actor: Actor, name = "Original organization") {
  await directory.set(
    seedOrgMembership$,
    { ...actor, name, membershipId: `orgmem_${randomUUID()}` },
    context.signal,
  );
}

async function leave(actor: Actor) {
  await directory.set(deleteOrgMembership$, actor, context.signal);
}

function api() {
  const app = setupApp;
  return {
    uploads: app({
      context,
      routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
    })(uploadsContract),
    shares: app({ context, routes: artifactShareRoutes })(
      artifactSharesContract,
    ),
    references: app({ context, routes: artifactReferenceRoutes })(
      artifactReferencesContract,
    ),
    catalog: app({ context, routes: artifactCatalogRoutes })(
      artifactCatalogContract,
    ),
    files: app({ context, routes: webFileUrlRoutes })(webFilesContract),
    og: app({ context, routes: artifactOgRoutes })(artifactOgContract),
  };
}

function as(actor: Actor) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return api();
}

function anonymous() {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  return api();
}

/** The owner uploads a file through the browser upload flow and completes it. */
async function upload(
  storage: Storage,
  owner: Actor,
  file: {
    readonly filename: string;
    readonly contentType: string;
    readonly purpose?: "artifact";
  } = { filename: "report.pdf", contentType: "application/pdf" },
) {
  const bytes = Buffer.from(`bytes of ${file.filename}`);
  const owned = as(owner);
  const prepared = await accept(
    owned.uploads.prepare({
      headers,
      body: {
        filename: file.filename,
        contentType: file.contentType,
        size: bytes.byteLength,
        ...(file.purpose ? { purpose: file.purpose } : {}),
      },
    }),
    [200],
  );
  if ("multipart" in prepared.body) {
    throw new Error("Expected a single-part upload");
  }
  storage.upload(
    prepared.body.uploadUrl,
    bytes,
    file.contentType,
    prepared.body.uploadHeaders,
  );
  const completed = await accept(
    owned.uploads.complete({ headers, body: { id: prepared.body.id } }),
    [200],
  );
  const reference = new URL(completed.body.url, APP_URL).pathname
    .split("/")
    .at(-1);
  if (!reference) {
    throw new Error("Expected an artifact reference");
  }
  return {
    id: prepared.body.id,
    preparedUrl: prepared.body.url,
    reference,
    legacyReference: prepared.body.id.replaceAll("-", ""),
  };
}

/** A fresh case: storage, an owner in "Original organization" and a peer. */
async function scenario() {
  mockEnv("APP_URL", APP_URL);
  const storage = installStorage();
  const owner = await member();
  const peer = await member({ orgId: owner.orgId });
  return { storage, owner, peer };
}

function setAudience(
  actor: Actor,
  fileId: string,
  audience: "private" | "organization" | "public",
) {
  return as(actor).shares.update({
    headers,
    body: { target: { kind: "file", id: fileId }, audience },
  });
}

function readStatus(actor: Actor, fileId: string) {
  return as(actor).shares.status({
    headers,
    body: { kind: "file", id: fileId },
  });
}

function resolveReference(
  actor: Actor,
  reference: string,
  kind?: "file" | "html" | "artifact",
) {
  return as(actor).references.resolve({
    headers,
    params: { reference },
    query: kind ? { kind } : {},
  });
}

function resolveShare(actor: Actor, shareId: string) {
  return as(actor).shares.resolve({ headers, params: { id: shareId } });
}

/** The owner's only catalog entry is the uploaded file. */
async function catalogArtifactId(owner: Actor, fileId: string) {
  const listed = await accept(
    as(owner).catalog.list({ headers, query: {} }),
    [200],
  );
  const [artifact] = listed.body.artifacts;
  if (listed.body.artifacts.length !== 1 || !artifact) {
    throw new Error("Expected exactly one catalog artifact");
  }
  const detail = await accept(
    as(owner).catalog.get({
      headers,
      params: { artifactId: artifact.id },
      query: {},
    }),
    [200],
  );
  expect(detail.body).toMatchObject({ kind: "file", file: { id: fileId } });
  return artifact.id;
}

function shortReference(url: string | null) {
  if (!url) {
    throw new Error("Expected a short share URL");
  }
  const reference = new URL(url).pathname.split("/").at(-1);
  if (!reference) {
    throw new Error("Expected a short share reference");
  }
  return reference;
}

async function deletionScenario(
  audience: "private" | "organization" | "public",
) {
  const { storage, owner } = await scenario();
  const file = await upload(storage, owner, {
    filename: "report.pdf",
    contentType: "application/pdf",
    purpose: "artifact",
  });
  await accept(setAudience(owner, file.id, audience), [200]);
  const artifactId = await catalogArtifactId(owner, file.id);
  const owned = as(owner);

  const deleted = await accept(
    owned.catalog.delete({ headers, params: { artifactId } }),
    [200],
  );
  const listed = await accept(
    owned.catalog.list({ headers, query: {} }),
    [200],
  );
  const detail = await owned.catalog.get({
    headers,
    params: { artifactId },
    query: {},
  });
  const reference = await resolveReference(owner, file.reference);
  const republished = await setAudience(owner, file.id, "public");
  const recompleted = await as(owner).uploads.complete({
    headers,
    body: { id: file.id },
  });
  const again = await accept(
    as(owner).catalog.delete({
      headers,
      params: { artifactId },
    }),
    [200],
  );
  const relisted = await accept(
    as(owner).catalog.list({ headers, query: {} }),
    [200],
  );

  expect(deleted.status).toBe(200);
  expect(listed.body.artifacts).toStrictEqual([]);
  expect(detail.status).toBe(404);
  expect(reference.status).toBe(404);
  expect(republished.status).toBe(404);
  expect(recompleted.status).toBe(404);
  expect(again.status).toBe(200);
  expect(relisted.body.artifacts).toStrictEqual([]);
}

/** Owner and peer walk a typed file through sharing, removal and revocation. */
async function typedFileScenario(filename: string, contentType: string) {
  const { storage, owner, peer } = await scenario();
  const file = await upload(storage, owner, { filename, contentType });

  const owned = await accept(resolveReference(owner, file.reference), [200]);
  expect(owned.body).toMatchObject({
    filename,
    contentType,
    target: { kind: "file", id: file.id },
  });
  expect(owned.body).not.toHaveProperty("previewImageUrl");
  expect(owned.headers.get("cache-control")).toBe("private, no-store");
  await accept(resolveReference(peer, file.reference), [404]);

  await accept(setAudience(owner, file.id, "organization"), [200]);
  const shared = await accept(resolveReference(peer, file.reference), [200]);
  expect(shared.body).toMatchObject({
    filename,
    contentType,
    target: { kind: "file", id: file.id },
  });
  expect(shared.body).not.toHaveProperty("previewImageUrl");
  await accept(resolveReference(peer, file.reference, "file"), [404]);

  await leave(peer);
  await accept(resolveReference(peer, file.reference), [404]);
  await accept(setAudience(owner, file.id, "private"), [200]);
  await join(peer);
  await accept(resolveReference(peer, file.reference), [404]);
}

/** A recipient signed into another workspace still belongs to the owner's organization. */
async function organizationReferenceScenario(
  referenceOf: (share: {
    readonly shortUrl: string | null;
    readonly shareId: string | null;
  }) => string,
) {
  const { storage, owner } = await scenario();
  const file = await upload(storage, owner);
  const shared = await accept(
    setAudience(owner, file.id, "organization"),
    [200],
  );
  expect(shared.body.shortUrl).toMatch(shortReportUrl);
  const reference = referenceOf(shared.body);
  const recipient = await member();
  const original = { userId: recipient.userId, orgId: owner.orgId };
  await join(original);

  const first = await accept(resolveReference(recipient, reference), [200]);
  expect(first.body.target).toStrictEqual({ kind: "file", id: file.id });
  await leave(original);
  await accept(resolveReference(recipient, reference), [404]);
  await join(original);

  await accept(setAudience(owner, file.id, "private"), [200]);
  await accept(resolveReference(owner, reference), [200]);
  await accept(resolveReference(recipient, reference), [404]);
}

describe("artifact shares", () => {
  it("artifact-shares-011 grants nothing to a peer who sees the reference; only the owner manages sharing", async () => {
    const { storage, owner, peer } = await scenario();
    const file = await upload(storage, owner);

    const initial = await accept(readStatus(owner, file.id), [200]);
    expect(initial.body).toMatchObject({
      audience: "private",
      shareId: null,
      url: null,
    });
    expect(storage.keys("artifact-shares/")).toStrictEqual([]);

    await accept(readStatus(peer, file.id), [404]);
    await accept(setAudience(peer, file.id, "public"), [404]);
    await accept(
      as(peer).files.fileUrl({ headers, query: { file_id: file.id } }),
      [404],
    );

    const published = await accept(
      setAudience(owner, file.id, "public"),
      [200],
    );
    expect(published.body.audience).toBe("public");
  });

  it("artifact-shares-004 deletes a catalog artifact only for its owner in the original organization", async () => {
    const { storage, owner, peer } = await scenario();
    const file = await upload(storage, owner, {
      filename: "report.pdf",
      contentType: "application/pdf",
      purpose: "artifact",
    });
    const artifactId = await catalogArtifactId(owner, file.id);
    const elsewhere = { userId: owner.userId, orgId: `org_${randomUUID()}` };
    await join(elsewhere, "Other organization");

    await accept(
      as(peer).catalog.delete({
        headers,
        params: { artifactId },
      }),
      [404],
    );
    await accept(
      as(elsewhere).catalog.delete({
        headers,
        params: { artifactId },
      }),
      [404],
    );

    const detail = await accept(
      as(owner).catalog.get({ headers, params: { artifactId }, query: {} }),
      [200],
    );
    expect(detail.body.id).toBe(artifactId);
  });

  it("artifact-shares-001 withdraws a private file from the catalog, owner access and shares", async () => {
    await expect(deletionScenario("private")).resolves.toBeUndefined();
  });

  it("artifact-shares-002 withdraws an organization file from the catalog, owner access and shares", async () => {
    await expect(deletionScenario("organization")).resolves.toBeUndefined();
  });

  it("artifact-shares-003 withdraws a public file from the catalog, owner access and shares", async () => {
    await expect(deletionScenario("public")).resolves.toBeUndefined();
  });

  it("artifact-shares-057 resolves a private artifact reference for deletion only for the owner", async () => {
    const { storage, owner, peer } = await scenario();
    const file = await upload(storage, owner, {
      filename: "report.pdf",
      contentType: "application/pdf",
      purpose: "artifact",
    });
    await accept(setAudience(owner, file.id, "private"), [200]);
    const artifactId = await catalogArtifactId(owner, file.id);

    for (const reference of [file.reference, file.legacyReference]) {
      const owned = await accept(
        as(owner).references.ownerArtifact({
          headers,
          params: { reference },
        }),
        [200],
      );
      expect(owned.body).toStrictEqual({ artifactId });
    }
    await accept(
      as(peer).references.ownerArtifact({
        headers,
        params: { reference: file.reference },
      }),
      [404],
    );
    await accept(
      anonymous().references.ownerArtifact({
        headers: {},
        params: { reference: file.reference },
      }),
      [401],
    );

    await accept(
      as(owner).catalog.delete({
        headers,
        params: { artifactId },
      }),
      [200],
    );
    await accept(
      as(owner).references.ownerArtifact({
        headers,
        params: { reference: file.reference },
      }),
      [404],
    );
  });

  it("artifact-shares-008 reads the organization name from fresh membership and follows renames", async () => {
    const { storage, owner } = await scenario();
    const file = await upload(storage, owner);
    const organization = context.mocks.clerk.organizations;
    organization.getOrganization.mockClear();
    organization.getOrganizationMembershipList.mockClear();

    const updated = await accept(
      setAudience(owner, file.id, "organization"),
      [200],
    );
    const first = await accept(readStatus(owner, file.id), [200]);
    const second = await accept(readStatus(owner, file.id), [200]);
    await join(owner, "Renamed organization");
    const renamed = await accept(readStatus(owner, file.id), [200]);

    expect(updated.body).toMatchObject({
      audience: "organization",
      organization: { id: owner.orgId, name: "Original organization" },
    });
    expect(second.body).toStrictEqual(first.body);
    for (const status of [first, second]) {
      expect(status.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(renamed.body.organization).toStrictEqual({
      id: owner.orgId,
      name: "Renamed organization",
    });
    expect(organization.getOrganization).not.toHaveBeenCalled();
    expect(organization.getOrganizationMembershipList).toHaveBeenCalledTimes(4);
  });

  it("artifact-shares-010 denies status and updates once the owner leaves the organization", async () => {
    const { storage, owner } = await scenario();
    const file = await upload(storage, owner);
    await accept(setAudience(owner, file.id, "public"), [200]);
    await accept(readStatus(owner, file.id), [200]);
    await leave(owner);

    const status = await accept(readStatus(owner, file.id), [404]);
    expect(status.body.error).toMatchObject({
      code: "NOT_FOUND",
      message: "Artifact not found",
    });
    await accept(setAudience(owner, file.id, "organization"), [404]);
  });

  it("artifact-shares-016 authorizes a hostless owner reference before signing and ignores extension hints", async () => {
    const { storage, owner, peer } = await scenario();
    const file = await upload(storage, owner);
    const renamed = `${file.reference.split(".")[0] ?? ""}.html`;

    const first = await accept(resolveReference(owner, renamed), [200]);
    expect(first.body).toMatchObject({
      filename: "report.pdf",
      contentType: "application/pdf",
      target: { kind: "file", id: file.id },
    });
    expect(first.body.url).toContain("signature=temporary");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(storage.keys("artifact-shares/")).toStrictEqual([]);
    await accept(resolveReference(owner, renamed), [200]);

    const signedBefore = storage.signed.length;
    await accept(resolveReference(peer, renamed), [404]);
    expect(storage.signed).toHaveLength(signedBefore);

    const unauthenticated = await accept(
      anonymous().references.resolve({
        headers: {},
        params: { reference: renamed },
        query: {},
      }),
      [401],
    );
    expect(unauthenticated.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("artifact-shares-017 resolves report.html without a poster and keeps file share authorization", async () => {
    await expect(
      typedFileScenario("report.html", "text/html"),
    ).resolves.toBeUndefined();
  });

  it("artifact-shares-018 resolves demo.mp4 without a poster and keeps file share authorization", async () => {
    await expect(
      typedFileScenario("demo.mp4", "video/mp4"),
    ).resolves.toBeUndefined();
  });

  it("artifact-shares-019 keeps the same short reference through organization sharing and revocation", async () => {
    const { storage, owner, peer } = await scenario();
    const file = await upload(storage, owner, {
      filename: "report.pdf",
      contentType: "application/pdf",
      purpose: "artifact",
    });
    expect(file.preparedUrl).toMatch(shortReportUrl);
    const reference = shortReference(file.preparedUrl);

    await accept(resolveReference(peer, reference), [404]);
    const references = storage.keys("artifact-references/");
    const shared = await accept(
      setAudience(owner, file.id, "organization"),
      [200],
    );
    expect(storage.keys("artifact-references/")).toStrictEqual(references);
    expect(shared.body.shortUrl).toBe(file.preparedUrl);
    expect(shared.body.url).toBe(file.preparedUrl);
    const resolved = await accept(resolveReference(peer, reference), [200]);
    expect(resolved.body.target).toStrictEqual({ kind: "file", id: file.id });

    await accept(setAudience(owner, file.id, "private"), [200]);
    await accept(resolveReference(owner, reference), [200]);
    await accept(resolveReference(peer, reference), [404]);
  });

  it("artifact-shares-027 resolves short organization references through current membership", async () => {
    await expect(
      organizationReferenceScenario((share) => {
        return shortReference(share.shortUrl);
      }),
    ).resolves.toBeUndefined();
  });

  it("artifact-shares-028 resolves legacy share-ID references through current membership", async () => {
    await expect(
      organizationReferenceScenario((share) => {
        if (!share.shareId) {
          throw new Error("Expected a share ID");
        }
        return share.shareId.replaceAll("-", "");
      }),
    ).resolves.toBeUndefined();
  });

  it("artifact-shares-036 checks current original-organization membership and grants no reshare rights", async () => {
    const { storage, owner } = await scenario();
    const file = await upload(storage, owner);
    const shared = await accept(
      setAudience(owner, file.id, "organization"),
      [200],
    );
    expect(shared.body.url).toBe(shared.body.shortUrl);
    expect(shared.headers.get("cache-control")).toBe("private, no-store");
    const shareId = shared.body.shareId;
    if (!shareId) {
      throw new Error("Expected a share ID");
    }
    const recipient = await member();
    const original = { userId: recipient.userId, orgId: owner.orgId };
    mockNow(new Date("2026-09-09T12:00:00.123Z"));

    await accept(resolveShare(recipient, shareId), [404]);
    await join(original);
    const signedBefore = storage.signed.length;
    const granted = await accept(resolveShare(recipient, shareId), [200]);
    expect(granted.body.expiresAt).toBe("2026-09-11T12:00:00.000Z");
    expect(granted.headers.get("cache-control")).toBe("private, no-store");
    expect(storage.signed.slice(signedBefore)).toContainEqual(
      expect.objectContaining({
        url: granted.body.url,
        expiresIn: 172_800,
        signingDate: new Date("2026-09-09T12:00:00.000Z"),
        cacheControl: "private, max-age=31536000, must-revalidate",
      }),
    );
    const repeated = await accept(resolveShare(recipient, shareId), [200]);
    expect(repeated.body.url).toBe(granted.body.url);

    await accept(readStatus(recipient, file.id), [404]);
    await leave(original);
    await accept(resolveShare(recipient, shareId), [404]);
    const unauthenticated = await accept(
      anonymous().shares.resolve({ headers: {}, params: { id: shareId } }),
      [401],
    );
    expect(unauthenticated.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("artifact-shares-037 makes an organization share unavailable after the original organization is deleted", async () => {
    const { storage, owner } = await scenario();
    const file = await upload(storage, owner);
    const shared = await accept(
      setAudience(owner, file.id, "organization"),
      [200],
    );
    const shareId = shared.body.shareId;
    if (!shareId) {
      throw new Error("Expected a share ID");
    }
    const outsider = await member();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkTransportTestError(404, [
        { code: "resource_not_found", message: "Organization not found" },
      ]),
    );

    const resolved = await accept(resolveShare(outsider, shareId), [404]);
    expect(resolved.body.error).toMatchObject({
      code: "NOT_FOUND",
      message: "Artifact unavailable",
    });
    expect(resolved.headers.get("cache-control")).toBe("private, no-store");
    await accept(readStatus(owner, file.id), [404]);
    await accept(setAudience(owner, file.id, "public"), [404]);
  });

  it("artifact-shares-047 revokes old public tokens on audience changes and stops sharing", async () => {
    const { storage, owner } = await scenario();
    const file = await upload(storage, owner);

    const first = await accept(setAudience(owner, file.id, "public"), [200]);
    expect(first.body.url).toMatch(
      /^https:\/\/a\.okou\.io\/[a-z0-9]{10}\.pdf$/u,
    );
    const organization = await accept(
      setAudience(owner, file.id, "organization"),
      [200],
    );
    expect(organization.body).toMatchObject({
      shareId: first.body.shareId,
      audience: "organization",
    });
    expect(storage.policy(organization.body.shareId ?? "")).toMatchObject({
      audience: "organization",
      publicToken: null,
    });
    const republished = await accept(
      setAudience(owner, file.id, "public"),
      [200],
    );
    expect(republished.body.url).not.toBe(first.body.url);
    const shareId = republished.body.shareId;
    if (!shareId) {
      throw new Error("Expected a share ID");
    }

    await accept(resolveShare(owner, shareId), [200]);
    const stopped = await accept(setAudience(owner, file.id, "private"), [200]);
    expect(stopped.body).toMatchObject({ audience: "private", url: null });
    await accept(resolveShare(owner, shareId), [404]);
    expect(storage.policy(shareId)).toMatchObject({
      status: "revoked",
      audience: "private",
      publicToken: null,
    });
  });

  it("artifact-shares-055 discloses public previews of canonical file links only while explicitly public", async () => {
    const { storage, owner, peer } = await scenario();
    const file = await upload(storage, owner);
    const missing = randomUUID().replaceAll("-", "");
    const publicLookup = (reference: string) => {
      return anonymous().references.publicUrl({ params: { reference } });
    };
    const unavailable = {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    };
    const expectUnavailable = async (reference: string) => {
      const response = await accept(publicLookup(reference), [404]);
      expect(response.body).toMatchObject(unavailable);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      return response.body;
    };

    const privateBody = await expectUnavailable(file.reference);
    const missingBody = await expectUnavailable(missing);
    expect(privateBody).toStrictEqual(missingBody);

    const organization = await accept(
      setAudience(owner, file.id, "organization"),
      [200],
    );
    const short = shortReference(organization.body.shortUrl);
    for (const reference of [file.reference, short]) {
      await expect(expectUnavailable(reference)).resolves.toStrictEqual(
        missingBody,
      );
    }

    const published = await accept(
      setAudience(owner, file.id, "public"),
      [200],
    );
    const renamed = `${file.reference.split(".")[0] ?? ""}.html`;
    for (const reference of [file.reference, short, renamed]) {
      const response = await accept(publicLookup(reference), [200]);
      expect(response.body).toStrictEqual({
        url: published.body.url,
        downloadUrl: expect.any(String),
        preview: { filename: "report.pdf", contentType: "application/pdf" },
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }

    await accept(setAudience(owner, file.id, "private"), [200]);
    for (const reference of [file.reference, short, renamed]) {
      await expect(expectUnavailable(reference)).resolves.toStrictEqual(
        missingBody,
      );
    }
    await accept(resolveReference(owner, short), [200]);
    await accept(resolveReference(peer, short), [404]);
    await accept(setAudience(peer, file.id, "public"), [404]);
  });

  it("artifact-shares-056 re-checks anonymous sharing for old Open Graph image URLs", async () => {
    const { storage, owner } = await scenario();
    const file = await upload(storage, owner, {
      filename: "confidential-report.png",
      contentType: "image/png",
    });
    const target = { kind: "reference" as const, id: file.reference };
    const og = () => {
      return anonymous().og;
    };
    const metadata = async () => {
      return (await accept(og().metadata({ query: target }), [200])).body;
    };
    const image = (version: string, variant?: "slack") => {
      return accept(
        og().image({
          query: { ...target, version, ...(variant ? { variant } : {}) },
        }),
        [302],
      );
    };

    await expect(metadata()).resolves.toStrictEqual({ available: false });

    await accept(setAudience(owner, file.id, "public"), [200]);
    const published = await metadata();
    if (!published.available) {
      throw new Error("Expected public Open Graph metadata");
    }
    expect(published.title).toBe("confidential-report.png");
    const prefix = "/cdn-cgi/image/";
    const transformed = published.imageUrl.indexOf(prefix);
    expect(transformed).toBeGreaterThan(0);
    const directives = published.imageUrl.slice(transformed + prefix.length);
    const source = new URL(directives.slice(directives.indexOf("/") + 1));
    expect(source.pathname).toBe("/api/artifact-og/image");
    expect(source.searchParams.get("id")).toBe(file.reference);
    const version = source.searchParams.get("version") ?? "";
    expect(version).not.toBe("");

    const original = await image(version);
    expect(original.headers.get("cache-control")).toBe("private, no-store");
    const location = original.headers.get("location") ?? "";
    const signed = storage.signed.find((entry) => {
      return entry.url === location;
    });
    expect(signed).toMatchObject({
      expiresIn: 60,
      cacheControl: "private, no-store, must-revalidate",
    });
    expect(signed?.key).toMatch(
      /^private-artifacts\/[^/]+\/shares\/[^/]+\/confidential-report\.png$/u,
    );
    expect(
      signed?.key.startsWith(`private-artifacts/${file.id}/`),
    ).toBeTruthy();
    const slack = await image(version, "slack");
    expect(new URL(slack.headers.get("location") ?? "").pathname).toBe(
      new URL(location).pathname,
    );
    const brand = await accept(og().defaultImage(), [302]);
    expect(brand.headers.get("location")).toBe(ARTIFACT_OG_BRAND.imageUrl);

    for (const audience of ["organization", "private"] as const) {
      await accept(setAudience(owner, file.id, audience), [200]);
      await expect(metadata()).resolves.toStrictEqual({ available: false });
      for (const variant of [undefined, "slack" as const]) {
        const withdrawn = await image(version, variant);
        expect(withdrawn.headers.get("location")).toBe(
          ARTIFACT_OG_BRAND.imageUrl,
        );
        expect(withdrawn.headers.get("cache-control")).toBe(
          "private, no-store",
        );
      }
    }

    await accept(setAudience(owner, file.id, "public"), [200]);
    const old = await image(version);
    expect(old.headers.get("location")).toBe(ARTIFACT_OG_BRAND.imageUrl);
  });

  it("artifact-shares-050 records a revocation for an unpublished file and keeps its share ID for a later share", async () => {
    const { storage, owner, peer } = await scenario();
    const file = await upload(storage, owner);

    const stopped = await accept(setAudience(owner, file.id, "private"), [200]);
    expect(stopped.body).toMatchObject({
      audience: "private",
      url: null,
      shortUrl: null,
      selectedTarget: { kind: "file", id: file.id },
      shareId: expect.any(String),
    });
    const status = await accept(readStatus(owner, file.id), [200]);
    expect(status.body).toStrictEqual(stopped.body);
    const shareId = stopped.body.shareId;
    if (!shareId) {
      throw new Error("Expected a share ID");
    }
    await accept(resolveShare(peer, shareId), [404]);

    const shared = await accept(
      setAudience(owner, file.id, "organization"),
      [200],
    );
    expect(shared.body.shareId).toBe(shareId);
    const signedBefore = storage.signed.length;
    const resolved = await accept(resolveShare(peer, shareId), [200]);
    const signed = storage.signed.slice(signedBefore).find((entry) => {
      return entry.url === resolved.body.url;
    });
    expect(
      signed?.key.startsWith(`private-artifacts/${file.id}/shares/`),
    ).toBeTruthy();
  });
});
