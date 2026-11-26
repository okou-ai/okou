import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharingContract } from "@okouai/api-contracts/contracts/artifact-sharing";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { artifactDownloadRoutes } from "../artifact-downloads";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactSharingRoutes } from "../artifact-sharing";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const REPORT = Buffer.from("%PDF-1.7 quarterly report");

interface Person {
  readonly user: ApiTestUser;
  readonly verified: boolean;
}

interface StoredObject {
  readonly body: Buffer;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return headers;
}

function notFoundError(): Error {
  return Object.assign(new Error("Not found"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

/** In-memory R2: presigned PUT URLs name the object the browser writes. */
function installStorage() {
  const objects = new Map<string, StoredObject>();
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
          return Promise.reject(
            Object.assign(new Error("Object exists"), {
              name: "PreconditionFailed",
              $metadata: { httpStatusCode: 412 },
            }),
          );
        }
        objects.set(id(input.Bucket, input.Key), {
          body: Buffer.from(input.Body as string | Uint8Array),
          contentType: input.ContentType as string | undefined,
        });
        return Promise.resolve({ ETag: '"put"' });
      }
      case "GetObjectCommand": {
        if (!stored) {
          return Promise.reject(notFoundError());
        }
        return Promise.resolve({
          Body: Readable.from([stored.body]),
          ContentLength: stored.body.byteLength,
          ContentType: stored.contentType,
          ETag: `"${createHash("sha256").update(stored.body).digest("hex")}"`,
        });
      }
      case "HeadObjectCommand": {
        if (!stored) {
          return Promise.reject(notFoundError());
        }
        return Promise.resolve({
          ContentLength: stored.body.byteLength,
          ContentType: stored.contentType,
          LastModified: new Date("2026-01-01T00:00:00.000Z"),
          Metadata: stored.metadata ?? {},
          ETag: '"head"',
        });
      }
      case "ListObjectsV2Command": {
        return Promise.resolve({ Contents: [], IsTruncated: false });
      }
      default: {
        return Promise.resolve({});
      }
    }
  });
  return {
    /** The browser PUTs bytes to a presigned upload URL. */
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
      objects.set(id(target.bucket, target.key), {
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

/** Clerk's user directory: every account is named "Taylor Viewer". */
function clerkDirectory(people: readonly Person[]) {
  mockClerkUsers(
    context,
    people.map((person) => {
      const emailId = `email_${person.user.userId}`;
      return {
        id: person.user.userId,
        username: null,
        banned: false,
        firstName: "Taylor",
        lastName: "Viewer",
        primaryEmailAddressId: emailId,
        emailAddresses: [
          {
            id: emailId,
            emailAddress: person.user.email,
            verification: {
              status: person.verified ? "verified" : "unverified",
            },
          },
        ],
      };
    }),
  );
}

async function member(
  options: {
    readonly userId?: string;
    readonly orgId?: string;
    readonly email?: string;
  } = {},
): Promise<ApiTestUser> {
  const user = bdd.user({
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.orgId ? { orgId: options.orgId, orgRole: "org:member" } : {}),
    ...(options.email ? { email: options.email } : {}),
  });
  await store.set(
    seedOrgMembership$,
    {
      orgId: user.orgId ?? "",
      userId: user.userId,
      role: user.orgRole === "org:admin" ? "admin" : "member",
      emailAddresses: [user.email],
    },
    context.signal,
  );
  return user;
}

async function setSharing(actor: ApiTestUser, enabled: boolean) {
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId ?? "", orgRole: actor.orgRole },
    { [FeatureSwitchKey.HostedSiteEmailSharing]: enabled },
  );
}

function acceptEmails() {
  context.mocks.resend.send.mockResolvedValue({
    data: { id: `email-${randomUUID()}` },
    error: null,
  });
}

/** The owner uploads report.pdf through the browser upload flow. */
async function uploadReport(owner: ApiTestUser) {
  const storage = installStorage();
  const uploads = setupApp({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
  })(uploadsContract);
  const prepared = await accept(
    uploads.prepare({
      headers: signIn(owner),
      body: {
        filename: "report.pdf",
        contentType: "application/pdf",
        size: REPORT.byteLength,
      },
    }),
    [200],
  );
  if ("multipart" in prepared.body) {
    throw new Error("Expected a single-part upload");
  }
  storage.upload(
    prepared.body.uploadUrl,
    REPORT,
    "application/pdf",
    prepared.body.uploadHeaders,
  );
  const completed = await accept(
    uploads.complete({
      headers: signIn(owner),
      body: { id: prepared.body.id },
    }),
    [200],
  );
  const reference = new URL(completed.body.url).pathname.split("/").at(-1);
  if (!reference) {
    throw new Error("Expected an artifact reference");
  }
  return { id: prepared.body.id, reference };
}

