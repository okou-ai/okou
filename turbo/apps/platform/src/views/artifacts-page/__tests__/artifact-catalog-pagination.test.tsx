import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  getCatalogViewport,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

function placeNearCatalogEnd(viewport: HTMLElement): void {
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 1000 },
    scrollHeight: { configurable: true, value: 5000 },
    scrollTop: { configurable: true, value: 2200 },
  });
}

test("A deep-linked artifact preview opens over its catalog and closes back to it", async () => {
  const selectedArtifactId = "a0000000-0000-4000-a000-000000000099";
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    if (query.cursor === "image-cursor-2") {
      return respond(200, {
        artifacts: [
          artifact({
            id: selectedArtifactId,
            kind: "image",
            title: "selected-image.png",
          }),
        ],
        nextCursor: null,
      });
    }
    return respond(200, {
      artifacts: [
        artifact({
          id: "a0000000-0000-4000-a000-000000000098",
          kind: "image",
          title: "recent-image.png",
        }),
      ],
      nextCursor: "image-cursor-2",
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({
        id: selectedArtifactId,
        kind: "image",
        title: "selected-image.png",
      }),
      kind: "image",
      file: {
        id: "f0000000-0000-4000-a000-000000000099",
        filename: "selected-image.png",
        contentType: "image/png",
        size: 4096,
        url: "https://artifacts.example.com/selected-image.png",
        previewImageUrl: null,
      },
      model: "image-model",
      provider: "image-provider",
    });
  });

  await setupArtifactCatalogPage(context, {
    path: `/artifacts?tab=image&artifact=${selectedArtifactId}`,
  });

  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute(
    "src",
    "https://artifacts.example.com/selected-image.png",
  );
  expect(pathname()).toBe("/artifacts");
  expect(new URLSearchParams(search()).get("tab")).toBe("image");
  expect(new URLSearchParams(search()).get("artifact")).toBe(
    selectedArtifactId,
  );
  await expect(
    within(getCatalogViewport()).findByText("selected-image.png"),
  ).resolves.toBeInTheDocument();

  click(getButtonByName("Close"));

  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
    expect(new URLSearchParams(search()).has("artifact")).toBeFalsy();
  });
  expect(pathname()).toBe("/artifacts");
  expect(new URLSearchParams(search()).get("tab")).toBe("image");
  await expect(
    findArtifactAction("selected-image.png"),
  ).resolves.toBeInTheDocument();
});

test("Scrolling through artifacts appends later results without losing earlier ones", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    if (query.cursor === "cursor-2") {
      return respond(200, {
        artifacts: [
          artifact({
            id: "a0000000-0000-4000-a000-000000000002",
            title: "second-page.txt",
          }),
        ],
        nextCursor: null,
      });
    }
    return respond(200, {
      artifacts: [artifact({ title: "first-page.txt" })],
      nextCursor: "cursor-2",
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  await expect(
    findArtifactAction("first-page.txt"),
  ).resolves.toBeInTheDocument();
  const viewport = getCatalogViewport();
  placeNearCatalogEnd(viewport);

  fireEvent.scroll(viewport);

  await expect(
    findArtifactAction("second-page.txt"),
  ).resolves.toBeInTheDocument();
  await expect(
    findArtifactAction("first-page.txt"),
  ).resolves.toBeInTheDocument();
});
