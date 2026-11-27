import { artifactReferencePath } from "@okouai/api-contracts/validators/artifact-references";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactLibraryPreviewsContract } from "@okouai/api-contracts/contracts/artifact-library-previews";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
const ids = Object.freeze([
  "a0000000-0000-4000-a000-000000000101",
  "a0000000-0000-4000-a000-000000000102",
  "a0000000-0000-4000-a000-000000000103",
]);
function createEntries() {
  return ids.map((id, index) => {
    return artifact({
      id,
      title: `cover-${index}.png`,
      thumbnail: { url: artifactReferencePath(id, "cover.png") },
    });
  });
}

test("renders titles before batched covers and resolves each appended page once", async () => {
  const entries = createEntries();
  const ready = createDeferredPromise<void>(context.signal);
  const batches: string[][] = [];
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts: query.cursor ? entries.slice(2) : entries.slice(0, 2),
      nextCursor: query.cursor ? null : "next-page",
    });
  });
  context.mocks.api(
    artifactLibraryPreviewsContract.resolve,
    async ({ body, respond }) => {
      batches.push(body.artifactIds);
      await ready.promise;
      return respond(200, {
        previews: body.artifactIds.map((artifactId) => {
          return {
            artifactId,
            url: `https://covers.example.test/${artifactId}.png`,
            expiresAt: "2099-01-01T00:00:00Z",
            contentType: "image/png",
          };
        }),
      });
    },
  );
  await setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.ArtifactLibrary]: true },
  });
  try {
    await expect(
      findArtifactAction("cover-0.png"),
    ).resolves.toBeInTheDocument();
    await expect(
      findArtifactAction("cover-1.png"),
    ).resolves.toBeInTheDocument();
  } finally {
    ready.resolve();
  }
  await waitFor(() => {
    const card = screen.getByRole("article", { name: "cover-0.png" });
    expect(
      within(card).getByTestId("artifact-catalog-thumbnail"),
    ).toHaveAttribute("src", `https://covers.example.test/${ids[0]}.png`);
  });
  expect(batches).toStrictEqual([ids.slice(0, 2)]);
  click(getButtonByName("Load more"));
  await expect(findArtifactAction("cover-2.png")).resolves.toBeInTheDocument();
  await waitFor(() => {
    const card = screen.getByRole("article", { name: "cover-2.png" });
    expect(
      within(card).getByTestId("artifact-catalog-thumbnail"),
    ).toHaveAttribute("src", `https://covers.example.test/${ids[2]}.png`);
  });
  expect(batches).toStrictEqual([ids.slice(0, 2), ids.slice(2)]);
});

test("keeps legacy cover resolution when Artifact Library is disabled", async () => {
  const entries = createEntries();
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [entries[0]!], nextCursor: null });
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: "https://covers.example.test/legacy.png",
      downloadUrl: "https://covers.example.test/legacy.png",
      expiresAt: "2099-01-01T00:00:00Z",
      filename: "cover-0.png",
      contentType: "image/png",
      target: { kind: "file", id: ids[0]! },
    });
  });
  await setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.ArtifactLibrary]: false },
  });
  await expect(findArtifactAction("cover-0.png")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByTestId("artifact-catalog-thumbnail")).toHaveAttribute(
      "src",
      "https://covers.example.test/legacy.png",
    );
  });
});

test("cancels a pending cover batch when the category changes", async () => {
  const entries = createEntries();
  const pending = createDeferredPromise<void>(context.signal);
  const requests: Request[] = [];
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts: [entries[query.category ? 1 : 0]!],
      nextCursor: null,
    });
  });
  context.mocks.api(
    artifactLibraryPreviewsContract.resolve,
    async ({ body, request, respond }) => {
      requests.push(request);
      if (body.artifactIds[0] === ids[0]) {
        await pending.promise;
      }
      return respond(200, {
        previews: body.artifactIds.map((artifactId) => {
          return {
            artifactId,
            url: `https://covers.example.test/${artifactId}.png`,
            contentType: "image/png",
            expiresAt: "2099-01-01T00:00:00Z",
          };
        }),
      });
    },
  );
  await setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.ArtifactLibrary]: true },
  });
  try {
    await expect(
      findArtifactAction("cover-0.png"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    const images = queryAllByRoleFast("tab").find((tab) => {
      return tab.textContent?.trim() === "Images";
    });
    if (!images) {
      throw new Error("Expected the Images category tab");
    }
    click(images);
    await expect(
      findArtifactAction("cover-1.png"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(requests[0]!.signal.aborted).toBeTruthy();
    });
    const current = screen.getByRole("article", { name: "cover-1.png" });
    await waitFor(() => {
      expect(
        within(current).getByTestId("artifact-catalog-thumbnail"),
      ).toHaveAttribute("src", `https://covers.example.test/${ids[1]}.png`);
    });
  } finally {
    pending.resolve();
  }
});
