import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  artifactCatalogContract,
  type ArtifactCatalogListClientQuery,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { array, literal, object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactReferenceRoutes } from "../artifact-references";
import { artifactShareRoutes } from "../artifact-shares";
import { featureSwitchesRoutes } from "../feature-switches";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function api() {
  return setupApp({
    context,
    routes: [
      ...artifactCatalogRoutes,
      ...artifactReferenceRoutes,
      ...artifactShareRoutes,
      ...featureSwitchesRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
    ],
  });
}

function fixture() {
  const owner = `user_${randomUUID()}`;
  const org = `org_${randomUUID()}`;
  const memberships = new Map([[org, new Set([owner])]]);
  const objects = new Map<string, string>();
  const etag = (body: string) => {
    return `"${createHash("md5").update(body).digest("hex")}"`;
  };

  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou.app");
  mockEnv("OKOU_HOST_SCHEME", "https");
  context.mocks.clerk.organizations.getOrganization.mockImplementation(
    (input) => {
      const { organizationId } = object({ organizationId: string() }).parse(
        input,
      );
      return Promise.resolve({
        id: organizationId,
        name: "Favorites test workspace",
      });
    },
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const params = object({
        organizationId: string(),
        userId: array(string()),
        limit: literal(1),
      }).parse(input);
      const members = memberships.get(params.organizationId);
      return Promise.resolve({
        data: params.userId
          .filter((userId) => {
            return members?.has(userId);
          })
          .map((userId) => {
            return {
              publicUserData: { userId },
              role: "org:member",
              organization: {
                id: params.organizationId,
                name: "Favorites test workspace",
              },
            };
          }),
        totalCount: members?.size ?? 0,
      });
    },
  );
  context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const { userId } = object({ userId: string() }).parse(input);
      return Promise.resolve({
        data: [...memberships]
          .filter(([, members]) => {
            return members.has(userId);
          })
          .map(([organizationId]) => {
            return {
              organization: { id: organizationId },
              publicUserData: { userId },
              role: "org:member",
            };
          }),
      });
    },
  );
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://private-r2.example/report.pdf?signature=temporary",
  );
  context.mocks.s3.send.mockImplementation((cmd) => {
    if (cmd instanceof ListObjectsV2Command) {
      return Promise.resolve({ Contents: [] });
    }
    if (cmd instanceof HeadObjectCommand) {
      return Promise.resolve({
        ContentLength: 13,
        ContentType: "application/pdf",
        Metadata: { "artifact-id": cmd.input.Key?.split("/")[1] },
      });
    }
    if (cmd instanceof CopyObjectCommand) {
      return Promise.resolve({});
    }
    if (cmd instanceof PutObjectCommand) {
      const key = cmd.input.Key;
      if (!key) {
        throw new Error("Expected an object-storage key");
      }
      const previous = objects.get(key);
      if (
        (cmd.input.IfNoneMatch === "*" && previous !== undefined) ||
        (cmd.input.IfMatch &&
          (previous === undefined || cmd.input.IfMatch !== etag(previous)))
      ) {
        return Promise.reject(
          Object.assign(new Error("Stale policy write"), {
            name: "PreconditionFailed",
          }),
        );
      }
      objects.set(key, String(cmd.input.Body));
      return Promise.resolve({});
    }
    if (cmd instanceof GetObjectCommand) {
      const body = cmd.input.Key ? objects.get(cmd.input.Key) : undefined;
      if (body === undefined) {
        return Promise.reject(
          Object.assign(new Error("Missing"), { name: "NoSuchKey" }),
        );
      }
      return Promise.resolve({
        Body: Readable.from([Buffer.from(body)]),
        ETag: etag(body),
      });
    }
    throw new Error("Unexpected storage operation");
  });

  function session(userId = owner, orgId: string | null = org) {
    mocks.clerk.session(userId, orgId, "org:member");
  }
  function addMember(userId: string, orgId = org) {
    const members = memberships.get(orgId) ?? new Set<string>();
    members.add(userId);
    memberships.set(orgId, members);
  }
  function removeMember(userId: string) {
    memberships.get(org)?.delete(userId);
  }
  session();
  return { owner, org, session, addMember, removeMember };
}

async function setLibraryEnabled(enabled = true) {
  const result = await accept(
    api()(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.ArtifactLibrary]: enabled } },
    }),
    [200],
  );
  expect(result.body.effectiveSwitches[FeatureSwitchKey.ArtifactLibrary]).toBe(
    enabled,
  );
}

