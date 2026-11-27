import { randomUUID } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { array, object, string } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactFavoritesContract } from "@okouai/api-contracts/contracts/artifact-favorites";
import { artifactSharingContract } from "@okouai/api-contracts/contracts/artifact-sharing";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { sharedThreadVisibilityContract } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { RouteEntry } from "../../route-entry";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactFavoritesRoutes } from "../artifact-favorites";
import { artifactSharingRoutes } from "../artifact-sharing";
import { artifactShareRoutes } from "../artifact-shares";
import { hostRoutes } from "../host";
import { sharedThreadRoutes } from "../shared-threads";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { launchCatalogPublisher } from "./helpers/catalog-publisher";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { mockClerkUsers } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  hostedTextFile,
  uploadHostedTextFiles,
} from "./helpers/api-bdd-host-files";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes: readonly RouteEntry[] = [
  ...artifactFavoritesRoutes,
  ...artifactCatalogRoutes,
  ...artifactSharingRoutes,
  ...artifactShareRoutes,
  ...hostRoutes,
  ...sharedThreadRoutes,
  ...uploadsPrepareRoutes,
  ...uploadsCompleteRoutes,
];

function api(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return setupApp({ context, routes });
}

async function flags(actor: ApiTestUser, library = true, star = true) {
  if (!actor.orgId) {
    throw new Error("Expected workspace");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    {
      [FeatureSwitchKey.ArtifactLibrary]: library,
      [FeatureSwitchKey.Star]: star,
      [FeatureSwitchKey.HostedSiteEmailSharing]: true,
    },
  );
}

