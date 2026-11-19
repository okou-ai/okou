import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { within } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("Artifact cards identify hosted sites and avatars and show available previews", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({ title: "launch-plan.txt" }),
        artifact({
          id: "a0000000-0000-4000-a000-000000000002",
          kind: "hosted-site",
          title: "launch-site",
          thumbnail: { url: "https://cdn.vm0.io/artifacts/test/preview.webp" },
        }),
        artifact({
          id: "a0000000-0000-4000-a000-000000000003",
          kind: "avatar",
          title: "avatar-video.mp4",
        }),
      ],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context);

  const siteCard = await findArtifactAction("launch-site");
  expect(
    within(siteCard).getByLabelText("Hosted site artifact"),
  ).toBeInTheDocument();
  expect(siteCard.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.vm0.io/cdn-cgi/image/width=640,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/test/preview.webp",
  );
  const avatarCard = await findArtifactAction("avatar-video.mp4");
  expect(
    within(avatarCard).getByLabelText("Avatar artifact"),
  ).toBeInTheDocument();
  await expect(
    findArtifactAction("launch-plan.txt"),
  ).resolves.toBeInTheDocument();
});

test("An artifact change event re-reads the catalog", async () => {
  let reads = 0;
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    reads += 1;
    return respond(200, {
      artifacts: [
        artifact({ title: reads > 1 ? "synced-plan.txt" : "launch-plan.txt" }),
      ],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context);
  await expect(findArtifactAction("launch-plan.txt")).resolves.toBeVisible();

  context.mocks.ably.trigger("artifact:changed", {
    artifactId: "a0000000-0000-4000-a000-000000000001",
  });

  await expect(findArtifactAction("synced-plan.txt")).resolves.toBeVisible();
});
