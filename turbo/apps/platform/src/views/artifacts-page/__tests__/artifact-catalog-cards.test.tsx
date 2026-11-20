import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  getButtonByName,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("Artifact cards identify their kind and show available previews", async () => {
  const siteCover = "https://static.example.test/covers/launch-site.png";
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          id: "a0000000-0000-4000-a000-000000000c01",
          kind: "file",
          title: "launch-plan.txt",
        }),
        artifact({
          id: "a0000000-0000-4000-a000-000000000c02",
          kind: "hosted-site",
          title: "Launch site",
          thumbnail: { url: siteCover },
        }),
        artifact({
          id: "a0000000-0000-4000-a000-000000000c03",
          kind: "avatar",
          title: "Founder intro",
          videoSourceUrl: "https://media.example.test/founder-intro.mp4",
        }),
      ],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context);

  await expect(screen.findByText("Launch site")).resolves.toBeInTheDocument();
  const site = getButtonByName("Preview Launch site");
  expect(
    within(site).getByRole("img", { name: "Hosted site artifact" }),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(
      within(site).getByTestId("artifact-catalog-thumbnail"),
    ).toHaveAttribute("src", siteCover);
  });
  expect(
    within(getButtonByName("Preview Founder intro")).getByRole("img", {
      name: "Avatar artifact",
    }),
  ).toBeInTheDocument();
  expect(getButtonByName("Preview launch-plan.txt")).toBeEnabled();
});

test("Re-read the catalog when one of the member's artifacts changes", async () => {
  const artifactId = "a0000000-0000-4000-a000-000000000c11";
  const server = { title: "launch-plan.txt" };
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ id: artifactId, title: server.title })],
      nextCursor: null,
    });
  });
  await setupArtifactCatalogPage(context);
  await expect(
    screen.findByText("launch-plan.txt"),
  ).resolves.toBeInTheDocument();

  // The member's artifact is updated elsewhere, for example by a Drive sync.
  server.title = "synced-plan.txt";
  context.mocks.ably.trigger("artifact:changed", { artifactId });

  await expect(
    screen.findByText("synced-plan.txt"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("launch-plan.txt")).not.toBeInTheDocument();
});
