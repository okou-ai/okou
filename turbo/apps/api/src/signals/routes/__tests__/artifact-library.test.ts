import { randomUUID } from "node:crypto";
import {
  artifactCatalogContract,
  type ArtifactCatalogListQuery,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { featureSwitchesRoutes } from "../feature-switches";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...artifactCatalogRoutes,
  ...featureSwitchesRoutes,
  ...uploadsPrepareRoutes,
  ...uploadsCompleteRoutes,
]);

function client() {
  return setupApp({ context, routes });
}

async function enableLibrary(enabled = true) {
  await accept(
    client()(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.ArtifactLibrary]: enabled } },
    }),
    [200],
  );
}

async function upload(filename: string) {
  const content = "library content";
  const prepared = await accept(
    client()(uploadsContract).prepare({
      headers,
      body: {
        filename,
        contentType: "application/octet-stream",
        size: Buffer.byteLength(content),
        purpose: "artifact",
      },
    }),
    [200],
  );
  if (!("uploadUrl" in prepared.body)) {
    throw new Error("Expected a single-part artifact upload");
  }
  const stored = await fetch(prepared.body.uploadUrl, {
    method: "PUT",
    headers: prepared.body.uploadHeaders,
    body: content,
  });
  expect(stored.status).toBe(200);
  await accept(
    client()(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  return prepared.body;
}

async function list(query: ArtifactCatalogListQuery = {}) {
  return (
    await accept(
      client()(artifactCatalogContract).list({ headers, query }),
      [200],
    )
  ).body;
}

async function collect(query: ArtifactCatalogListQuery) {
  const artifacts: ArtifactSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ ...query, limit: 2, cursor });
    artifacts.push(...page.artifacts);
    cursor = page.nextCursor ?? undefined;
    expect(artifacts.length).toBeLessThanOrEqual(10);
  } while (cursor);
  return artifacts;
}

beforeEach(() => {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  installSharedThreadStorage(context);
});

describe("artifact library list queries", () => {
  it("honors per-user opt-in and opt-out while legacy requests and cursors stay available", async () => {
    await upload("first.txt");
    await upload("second.txt");
    const legacy = await list({ limit: 1 });
    expect(legacy.artifacts[0]).toMatchObject({ title: "second.txt" });
    expect(legacy.nextCursor).toStrictEqual(expect.any(String));
    for (const query of [
      { sort: "createdAt" as const },
      { direction: "asc" as const },
    ]) {
      await accept(
        client()(artifactCatalogContract).list({ headers, query }),
        [403],
      );
    }

    await enableLibrary();
    const library = await list({ sort: "createdAt", direction: "asc" });
    expect(
      library.artifacts.map((artifact) => {
        return artifact.title;
      }),
    ).toStrictEqual(["first.txt", "second.txt"]);
    await enableLibrary(false);
    await accept(
      client()(artifactCatalogContract).list({
        headers,
        query: { sort: "title", direction: "desc" },
      }),
      [403],
    );
    const nextLegacy = await list({ cursor: legacy.nextCursor! });
    expect(
      nextLegacy.artifacts.map((artifact) => {
        return artifact.title;
      }),
    ).toStrictEqual(["first.txt"]);
    expect(nextLegacy.nextCursor).toBeNull();
    expect((await list({ keyword: "SECOND" })).artifacts).toStrictEqual(
      legacy.artifacts,
    );
  });

  it("sorts the full filtered result in either direction and paginates equal values without repeats", async () => {
    for (const filename of ["Zulu.txt", "Echo.txt", "Alpha.txt", "Echo.txt"]) {
      await upload(filename);
    }
    await upload("Deck.pptx");
    await enableLibrary();
    const legacyFiles = (await list({ kind: "file" })).artifacts;
    for (const direction of ["asc", "desc"] as const) {
      const byTitle = await collect({ sort: "title", direction, kind: "file" });
      expect(
        byTitle.map((artifact) => {
          return artifact.title;
        }),
      ).toStrictEqual(
        direction === "asc"
          ? ["Alpha.txt", "Echo.txt", "Echo.txt", "Zulu.txt"]
          : ["Zulu.txt", "Echo.txt", "Echo.txt", "Alpha.txt"],
      );
      expect(
        new Set(
          byTitle.map((artifact) => {
            return artifact.id;
          }),
        ).size,
      ).toBe(4);
      const echoes = byTitle.filter((artifact) => {
        return artifact.title === "Echo.txt";
      });
      const echoIds = echoes
        .map((artifact) => {
          return artifact.id;
        })
        .sort();
      expect(
        echoes.map((artifact) => {
          return artifact.id;
        }),
      ).toStrictEqual(direction === "asc" ? echoIds : echoIds.reverse());

      const byCreated = await collect({
        sort: "createdAt",
        direction,
        kind: "file",
      });
      expect(
        byCreated.map((artifact) => {
          return artifact.id;
        }),
      ).toStrictEqual(
        (direction === "desc" ? legacyFiles : [...legacyFiles].reverse()).map(
          (artifact) => {
            return artifact.id;
          },
        ),
      );
    }
    const deck = await list({
      kind: "presentation",
      sort: "title",
      direction: "asc",
      keyword: "DECK",
      limit: 1,
    });
    expect(deck.artifacts).toStrictEqual([
      expect.objectContaining({ kind: "presentation", title: "Deck.pptx" }),
    ]);
    expect(deck.nextCursor).toBeNull();
  });

  it("binds library cursors to sorting, filters and the authorized owner without widening literal search", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    for (const filename of ["Alpha.txt", "Bravo.txt", "literal%_draft.txt"]) {
      await upload(filename);
    }
    await enableLibrary();
    const query = { sort: "title", direction: "asc" } as const;
    const first = await list({ ...query, limit: 1 });
    expect(first.artifacts[0]?.title).toBe("Alpha.txt");
    expect(first.nextCursor).toStrictEqual(expect.any(String));
    const cursor = first.nextCursor!;
    for (const changed of [
      { ...query, sort: "createdAt" as const },
      { ...query, direction: "desc" as const },
      { ...query, kind: "file" as const },
      { ...query, keyword: "Alpha" },
      { ...query, chatThreadId: randomUUID() },
    ]) {
      await accept(
        client()(artifactCatalogContract).list({
          headers,
          query: { ...changed, cursor },
        }),
        [403],
      );
    }
    const legacy = await list({ limit: 1 });
    for (const incompatible of [
      { cursor },
      { cursor: "not-a-cursor" },
      { ...query, cursor: legacy.nextCursor! },
      { ...query, cursor: "not-a-cursor" },
    ]) {
      await accept(
        client()(artifactCatalogContract).list({
          headers,
          query: incompatible,
        }),
        [403],
      );
    }
    for (const keyword of ["%", "_"]) {
      const matches = await list({ ...query, keyword, limit: 1 });
      expect(matches.artifacts).toStrictEqual([
        expect.objectContaining({ title: "literal%_draft.txt" }),
      ]);
      expect(matches.nextCursor).toBeNull();
    }

    for (const identity of [
      { userId: `user_${randomUUID()}`, orgId },
      { userId, orgId: `org_${randomUUID()}` },
    ]) {
      mocks.clerk.session(identity.userId, identity.orgId);
      await accept(
        client()(artifactCatalogContract).list({ headers, query }),
        [403],
      );
      await enableLibrary();
      await accept(
        client()(artifactCatalogContract).list({
          headers,
          query: { ...query, cursor },
        }),
        [403],
      );
      await expect(list(query)).resolves.toStrictEqual({
        artifacts: [],
        nextCursor: null,
      });
    }
  });
});
