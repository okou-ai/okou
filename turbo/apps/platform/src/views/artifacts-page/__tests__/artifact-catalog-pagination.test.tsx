import { artifactCatalogContract } from "@okouai/api-contracts/client/artifact-catalog";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { imageArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
import {
  artifact,
  getButtonByName,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("Closing a later-page image deep link returns to the Images catalog", async () => {
  const first = artifact({ kind: "image", title: "first.png" });
  const later = artifact({
    id: "a0000000-0000-4000-a000-000000000002",
    kind: "image",
    title: "later.png",
  });
  const url = "https://files.example.test/later.png";
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(
      200,
      query.cursor
        ? { artifacts: [later], nextCursor: null }
        : { artifacts: [first], nextCursor: "next" },
    );
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    expect(params.artifactId).toBe(later.id);
    return respond(
      200,
      imageArtifactDetail(later, {
        fileId: "a0000000-0000-4000-a000-000000000003",
        filename: later.title,
        url,
      }),
    );
  });

  await setupArtifactCatalogPage(context, {
    path: `/artifacts?tab=image&artifact=${later.id}`,
  });

  const preview = await screen.findByRole("img", { name: later.title });
  expect(preview).toHaveAttribute("src", url);
  const openParams = new URLSearchParams(window.location.search);
  expect(openParams.get("artifact")).toBe(later.id);
  expect(openParams.get("tab")).toBe("image");
  expect(window.location.pathname).toBe("/artifacts");
  await waitFor(() => {
    expect(
      document.querySelector('button[aria-label="Preview later.png"]'),
    ).toBeInTheDocument();
  });

  click(getButtonByName("Close", screen.getByRole("dialog")));

  await waitFor(() => {
    const params = new URLSearchParams(window.location.search);
    expect(params.has("artifact")).toBeFalsy();
    expect(params.get("tab")).toBe("image");
  });
  expect(window.location.pathname).toBe("/artifacts");
  expect(getButtonByName("Preview later.png")).toBeEnabled();
});
