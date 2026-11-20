import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { artifact, getButtonByName } from "./artifact-catalog-test-helpers.ts";
import { imageArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";

const context = testContext();

test("artifact-catalog-pagination-001 closes a later-page deep link back to its Images result", async () => {
  const first = artifact({ title: "Valley", kind: "image" });
  const chosen = artifact({
    title: "Ridge.png",
    kind: "image",
    id: "51000000-0000-4000-8000-000000000025",
  });
  const url = "https://media.example.test/maps/ridge.png";
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    if (query.kind !== "image") {
      return respond(200, { artifacts: [], nextCursor: null });
    }
    return query.cursor === "next-survey"
      ? respond(200, { artifacts: [chosen], nextCursor: null })
      : respond(200, { artifacts: [first], nextCursor: "next-survey" });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    return params.artifactId === chosen.id
      ? respond(
          200,
          imageArtifactDetail(chosen, {
            fileId: chosen.id,
            filename: chosen.title,
            url,
          }),
        )
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown survey" },
        });
  });
  const page = "/artifacts?tab=image&artifact=" + chosen.id;
  await setupPage({
    context,
    path: page,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });
  const preview = await screen.findByRole("dialog");
  await expect(
    within(preview).findByAltText(chosen.title),
  ).resolves.toHaveAttribute("src", url);
  const catalog = screen.getByRole("main", { hidden: true });
  await expect(
    within(catalog).findByText(chosen.title),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/artifacts");
  expect(new URLSearchParams(location.search).get("artifact")).toBe(chosen.id);
  expect(new URLSearchParams(location.search).get("tab")).toBe("image");
  click(getButtonByName("Close", preview));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(location.pathname + location.search).toBe("/artifacts?tab=image");
  expect(
    within(screen.getByRole("main")).getByText(chosen.title),
  ).toBeVisible();
});
