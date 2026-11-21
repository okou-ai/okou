import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactReferencePath } from "@okouai/api-contracts/validators/artifact-references";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fileArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

function serveCatalog(summary: ArtifactSummary): void {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [summary], nextCursor: null });
  });
}

/** A stored file the catalog opens in its preview dialog. */
function serveStoredFile(
  summary: ArtifactSummary,
  file: { readonly filename: string; readonly contentType: string },
): string {
  const url = `https://files.example.test/originals/${file.filename}`;
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    expect(params.artifactId).toBe(summary.id);
    return respond(
      200,
      fileArtifactDetail(summary, {
        ...file,
        fileId: "a0000000-0000-4000-a000-000000000d99",
        url,
      }),
    );
  });
  context.mocks.http.get(url, () => {
    return new HttpResponse(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      headers: { "Content-Type": file.contentType },
    });
  });
  return url;
}

async function openPreview(filename: string): Promise<HTMLElement> {
  click(await findArtifactAction(filename));
  return await screen.findByRole("dialog", { name: `${filename} preview` });
}

test("HTML artifact cards resolve their stored private cover image", async () => {
  const coverId = "a0000000-0000-4000-a000-000000000d01";
  const authorizedCover =
    "https://private-files.example.test/covers/quarterly.png?grant=signed";
  serveCatalog(
    artifact({
      id: "a0000000-0000-4000-a000-000000000d02",
      kind: "hosted-site",
      title: "Quarterly site",
      thumbnail: { url: artifactReferencePath(coverId, "cover.png") },
    }),
  );
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: authorizedCover,
      downloadUrl: `${authorizedCover}&download=1`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      filename: "cover.png",
      contentType: "image/png",
      target: { kind: "file", id: coverId },
    });
  });

  await setupArtifactCatalogPage(context);

  const card = getButtonByName("Preview Quarterly site", document.body);
  await waitFor(() => {
    expect(
      within(card).getByTestId("artifact-catalog-thumbnail"),
    ).toHaveAttribute("src", authorizedCover);
  });
});

test("A binary can be downloaded from its preview", async () => {
  const summary = artifact({
    id: "a0000000-0000-4000-a000-000000000d11",
    title: "release-bundle.zip",
  });
  serveCatalog(summary);
  const url = serveStoredFile(summary, {
    filename: "release-bundle.zip",
    contentType: "application/zip",
  });
  const browser = context.mocks.browser.blobDownload();
  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });
  const preview = await openPreview("release-bundle.zip");

  click(getButtonByName("Download", preview));

  await waitFor(() => {
    expect(
      browser.downloads.map(({ url: source, filename }) => {
        return { source, filename };
      }),
    ).toStrictEqual([{ source: url, filename: "release-bundle.zip" }]);
  });
});

test("A native PPTX in Presentations keeps its Office preview and original download", async () => {
  const summary = artifact({
    id: "a0000000-0000-4000-a000-000000000d21",
    title: "quarterly-review.pptx",
  });
  serveCatalog(summary);
  const url = serveStoredFile(summary, {
    filename: "quarterly-review.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  const browser = context.mocks.browser.blobDownload();
  await setupArtifactCatalogPage(context, {
    path: "/artifacts?tab=presentation",
  });
  const preview = await openPreview("quarterly-review.pptx");
  await expect(
    within(preview).findByTestId("artifact-dialog-body-office"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Download options", preview));
  const download = await waitFor(() => {
    const item = queryAllByRoleFast("menuitem").find((candidate) => {
      return candidate.textContent?.trim() === "Download";
    });
    expect(item).toBeEnabled();
    return item as HTMLElement;
  });

  click(download);

  await waitFor(() => {
    expect(
      browser.downloads.map(({ url: source, filename }) => {
        return { source, filename };
      }),
    ).toStrictEqual([{ source: url, filename: "quarterly-review.pptx" }]);
  });
  const viewer = new URL(
    within(preview)
      .getByTestId("artifact-dialog-body-office")
      .getAttribute("src") ?? "",
  );
  expect(`${viewer.origin}${viewer.pathname}`).toBe(
    "https://view.officeapps.live.com/op/embed.aspx",
  );
  expect(viewer.searchParams.get("src")).toBe(url);
});
