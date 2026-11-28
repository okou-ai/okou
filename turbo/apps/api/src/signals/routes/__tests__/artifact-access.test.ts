import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { artifactAccessRoutes } from "../artifact-access";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactReferenceRoutes } from "../artifact-references";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const host = createHostBddApi(context);
const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});
const SAMPLE_FILE = Buffer.from("%PDF-1.7 unified artifact access test");

const accessClient = setupApp({ context, routes: artifactAccessRoutes })(
  artifactAccessContract,
);
const catalogClient = setupApp({ context, routes: artifactCatalogRoutes })(
  artifactCatalogContract,
);
const referencesClient = setupApp({ context, routes: artifactReferenceRoutes })(
  artifactReferencesContract,
);
const uploadsClient = setupApp({
  context,
  routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
})(uploadsContract);

interface StoredObject {
  readonly body: Buffer;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function notFoundError(code: "NotFound" | "NoSuchKey" = "NotFound"): Error {
  return Object.assign(new Error("Not found"), {
    name: code,
    Code: code,
    $metadata: { httpStatusCode: 404 },
  });
}

function signIn(actor: ApiTestUser): Readonly<Record<string, string>> {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  if (actor.orgId) {
    const orgId = actor.orgId;
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: orgId,
      name: "Unified Test Workspace",
      slug: "unified-test-workspace",
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          id: `mem_${actor.userId}_${orgId}`,
          role: actor.orgRole ?? "org:member",
          organization: { id: orgId, name: "Unified Test Workspace" },
          publicUserData: { userId: actor.userId },
        },
      ],
    });
  }
  return SESSION_HEADERS;
}

