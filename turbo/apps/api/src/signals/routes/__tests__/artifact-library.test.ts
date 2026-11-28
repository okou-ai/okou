import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  artifactCatalogContract,
  type ArtifactCatalogListQuery,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactLibraryPreviewsContract } from "@okouai/api-contracts/contracts/artifact-library-previews";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now, nowDate } from "../../../lib/time";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const files = createChatFilesBddApi(context);

function catalog() {
  return setupApp({ context, routes: artifactCatalogRoutes })(
    artifactCatalogContract,
  );
}

function previews() {
  return setupApp({ context, routes: artifactCatalogRoutes })(
    artifactLibraryPreviewsContract,
  );
}

function signIn(actor: ApiTestUser): { authorization: string } {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

/** The member uploads one artifact file one second after the previous one. */
async function upload(
  actor: ApiTestUser,
  filename: string,
  contentType = "text/plain",
): Promise<string> {
  mockNow(now() + 1000);
  const prepared = await files.prepareUpload(actor, {
    filename,
    contentType,
    size: 5,
    purpose: "artifact",
  });
  // The browser has written the bytes to R2; storage reports the object.
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      return Promise.resolve({
        ContentLength: 5,
        ContentType: contentType,
        LastModified: nowDate(),
      });
    }
    if (command instanceof GetObjectCommand) {
      if (!command.input.Key?.startsWith("private-artifacts/")) {
        return Promise.reject(
          Object.assign(new Error("Missing object"), { name: "NoSuchKey" }),
        );
      }
      return Promise.resolve({
        ContentLength: 5,
        ContentType: contentType,
        LastModified: nowDate(),
        Body: Readable.from([Buffer.from("hello")]),
      });
    }
    if (command instanceof PutObjectCommand) {
      return Promise.resolve({ ETag: '"etag-1"' });
    }
    return Promise.resolve({});
  });
  await files.completeUpload(actor, { id: prepared.id });
  return prepared.id;
}

async function list(actor: ApiTestUser, query: ArtifactCatalogListQuery) {
  return await accept(
    catalog().list({ headers: signIn(actor), query }),
    [200, 403],
  );
}

async function setOptIn(actor: ApiTestUser, enabled: boolean): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected an org member");
  }
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId, orgRole: actor.orgRole },
    { artifactLibrary: enabled },
  );
}

function titles(body: {
  readonly artifacts: readonly { readonly title: string }[];
}) {
  return body.artifacts.map((artifact) => {
    return artifact.title;
  });
}

function ok<Body>(
  response:
    { readonly status: 200; readonly body: Body } | { readonly status: 403 },
): Body {
  if (response.status !== 200) {
    throw new Error(`Expected HTTP 200, got ${response.status}`);
  }
  return response.body;
}

/** Walks every page of one catalog query. */
async function allPages(actor: ApiTestUser, query: ArtifactCatalogListQuery) {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page: {
      readonly artifacts: readonly { readonly id: string }[];
      readonly nextCursor: string | null;
    } = ok(await list(actor, cursor === null ? query : { ...query, cursor }));
    ids.push(
      ...page.artifacts.map((artifact) => {
        return artifact.id;
      }),
    );
    cursor = page.nextCursor;
  } while (cursor !== null);
  return ids;
}