async function list(query?: ArtifactCatalogListClientQuery) {
  const response = await accept(
    api()(artifactCatalogContract).list({ headers, query }),
    [200],
  );
  return response.body;
}

async function upload(filename = "report.pdf") {
  const before = await list({ limit: 200 });
  const previousIds = new Set(
    before.artifacts.map((artifact) => {
      return artifact.id;
    }),
  );
  const prepared = await accept(
    api()(uploadsContract).prepare({
      headers,
      body: {
        filename,
        contentType: filename.endsWith(".pptx")
          ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          : "application/pdf",
        size: 13,
        purpose: "artifact",
      },
    }),
    [200],
  );
  await accept(
    api()(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  const after = await list({ limit: 200 });
  const added = after.artifacts.filter((artifact) => {
    return !previousIds.has(artifact.id);
  });
  expect(added).toHaveLength(1);
  const artifact = added[0];
  if (!artifact) {
    throw new Error("Expected the uploaded artifact in the catalog");
  }
  return {
    artifactId: artifact.id,
    target: { kind: "file" as const, id: prepared.body.id },
  };
}

type UploadedArtifact = Awaited<ReturnType<typeof upload>>;

async function share(
  artifact: UploadedArtifact,
  audience: "organization" | "private" = "organization",
) {
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target: artifact.target, audience },
    }),
    [200],
  );
}

async function setFavorite(artifactId: string, starred = true) {
  const response = await accept(
    api()(artifactCatalogContract).setFavorite({
      headers,
      params: { artifactId },
      body: { starred },
    }),
    [200],
  );
  expect(response.body).toStrictEqual({ artifactId, starred });
}

async function expectFavorites(artifactIds: readonly string[]) {
  const response = await accept(
    api()(artifactCatalogContract).listFavorites({ headers }),
    [200],
  );
  expect([...response.body.artifactIds].sort()).toStrictEqual(
    [...artifactIds].sort(),
  );
}

function ids(page: Awaited<ReturnType<typeof list>>) {
  return page.artifacts.map((artifact) => {
    return artifact.id;
  });
}

async function expectUnavailable(artifactId: string) {
  await expectFavorites([]);
  expect(ids(await list({ starred: "true" }))).toStrictEqual([]);
  expect(ids(await list({ sort: "title", direction: "asc" }))).toStrictEqual(
    [],
  );
  await accept(
    api()(artifactCatalogContract).get({ headers, params: { artifactId } }),
    [404],
  );
  for (const starred of [true, false]) {
    await accept(
      api()(artifactCatalogContract).setFavorite({
        headers,
        params: { artifactId },
        body: { starred },
      }),
      [404],
    );
  }
}

async function expectFavoritesDisabled(artifactId: string) {
  await accept(
    api()(artifactCatalogContract).listFavorites({ headers }),
    [403],
  );
  for (const starred of [true, false]) {
    await accept(
      api()(artifactCatalogContract).setFavorite({
        headers,
        params: { artifactId },
        body: { starred },
      }),
      [403],
    );
  }
  await accept(
    api()(artifactCatalogContract).list({
      headers,
      query: { starred: "true" },
    }),
    [403],
  );
}

