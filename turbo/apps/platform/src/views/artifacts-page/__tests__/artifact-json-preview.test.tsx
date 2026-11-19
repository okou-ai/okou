import { artifactCatalogContract } from "@okouai/api-contracts/client/artifact-catalog";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fileArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("The artifact catalog JSON preview preserves numeric spelling and exact source", async () => {
  const filename = "catalog.json";
  const url = "https://files.example.test/catalog.json";
  const source = '{"catalog":{"items":[1,2],"version":1.00}}';
  const summary = artifact({ title: filename });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [summary], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    expect(params.artifactId).toBe(summary.id);
    return respond(
      200,
      fileArtifactDetail(summary, {
        filename,
        fileId: "a0000000-0000-4000-a000-000000000002",
        contentType: "application/json",
        url,
      }),
    );
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text(source, {
      headers: { "Content-Type": "application/json" },
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });
  click(await findArtifactAction(filename));

  await expect(screen.findByText("Tree")).resolves.toBeInTheDocument();
  await waitFor(() =>
    expect(getButtonByName('Expand "catalog"')).toBeEnabled(),
  );
  click(getButtonByName('Expand "catalog"'));
  expect(screen.getByText("1.00")).toBeInTheDocument();
  click(getButtonByName('Expand "items"'));
  expect(screen.getByText("[1]")).toBeInTheDocument();
  click(getButtonByName("Source"));

  expect(screen.getByText(source, { exact: true })).toBeInTheDocument();
  expect(getButtonByName("Source")).toHaveAttribute("aria-pressed", "true");
});
