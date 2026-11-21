import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findNamedButton,
  findNamedMenuItem,
  queryNamedButton,
} from "../../okou-page/__tests__/chat-attachment-test-helpers.ts";

const context = testContext();

async function download() {
  click(await findNamedButton("Download options"));
  click(await findNamedMenuItem("Download"));
}

test("shared-thread-snapshot-viewer-001 shares the snapshot address and downloads under a refreshed grant", async () => {
  const route = "/artifacts/coast025ab.png#inlet";
  const preview = "https://media.example.test/map.png";
  const filename = "Survey map.png";
  let downloadUrl = "https://media.example.test/maps?token=initial";
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url: preview,
      downloadUrl,
      sharedThreadSnapshot: true,
      preview: { filename, contentType: "image/png" },
    });
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const browser = context.mocks.browser.blobDownload();
  const navigation = context.mocks.browser.locationAssign();
  await setupPage({ context, auth: null, host: "app.okou.ai", path: route });
  const image = await screen.findByAltText(filename);
  expect(image).toHaveAttribute("src", preview + "#inlet");
  click(await findNamedButton("Share"));
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toContain("https://app.okou.ai" + route);
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  expect(queryNamedButton("Copy link")).toBeNull();
  downloadUrl = "https://media.example.test/maps?token=renewed";
  await download();
  await waitFor(() => {
    return expect(browser.downloads).toContainEqual({
      url: downloadUrl,
      filename,
      blob: null,
    });
  });
  expect(screen.getByAltText(filename)).toHaveAttribute(
    "src",
    preview + "#inlet",
  );
  expect(location.pathname + location.hash).toBe(route);
  expect(navigation.calls).toStrictEqual([]);
});

test("shared-thread-snapshot-viewer-003 previews the requested HTML slide and saves its authorized original", async () => {
  const filename = "Coast slides.html";
  const preview = `https://ps-${"253d".repeat(12)}.okou.app/index.html`;
  context.mocks.api(artifactDownloadsContract.files, ({ respond }) => {
    return respond(401, {
      error: {
        code: "UNAUTHORIZED",
        message: "Sign in to access publication files",
      },
    });
  });
  const downloadUrl =
    "https://media.example.test/coast.html?credential=archive25";
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url: preview,
      downloadUrl,
      sharedThreadSnapshot: true,
      preview: { filename, contentType: "text/html" },
    });
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPage({
    context,
    path: "/artifacts/coast025ab.html#slide-7",
    host: "app.okou.ai",
    auth: null,
  });
  const frame = await screen.findByTitle(filename + " preview");
  expect(frame).toHaveAttribute("src", preview + "#slide-7");
  expect(frame).toHaveAttribute("referrerpolicy", "origin");
  expect(frame.getAttribute("sandbox")?.split(/\s+/u).sort()).toStrictEqual([
    "allow-same-origin",
    "allow-scripts",
  ]);
  await download();
  await waitFor(() => {
    return expect(browser.downloads).toContainEqual({
      url: downloadUrl,
      filename,
      blob: null,
    });
  });
});