function sharingApi() {
  return setupApp({ context, routes: artifactSharingRoutes })(
    artifactSharingContract,
  );
}

function share(actor: ApiTestUser, fileId: string, email: string) {
  return sharingApi().share({
    headers: signIn(actor),
    params: { kind: "file", id: fileId },
    body: { email },
  });
}

function removeShare(actor: ApiTestUser, fileId: string, shareId: string) {
  return sharingApi().remove({
    headers: signIn(actor),
    params: { kind: "file", id: fileId, shareId },
    body: undefined,
  });
}

function searchAccounts(actor: ApiTestUser, fileId: string, query: string) {
  return sharingApi().search({
    headers: signIn(actor),
    params: { kind: "file", id: fileId },
    query: { query },
  });
}

function resolveReference(actor: ApiTestUser, reference: string) {
  return setupApp({ context, routes: artifactReferenceRoutes })(
    artifactReferencesContract,
  ).resolve({ headers: signIn(actor), params: { reference }, query: {} });
}

function downloadReference(actor: ApiTestUser, reference: string) {
  return setupApp({ context, routes: artifactDownloadRoutes })(
    artifactDownloadsContract,
  ).download({ headers: signIn(actor), params: { reference } });
}

function expectOneInvitation(recipient: string) {
  const sent = context.mocks.resend.send.mock.calls.map((call) => {
    return call[0];
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ from: "Okou <noreply@okou.ai>" });
  const payload = JSON.stringify(sent[0]);
  expect(payload).toContain(recipient);
  expect(payload).toContain("okou-artifact-invitation-v1");
  expect(payload).toContain("Taylor Viewer");
  expect(payload).toContain("/artifacts/");
}

/** Sharing is on, the owner uploaded report.pdf and "Taylor Viewer" is a verified member. */
async function namedViewerScenario() {
  acceptEmails();
  const owner = await member();
  const viewer = await member({
    orgId: owner.orgId ?? undefined,
    email: "taylor@example.com",
  });
  clerkDirectory([
    { user: owner, verified: true },
    { user: viewer, verified: true },
  ]);
  await setSharing(owner, true);
  const file = await uploadReport(owner);
  return { owner, viewer, file };
}

/** The same viewer, now active in another workspace with a Pro entitlement. */
async function proWorkspaceOf(viewer: ApiTestUser) {
  const elsewhere = await member({
    userId: viewer.userId,
    email: viewer.email,
  });
  await publicPlanLifecycle(context, elsewhere, "pro").update("active");
  return elsewhere;
}

