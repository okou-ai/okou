import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fileArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("artifact-json-preview-001 reads the stored numeric literal in the catalog tree and source", async () => {
  const source = '{"catalog":{"items":[1,2],"version":1.00}}';
  const summary = artifact({ title: "catalog.json" });
  const file = {
    filename: summary.title,
    contentType: "application/json",
    fileId: summary.id,
    url: "https://content.example.test/inventory.json",
  };
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [summary], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, fileArtifactDetail(summary, file));
  });
  context.mocks.http.get(file.url, () => {
    return HttpResponse.text(source, {
      headers: { "Content-Type": "application/json" },
    });
  });
  await setupPage({ context, path: "/artifacts?tab=file" });
  click(await findArtifactAction(summary.title));
  const dialog = await screen.findByRole("dialog", {
    name: "catalog.json preview",
  });
  const preview = within(dialog);
  click(await preview.findByLabelText('Expand "catalog"'));
  expect(preview.getByText("1.00")).toBeInTheDocument();
  click(preview.getByLabelText('Expand "items"'));
  expect(preview.getByText("[1]")).toBeInTheDocument();
  click(getButtonByName("Source", dialog));
  expect(preview.getByText(source, { selector: "pre" }).textContent).toBe(
    source,
  );
});
