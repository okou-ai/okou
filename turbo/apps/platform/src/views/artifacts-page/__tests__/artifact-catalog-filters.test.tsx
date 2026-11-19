import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("Every kind filter stays available after choosing Files in an empty catalog", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });

  await setupArtifactCatalogPage(context);
  await expect(screen.findByText("No artifacts found")).resolves.toBeVisible();
  const filters = screen.getByLabelText("Artifact kind filters");

  click(getButtonByName("Show file artifacts", filters));

  await waitFor(() => {
    expect(getButtonByName("Show file artifacts", filters)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  expect(
    queryAllByRoleFast("button", filters).map((button) => {
      return button.textContent?.trim();
    }),
  ).toStrictEqual([
    "Presentations",
    "Websites",
    "Images",
    "Videos",
    "Avatars",
    "Shared chats",
    "Files",
  ]);
  await expect(screen.findByText("No artifacts found")).resolves.toBeVisible();
});

test.each([false, true])(
  "A shared conversation links directly to its shared thread with sidebar preview %s",
  async (sidebarPreview) => {
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      return respond(200, {
        artifacts: [
          query.kind === "shared-thread"
            ? artifact({
                kind: "shared-thread",
                title: "Weekly launch review",
                sharedThreadId: "b0000000-0000-4000-a000-000000000001",
              })
            : artifact({ kind: "presentation", title: "launch-deck" }),
        ],
        nextCursor: null,
      });
    });

    await setupPage({
      context,
      path: "/artifacts",
      featureSwitches: {
        [FeatureSwitchKey.ArtifactSidebarPreview]: sidebarPreview,
      },
    });
    await expect(
      findArtifactAction("launch-deck"),
    ).resolves.toBeInTheDocument();

    click(
      getButtonByName(
        "Show shared chat artifacts",
        screen.getByLabelText("Artifact kind filters"),
      ),
    );

    const conversation = await findArtifactAction("Weekly launch review");
    expect(conversation).toHaveRole("link");
    expect(conversation).toHaveAttribute(
      "href",
      "/share/threads/b0000000-0000-4000-a000-000000000001",
    );
    expect(conversation).toHaveAttribute("target", "_blank");
    expect(conversation).toHaveAttribute("rel", "noopener noreferrer");
    const listItem = conversation.closest("li");
    expect(listItem).toHaveRole("listitem");
    expect(listItem?.parentElement).toHaveRole("list");
  },
);
