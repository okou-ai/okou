import { HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  artifactCatalogContract,
  type ArtifactCatalogListQuery,
} from "@okouai/api-contracts/contracts/artifact-catalog";
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
    return Promise.resolve(
      command instanceof HeadObjectCommand
        ? {
            ContentLength: 5,
            ContentType: contentType,
            LastModified: nowDate(),
          }
        : {},
    );
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
});