describe("artifact sharing", () => {
  it("artifact-sharing-005 honors the server switch and recipient quotas", async () => {
    acceptEmails();
    const owner = await member();
    clerkDirectory([{ user: owner, verified: true }]);
    const file = await uploadReport(owner);

    const disabled = await accept(
      share(owner, file.id, "viewer@example.com"),
      [404],
    );
    await setSharing(owner, true);
    const enabled = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      enabled.push(
        await accept(share(owner, file.id, "viewer@example.com"), [200]),
      );
    }
    const limited = await accept(
      share(owner, file.id, "viewer@example.com"),
      [429],
    );
    const elsewhere = await member({ userId: owner.userId });
    await setSharing(elsewhere, true);
    const listedElsewhere = await accept(
      sharingApi().list({
        headers: signIn(elsewhere),
        params: { kind: "file", id: file.id },
      }),
      [404],
    );

    expect(disabled.status).toBe(404);
    expect(
      enabled.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([200, 200, 200]);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(listedElsewhere.status).toBe(404);
  });

  it("artifact-sharing-001 (1/3) invites the named viewer once for two shares", async () => {
    const { owner, viewer, file } = await namedViewerScenario();

    const first = await accept(share(owner, file.id, viewer.email), [200]);
    const second = await accept(share(owner, file.id, viewer.email), [200]);

    expect(first.body).toStrictEqual({
      share: { id: first.body.share.id, email: viewer.email },
    });
    expect(second.body).toStrictEqual(first.body);
    expectOneInvitation(viewer.email);
  });

  it("artifact-sharing-001 (2/3) lets the viewer open and download report.pdf from another workspace", async () => {
    const { owner, viewer, file } = await namedViewerScenario();
    await accept(share(owner, file.id, viewer.email), [200]);
    const elsewhere = await proWorkspaceOf(viewer);

    const preview = await accept(
      resolveReference(elsewhere, file.reference),
      [200],
    );
    const download = await accept(
      downloadReference(elsewhere, file.reference),
      [200],
    );
    const reshare = await accept(
      share(elsewhere, file.id, "other@example.com"),
      [404],
    );

    expect(preview.body).toMatchObject({
      filename: "report.pdf",
      contentType: "application/pdf",
      target: { kind: "file" },
    });
    expect(download.body).toMatchObject({ kind: "file" });
    expect(reshare.status).toBe(404);
  });

  it("artifact-sharing-001 (3/3) closes both reads after the owner removes the grant", async () => {
    const { owner, viewer, file } = await namedViewerScenario();
    const shared = await accept(share(owner, file.id, viewer.email), [200]);
    const elsewhere = await proWorkspaceOf(viewer);

    const removed = await accept(
      removeShare(owner, file.id, shared.body.share.id),
      [200],
    );
    const preview = await accept(
      resolveReference(elsewhere, file.reference),
      [404],
    );
    const download = await accept(
      downloadReference(elsewhere, file.reference),
      [404],
    );

    expect([removed.status, preview.status, download.status]).toStrictEqual([
      200, 404, 404,
    ]);
  });

  it("artifact-sharing-003 invites an external email and requires verification to claim", async () => {
    acceptEmails();
    const owner = await member();
    const invitee = await member({ email: "outside@example.com" });
    clerkDirectory([
      { user: owner, verified: true },
      { user: invitee, verified: false },
    ]);
    await setSharing(owner, true);
    const file = await uploadReport(owner);

    const first = await accept(share(owner, file.id, invitee.email), [200]);
    const second = await accept(share(owner, file.id, invitee.email), [200]);
    const unverified = await accept(
      resolveReference(invitee, file.reference),
      [404],
    );
    clerkDirectory([
      { user: owner, verified: true },
      { user: invitee, verified: true },
    ]);
    const verified = await accept(
      resolveReference(invitee, file.reference),
      [200],
    );
    await accept(removeShare(owner, file.id, first.body.share.id), [200]);
    const removed = await accept(
      resolveReference(invitee, file.reference),
      [404],
    );

    expect(second.body).toStrictEqual(first.body);
    expectOneInvitation(invitee.email);
    expect([unverified.status, verified.status, removed.status]).toStrictEqual([
      404, 200, 404,
    ]);
  });

  it("artifact-sharing-004 keeps search in the owner's workspace and stops strangers claiming", async () => {
    acceptEmails();
    const owner = await member();
    const local = await member({
      orgId: owner.orgId ?? undefined,
      email: "taylor.local@example.com",
    });
    const external = await member({ email: "taylor.external@example.com" });
    const stranger = await member();
    clerkDirectory([
      { user: owner, verified: true },
      { user: local, verified: true },
      { user: external, verified: true },
      { user: stranger, verified: true },
    ]);
    await setSharing(owner, true);
    await setSharing(stranger, true);
    const file = await uploadReport(owner);

    const byNickname = await accept(
      searchAccounts(owner, file.id, "Taylor"),
      [200],
    );
    const byExternalEmail = await accept(
      searchAccounts(owner, file.id, external.email),
      [200],
    );
    await accept(share(owner, file.id, external.email), [200]);
    const strangerResolve = await accept(
      resolveReference(stranger, file.reference),
      [404],
    );
    const strangerSearch = await accept(
      searchAccounts(stranger, file.id, "Taylor"),
      [404],
    );

    expect(byNickname.body.accounts).toStrictEqual([
      { userId: local.userId, name: "Taylor Viewer", email: local.email },
    ]);
    expect(byExternalEmail.body.accounts).toStrictEqual([]);
    expect([strangerResolve.status, strangerSearch.status]).toStrictEqual([
      404, 404,
    ]);
  });
});
