import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";

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

test("A deep-linked artifact preview returns to its catalog position", async () => {
  const selectedArtifactId = "a0000000-0000-4000-a000-000000000099";
  const scrollIntoView = vi
    .spyOn(HTMLElement.prototype, "scrollIntoView")
    .mockImplementation(() => {});
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
  await waitFor(() => {
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });
  const centeredCallsBeforeClose = scrollIntoView.mock.calls.length;

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
  await waitFor(() => {
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(
      centeredCallsBeforeClose,
    );
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center" });
  });
});

test("Switching artifact kind ignores results from the previous kind", async () => {
  const secondPageStarted = context.mocks.deferred<void>();
  const releaseSecondPage = context.mocks.deferred<void>();
  const staleResponseReturned = context.mocks.deferred<void>();
  context.mocks.api(
    artifactCatalogContract.list,
    async ({ query, respond }) => {
      if (query.cursor === "file-next") {
        secondPageStarted.resolve();
        await releaseSecondPage.promise;
        const response = respond(200, {
          artifacts: [
            artifact({
              id: "a0000000-0000-4000-a000-000000000002",
              title: "stale-file.txt",
            }),
          ],
          nextCursor: null,
        });
        staleResponseReturned.resolve();
        return response;
      }
      if (query.kind === "image") {
        return respond(200, {
          artifacts: [
            artifact({
              id: "a0000000-0000-4000-a000-000000000003",
              kind: "image",
              title: "fresh-image.png",
            }),
          ],
          nextCursor: null,
        });
      }
      return respond(200, {
        artifacts: [artifact({ title: "first-page.txt" })],
        nextCursor: "file-next",
      });
    },
  );

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  await expect(
    findArtifactAction("first-page.txt"),
  ).resolves.toBeInTheDocument();
  const viewport = getCatalogViewport();
  placeNearCatalogEnd(viewport);
  fireEvent.scroll(viewport);
  await secondPageStarted.promise;

  await expect(
    findArtifactAction("first-page.txt"),
  ).resolves.toBeInTheDocument();
  const filters = screen.getByLabelText("Artifact kind filters");
  expect(getButtonByName("Show image artifacts", filters)).toBeEnabled();

  click(getButtonByName("Show image artifacts", filters));

  await expect(
    findArtifactAction("fresh-image.png"),
  ).resolves.toBeInTheDocument();

  await act(async () => {
    releaseSecondPage.resolve();
    await staleResponseReturned.promise;
  });

  await waitFor(() => {
    expect(screen.getByText("fresh-image.png")).toBeInTheDocument();
    expect(screen.queryByText("stale-file.txt")).not.toBeInTheDocument();
  });
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

test("Scrolling can recover after a later artifact page fails", async () => {
  const firstFailureStarted = context.mocks.deferred<void>();
  const releaseFirstFailure = context.mocks.deferred<void>();
  const firstFailureReturned = context.mocks.deferred<void>();
  let nextPageAttempts = 0;
  context.mocks.api(
    artifactCatalogContract.list,
    async ({ query, respond }) => {
      if (query.cursor !== "retry-next") {
        return respond(200, {
          artifacts: [artifact({ title: "first-page.txt" })],
          nextCursor: "retry-next",
        });
      }
      nextPageAttempts += 1;
      if (nextPageAttempts === 1) {
        firstFailureStarted.resolve();
        await releaseFirstFailure.promise;
        const response = respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Transient catalog failure",
          },
        });
        firstFailureReturned.resolve();
        return response;
      }
      return respond(200, {
        artifacts: [
          artifact({
            id: "a0000000-0000-4000-a000-000000000002",
            title: "retried-page.txt",
          }),
        ],
        nextCursor: null,
      });
    },
  );

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  await expect(
    findArtifactAction("first-page.txt"),
  ).resolves.toBeInTheDocument();
  const viewport = getCatalogViewport();
  placeNearCatalogEnd(viewport);
  fireEvent.scroll(viewport);
  await firstFailureStarted.promise;

  await act(async () => {
    releaseFirstFailure.resolve();
    await firstFailureReturned.promise;
  });
  await expect(
    findArtifactAction("first-page.txt"),
  ).resolves.toBeInTheDocument();
  expect(
    getButtonByName(
      "Show file artifacts",
      screen.getByLabelText("Artifact kind filters"),
    ),
  ).toBeEnabled();

  fireEvent.scroll(viewport);

  await expect(
    findArtifactAction("retried-page.txt"),
  ).resolves.toBeInTheDocument();
});

test("a failed first page recovers from its own message instead of a browser reload", async () => {
  let attempts = 0;
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    attempts += 1;
    if (attempts === 1) {
      return respond(500, {
        error: { code: "INTERNAL", message: "Catalog unavailable" },
      });
    }
    return respond(200, {
      artifacts: [artifact({ title: "recovered.txt" })],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context);

  await expect(
    screen.findByText("Could not load artifacts."),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Try again"));

  await expect(screen.findByText("recovered.txt")).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("Could not load artifacts."),
  ).not.toBeInTheDocument();
});
