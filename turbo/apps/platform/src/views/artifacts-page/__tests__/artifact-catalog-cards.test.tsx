import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { fireEvent, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("Artifact cards identify their kind and show available previews", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({ title: "launch-plan.txt" }),
        artifact({
          id: "a0000000-0000-4000-a000-000000000002",
          kind: "hosted-site",
          title: "launch-site",
          thumbnail: {
            url: "https://cdn.vm0.io/artifacts/test/preview.webp",
          },
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

  await expect(
    findArtifactAction("launch-plan.txt"),
  ).resolves.toBeInTheDocument();
  const siteCard = await findArtifactAction("launch-site");
  const avatarCard = await findArtifactAction("avatar-video.mp4");

  expect(
    within(siteCard).getByLabelText("Hosted site artifact"),
  ).toBeInTheDocument();
  expect(
    within(avatarCard).getByLabelText("Avatar artifact"),
  ).toBeInTheDocument();
  expect(siteCard.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.vm0.io/cdn-cgi/image/width=640,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/test/preview.webp",
  );
});

test("A hosted site whose thumbnail fails to load falls back to its kind", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          id: "a0000000-0000-4000-a000-000000000002",
          kind: "hosted-site",
          title: "launch-site",
          thumbnail: { url: "https://cdn.vm0.io/artifacts/test/preview.webp" },
        }),
      ],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context);

  const siteCard = await findArtifactAction("launch-site");
  const thumbnail = await within(siteCard).findByTestId(
    "artifact-catalog-thumbnail",
  );
  expect(
    within(siteCard).getByTestId("artifact-catalog-kind-icon-hosted-site"),
  ).toBeInTheDocument();

  fireEvent.error(thumbnail);

  await expect(
    within(siteCard).findByTestId("artifact-catalog-kind-cover-hosted-site"),
  ).resolves.toBeInTheDocument();
  expect(
    within(siteCard).queryByTestId("artifact-catalog-kind-icon-hosted-site"),
  ).toBeNull();
});

test("A video artifact without a poster uses its source as the catalog preview", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          kind: "video",
          title: "product-tour.mp4",
          videoSourceUrl: "https://videos.example.test/product-tour.mp4",
        }),
      ],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=video" });

  const card = await findArtifactAction("product-tour.mp4");
  expect(
    within(card).getByTestId("artifact-catalog-video-source"),
  ).toHaveAttribute(
    "src",
    "https://videos.example.test/product-tour.mp4#t=0.001",
  );
});
