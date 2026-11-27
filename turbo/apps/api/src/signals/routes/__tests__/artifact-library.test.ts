import { artifactLibraryPreviewsContract } from "@okouai/api-contracts/contracts/artifact-library-previews";
import { now } from "../../../lib/time";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import {
  artifactCatalogContract,
  ARTIFACT_CATALOG_CATEGORIES,
  type ArtifactCatalogCategory,
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

async function upload(
  filename: string,
  contentType = "application/octet-stream",
) {
  const content = "library content";
  const prepared = await accept(
    client()(uploadsContract).prepare({
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
    await accept(
      client()(artifactCatalogContract).list({
        headers,
        query: { direction: "asc" },
      }),
      [403],
    );

    await accept(
      client()(artifactCatalogContract).list({
        headers,
        query: { category: "document" },
      }),
      [403],
    );

    await enableLibrary();
    const library = await list({ direction: "asc" });
    expect(
      library.artifacts.map((artifact) => {
        return artifact.title;
      }),
    ).toStrictEqual(["first.txt", "second.txt"]);
    await enableLibrary(false);
    await accept(
      client()(artifactCatalogContract).list({
        headers,
        query: { direction: "desc" },
      }),
      [403],
    );
    await accept(
      client()(artifactCatalogContract).list({
        headers,
        query: { category: "document", direction: "desc" },
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

  it("orders the full filtered result by creation in either direction across every page", async () => {
    for (const filename of ["Zulu.txt", "Echo.txt", "Alpha.txt", "Echo.txt"]) {
      await upload(filename);
    }
    await upload("Deck.pptx");
    await enableLibrary();
    const legacyFiles = (await list({ kind: "file" })).artifacts;
    for (const direction of ["asc", "desc"] as const) {
      const byCreated = await collect({ direction, kind: "file" });
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
      direction: "asc",
      keyword: "DECK",
      limit: 1,
    });
    expect(deck.artifacts).toStrictEqual([
      expect.objectContaining({ kind: "presentation", title: "Deck.pptx" }),
    ]);
    expect(deck.nextCursor).toBeNull();
  });

  it("filters semantic categories before paging without changing file-backed kinds", async () => {
    const files: readonly (readonly [
      string,
      string,
      ArtifactCatalogCategory,
    ])[] = [
      ["Readme.MD", "application/octet-stream", "document"],
      ["brief.pdf", "application/pdf", "document"],
      [
        "contract.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "document",
      ],
      ["Deck.PPTX", "application/octet-stream", "presentation"],
      ["notes.html", "text/html", "website"],
      [
        "budget.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "spreadsheet",
      ],
      ["metrics.csv", "text/csv", "spreadsheet"],
      ["export", "text/tab-separated-values", "spreadsheet"],
      ["portrait.PNG", "application/octet-stream", "image"],
      ["download", "image/jpeg", "image"],
      ["clip.mp4", "video/mp4", "video"],
      ["interview.mp3", "audio/mpeg", "audio"],
      ["archive.zip", "application/zip", "other"],
    ];
    for (const [filename, contentType] of files) {
      await upload(filename, contentType);
    }
    await enableLibrary();
    for (const direction of ["asc", "desc"] as const) {
      for (const category of ARTIFACT_CATALOG_CATEGORIES) {
        const expected = files.filter((file) => {
          return file[2] === category;
        });
        if (direction === "desc") {
          expected.reverse();
        }
        const matches = await collect({ direction, category });
        expect(
          matches.map(({ title, category: actualCategory, kind }) => {
            return { title, category: actualCategory, kind };
          }),
        ).toStrictEqual(
          expected.map(([title]) => {
            return {
              title,
              category,
              kind: category === "presentation" ? "presentation" : "file",
            };
          }),
        );
      }
    }
    const documents = await list({
      direction: "asc",
      category: "document",
      limit: 1,
    });
    expect(documents.nextCursor).toStrictEqual(expect.any(String));
    await accept(
      client()(artifactCatalogContract).list({
        headers,
        query: {
          direction: "asc",
          category: "image",
          cursor: documents.nextCursor!,
        },
      }),
      [403],
    );
    expect(
      (await list({ direction: "asc", category: "image", kind: "video" }))
        .artifacts,
    ).toStrictEqual([]);
    const image = (await list({ direction: "asc", category: "image" }))
      .artifacts[0]!;
    const detail = await accept(
      client()(artifactCatalogContract).get({
        headers,
        params: { artifactId: image.id },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({ kind: "file" });
  });

  it("binds library cursors to direction, filters and the authorized owner without widening literal search", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    for (const filename of ["Alpha.txt", "Bravo.txt", "literal%_draft.txt"]) {
      await upload(filename);
    }
    await enableLibrary();
    const query = { direction: "asc" } as const;
    const first = await list({ ...query, limit: 1 });
    expect(first.artifacts[0]?.title).toBe("Alpha.txt");
    expect(first.nextCursor).toStrictEqual(expect.any(String));
    const cursor = first.nextCursor!;
    for (const changed of [
      { ...query, direction: "desc" as const },
      { ...query, kind: "file" as const },
      { ...query, category: "document" as const },
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

describe("artifact library batch covers", () => {
  it("serves completed private covers without another storage HEAD and honors the library switch", async () => {
    await upload("cover-one.png", "image/png");
    await upload("cover-two.png", "image/png");
    const entries = (await list({})).artifacts;
    const body = {
      artifactIds: entries.map(({ id }) => {
        return id;
      }),
    };
    const previews = client()(artifactLibraryPreviewsContract);
    await accept(previews.resolve({ headers, body }), [403]);
    await enableLibrary();
    const storage = context.mocks.s3.send.getMockImplementation();
    context.mocks.s3.send.mockImplementation((...args) => {
      if (args[0] instanceof HeadObjectCommand) {
        throw new Error("Object metadata endpoint is unavailable");
      }
      return storage ? storage(...args) : Promise.resolve({});
    });
    const resolved = await accept(
      previews.resolve({
        headers,
        body: {
          artifactIds: [...body.artifactIds, body.artifactIds[0]!],
        },
      }),
      [200],
    );
    expect(resolved.headers.get("cache-control")).toBe("private, no-store");
    expect(resolved.body.previews).toHaveLength(2);
    expect(
      resolved.body.previews
        .map(({ artifactId }) => {
          return artifactId;
        })
        .sort(),
    ).toStrictEqual([...body.artifactIds].sort());
    for (const preview of resolved.body.previews) {
      expect(preview.contentType).toBe("image/png");
      expect(Date.parse(preview.expiresAt)).toBeGreaterThan(now());
      const bytes = await fetch(preview.url);
      expect(bytes.status).toBe(200);
      await expect(bytes.text()).resolves.toBe("library content");
    }
    await enableLibrary(false);
    await accept(previews.resolve({ headers, body }), [403]);
  });

  it("does not reveal another owner, workspace or deleted cover", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    await upload("private.png", "image/png");
    await enableLibrary();
    const [entry] = (await list({ direction: "desc" })).artifacts;
    const body = { artifactIds: [entry!.id, randomUUID()] };
    const previews = client()(artifactLibraryPreviewsContract);
    const visible = await accept(previews.resolve({ headers, body }), [200]);
    expect(visible.body.previews).toHaveLength(1);
    for (const actor of [
      { userId: `user_${randomUUID()}`, orgId },
      { userId, orgId: `org_${randomUUID()}` },
    ]) {
      mocks.clerk.session(actor.userId, actor.orgId);
      await enableLibrary();
      const hidden = await accept(previews.resolve({ headers, body }), [200]);
      expect(hidden.body).toStrictEqual({ previews: [] });
    }
    mocks.clerk.session(userId, orgId);
    await accept(
      client()(artifactCatalogContract).delete({
        headers,
        params: { artifactId: entry!.id },
      }),
      [200],
    );
    const deleted = await accept(previews.resolve({ headers, body }), [200]);
    expect(deleted.body).toStrictEqual({ previews: [] });
  });
});