async function seedFilteredCatalogMember() {
  const member = bdd.user({ orgRole: "org:member" });
  await setOptIn(member, true);
  await upload(member, "Echo.txt");
  await upload(member, "Echo.txt");
  await upload(member, "alpha.txt");
  await upload(
    member,
    "Deck.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  await upload(member, "beta.txt");
  return member;
}

describe("artifact library list queries", () => {
  it("artifact-library-001 honors per-user opt-in and opt-out while legacy requests and cursors stay available", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await upload(member, "first.txt");
    await upload(member, "second.txt");

    const legacy = ok(await list(member, { limit: 1 }));
    expect(titles(legacy)).toStrictEqual(["second.txt"]);
    expect(legacy.nextCursor).toBeTruthy();
    const cursor = legacy.nextCursor ?? "";

    expect((await list(member, { direction: "asc" })).status).toBe(403);

    await setOptIn(member, true);
    expect(titles(ok(await list(member, { direction: "asc" })))).toStrictEqual([
      "first.txt",
      "second.txt",
    ]);

    await setOptIn(member, false);
    expect((await list(member, { direction: "asc" })).status).toBe(403);

    const resumed = ok(await list(member, { limit: 1, cursor }));
    expect(titles(resumed)).toStrictEqual(["first.txt"]);
    expect(resumed.nextCursor).toBeNull();
    expect(
      ok(await list(member, { limit: 1, keyword: "SECOND" })).artifacts,
    ).toStrictEqual(legacy.artifacts);
  });

  it("artifact-library-002 (1/2) matches legacy file order when paginating descending and finds the Deck presentation", async () => {
    const member = await seedFilteredCatalogMember();

    const legacy = await allPages(member, { kind: "file", limit: 2 });
    expect(legacy).toHaveLength(4);
    const descending = await allPages(member, {
      kind: "file",
      limit: 2,
      direction: "desc",
    });
    expect(descending).toStrictEqual(legacy);

    const deck = ok(
      await list(member, { kind: "presentation", keyword: "DECK" }),
    );
    expect(titles(deck)).toStrictEqual(["Deck.pptx"]);
    expect(deck.nextCursor).toBeNull();
  });

  it("artifact-library-002 (2/2) reverses the full filtered file order when paginating ascending across every page", async () => {
    const member = await seedFilteredCatalogMember();

    const legacy = await allPages(member, { kind: "file", limit: 2 });
    expect(legacy).toHaveLength(4);
    const ascending = await allPages(member, {
      kind: "file",
      limit: 2,
      direction: "asc",
    });
    expect(ascending).toStrictEqual([...legacy].reverse());
  });

  it("pf-058 filters semantic categories before paging without changing file-backed kinds", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    await setOptIn(member, true);
    await upload(member, "notes.txt", "text/plain");
    await upload(member, "metrics.csv", "text/csv");
    await upload(
      member,
      "slides.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    await upload(member, "brief.pdf", "application/pdf");

    const firstDocPage = ok(
      await list(member, { category: "document", direction: "desc", limit: 1 }),
    );
    expect(titles(firstDocPage)).toStrictEqual(["brief.pdf"]);
    expect(firstDocPage.artifacts[0]?.category).toBe("document");
    expect(firstDocPage.nextCursor).toBeTruthy();

    const secondDocPage = ok(
      await list(member, {
        category: "document",
        direction: "desc",
        limit: 1,
        cursor: firstDocPage.nextCursor ?? undefined,
      }),
    );
    expect(titles(secondDocPage)).toStrictEqual(["notes.txt"]);
    expect(secondDocPage.artifacts[0]?.category).toBe("document");
    expect(secondDocPage.nextCursor).toBeNull();

    const spreadsheets = ok(
      await list(member, { category: "spreadsheet", direction: "desc" }),
    );
    expect(titles(spreadsheets)).toStrictEqual(["metrics.csv"]);
    expect(spreadsheets.artifacts[0]?.category).toBe("spreadsheet");

    const fileKind = await allPages(member, { kind: "file", limit: 10 });
    expect(fileKind).toHaveLength(3);
  });
});

describe("artifact library batch covers", () => {
  async function uploadImageArtifact(
    actor: ApiTestUser,
    filename: string,
  ): Promise<string> {
    await upload(actor, filename, "image/png");
    const listed = ok(await list(actor, { keyword: filename, limit: 10 }));
    const match = listed.artifacts.find((artifact) => {
      return artifact.title === filename;
    });
    if (!match) {
      throw new Error(`Expected catalog artifact for ${filename}`);
    }
    return match.id;
  }

  it("pf-152 serves completed private covers without another storage HEAD and honors the library switch", async () => {
    const member = bdd.user({ orgRole: "org:member" });
    const artifactId = await uploadImageArtifact(member, "cover-ready.png");

    const disabled = await accept(
      previews().resolve({
        headers: signIn(member),
        body: { artifactIds: [artifactId] },
      }),
      [403],
    );
    expect(disabled.status).toBe(403);

    await setOptIn(member, true);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return Promise.reject(
          new Error("Batch preview resolution must not issue HeadObject"),
        );
      }
      return Promise.resolve({});
    });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/presigned/cover-ready.png",
    );

    const resolved = await accept(
      previews().resolve({
        headers: signIn(member),
        body: { artifactIds: [artifactId] },
      }),
      [200],
    );
    expect(resolved.headers.get("cache-control")).toBe("private, no-store");
    expect(resolved.body.previews).toStrictEqual([
      {
        artifactId,
        url: "https://r2.example.com/presigned/cover-ready.png",
        expiresAt: expect.any(String),
        contentType: "image/png",
      },
    ]);
  });

  it("pf-153 does not reveal another owner, workspace, or deleted cover", async () => {
    const owner = bdd.user({ orgRole: "org:member" });
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const outsider = bdd.user({ orgRole: "org:member" });
    await setOptIn(owner, true);

    const [liveId, deletedId, peerId, outsiderId] = [
      await uploadImageArtifact(owner, "owner-live.png"),
      await uploadImageArtifact(owner, "owner-deleted.png"),
      await uploadImageArtifact(peer, "peer-cover.png"),
      await uploadImageArtifact(outsider, "outsider-cover.png"),
    ];

    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof GetObjectCommand) {
        return Promise.reject(
          Object.assign(new Error("NoSuchKey"), {
            name: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({});
    });
    await accept(
      catalog().delete({
        headers: signIn(owner),
        params: { artifactId: deletedId },
      }),
      [200],
    );

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/presigned/owner-live.png",
    );
    const resolved = await accept(
      previews().resolve({
        headers: signIn(owner),
        body: { artifactIds: [liveId, deletedId, peerId, outsiderId] },
      }),
      [200],
    );
    expect(resolved.body.previews).toStrictEqual([
      {
        artifactId: liveId,
        url: "https://r2.example.com/presigned/owner-live.png",
        expiresAt: expect.any(String),
        contentType: "image/png",
      },
    ]);
  });
});