async function upload(
  actor: ApiTestUser,
  filename = "private-report.pdf",
  contentType = "application/pdf",
) {
  const content = "favorite content";
  const prepared = await accept(
    api(actor)(uploadsContract).prepare({
      headers,
      body: {
        filename,
        contentType,
        size: Buffer.byteLength(content),
        purpose: "artifact",
      },
    }),
    [200],
  );
  if (!("uploadUrl" in prepared.body)) {
    throw new Error("Expected single upload");
  }
  const stored = await fetch(prepared.body.uploadUrl, {
    method: "PUT",
    headers: prepared.body.uploadHeaders,
    body: content,
  });
  expect(stored.status).toBe(200);
  const complete = await accept(
    api(actor)(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  const catalog = await accept(
    api(actor)(artifactCatalogContract).list({ headers, query: {} }),
    [200],
  );
  const artifact = catalog.body.artifacts.find((row) => {
    return row.title === filename;
  });
  if (!artifact) {
    throw new Error("Expected catalog entry");
  }
  return {
    artifactId: artifact.id,
    fileId: prepared.body.id,
    url: complete.body.url,
    artifact,
  };
}

function directory(
  users: readonly ApiTestUser[],
  members: readonly ApiTestUser[] = users,
) {
  mockClerkUsers(
    context,
    users.map((user) => {
      return {
        id: user.userId,
        firstName: "Favorite",
        lastName: "Viewer",
        banned: false,
        primaryEmailAddressId: `email_${user.userId}`,
        emailAddresses: [
          {
            id: `email_${user.userId}`,
            emailAddress: user.email,
            verification: { status: "verified" },
          },
        ],
      };
    }),
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const params = object({
        organizationId: string(),
        userId: array(string()).optional(),
        emailAddress: array(string()).optional(),
      }).parse(input);
      return Promise.resolve({
        data: members
          .filter((user) => {
            return (
              user.orgId === params.organizationId &&
              (!params.userId || params.userId.includes(user.userId)) &&
              (!params.emailAddress || params.emailAddress.includes(user.email))
            );
          })
          .map((user) => {
            return {
              organization: { id: user.orgId, name: "Source workspace" },
              publicUserData: { userId: user.userId },
              role: user.orgRole,
            };
          }),
      });
    },
  );
}

beforeEach(() => {
  installSharedThreadStorage(context);
  context.mocks.resend.send.mockResolvedValue({
    data: { id: randomUUID() },
    error: null,
  });
});

describe("artifact favorites", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    "requires BOTH flags for every entry point (library=%s, star=%s)",
    async (library, star) => {
      const owner = bdd.user();
      const file = await upload(owner);
      await flags(owner, library, star);
      const client = api(owner)(artifactFavoritesContract);
      const params = { artifactId: file.artifactId };
      const gated = await accept(
        client.create({ headers, body: params }),
        [403],
      );
      expect(gated.body).toMatchObject({
        error: { message: "Favorites are not available" },
      });
      await accept(client.remove({ headers, params }), [403]);
      await accept(client.list({ headers, query: {} }), [403]);
      await accept(
        client.status({
          headers,
          query: { artifactIds: `${file.artifactId},${randomUUID()}` },
        }),
        [403],
      );
      await accept(
        client.resolve({ headers, query: { url: file.url } }),
        [403],
      );
      await accept(client.get({ headers, params }), [403]);
      await accept(
        client.get({ headers, params: { artifactId: randomUUID() } }),
        [403],
      );
      // New gates never disable the existing Library/catalog contract.
      await accept(
        api(owner)(artifactCatalogContract).list({ headers, query: {} }),
        [200],
      );
    },
  );

  it("authenticates reads and writes and requires an active workspace", async () => {
    const actor = bdd.user({ orgId: null });
    await accept(
      api(actor)(artifactFavoritesContract).list({ headers, query: {} }),
      [401],
    );
    await accept(
      api(actor)(artifactFavoritesContract).create({
        headers,
        body: { artifactId: randomUUID() },
      }),
      [401],
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const client = setupApp({ context, routes })(artifactFavoritesContract);
    const unauthenticated = await accept(
      client.status({ query: { artifactIds: randomUUID() } }),
      [401],
    );
    expect(unauthenticated.body).not.toHaveProperty("favorites");
    await accept(
      client.remove({ params: { artifactId: randomUUID() } }),
      [401],
    );
  });

  it("is idempotent, orders by favorite time and UUID, batches status, and scopes relations per user and workspace", async () => {
    const owner = bdd.user();
    await flags(owner);
    const first = await upload(owner, "one.md", "text/markdown");
    const second = await upload(owner, "two.csv", "text/csv");
    mockNow(new Date("2026-11-27T08:00:00Z"));
    for (const artifactId of [first.artifactId, second.artifactId]) {
      await accept(
        api(owner)(artifactFavoritesContract).create({
          headers,
          body: { artifactId },
        }),
        [200],
      );
    }
    const initial = await accept(
      api(owner)(artifactFavoritesContract).list({ headers, query: {} }),
      [200],
    );
    expect(
      initial.body.favorites.map((favorite) => {
        return favorite.artifactId;
      }),
    ).toStrictEqual([first.artifactId, second.artifactId].sort().reverse());
    mockNow(new Date("2026-11-27T09:00:00Z"));
    await accept(
      api(owner)(artifactFavoritesContract).create({
        headers,
        body: { url: first.url },
      }),
      [200],
    );
    const repeated = await accept(
      api(owner)(artifactFavoritesContract).list({ headers, query: {} }),
      [200],
    );
    expect(repeated.body).toStrictEqual(initial.body);
    const resolved = await accept(
      api(owner)(artifactFavoritesContract).resolve({
        headers,
        query: { url: first.url },
      }),
      [200],
    );
    expect(resolved.body).toStrictEqual({
      artifactId: first.artifactId,
      favorited: true,
    });
    const detail = await accept(
      api(owner)(artifactFavoritesContract).get({
        headers,
        params: { artifactId: first.artifactId },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({ id: first.artifactId, isOwner: true });
    const missing = randomUUID();
    const status = await accept(
      api(owner)(artifactFavoritesContract).status({
        headers,
        query: {
          artifactIds: [first.artifactId, first.fileId, missing].join(","),
        },
      }),
      [200],
    );
    expect(status.body.favorites).toStrictEqual({
      [first.artifactId]: true,
      [first.fileId]: false,
      [missing]: false,
    });
    for (const actor of [
      bdd.user({ orgId: owner.orgId }),
      { ...owner, orgId: `org_${randomUUID()}` },
    ]) {
      await flags(actor);
      expect(
        (
          await accept(
            api(actor)(artifactFavoritesContract).list({ headers, query: {} }),
            [200],
          )
        ).body.favorites,
      ).toStrictEqual([]);
      expect(
        (
          await accept(
            api(actor)(artifactFavoritesContract).status({
              headers,
              query: { artifactIds: first.artifactId },
            }),
            [200],
          )
        ).body.favorites[first.artifactId],
      ).toBeFalsy();
      await accept(
        api(actor)(artifactFavoritesContract).remove({
          headers,
          params: { artifactId: first.artifactId },
        }),
        [200],
      );
    }
    expect(
      (
        await accept(
          api(owner)(artifactFavoritesContract).status({
            headers,
            query: { artifactIds: first.artifactId },
          }),
          [200],
        )
      ).body.favorites[first.artifactId],
    ).toBeTruthy();
  });

  it("favorites a supported public CDN object through prepare, upload, Run completion and catalog registration", async () => {
    const owner = bdd.user();
    const viewer = bdd.user();
    await flags(owner);
    await flags(viewer);
    const publisher = await launchCatalogPublisher(context, owner);
    const storage = installSharedThreadStorage(context);
    mockEnv("OKOU_PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.okou.io");
    const content = "Public CDN report";
    // The supported org-less upload protocol allocates public storage. The
    // genuine Run later completes that owned object into its workspace catalog.
    const prepared = await accept(
      api({ ...owner, orgId: null, orgRole: undefined })(
        uploadsContract,
      ).prepare({
        headers,
        body: {
          filename: "public-report.pdf",
          contentType: "application/pdf",
          size: Buffer.byteLength(content),
        },
      }),
      [200],
    );
    if (!("uploadUrl" in prepared.body)) {
      throw new Error("Expected single public upload");
    }
    expect(
      (
        await fetch(prepared.body.uploadUrl, {
          method: "PUT",
          headers: prepared.body.uploadHeaders,
          body: content,
        })
      ).status,
    ).toBe(200);
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const complete = await accept(
      setupApp({ context, routes })(uploadsContract).complete({
        headers: { authorization: `Bearer ${publisher.bearerToken}` },
        body: { id: prepared.body.id },
      }),
      [200],
    );
    expect(complete.body.url).toMatch(/^https:\/\/cdn\.okou\.io\/artifacts\//u);
    const catalog = await accept(
      api(owner)(artifactCatalogContract).list({ headers, query: {} }),
      [200],
    );
    const artifactId = catalog.body.artifacts[0]!.id;
    expect(
      (
        await accept(
          api(viewer)(artifactFavoritesContract).resolve({
            headers,
            query: { url: complete.body.url },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ artifactId, favorited: false });
    await accept(
      api(viewer)(artifactFavoritesContract).create({
        headers,
        body: { artifactId },
      }),
      [200],
    );
    expect(
      (
        await accept(
          api(viewer)(artifactFavoritesContract).get({
            headers,
            params: { artifactId },
          }),
          [200],
        )
      ).body,
    ).toMatchObject({ title: "public-report.pdf", isOwner: false });
    storage.removeUpload(prepared.body.uploadUrl);
    await accept(
      api(viewer)(artifactFavoritesContract).get({
        headers,
        params: { artifactId },
      }),
      [404],
    );
    expect(
      (
        await accept(
          api(viewer)(artifactFavoritesContract).list({ headers, query: {} }),
          [200],
        )
      ).body.favorites,
    ).toStrictEqual([
      { artifactId, createdAt: expect.any(String), artifact: null },
    ]);
  });

  it("paginates bounded relation pages and filters only currently authorized metadata", async () => {
    const owner = bdd.user();
    await flags(owner);
    const document = await upload(owner, "search-me.md", "text/markdown");
    const sheet = await upload(owner, "budget.csv", "text/csv");
    for (const [index, artifactId] of [
      document.artifactId,
      sheet.artifactId,
    ].entries()) {
      mockNow(new Date(`2026-11-27T08:00:0${index}Z`));
      await accept(
        api(owner)(artifactFavoritesContract).create({
          headers,
          body: { artifactId },
        }),
        [200],
      );
    }
    const first = await accept(
      api(owner)(artifactFavoritesContract).list({
        headers,
        query: { limit: 1, category: "document" },
      }),
      [200],
    );
    expect(first.body.favorites).toStrictEqual([]);
    expect(first.body.nextCursor).toStrictEqual(expect.any(String));
    const second = await accept(
      api(owner)(artifactFavoritesContract).list({
        headers,
        query: {
          limit: 1,
          category: "document",
          cursor: first.body.nextCursor!,
        },
      }),
      [200],
    );
    expect(second.body.favorites).toMatchObject([
      { artifactId: document.artifactId, artifact: { category: "document" } },
    ]);
    expect(second.body.nextCursor).toBeNull();
    await accept(
      api(owner)(artifactFavoritesContract).list({
        headers,
        query: { category: "image", cursor: first.body.nextCursor! },
      }),
      [400],
    );
    const found = await accept(
      api(owner)(artifactFavoritesContract).list({
        headers,
        query: { keyword: "SEARCH-ME" },
      }),
      [200],
    );
    expect(
      found.body.favorites.map((favorite) => {
        return favorite.artifactId;
      }),
    ).toStrictEqual([document.artifactId]);
  });

  it("uses live named-file grants across active workspaces and redacts revoked favorites without hiding their removable relation", async () => {
    const owner = bdd.user();
    const viewer = bdd.user({ orgId: owner.orgId });
    const outside = { ...viewer, orgId: `org_${randomUUID()}` };
    const stranger = bdd.user();
    await flags(owner);
    await flags(outside);
    await flags(stranger);
    const file = await upload(owner, "confidential-acquisition.pdf");
    directory([owner, viewer, stranger]);
    await accept(
      api(outside)(artifactFavoritesContract).get({
        headers,
        params: { artifactId: file.artifactId },
      }),
      [404],
    );
    await accept(
      api(stranger)(artifactFavoritesContract).create({
        headers,
        body: { artifactId: file.artifactId },
      }),
      [404],
    );
    await accept(
      api(stranger)(artifactFavoritesContract).resolve({
        headers,
        query: { url: file.url },
      }),
      [404],
    );
    const grant = await accept(
      api(owner)(artifactSharingContract).share({
        headers,
        params: { kind: "file", id: file.fileId },
        body: { email: viewer.email },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const resolved = await accept(
      api(outside)(artifactFavoritesContract).resolve({
        headers,
        query: { url: file.url },
      }),
      [200],
    );
    expect(resolved.body).toStrictEqual({
      artifactId: file.artifactId,
      favorited: false,
    });
    await accept(
      api(outside)(artifactFavoritesContract).create({
        headers,
        body: { url: file.url },
      }),
      [200],
    );
    const detail = await accept(
      api(outside)(artifactFavoritesContract).get({
        headers,
        params: { artifactId: file.artifactId },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      id: file.artifactId,
      title: "confidential-acquisition.pdf",
      isOwner: false,
    });
    expect(Object.keys(detail.body).sort()).toStrictEqual([
      "createdAt",
      "file",
      "id",
      "isOwner",
      "kind",
      "sourceUrl",
      "thumbnail",
      "title",
      "updatedAt",
    ]);
    expect(
      "file" in detail.body && Object.keys(detail.body.file).sort(),
    ).toStrictEqual([
      "contentType",
      "filename",
      "id",
      "previewImageUrl",
      "size",
      "url",
    ]);
    await accept(
      api(owner)(artifactSharingContract).remove({
        headers,
        params: { kind: "file", id: file.fileId, shareId: grant.body.share.id },
      }),
      [200],
    );
    const unavailable = await accept(
      api(outside)(artifactFavoritesContract).list({ headers, query: {} }),
      [200],
    );
    expect(unavailable.body.favorites).toStrictEqual([
      {
        artifactId: file.artifactId,
        createdAt: expect.any(String),
        artifact: null,
      },
    ]);
    expect(
      (
        await accept(
          api(outside)(artifactFavoritesContract).list({
            headers,
            query: { keyword: "confidential" },
          }),
          [200],
        )
      ).body.favorites,
    ).toStrictEqual([]);
    await accept(
      api(outside)(artifactFavoritesContract).get({
        headers,
        params: { artifactId: file.artifactId },
      }),
      [404],
    );
    expect(
      (
        await accept(
          api(outside)(artifactFavoritesContract).status({
            headers,
            query: { artifactIds: file.artifactId },
          }),
          [200],
        )
      ).body.favorites[file.artifactId],
    ).toBeTruthy();
    await accept(
      api(outside)(artifactFavoritesContract).remove({
        headers,
        params: { artifactId: file.artifactId },
      }),
      [200],
    );
    await accept(
      api(outside)(artifactFavoritesContract).remove({
        headers,
        params: { artifactId: file.artifactId },
      }),
      [200],
    );
    expect(
      (
        await accept(
          api(outside)(artifactFavoritesContract).list({ headers, query: {} }),
          [200],
        )
      ).body.favorites,
    ).toStrictEqual([]);
  });

  it.each(["organization", "public"] as const)(
    "uses current %s file sharing authority, including membership revocation",
    async (audience) => {
      const owner = bdd.user();
      const viewer = bdd.user({
        orgId: audience === "organization" ? owner.orgId : undefined,
      });
      await flags(owner);
      await flags(viewer);
      const file = await upload(owner);
      directory([owner, viewer]);
      await accept(
        api(owner)(artifactSharesContract).update({
          headers,
          body: { target: { kind: "file", id: file.fileId }, audience },
        }),
        [200],
      );
      await accept(
        api(viewer)(artifactFavoritesContract).create({
          headers,
          body: { artifactId: file.artifactId },
        }),
        [200],
      );
      if (audience === "organization") {
        directory([owner, viewer], [owner]);
      } else {
        await accept(
          api(owner)(artifactSharesContract).update({
            headers,
            body: {
              target: { kind: "file", id: file.fileId },
              audience: "private",
            },
          }),
          [200],
        );
      }
      expect(
        (
          await accept(
            api(viewer)(artifactFavoritesContract).list({ headers, query: {} }),
            [200],
          )
        ).body.favorites,
      ).toStrictEqual([
        {
          artifactId: file.artifactId,
          createdAt: expect.any(String),
          artifact: null,
        },
      ]);
    },
  );

  it("keeps deleted targets as generic placeholders and does not turn provider failures into unavailable", async () => {
    const owner = bdd.user();
    await flags(owner);
    const file = await upload(owner);
    await accept(
      api(owner)(artifactFavoritesContract).create({
        headers,
        body: { artifactId: file.artifactId },
      }),
      [200],
    );
    const storage = context.mocks.s3.send.getMockImplementation()!;
    context.mocks.s3.send.mockImplementation((operation, ...args) => {
      if (
        (operation instanceof GetObjectCommand &&
          operation.input.Key?.startsWith("artifact-references/")) ||
        (operation instanceof HeadObjectCommand &&
          operation.input.Key?.startsWith("private-artifacts/"))
      ) {
        return Promise.reject(new Error("Storage dependency offline"));
      }
      return storage(operation, ...args);
    });
    await accept(
      api(owner)(artifactFavoritesContract).resolve({
        headers,
        query: { url: file.url },
      }),
      [500],
    );
    await accept(
      api(owner)(artifactFavoritesContract).list({ headers, query: {} }),
      [500],
    );
    context.mocks.s3.send.mockImplementation(storage);
    await accept(
      api(owner)(artifactCatalogContract).delete({
        headers,
        params: { artifactId: file.artifactId },
      }),
      [200],
    );
    expect(
      (
        await accept(
          api(owner)(artifactFavoritesContract).list({ headers, query: {} }),
          [200],
        )
      ).body.favorites,
    ).toStrictEqual([
      {
        artifactId: file.artifactId,
        createdAt: expect.any(String),
        artifact: null,
      },
    ]);
    await accept(
      api(owner)(artifactFavoritesContract).remove({
        headers,
        params: { artifactId: file.artifactId },
      }),
      [200],
    );
    await accept(
      api(owner)(artifactFavoritesContract).remove({
        headers,
        params: { artifactId: randomUUID() },
      }),
      [200],
    );
  });

  it("opens the latest Site deployment only under its current access, never falling back to an earlier readable version", async () => {
    const owner = bdd.user();
    const viewer = bdd.user({ orgId: owner.orgId });
    await flags(owner);
    await flags(viewer);
    const publisher = await launchCatalogPublisher(context, owner);
    installSharedThreadStorage(context);
    directory([owner, viewer]);
    const host = createHostBddApi(context);
    const siteName = `favorite-${randomUUID().slice(0, 8)}`;
    const first = await host.prepareHostedSite(publisher, {
      site: siteName,
      title: "Version one",
      artifactKind: "presentation-html",
      spaFallback: false,
      visibility: "organization",
      files: [hostedTextFile("/index.html", "<main>first</main>")],
    });
    await uploadHostedTextFiles(first, { "/index.html": "<main>first</main>" });
    await host.completeHostedSite(publisher, first.deploymentId);
    const catalog = await accept(
      api(owner)(artifactCatalogContract).list({ headers, query: {} }),
      [200],
    );
    const artifactId = catalog.body.artifacts[0]!.id;
    await accept(
      api(viewer)(artifactFavoritesContract).create({
        headers,
        body: { artifactId },
      }),
      [200],
    );
    expect(
      (
        await accept(
          api(viewer)(artifactFavoritesContract).get({
            headers,
            params: { artifactId },
          }),
          [200],
        )
      ).body,
    ).toMatchObject({ site: { deploymentVersion: 1 }, isOwner: false });
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const second = await host.prepareHostedSite(publisher, {
      site: siteName,
      title: "Version two",
      artifactKind: "presentation-html",
      spaFallback: false,
      visibility: "private",
      files: [hostedTextFile("/index.html", "<main>second</main>")],
    });
    await uploadHostedTextFiles(second, {
      "/index.html": "<main>second</main>",
    });
    await host.completeHostedSite(publisher, second.deploymentId);
    const latest = await accept(
      api(owner)(artifactFavoritesContract).get({
        headers,
        params: { artifactId },
      }),
      [200],
    );
    expect(latest.body).toMatchObject({
      site: { deploymentVersion: 2 },
      isOwner: true,
      aliasUrl: expect.any(String),
      sourceChatThreadId: expect.any(String),
    });
    await accept(
      api(viewer)(artifactFavoritesContract).get({
        headers,
        params: { artifactId },
      }),
      [404],
    );
    await accept(
      api(viewer)(artifactFavoritesContract).resolve({
        headers,
        query: { url: first.artifactUrl ?? first.url },
      }),
      [404],
    );
    expect(
      (
        await accept(
          api(viewer)(artifactFavoritesContract).list({ headers, query: {} }),
          [200],
        )
      ).body.favorites,
    ).toStrictEqual([
      { artifactId, createdAt: expect.any(String), artifact: null },
    ]);
    await accept(
      api(owner)(artifactSharingContract).share({
        headers,
        params: { kind: "site", id: second.siteId },
        body: { email: viewer.email },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const sharedDetail = await accept(
      api(viewer)(artifactFavoritesContract).get({
        headers,
        params: { artifactId },
      }),
      [200],
    );
    expect(sharedDetail.body).toMatchObject({
      site: { deploymentVersion: 2 },
      isOwner: false,
    });
    expect(Object.keys(sharedDetail.body).sort()).toStrictEqual([
      "createdAt",
      "id",
      "isOwner",
      "kind",
      "site",
      "sourceUrl",
      "thumbnail",
      "title",
      "updatedAt",
    ]);
    expect(
      "site" in sharedDetail.body && Object.keys(sharedDetail.body.site).sort(),
    ).toStrictEqual([
      "deploymentVersion",
      "entrypoint",
      "id",
      "publicSlug",
      "slug",
      "spaFallback",
      "url",
    ]);
  });

  it("supports the entire shared conversation while rejecting its nested artifact snapshots", async () => {
    const owner = bdd.user();
    const viewer = bdd.user();
    const runs = createRunsApi(context);
    bdd.acceptStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.configureRunnerGroup();
    await runs.grantProEntitlement(owner);
    await runs.ensurePersonalSubscriptionModel(owner, {
      model: "claude-fable-5-1",
    });
    installSharedThreadStorage(context);
    const file = await upload(owner, "shared-report.pdf");
    const chat = createChatFilesBddApi(context);
    const sent = await chat.sendAndLaunch(owner, {
      prompt: `Share this launch plan: [Report](${file.url})`,
    });
    const { events } = await chat.listThreadEvents(owner, sent.threadId);
    const eventId = events.find((event) => {
      return event.eventType === "input.prompt" && event.runId === sent.runId;
    })?.id;
    if (!eventId) {
      throw new Error("Expected selected prompt");
    }
    await flags(owner);
    await flags(viewer);
    directory([owner, viewer]);
    const shared = await accept(
      api(owner)(sharedThreadVisibilityContract).create({
        headers,
        params: { threadId: sent.threadId },
        body: { eventIds: [eventId], audience: "public" },
      }),
      [201],
    );
    const url = new URL(`/share/threads/${shared.body.id}`, env("APP_URL"))
      .href;
    const resolved = await accept(
      api(viewer)(artifactFavoritesContract).resolve({
        headers,
        query: { url },
      }),
      [200],
    );
    await accept(
      api(viewer)(artifactFavoritesContract).create({ headers, body: { url } }),
      [200],
    );
    const ownerDetail = await accept(
      api(owner)(artifactFavoritesContract).get({
        headers,
        params: { artifactId: resolved.body.artifactId },
      }),
      [200],
    );
    expect(ownerDetail.body).toMatchObject({
      isOwner: true,
      sourceChatThreadId: sent.threadId,
    });
    const viewerDetail = await accept(
      api(viewer)(artifactFavoritesContract).get({
        headers,
        params: { artifactId: resolved.body.artifactId },
      }),
      [200],
    );
    expect(viewerDetail.body).toMatchObject({
      kind: "shared-thread",
      sharedThreadId: shared.body.id,
      isOwner: false,
    });
    expect(Object.keys(viewerDetail.body).sort()).toStrictEqual([
      "createdAt",
      "id",
      "isOwner",
      "kind",
      "sharedThread",
      "sharedThreadId",
      "thumbnail",
      "title",
      "updatedAt",
    ]);
    await chat.requestReadThread(viewer, sent.threadId, [404]);
    await accept(
      api(viewer)(artifactCatalogContract).delete({
        headers,
        params: { artifactId: resolved.body.artifactId },
      }),
      [404],
    );
    await accept(
      api(viewer)(sharedThreadVisibilityContract).update({
        headers,
        params: { id: shared.body.id },
        body: { audience: "private", expectedRevision: null },
      }),
      [404],
    );
    await accept(
      api(viewer)(sharedThreadsContract).delete({
        headers,
        params: { id: shared.body.id },
      }),
      [404],
    );
    await chat.requestReadThread(owner, sent.threadId, [200]);
    const snapshot = await accept(
      api(viewer)(sharedThreadsContract).get({
        params: { id: shared.body.id },
      }),
      [200],
    );
    const nested = snapshot.body.messages[0]?.content.match(
      /\/artifacts\/[a-z0-9]{10}(?:\.[a-z0-9]{1,12})?/u,
    )?.[0];
    expect(nested).toBeDefined();
    expect(nested).not.toBe(new URL(file.url).pathname);
    for (const actor of [owner, viewer]) {
      await accept(
        api(actor)(artifactFavoritesContract).resolve({
          headers,
          query: { url: nested! },
        }),
        [404],
      );
      await accept(
        api(actor)(artifactFavoritesContract).create({
          headers,
          body: { url: nested! },
        }),
        [404],
      );
    }
    const privateFollowup =
      "Private follow-up must never enter the published selection";
    await chat.requestSendEvent(
      owner,
      { threadId: sent.threadId, prompt: privateFollowup },
      [201],
    );
    await flushWaitUntilForTest();
    const privateSource = await chat.listThreadEvents(owner, sent.threadId);
    expect(JSON.stringify(privateSource.events)).toContain(privateFollowup);
    const unchanged = await accept(
      api(viewer)(sharedThreadsContract).get({
        params: { id: shared.body.id },
      }),
      [200],
    );
    expect(unchanged.body.messages).toStrictEqual(snapshot.body.messages);
    expect(
      unchanged.body.messages
        .map((message) => {
          return message.content;
        })
        .join("\n"),
    ).not.toContain(privateFollowup);
    const stillOwned = await accept(
      api(owner)(artifactFavoritesContract).get({
        headers,
        params: { artifactId: resolved.body.artifactId },
      }),
      [200],
    );
    expect(stillOwned.body).toMatchObject({
      sourceChatThreadId: sent.threadId,
      isOwner: true,
    });
    const visibility = await accept(
      api(owner)(sharedThreadVisibilityContract).get({
        headers,
        params: { id: shared.body.id },
      }),
      [200],
    );
    await accept(
      api(owner)(sharedThreadVisibilityContract).update({
        headers,
        params: { id: shared.body.id },
        body: {
          audience: "private",
          expectedRevision: visibility.body.revision,
        },
      }),
      [200],
    );
    expect(
      (
        await accept(
          api(viewer)(artifactFavoritesContract).list({ headers, query: {} }),
          [200],
        )
      ).body.favorites[0]?.artifact,
    ).toBeNull();
  });
});
