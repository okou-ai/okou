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

test("Artifact kind filters remain available while switching catalogs", async () => {
  const avatarRequestStarted = context.mocks.deferred<void>();
  const releaseAvatar = context.mocks.deferred<void>();
  context.mocks.api(
    artifactCatalogContract.list,
    async ({ query, respond }) => {
      if (query.kind === "avatar") {
        avatarRequestStarted.resolve();
        await releaseAvatar.promise;
        return respond(200, {
          artifacts: [artifact({ kind: "avatar", title: "avatar-video.mp4" })],
          nextCursor: null,
        });
      }
      return respond(200, {
        artifacts: [artifact({ kind: "presentation", title: "launch-deck" })],
        nextCursor: null,
      });
    },
  );

  await setupArtifactCatalogPage(context);

  await expect(findArtifactAction("launch-deck")).resolves.toBeInTheDocument();
  const filters = screen.getByLabelText("Artifact kind filters");
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
    "Shared conversations",
    "Files",
  ]);
  expect(
    getButtonByName("Show presentation artifacts", filters),
  ).toHaveAttribute("aria-pressed", "true");

  click(getButtonByName("Show avatar artifacts", filters));
  await avatarRequestStarted.promise;

  await expect(
    screen.findByLabelText("Loading artifacts"),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Show avatar artifacts", filters)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  releaseAvatar.resolve();

  await expect(
    findArtifactAction("avatar-video.mp4"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("launch-deck")).not.toBeInTheDocument();
});

test.each([false, true])(
  "A shared conversation links directly to its shared thread with sidebar preview %s",
  async (sidebarPreview) => {
    const sharedRequestStarted = context.mocks.deferred<void>();
    const releaseSharedConversation = context.mocks.deferred<void>();
    context.mocks.api(
      artifactCatalogContract.list,
      async ({ query, respond }) => {
        if (query.kind === "shared-thread") {
          sharedRequestStarted.resolve();
          await releaseSharedConversation.promise;
          return respond(200, {
            artifacts: [
              artifact({
                kind: "shared-thread",
                title: "Weekly launch review",
                sharedThreadId: "b0000000-0000-4000-a000-000000000001",
              }),
            ],
            nextCursor: null,
          });
        }
        return respond(200, {
          artifacts: [artifact({ kind: "presentation", title: "launch-deck" })],
          nextCursor: null,
        });
      },
    );

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
    const filters = screen.getByLabelText("Artifact kind filters");
    click(getButtonByName("Show shared conversation artifacts", filters));
    await sharedRequestStarted.promise;

    await expect(
      screen.findByLabelText("Loading artifacts"),
    ).resolves.toBeInTheDocument();

    releaseSharedConversation.resolve();

    const conversation = await findArtifactAction("Weekly launch review");
    const listItem = conversation.closest("li");
    if (!listItem?.parentElement) {
      throw new Error("Expected a shared conversation in a compact list");
    }
    expect(conversation).toHaveRole("link");
    expect(conversation).toHaveAttribute(
      "href",
      "/share/threads/b0000000-0000-4000-a000-000000000001",
    );
    expect(conversation).toHaveAttribute("target", "_blank");
    expect(conversation).toHaveAttribute("rel", "noopener noreferrer");
    expect(listItem).toHaveRole("listitem");
    expect(listItem.parentElement).toHaveRole("list");
  },
);

test.each([false, true])(
  "An older API retains catalog deep links with sidebar preview %s",
  async (sidebarPreview) => {
    const locationAssign = context.mocks.browser.locationAssign();
    const conversation = artifact({
      kind: "shared-thread",
      title: "Weekly launch review",
    });
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, { artifacts: [conversation], nextCursor: null });
    });
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(200, {
        ...conversation,
        kind: "shared-thread",
        sharedThread: { id: "b0000000-0000-4000-a000-000000000001" },
      });
    });
    await setupPage({
      context,
      path: `/artifacts?tab=shared-thread&artifact=${conversation.id}`,
      featureSwitches: {
        [FeatureSwitchKey.ArtifactSidebarPreview]: sidebarPreview,
      },
    });
    await expect(
      findArtifactAction(conversation.title),
    ).resolves.toHaveAttribute(
      "href",
      `/artifacts?tab=shared-thread&artifact=${conversation.id}`,
    );
    await waitFor(() => {
      expect(locationAssign.calls).toStrictEqual([
        "/share/threads/b0000000-0000-4000-a000-000000000001",
      ]);
    });
  },
);