describe("artifact catalog favorites", () => {
  it("persists idempotent star and unstar requests through subsequent reads", async () => {
    fixture();
    await setLibraryEnabled();
    const first = await upload("first.pdf");
    const second = await upload("second.pdf");
    const original = await list();
    const timestamps = original.artifacts.map((artifact) => {
      return {
        id: artifact.id,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
      };
    });

    await setFavorite(first.artifactId);
    await setFavorite(first.artifactId);
    await expectFavorites([first.artifactId]);
    const afterStar = await list();
    expect(afterStar.artifacts).toMatchObject(timestamps);
    expect(ids(await list({ starred: "true" }))).toStrictEqual([
      first.artifactId,
    ]);
    const detail = await accept(
      api()(artifactCatalogContract).get({
        headers,
        params: { artifactId: first.artifactId },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      id: first.artifactId,
      title: "first.pdf",
    });

    await setFavorite(first.artifactId, false);
    await setFavorite(first.artifactId, false);
    await expectFavorites([]);
    expect(ids(await list({ starred: "true" }))).toStrictEqual([]);
    const afterUnstar = await list();
    expect(afterUnstar.artifacts).toMatchObject(timestamps);
    expect(ids(afterUnstar).sort()).toStrictEqual(
      [first.artifactId, second.artifactId].sort(),
    );
  });

  it("isolates favorites by current user and organization without revealing private artifacts", async () => {
    const f = fixture();
    await setLibraryEnabled();
    const original = await upload("original.pdf");
    await setFavorite(original.artifactId);

    const peer = `user_${randomUUID()}`;
    f.addMember(peer);
    const otherOrg = `org_${randomUUID()}`;
    f.addMember(f.owner, otherOrg);
    for (const [userId, orgId] of [
      [peer, f.org],
      [f.owner, otherOrg],
    ] as const) {
      f.session(userId, orgId);
      await setLibraryEnabled();
      await expectFavorites([]);
      expect(ids(await list({ starred: "true" }))).toStrictEqual([]);
      expect(ids(await list({ sort: "title" }))).toStrictEqual([]);
      const missingId = randomUUID();
      for (const starred of [true, false]) {
        const foreign = await accept(
          api()(artifactCatalogContract).setFavorite({
            headers,
            params: { artifactId: original.artifactId },
            body: { starred },
          }),
          [404],
        );
        const missing = await accept(
          api()(artifactCatalogContract).setFavorite({
            headers,
            params: { artifactId: missingId },
            body: { starred },
          }),
          [404],
        );
        expect(foreign.body).toStrictEqual(missing.body);
      }
      const foreign = await accept(
        api()(artifactCatalogContract).get({
          headers,
          params: { artifactId: original.artifactId },
        }),
        [404],
      );
      const missing = await accept(
        api()(artifactCatalogContract).get({
          headers,
          params: { artifactId: missingId },
        }),
        [404],
      );
      expect(foreign.body).toStrictEqual(missing.body);
      const own = await upload("separate.pdf");
      await setFavorite(own.artifactId);
      await expectFavorites([own.artifactId]);
    }

    f.session();
    await expectFavorites([original.artifactId]);
    expect(ids(await list({ starred: "true" }))).toStrictEqual([
      original.artifactId,
    ]);
  });

  it("lets a current organization member star and read a shared file without acquiring deletion rights", async () => {
    const f = fixture();
    const shared = await upload("shared.pdf");
    const undiscovered = await upload("not-favorited.pdf");
    await share(shared);
    await share(undiscovered);
    const recipient = `user_${randomUUID()}`;
    f.addMember(recipient);
    f.session(recipient);
    await setLibraryEnabled();

    expect(ids(await list({ sort: "title" }))).toStrictEqual([]);
    await accept(
      api()(artifactCatalogContract).get({
        headers,
        params: { artifactId: shared.artifactId },
      }),
      [200],
    );
    await setFavorite(shared.artifactId);
    await expectFavorites([shared.artifactId]);
    expect(ids(await list({ starred: "true" }))).toStrictEqual([
      shared.artifactId,
    ]);
    expect(ids(await list({ sort: "title" }))).toStrictEqual([
      shared.artifactId,
    ]);
    const detail = await accept(
      api()(artifactCatalogContract).get({
        headers,
        params: { artifactId: shared.artifactId },
      }),
      [200],
    );
    if (detail.body.kind !== "file") {
      throw new Error("Expected a shared file detail");
    }
    expect(detail.body.file.filename).toBe("shared.pdf");
    await accept(
      api()(artifactCatalogContract).get({
        headers,
        params: { artifactId: shared.artifactId },
        query: { access: "owner" },
      }),
      [404],
    );
    const reference = new URL(
      detail.body.file.url,
      "https://app.okou.ai",
    ).pathname.slice("/artifacts/".length);
    const read = await accept(
      api()(artifactReferencesContract).read({
        headers,
        params: { reference },
      }),
      [200],
    );
    expect(read.body).toMatchObject({
      filename: "shared.pdf",
      url: "https://private-r2.example/report.pdf?signature=temporary",
    });
    await accept(
      api()(artifactCatalogContract).delete({
        headers,
        params: { artifactId: shared.artifactId },
      }),
      [404],
    );

    await setFavorite(shared.artifactId, false);
    await expectFavorites([]);
    expect(ids(await list({ sort: "title" }))).toStrictEqual([]);
    await setFavorite(shared.artifactId);
    await setLibraryEnabled(false);
    await accept(
      api()(artifactCatalogContract).get({
        headers,
        params: { artifactId: shared.artifactId },
      }),
      [404],
    );
    expect(ids(await list())).toStrictEqual([]);
    await setLibraryEnabled();
    await expectFavorites([shared.artifactId]);
    f.session();
    await accept(
      api()(artifactCatalogContract).get({
        headers,
        params: { artifactId: shared.artifactId },
        query: { access: "owner" },
      }),
      [200],
    );
  });

  it.each(["revocation", "deletion"] as const)(
    "drops inaccessible favorites from IDs, list and detail after %s",
    async (change) => {
      const f = fixture();
      await setLibraryEnabled();
      const artifact = await upload();
      await setFavorite(artifact.artifactId);
      await share(artifact);
      const recipient = `user_${randomUUID()}`;
      f.addMember(recipient);
      f.session(recipient);
      await setLibraryEnabled();
      await setFavorite(artifact.artifactId);
      await expectFavorites([artifact.artifactId]);

      f.session();
      if (change === "revocation") {
        await share(artifact, "private");
        await expectFavorites([artifact.artifactId]);
      } else {
        await accept(
          api()(artifactCatalogContract).delete({
            headers,
            params: { artifactId: artifact.artifactId },
          }),
          [200],
        );
        await expectFavorites([]);
        expect(ids(await list({ starred: "true" }))).toStrictEqual([]);
        await accept(
          api()(artifactCatalogContract).get({
            headers,
            params: { artifactId: artifact.artifactId },
          }),
          [404],
        );
      }
      f.session(recipient);
      await expectUnavailable(artifact.artifactId);
    },
  );

  it("rechecks current organization membership instead of trusting a surviving session claim", async () => {
    const f = fixture();
    const artifact = await upload();
    await share(artifact);
    const recipient = `user_${randomUUID()}`;
    f.addMember(recipient);
    f.session(recipient);
    await setLibraryEnabled();
    await setFavorite(artifact.artifactId);
    await expectFavorites([artifact.artifactId]);

    f.removeMember(recipient);
    await expectUnavailable(artifact.artifactId);
    f.session();
    const ownerArtifact = await accept(
      api()(artifactCatalogContract).get({
        headers,
        params: { artifactId: artifact.artifactId },
      }),
      [200],
    );
    expect(ownerArtifact.body.id).toBe(artifact.artifactId);
  });

  it("defaults off and gates favorite operations without changing legacy owner list and detail", async () => {
    fixture();
    const artifact = await upload();
    const initial = await accept(
      api()(featureSwitchesContract).get({ headers }),
      [200],
    );
    expect(
      initial.body.effectiveSwitches[FeatureSwitchKey.ArtifactLibrary],
    ).toBeFalsy();
    const before = await list();
    const detailBefore = await accept(
      api()(artifactCatalogContract).get({
        headers,
        params: { artifactId: artifact.artifactId },
      }),
      [200],
    );

    await expectFavoritesDisabled(artifact.artifactId);
    await setLibraryEnabled();
    await setFavorite(artifact.artifactId);
    await setLibraryEnabled(false);
    await expectFavoritesDisabled(artifact.artifactId);
    await expect(list()).resolves.toStrictEqual(before);
    const detail = await accept(
      api()(artifactCatalogContract).get({
        headers,
        params: { artifactId: artifact.artifactId },
      }),
      [200],
    );
    expect(detail.body).toStrictEqual(detailBefore.body);
    await setLibraryEnabled();
    await expectFavorites([artifact.artifactId]);
  });

  it("intersects favorites, kind and keyword across the full result before keyset paging", async () => {
    fixture();
    await setLibraryEnabled();
    await upload("Alpha report.pdf");
    const echo = await upload("Echo report.pdf");
    const presentation = await upload("Charlie report.pptx");
    const bravo = await upload("Bravo report.pdf");
    const notes = await upload("Delta notes.pdf");
    const sameTitle = await upload("Echo report.pdf");
    for (const artifact of [bravo, presentation, notes, echo, sameTitle]) {
      await setFavorite(artifact.artifactId);
    }
    await expectFavorites([
      bravo.artifactId,
      presentation.artifactId,
      notes.artifactId,
      echo.artifactId,
      sameTitle.artifactId,
    ]);
    const equalTitleIds = [echo.artifactId, sameTitle.artifactId].sort();
    const ascending = [bravo.artifactId, ...equalTitleIds];

    for (const sort of ["title", "createdAt"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        const query = {
          starred: "true",
          kind: "file",
          keyword: "REPORT",
          sort,
          direction,
          limit: 2,
        } as const;
        const full = await list({ ...query, limit: 200 });
        expect(ids(full).sort()).toStrictEqual([...ascending].sort());
        if (sort === "title") {
          expect(ids(full)).toStrictEqual(
            direction === "asc" ? ascending : [...ascending].reverse(),
          );
        } else {
          const createdAt = full.artifacts.map((artifact) => {
            return artifact.createdAt;
          });
          const ordered = [...createdAt].sort();
          expect(createdAt).toStrictEqual(
            direction === "asc" ? ordered : ordered.reverse(),
          );
        }
        const first = await list(query);
        expect(first.artifacts).toHaveLength(2);
        expect(first.nextCursor).toBeTypeOf("string");
        const second = await list({
          ...query,
          cursor: first.nextCursor ?? undefined,
        });
        expect(second.artifacts).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
        expect([...ids(first), ...ids(second)]).toStrictEqual(ids(full));
      }
    }
  });

  it("fills keyset pages with live readable favorites after leading shares are revoked", async () => {
    const f = fixture();
    const artifacts: UploadedArtifact[] = [];
    for (const filename of ["A.pdf", "B.pdf", "C.pdf", "D.pdf", "E.pdf"]) {
      const artifact = await upload(filename);
      await share(artifact);
      artifacts.push(artifact);
    }
    const recipient = `user_${randomUUID()}`;
    f.addMember(recipient);
    f.session(recipient);
    await setLibraryEnabled();
    for (const artifact of artifacts) {
      await setFavorite(artifact.artifactId);
    }
    f.session();
    for (const artifact of artifacts.slice(0, 2)) {
      await share(artifact, "private");
    }
    f.session(recipient);
    const readableIds = artifacts.slice(2).map((artifact) => {
      return artifact.artifactId;
    });
    await expectFavorites(readableIds);
    for (const starred of [undefined, "true"] as const) {
      const query = {
        sort: "title",
        direction: "asc",
        limit: 2,
        starred,
      } as const;
      const first = await list(query);
      expect(ids(first)).toStrictEqual(readableIds.slice(0, 2));
      expect(first.nextCursor).toBeTypeOf("string");
      const second = await list({
        ...query,
        cursor: first.nextCursor ?? undefined,
      });
      expect(ids(second)).toStrictEqual(readableIds.slice(2));
      expect(second.nextCursor).toBeNull();
    }
  });

  it("binds keyset cursors to starred versus all queries, including default sorting", async () => {
    fixture();
    await setLibraryEnabled();
    await upload("A.pdf");
    const second = await upload("B.pdf");
    const third = await upload("C.pdf");
    await setFavorite(second.artifactId);
    await setFavorite(third.artifactId);
    const query = { sort: "title", direction: "asc", limit: 1 } as const;
    const all = await list(query);
    const starred = await list({ ...query, starred: "true" });
    expect(all.nextCursor).toBeTypeOf("string");
    expect(starred.nextCursor).toBeTypeOf("string");
    await accept(
      api()(artifactCatalogContract).list({
        headers,
        query: {
          ...query,
          starred: "true",
          cursor: all.nextCursor ?? undefined,
        },
      }),
      [403],
    );
    await accept(
      api()(artifactCatalogContract).list({
        headers,
        query: { ...query, cursor: starred.nextCursor ?? undefined },
      }),
      [403],
    );
    const continued = await list({
      ...query,
      starred: "true",
      cursor: starred.nextCursor ?? undefined,
    });
    expect(ids(continued)).toStrictEqual([third.artifactId]);
    expect(continued.nextCursor).toBeNull();

    const defaultStarred = await list({ starred: "true", limit: 1 });
    const legacyAll = await list({ limit: 1 });
    expect(defaultStarred.nextCursor).toBeTypeOf("string");
    expect(legacyAll.nextCursor).toBeTypeOf("string");
    await accept(
      api()(artifactCatalogContract).list({
        headers,
        query: { limit: 1, cursor: defaultStarred.nextCursor ?? undefined },
      }),
      [403],
    );
    await accept(
      api()(artifactCatalogContract).list({
        headers,
        query: {
          starred: "true",
          limit: 1,
          cursor: legacyAll.nextCursor ?? undefined,
        },
      }),
      [403],
    );
  });

  it("requires an authenticated organization for favorite operations", async () => {
    const f = fixture();
    await setLibraryEnabled();
    const artifact = await upload();
    f.session(f.owner, null);
    for (const anonymous of [false, true]) {
      if (anonymous) {
        context.mocks.clerk.authenticateRequest.mockResolvedValue({
          isAuthenticated: false,
        });
      }
      const favorites = await accept(
        api()(artifactCatalogContract).listFavorites({ headers }),
        [401],
      );
      expect(favorites.body.error.message).toBeTruthy();
      await accept(
        api()(artifactCatalogContract).setFavorite({
          headers,
          params: { artifactId: artifact.artifactId },
          body: { starred: true },
        }),
        [401],
      );
      await accept(
        api()(artifactCatalogContract).list({
          headers,
          query: { starred: "true" },
        }),
        [401],
      );
    }
  });
});
