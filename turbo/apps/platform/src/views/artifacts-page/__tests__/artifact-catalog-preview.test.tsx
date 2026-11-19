import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
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

async function openPreview(title: string) {
  click(await findArtifactAction(title));
  return screen.findByTestId("attachment-lightbox");
}

async function download(viewer: HTMLElement) {
  click(getButtonByName("Download options", viewer));
  const menu = await screen.findByRole("menu");
  const download = queryAllByRoleFast("menuitem", menu).find((item) => {
    return item.textContent?.trim() === "Download";
  });
  if (!download) {
    throw new Error("Expected the download action");
  }
  click(download);
}

test("A hosted-site card shows its resolved private cover image", async () => {
  const fileId = "f0000000-0000-4000-a000-000000000005";
  const resolved = "https://private.example/preview.png?signature=authorized";
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          kind: "hosted-site",
          title: "Website with a sandbox cover",
          thumbnail: { url: artifactReferencePath(fileId, "preview.png") },
        }),
      ],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      downloadUrl: new URL("?download=1", resolved).href,
      url: resolved,
      expiresAt: "2099-01-01T00:00:00.000Z",
      filename: "preview.png",
      contentType: "image/png",
      target: { kind: "file", id: fileId },
    });
  });

  await setupArtifactCatalogPage(context);

  const card = await findArtifactAction("Website with a sandbox cover");
  await expect(
    within(card).findByTestId("artifact-catalog-thumbnail"),
  ).resolves.toHaveAttribute("src", resolved);
});

test("A binary file downloads from its preview with the original URL", async () => {
  const browser = context.mocks.browser.blobDownload();
  const filename = "release-bundle.zip";
  const url = `https://artifacts.example.com/${filename}`;
  const summary = artifact({ title: filename });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [summary], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(
      200,
      fileArtifactDetail(summary, {
        contentType: "application/zip",
        fileId: "f0000000-0000-4000-a000-000000000002",
        filename,
        url,
      }),
    );
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text("archive bytes", {
      headers: { "Content-Type": "application/zip" },
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });
  await download(await openPreview(filename));

  await waitFor(() => {
    expect(browser.downloads).toMatchObject([{ filename, url }]);
  });
});

test("A native PPTX keeps its Office preview and downloads the original file", async () => {
  const browser = context.mocks.browser.blobDownload();
  const filename = "quarterly-review.pptx";
  const url = `https://artifacts.example.com/${filename}`;
  const contentType =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const summary = artifact({ kind: "presentation", title: filename });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [summary], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(
      200,
      fileArtifactDetail(summary, {
        contentType,
        fileId: "f0000000-0000-4000-a000-000000000002",
        filename,
        url,
      }),
    );
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text("PowerPoint bytes", {
      headers: { "Content-Type": contentType },
    });
  });

  await setupArtifactCatalogPage(context);
  const viewer = await openPreview(filename);
  const frame = await within(viewer).findByTitle(`${filename} preview`);
  const officeUrl = new URL(frame.getAttribute("src") ?? "");
  expect(`${officeUrl.origin}${officeUrl.pathname}`).toBe(
    "https://view.officeapps.live.com/op/embed.aspx",
  );
  expect(officeUrl.searchParams.get("src")).toBe(url);

  await download(viewer);

  await waitFor(() => {
    expect(browser.downloads).toMatchObject([{ filename, url }]);
  });
  expect(frame).toHaveAttribute("src", officeUrl.href);
});
