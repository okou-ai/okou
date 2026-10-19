import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("An Artifacts catalog JSON file shares the source-aware tree viewer", async () => {
  const url = "https://artifacts.example.com/catalog.json";
  const source = '{"catalog":{"items":[1,2],"version":1.00}}';
  const summary = artifact({ title: "catalog.json" });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [summary], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...summary,
      kind: "file",
      file: {
        id: "f0000000-0000-4000-a000-000000000005",
        filename: "catalog.json",
        contentType: "application/json",
        size: source.length,
        url,
        previewImageUrl: null,
      },
    });
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text(source, {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${String(source.length - 1)}/${String(source.length)}`,
      },
    });
  });
  await setupPage({
    context,
    path: "/artifacts?tab=file",
    featureSwitches: { [FeatureSwitchKey.JsonTreePreview]: true },
  });
  const card = await findArtifactAction("catalog.json");
  click(card);
  const tree = await screen.findByTestId("json-preview");
  click(getButtonByName('Expand "catalog"', tree));
  expect(within(tree).getByText("1.00")).toBeInTheDocument();
  click(getButtonByName('Expand "items"', tree));
  expect(within(tree).getByText("[1]")).toBeInTheDocument();
  click(getButtonByName("Source", tree));
  expect(tree.querySelector("pre")?.textContent).toBe(source);
});