function installFileStorage() {
  const objects = new Map<string, StoredObject>();
  const signed = new Map<string, { bucket: string; key: string }>();
  const keyOf = (bucket: string, key: string) => {
    return `${bucket}/${key}`;
  };

  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      const cmdRecord = isRecord(command) ? command : {};
      const input = isRecord(cmdRecord.input) ? cmdRecord.input : {};
      const bucket = stringField(input, "Bucket") ?? "";
      const key = stringField(input, "Key") ?? "";
      const url = `https://r2.example.test/${bucket}/${key}?n=${String(signed.size)}`;
      signed.set(url, { bucket, key });
      return Promise.resolve(url);
    },
  );

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const cmdRecord = isRecord(command) ? command : {};
    const input = isRecord(cmdRecord.input) ? cmdRecord.input : {};
    const bucket = stringField(input, "Bucket") ?? "";
    const key = stringField(input, "Key") ?? "";
    const stored = objects.get(keyOf(bucket, key));

    if (command instanceof PutObjectCommand) {
      if (input.IfNoneMatch === "*" && stored) {
        return Promise.reject(
          Object.assign(new Error("Object exists"), {
            name: "PreconditionFailed",
            $metadata: { httpStatusCode: 412 },
          }),
        );
      }
      const rawBody = input.Body;
      const body = Buffer.isBuffer(rawBody)
        ? rawBody
        : typeof rawBody === "string"
          ? Buffer.from(rawBody)
          : rawBody instanceof Uint8Array
            ? Buffer.from(rawBody)
            : Buffer.alloc(0);
      objects.set(keyOf(bucket, key), {
        body,
        contentType: stringField(input, "ContentType"),
      });
      return Promise.resolve({ ETag: '"put"' });
    }
    if (command instanceof GetObjectCommand) {
      if (!stored) {
        return Promise.reject(notFoundError("NoSuchKey"));
      }
      return Promise.resolve({
        Body: Readable.from([stored.body]),
        ContentLength: stored.body.byteLength,
        ContentType: stored.contentType,
        ETag: `"${createHash("sha256").update(stored.body).digest("hex")}"`,
      });
    }
    if (command instanceof HeadObjectCommand) {
      if (!stored) {
        return Promise.reject(notFoundError());
      }
      return Promise.resolve({
        ContentLength: stored.body.byteLength,
        ContentType: stored.contentType,
        LastModified: nowDate(),
        Metadata: stored.metadata ?? {},
        ETag: '"head"',
      });
    }
    if (command instanceof ListObjectsV2Command) {
      return Promise.resolve({ Contents: [], IsTruncated: false });
    }
    return Promise.resolve({});
  });

  return {
    upload(
      uploadUrl: string,
      body: Buffer,
      contentType: string,
      uploadHeaders: Readonly<Record<string, string>> = {},
    ) {
      const target = signed.get(uploadUrl);
      if (!target) {
        throw new Error(`Unknown upload URL ${uploadUrl}`);
      }
      objects.set(keyOf(target.bucket, target.key), {
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

function registerClerkDirectory(users: readonly ApiTestUser[]): void {
  mockClerkUsers(
    context,
    users.map((user) => {
      const emailId = `email_${user.userId}`;
      return {
        id: user.userId,
        username: null,
        banned: false,
        firstName: "Workspace",
        lastName: "Peer",
        primaryEmailAddressId: emailId,
        emailAddresses: [
          {
            id: emailId,
            emailAddress: user.email,
            verification: { status: "verified" },
          },
        ],
      };
    }),
  );
}

async function seedMember(orgId?: string): Promise<ApiTestUser> {
  const user = bdd.user(orgId ? { orgId, orgRole: "org:member" } : {});
  if (user.orgId) {
    await store.set(
      seedOrgMembership$,
      {
        orgId: user.orgId,
        userId: user.userId,
        role: user.orgRole === "org:admin" ? "admin" : "member",
        emailAddresses: [user.email],
      },
      context.signal,
    );
  }
  return user;
}

function acceptEmails(): void {
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `email-${randomUUID()}` },
    error: null,
  });
}

async function uploadPrivateFileArtifact(
  owner: ApiTestUser,
  storage: ReturnType<typeof installFileStorage>,
): Promise<{ readonly artifactId: string; readonly fileId: string }> {
  const filename = `report-${randomUUID().slice(0, 8)}.pdf`;
  const headers = signIn(owner);
  const prepared = await accept(
    uploadsClient.prepare({
      headers,
      body: {
        filename,
        contentType: "application/pdf",
        size: SAMPLE_FILE.byteLength,
        purpose: "artifact",
      },
    }),
    [200],
  );
  if ("multipart" in prepared.body) {
    throw new Error("Expected single upload mode");
  }
  storage.upload(
    prepared.body.uploadUrl,
    SAMPLE_FILE,
    "application/pdf",
    prepared.body.uploadHeaders,
  );
  await accept(
    uploadsClient.complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  const fileId = prepared.body.id;
  return { artifactId: fileId, fileId };
}

async function publishPrivateSiteArtifact(
  owner: ApiTestUser,
): Promise<{ readonly artifactId: string; readonly siteId: string }> {
  host.captureHostedSitesS3();
  const slug = `site-${randomUUID().slice(0, 8)}`;
  const title = `Unified Site ${slug}`;
  const html = "<h1>Unified Access Site</h1>";
  const prepared = await host.prepareHostedSite(owner, {
    site: slug,
    title,
    visibility: "private",
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [
      {
        path: "/index.html",
        size: Buffer.byteLength(html),
        sha256: createHash("sha256").update(html).digest("hex"),
        contentType: "text/html; charset=utf-8",
      },
    ],
  });
  await host.completeHostedSite(owner, prepared.deploymentId);
  return { artifactId: prepared.siteId, siteId: prepared.siteId };
}

describe("Unified artifact access API", () => {
  beforeAll(async () => {
    const warmed = await settleIncludingAbort(async () => {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      const warmupId = randomUUID();
      await Promise.all([
        accept(
          accessClient.getVisibility({
            headers: {},
            params: { artifactId: warmupId },
          }),
          [401],
        ),
        accept(
          accessClient.updateVisibility({
            headers: {},
            params: { artifactId: warmupId },
            body: { visibility: "private" },
          }),
          [401],
        ),
        accept(
          accessClient.listShares({
            headers: {},
            params: { artifactId: warmupId },
          }),
          [401],
        ),
        accept(
          accessClient.searchShareAccounts({
            headers: {},
            params: { artifactId: warmupId },
            query: { query: "wa" },
          }),
          [401],
        ),
        accept(
          accessClient.addShare({
            headers: {},
            params: { artifactId: warmupId },
            body: { userId: "user_warmup" },
          }),
          [401],
        ),
        accept(
          accessClient.removeShare({
            headers: {},
            params: { artifactId: warmupId, userId: "user_warmup" },
          }),
          [401],
        ),
        accept(
          uploadsClient.prepare({
            headers: {},
            body: {
              filename: "warmup.pdf",
              contentType: "application/pdf",
              size: 16,
              purpose: "artifact",
            },
          }),
          [401],
        ),
        accept(
          uploadsClient.complete({
            headers: {},
            body: { id: warmupId },
          }),
          [401],
        ),
      ]);
    });
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  it("pf-158 unified artifact visibility updates file artifacts across private, organization, and public", async () => {
    const storage = installFileStorage();
    const owner = await seedMember();
    const { artifactId } = await uploadPrivateFileArtifact(owner, storage);
    const headers = signIn(owner);

    const initial = await accept(
      accessClient.getVisibility({ headers, params: { artifactId } }),
      [200],
    );
    expect(initial.body).toMatchObject({
      kind: "file",
      visibility: "private",
      shareUrl: null,
      shortUrl: null,
    });
    const catalogArtifactId = initial.body.artifactId;

    const orgUpdated = await accept(
      accessClient.updateVisibility({
        headers,
        params: { artifactId: catalogArtifactId },
        body: { visibility: "organization" },
      }),
      [200],
    );
    expect(orgUpdated.body.visibility).toBe("organization");
    expect(orgUpdated.body.shareUrl).toBeTruthy();

    const publicUpdated = await accept(
      accessClient.updateVisibility({
        headers,
        params: { artifactId: catalogArtifactId },
        body: { visibility: "public" },
      }),
      [200],
    );
    expect(publicUpdated.body.visibility).toBe("public");
    expect(publicUpdated.body.shareUrl).toBeTruthy();

    const readPublic = await accept(
      accessClient.getVisibility({ headers, params: { artifactId } }),
      [200],
    );
    expect(readPublic.body.visibility).toBe("public");
    expect(readPublic.body.shareUrl).toBeTruthy();

    const backToPrivate = await accept(
      accessClient.updateVisibility({
        headers,
        params: { artifactId },
        body: { visibility: "private" },
      }),
      [200],
    );
    expect(backToPrivate.body).toMatchObject({
      visibility: "private",
      shareUrl: null,
      shortUrl: null,
    });

    const readFinal = await accept(
      accessClient.getVisibility({ headers, params: { artifactId } }),
      [200],
    );
    expect(readFinal.body.visibility).toBe("private");
  });

  it("pf-160 unified artifact shares support userId primary path, email fallback, non-member rejection, and DELETE by userId", async () => {
    const storage = installFileStorage();
    acceptEmails();
    const owner = await seedMember();
    const orgId = owner.orgId ?? "";
    const [peerA, peerB, outsider] = await Promise.all([
      seedMember(orgId),
      seedMember(orgId),
      seedMember(),
      updateFeatureSwitchesForUser(
        context,
        { userId: owner.userId, orgId, orgRole: owner.orgRole },
        { [FeatureSwitchKey.ArtifactUserSharing]: true },
      ),
    ]);
    registerClerkDirectory([owner, peerA, peerB, outsider]);
    const { artifactId } = await uploadPrivateFileArtifact(owner, storage);
    const headers = signIn(owner);

    const addedByUserId = await accept(
      accessClient.addShare({
        headers,
        params: { artifactId },
        body: { userId: peerA.userId },
      }),
      [200],
    );
    expect(addedByUserId.body.share).toMatchObject({
      userId: peerA.userId,
      email: peerA.email,
    });

    const addedByEmail = await accept(
      accessClient.addShare({
        headers,
        params: { artifactId },
        body: { email: peerB.email },
      }),
      [200],
    );
    expect(addedByEmail.body.share).toMatchObject({
      userId: peerB.userId,
      email: peerB.email,
    });

    const rejectedOutsider = await accept(
      accessClient.addShare({
        headers,
        params: { artifactId },
        body: { userId: outsider.userId },
      }),
      [400],
    );
    expect(rejectedOutsider.status).toBe(400);

    const listedBefore = await accept(
      accessClient.listShares({ headers, params: { artifactId } }),
      [200],
    );
    expect(
      listedBefore.body.shares
        .map((entry) => {
          return entry.userId;
        })
        .sort(),
    ).toStrictEqual([peerA.userId, peerB.userId].sort());

    const removed = await accept(
      accessClient.removeShare({
        headers,
        params: { artifactId, userId: peerA.userId },
      }),
      [200],
    );
    expect(removed.body).toStrictEqual({ removed: peerA.userId });

    const listedAfter = await accept(
      accessClient.listShares({ headers, params: { artifactId } }),
      [200],
    );
    expect(
      listedAfter.body.shares.map((entry) => {
        return entry.userId;
      }),
    ).toStrictEqual([peerB.userId]);
    await flushWaitUntilForTest();
  });

  it("pf-161 unified /shares routes are gated by ArtifactUserSharing independently from HostedSiteEmailSharing", async () => {
    const storage = installFileStorage();
    acceptEmails();
    const owner = await seedMember();
    const orgId = owner.orgId ?? "";
    const peer = await seedMember(orgId);
    registerClerkDirectory([owner, peer]);
    const { artifactId } = await uploadPrivateFileArtifact(owner, storage);

    await updateFeatureSwitchesForUser(
      context,
      { userId: owner.userId, orgId, orgRole: owner.orgRole },
      {
        [FeatureSwitchKey.ArtifactUserSharing]: false,
      },
    );
    const headers = signIn(owner);
    const [listOff, searchOff, addOff, removeOff] = await Promise.all([
      accept(
        accessClient.listShares({ headers, params: { artifactId } }),
        [404],
      ),
      accept(
        accessClient.searchShareAccounts({
          headers,
          params: { artifactId },
          query: { query: peer.email.slice(0, 6) },
        }),
        [404],
      ),
      accept(
        accessClient.addShare({
          headers,
          params: { artifactId },
          body: { userId: peer.userId },
        }),
        [404],
      ),
      accept(
        accessClient.removeShare({
          headers,
          params: { artifactId, userId: peer.userId },
        }),
        [404],
      ),
    ]);
    expect([
      listOff.status,
      searchOff.status,
      addOff.status,
      removeOff.status,
    ]).toStrictEqual([404, 404, 404, 404]);

    await updateFeatureSwitchesForUser(
      context,
      { userId: owner.userId, orgId, orgRole: owner.orgRole },
      {
        [FeatureSwitchKey.ArtifactUserSharing]: true,
      },
    );
    const listOn = await accept(
      accessClient.listShares({
        headers: signIn(owner),
        params: { artifactId },
      }),
      [200],
    );
    const searchOn = await accept(
      accessClient.searchShareAccounts({
        headers: signIn(owner),
        params: { artifactId },
        query: { query: peer.email.slice(0, 6) },
      }),
      [200],
    );
    const addOn = await accept(
      accessClient.addShare({
        headers: signIn(owner),
        params: { artifactId },
        body: { userId: peer.userId },
      }),
      [200],
    );
    const removeOn = await accept(
      accessClient.removeShare({
        headers: signIn(owner),
        params: { artifactId, userId: peer.userId },
      }),
      [200],
    );

    expect(listOn.body.shares).toStrictEqual([]);
    expect(
      searchOn.body.accounts.map((account) => {
        return account.userId;
      }),
    ).toContain(peer.userId);
    expect(addOn.body.share.userId).toBe(peer.userId);
    expect(removeOn.body).toStrictEqual({ removed: peer.userId });
    await flushWaitUntilForTest();
  });

  it("pf-162 unified artifact visibility and shares manage hosted-site artifacts end-to-end", async () => {
    acceptEmails();
    const owner = await seedMember();
    const orgId = owner.orgId ?? "";
    const [peer] = await Promise.all([
      seedMember(orgId),
      updateFeatureSwitchesForUser(
        context,
        { userId: owner.userId, orgId, orgRole: owner.orgRole },
        {
          [FeatureSwitchKey.ArtifactUserSharing]: true,
        },
      ),
    ]);
    registerClerkDirectory([owner, peer]);
    const { artifactId } = await publishPrivateSiteArtifact(owner);
    const headers = signIn(owner);

    const initial = await accept(
      accessClient.getVisibility({ headers, params: { artifactId } }),
      [200],
    );
    expect(initial.body).toMatchObject({
      kind: "hosted-site",
      visibility: "private",
      shareUrl: null,
    });
    expect(initial.body.artifactId).toBeTruthy();

    await accept(
      accessClient.updateVisibility({
        headers,
        params: { artifactId },
        body: { visibility: "organization" },
      }),
      [200],
    );

    const readOrg = await accept(
      accessClient.getVisibility({ headers, params: { artifactId } }),
      [200],
    );
    expect(readOrg.body.visibility).toBe("organization");

    await accept(
      accessClient.updateVisibility({
        headers,
        params: { artifactId },
        body: { visibility: "public" },
      }),
      [200],
    );

    const readPublic = await accept(
      accessClient.getVisibility({ headers, params: { artifactId } }),
      [200],
    );
    expect(readPublic.body.visibility).toBe("public");
    expect(readPublic.body.shareUrl).toBeTruthy();

    await accept(
      accessClient.addShare({
        headers,
        params: { artifactId },
        body: { userId: peer.userId },
      }),
      [200],
    );
    const sharesAfterAdd = await accept(
      accessClient.listShares({ headers, params: { artifactId } }),
      [200],
    );
    expect(
      sharesAfterAdd.body.shares.map((share) => {
        return share.email;
      }),
    ).toContain(peer.email);

    await accept(
      accessClient.removeShare({
        headers,
        params: { artifactId, userId: peer.userId },
      }),
      [200],
    );
    const sharesAfterRemove = await accept(
      accessClient.listShares({ headers, params: { artifactId } }),
      [200],
    );
    expect(sharesAfterRemove.body.shares).toStrictEqual([]);
    await flushWaitUntilForTest();
  });

  it("pf-165 addShare returns 404 for unowned or missing artifacts before membership lookup or quota", async () => {
    const storage = installFileStorage();
    acceptEmails();
    const ownerA = await seedMember();
    const orgId = ownerA.orgId ?? "";
    const [ownerB, peer] = await Promise.all([
      seedMember(orgId),
      seedMember(orgId),
    ]);
    await updateFeatureSwitchesForUser(
      context,
      { userId: ownerB.userId, orgId, orgRole: ownerB.orgRole },
      { [FeatureSwitchKey.ArtifactUserSharing]: true },
    );
    registerClerkDirectory([ownerA, ownerB, peer]);
    const artifactA = await uploadPrivateFileArtifact(ownerA, storage);
    const artifactB = await uploadPrivateFileArtifact(ownerB, storage);

    const headersB = signIn(ownerB);
    const missingStatus = await accept(
      accessClient.addShare({
        headers: headersB,
        params: { artifactId: randomUUID() },
        body: { userId: peer.userId },
      }),
      [404],
    );
    const foreignStatus = await accept(
      accessClient.addShare({
        headers: headersB,
        params: { artifactId: artifactA.artifactId },
        body: { userId: peer.userId },
      }),
      [404],
    );

    const ownShare = await accept(
      accessClient.addShare({
        headers: headersB,
        params: { artifactId: artifactB.artifactId },
        body: { userId: peer.userId },
      }),
      [200],
    );

    expect(missingStatus.status).toBe(404);
    expect(foreignStatus.status).toBe(404);
    expect(ownShare.body.share.userId).toBe(peer.userId);
    await flushWaitUntilForTest();
  });

  it("pf-171 unified artifact visibility controls file artifacts and reflects immediately in catalog and reference resolution", async () => {
    const storage = installFileStorage();
    const owner = await seedMember();
    const orgId = owner.orgId ?? "";
    const peer = await seedMember(orgId);
    const { artifactId, fileId } = await uploadPrivateFileArtifact(
      owner,
      storage,
    );
    const reference = `${fileId.replace(/-/gu, "")}.pdf`;

    const ownerHeaders = signIn(owner);
    const initialCatalog = await accept(
      catalogClient.list({ headers: ownerHeaders, query: {} }),
      [200],
    );
    expect(initialCatalog.body.artifacts[0]?.visibility).toBe("private");
    await accept(
      referencesClient.resolve({
        headers: ownerHeaders,
        params: { reference },
        query: {},
      }),
      [200],
    );

    const peerHeaders = signIn(peer);
    await accept(
      referencesClient.resolve({
        headers: peerHeaders,
        params: { reference },
        query: {},
      }),
      [404],
    );
    await accept(referencesClient.publicUrl({ params: { reference } }), [404]);

    await accept(
      accessClient.updateVisibility({
        headers: signIn(owner),
        params: { artifactId },
        body: { visibility: "organization" },
      }),
      [200],
    );
    const orgCatalog = await accept(
      catalogClient.list({ headers: signIn(owner), query: {} }),
      [200],
    );
    expect(orgCatalog.body.artifacts[0]?.visibility).toBe("organization");
    await accept(
      referencesClient.resolve({
        headers: signIn(peer),
        params: { reference },
        query: {},
      }),
      [200],
    );
    await accept(referencesClient.publicUrl({ params: { reference } }), [404]);

    await accept(
      accessClient.updateVisibility({
        headers: signIn(owner),
        params: { artifactId },
        body: { visibility: "public" },
      }),
      [200],
    );
    const publicCatalog = await accept(
      catalogClient.list({ headers: signIn(owner), query: {} }),
      [200],
    );
    expect(publicCatalog.body.artifacts[0]?.visibility).toBe("public");
    await accept(referencesClient.publicUrl({ params: { reference } }), [200]);

    await accept(
      accessClient.updateVisibility({
        headers: signIn(owner),
        params: { artifactId },
        body: { visibility: "private" },
      }),
      [200],
    );
    const privateCatalog = await accept(
      catalogClient.list({ headers: signIn(owner), query: {} }),
      [200],
    );
    expect(privateCatalog.body.artifacts[0]?.visibility).toBe("private");
    await accept(
      referencesClient.resolve({
        headers: signIn(peer),
        params: { reference },
        query: {},
      }),
      [404],
    );
    await accept(referencesClient.publicUrl({ params: { reference } }), [404]);
  });

  it("pf-176 unshared user files are owner-only, and library delete soft-deletes artifacts without breaking owner file access", async () => {
    const storage = installFileStorage();
    const owner = await seedMember();
    const orgId = owner.orgId ?? "";
    const peer = await seedMember(orgId);
    const { fileId } = await uploadPrivateFileArtifact(owner, storage);
    const reference = `${fileId.replace(/-/gu, "")}.pdf`;

    const beforeCatalog = await accept(
      catalogClient.list({ headers: signIn(owner), query: {} }),
      [200],
    );
    const entry = beforeCatalog.body.artifacts[0];
    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error("Expected uploaded file in owner library catalog");
    }

    await accept(
      referencesClient.resolve({
        headers: signIn(peer),
        params: { reference },
        query: {},
      }),
      [404],
    );

    const deleted = await accept(
      catalogClient.delete({
        headers: signIn(owner),
        params: { artifactId: entry.id },
      }),
      [200],
    );
    expect(deleted.body).toStrictEqual({ deleted: true });

    const afterCatalog = await accept(
      catalogClient.list({ headers: signIn(owner), query: {} }),
      [200],
    );
    expect(afterCatalog.body.artifacts).toStrictEqual([]);
    await accept(
      catalogClient.get({
        headers: signIn(owner),
        params: { artifactId: entry.id },
      }),
      [404],
    );

    const ownerStillReads = await accept(
      referencesClient.resolve({
        headers: signIn(owner),
        params: { reference },
        query: {},
      }),
      [200],
    );
    expect(ownerStillReads.body.target).toStrictEqual({
      kind: "file",
      id: fileId,
    });
    expect(ownerStillReads.body.artifactId).toBeUndefined();
    await accept(
      referencesClient.resolve({
        headers: signIn(peer),
        params: { reference },
        query: {},
      }),
      [404],
    );
  });
});
