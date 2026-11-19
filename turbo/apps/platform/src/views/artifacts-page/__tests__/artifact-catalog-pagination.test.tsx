import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  holdElementAnimations,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  getCatalogViewport,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

function placeNearCatalogEnd(viewport: HTMLElement): void {
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 1000 },
    scrollHeight: { configurable: true, value: 5000 },
  });
  viewport.scrollTop = 2200;
}

test.each(["Close", "Escape"])(
  "A deep-linked preview closes in place with %s after its exit animation",
  async (dismissal) => {
    const user = userEvent.setup({ delay: null });
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

    await setupPage({
      context,
      path: `/artifacts?tab=image&artifact=${selectedArtifactId}&source=library&tag=one&tag=two#selected`,
      featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
    });

    const preview = await screen.findByTestId("attachment-lightbox");
    await expect(
      within(preview).findByTestId("attachment-lightbox-image"),
    ).resolves.toHaveAttribute(
      "src",
      "https://artifacts.example.com/selected-image.png",
    );
    await expect(
      within(getCatalogViewport()).findByText("selected-image.png"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(within(preview).getByRole("group")).toHaveFocus();
    });
    const finishExit = holdElementAnimations(preview);

    try {
      if (dismissal === "Escape") {
        await user.keyboard("{Escape}");
      } else {
        click(getButtonByName("Close", preview));
      }

      await waitFor(() => {
        expect(window.location.search).toBe(
          "?tab=image&source=library&tag=one&tag=two",
        );
      });
      expect(preview).toBeVisible();
      expect(
        within(preview).getByTestId("attachment-lightbox-image"),
      ).toHaveAttribute(
        "src",
        "https://artifacts.example.com/selected-image.png",
      );
    } finally {
      finishExit();
    }

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });
    expect(window.location.pathname).toBe("/artifacts");
    expect(window.location.hash).toBe("#selected");
    expect(getButtonByName("Show image artifacts")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      findArtifactAction("recent-image.png"),
    ).resolves.toBeInTheDocument();
    await expect(
      findArtifactAction("selected-image.png"),
    ).resolves.toBeInTheDocument();
  },
);

test("Closing an earlier artifact keeps later pages, scroll position, and keyboard focus", async () => {
  const user = userEvent.setup({ delay: null });
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    if (query.cursor === "cursor-2") {
      return respond(200, {
        artifacts: [
          artifact({
            id: "a0000000-0000-4000-a000-000000000002",
            kind: "image",
            title: "second-page.png",
          }),
        ],
        nextCursor: null,
      });
    }
    return respond(200, {
      artifacts: [artifact({ kind: "image", title: "first-page.png" })],
      nextCursor: "cursor-2",
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({ kind: "image", title: "first-page.png" }),
      kind: "image",
      file: {
        id: "f0000000-0000-4000-a000-000000000001",
        filename: "first-page.png",
        contentType: "image/png",
        size: 4096,
        url: "https://artifacts.example.com/first-page.png",
        previewImageUrl: null,
      },
      model: "image-model",
      provider: "image-provider",
    });
  });

  await setupPage({
    context,
    path: "/artifacts?tab=image&source=library#catalog",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });

  await expect(
    findArtifactAction("first-page.png"),
  ).resolves.toBeInTheDocument();
  const viewport = getCatalogViewport();
  placeNearCatalogEnd(viewport);

  fireEvent.scroll(viewport);

  await expect(
    findArtifactAction("second-page.png"),
  ).resolves.toBeInTheDocument();
  await user.click(await findArtifactAction("first-page.png"));
  const preview = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    expect(within(preview).getByRole("group")).toHaveFocus();
  });

  click(getButtonByName("Close", preview));

  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
  });
  expect(window.location.pathname).toBe("/artifacts");
  expect(window.location.search).toBe("?tab=image&source=library");
  expect(window.location.hash).toBe("#catalog");
  await expect(
    findArtifactAction("first-page.png"),
  ).resolves.toBeInTheDocument();
  await expect(
    findArtifactAction("second-page.png"),
  ).resolves.toBeInTheDocument();
  expect(getCatalogViewport().scrollTop).toBe(2200);
  await waitFor(() => {
    expect(
      getButtonByName("Preview first-page.png", getCatalogViewport()),
    ).toHaveFocus();
  });
});
