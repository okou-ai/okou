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

test("Only populated artifact kind filters remain available while switching catalogs", async () => {
  const avatarRequestStarted = context.mocks.deferred<void>();
  const releaseAvatar = context.mocks.deferred<void>();
  context.mocks.api(
    artifactCatalogContract.list,
    async ({ query, respond }) => {
      if (query.limit === 1) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Kind probes are unavailable" },
        });
      }
      if (query.kind === "avatar") {
        avatarRequestStarted.resolve();
        await releaseAvatar.promise;
        return respond(200, {
          artifacts: [artifact({ kind: "avatar", title: "avatar-video.mp4" })],
          nextCursor: null,
          availableKinds: ["presentation", "avatar"],
        });
      }
      return respond(200, {
        artifacts:
          query.kind === "presentation"
            ? [artifact({ kind: "presentation", title: "launch-deck" })]
            : [],
        nextCursor: null,
        availableKinds: ["presentation", "avatar"],
      });
    },
  );

  await setupArtifactCatalogPage(context);

  await expect(findArtifactAction("launch-deck")).resolves.toBeInTheDocument();
  const filters = await screen.findByLabelText("Artifact kind filters");
  expect(
    queryAllByRoleFast("button", filters).map((button) => {
      return button.textContent?.trim();
    }),
  ).toStrictEqual(["Presentations", "Avatars"]);
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
  expect(
    queryAllByRoleFast("button", filters).map((button) => {
      return button.textContent?.trim();
    }),
  ).toStrictEqual(["Presentations", "Avatars"]);

  releaseAvatar.resolve();

  await expect(
    findArtifactAction("avatar-video.mp4"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("launch-deck")).not.toBeInTheDocument();
});

test("An empty artifact catalog has no kind chips", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [],
      nextCursor: null,
      availableKinds: [],
    });
  });

  await setupArtifactCatalogPage(context);

  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Artifact kind filters"),
  ).not.toBeInTheDocument();
});

test("Kind chips include artifacts outside the current catalog page", async () => {
  const files = Array.from({ length: 60 }, (_, index) => {
    return artifact({
      id: `a0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
      title: `report-${index}.txt`,
    });
  });
  const image = artifact({
    id: "b0000000-0000-4000-a000-000000000001",
    kind: "image",
    title: "older-image.png",
  });
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts:
        query.kind === "file"
          ? files.slice(0, query.limit)
          : query.kind === "image"
            ? [image]
            : [],
      nextCursor: query.kind === "file" ? "more-files" : null,
      availableKinds: ["file", "image"],
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  await expect(findArtifactAction("report-0.txt")).resolves.toBeInTheDocument();
  const filters = await screen.findByLabelText("Artifact kind filters");
  expect(
    queryAllByRoleFast("button", filters).map((button) => {
      return button.textContent?.trim();
    }),
  ).toStrictEqual(["Images", "Files"]);

  click(getButtonByName("Show image artifacts", filters));

  await expect(findArtifactAction(image.title)).resolves.toBeInTheDocument();
  expect(getButtonByName("Show file artifacts", filters)).toBeInTheDocument();
});

test("Kind chips still work when an older API omits kind metadata", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts:
        query.kind === "image"
          ? [artifact({ kind: "image", title: "legacy-api-image.png" })]
          : [],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=image" });

  await expect(
    findArtifactAction("legacy-api-image.png"),
  ).resolves.toBeInTheDocument();
  const filters = await screen.findByLabelText("Artifact kind filters");
  expect(
    queryAllByRoleFast("button", filters).map((button) => {
      return button.textContent?.trim();
    }),
  ).toStrictEqual(["Images"]);
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
          if (query.limit !== 1) {
            sharedRequestStarted.resolve();
            await releaseSharedConversation.promise;
          }
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
    const filters = await screen.findByLabelText("Artifact kind filters");
    click(getButtonByName("Show shared chat artifacts", filters));
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
  "A routed shared conversation opens its shared thread with sidebar preview %s",
  async (sidebarPreview) => {
    const locationAssign = context.mocks.browser.locationAssign();
    const sharedThreadId = "b0000000-0000-4000-a000-000000000001";
    const conversation = artifact({
      kind: "shared-thread",
      title: "Weekly launch review",
      sharedThreadId,
    });
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, { artifacts: [conversation], nextCursor: null });
    });
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(200, {
        ...conversation,
        kind: "shared-thread",
        sharedThreadId,
        sharedThread: { id: sharedThreadId },
      });
    });
    // Global search opens a shared conversation through this catalog route.
    await setupPage({
      context,
      path: `/artifacts?tab=shared-thread&artifact=${conversation.id}`,
      featureSwitches: {
        [FeatureSwitchKey.ArtifactSidebarPreview]: sidebarPreview,
      },
    });
    await waitFor(() => {
      expect(locationAssign.calls).toStrictEqual([
        `/share/threads/${sharedThreadId}`,
      ]);
    });
  },
);
