// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  attachment,
  conversation,
  fileParts,
  userRow,
  serveReference,
} from "./attachment-preview-boundaries.ts";
import { findNamedMenuItem } from "./chat-attachment-test-helpers.ts";
import {
  artifactSummary,
  fileArtifactDetail,
} from "./chat-navigation-artifact-test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  publicConversation,
  promptFiles,
  sharedFile,
} from "../../shared-thread-page/__tests__/shared-preview-boundaries.ts";
const context = testContext();
function captureDownloads() {
  const sink = context.mocks.posthog();
  return () => {
    return sink.events
      .filter((e) => {
        return e.name === "artifact_action_clicked";
      })
      .map((e) => {
        return e.properties;
      });
  };
}
test("artifact-action-telemetry-001 catalog archive downloads report their distinct surfaces and copying only copies", async () => {
  const events = captureDownloads(),
    browser = context.mocks.browser.blobDownload(),
    clipboard = context.mocks.browser.clipboardWriteText();
  const zip = attachment("confidential-release-bundle.zip", "application/zip");
  const item = artifactSummary(crypto.randomUUID(), "file", zip.filename);
  const detail = fileArtifactDetail(item, {
    fileId: zip.id,
    filename: zip.filename,
    url: zip.path,
    contentType: zip.contentType,
  });
  const ownerUrl = "https://app.okou.ai/artifacts/otherown01.zip";
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [item], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    return params.artifactId === item.id
      ? respond(200, detail)
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown archive" },
        });
  });
  serveReference(context, zip);
  context.mocks.api(artifactSharesContract.status, ({ body, respond }) => {
    return body.id === zip.id
      ? respond(200, {
          ownerUrl,
          shareId: null,
          audience: "private",
          organization: { id: "org_default", name: "Field team" },
          selectedTarget: null,
          selectedVersion: null,
          candidateVersion: null,
          url: null,
          shortUrl: null,
        })
      : respond(404, { error: { code: "NOT_FOUND", message: "Unknown file" } });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });
  click((await screen.findByText(item.title)).closest("button")!);
  const dialog = await screen.findByTestId("attachment-lightbox");
  const download = await findAction("button", "Download", dialog);
  expect(events()).toStrictEqual([]);
  click(download);
  const first = {
      action: "download",
      surface: "file_preview",
      artifact_type: "archive",
    },
    second = { ...first, surface: "dialog" };
  const saved = { filename: zip.filename, url: zip.url, blob: null };
  await waitFor(() => {
    return expect(browser.downloads).toStrictEqual([saved]);
  });
  expect(events()).toStrictEqual([first]);
  click(await findAction("button", "Download options", dialog));
  const menu = await findNamedMenuItem("Download");
  expect(events()).toStrictEqual([first]);
  click(menu);
  await waitFor(() => {
    return expect(browser.downloads).toStrictEqual([saved, saved]);
  });
  expect(events()).toStrictEqual([first, second]);
  click(await findAction("button", "Share", dialog));
  click(await findAction("button", "Copy link"));
  await waitFor(() => {
    return expect(clipboard.writes).toContain(ownerUrl);
  });
  expect(events()).toStrictEqual([first, second]);
});
test("artifact-action-telemetry-002 opening Word is silent and saving the binary reports the attachment chip", async () => {
  const events = captureDownloads(),
    browser = context.mocks.browser.blobDownload();
  const bin = attachment(
      "confidential-forecast.bin",
      "application/octet-stream",
    ),
    word = attachment(
      "review.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const f = [bin, word].find((x) => {
      return x.id === query.file_id;
    });
    if (!f) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unknown file" },
      });
    }
    return respond(200, {
      url: f.url,
      downloadUrl: new URL("?download=1", f.url).href,
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  await conversation(context, {
    chatEvents: [userRow(fileParts([bin, word]))],
  });
  click(await findAction("button", "Preview " + word.filename));
  const panel = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    return expect(
      new URL(panel.querySelector("iframe")!.src).searchParams.get("src"),
    ).toBe(word.url);
  });
  expect(events()).toStrictEqual([]);
  expect(browser.downloads).toStrictEqual([]);
  click(await findAction("button", "Close", panel));
  await waitFor(() => {
    return expect(panel).not.toBeInTheDocument();
  });
  click(await findAction("button", "Download " + bin.filename));
  await waitFor(() => {
    return expect(browser.downloads).toStrictEqual([
      {
        url: new URL("?download=1", bin.url).href,
        filename: bin.filename,
        blob: null,
      },
    ]);
  });
  expect(events()).toStrictEqual([
    { action: "download", artifact_type: "other", surface: "attachment_chip" },
  ]);
});
test("artifact-action-telemetry-004 the fullscreen public movie obtains fresh download access and reports only the save", async () => {
  const events = captureDownloads(),
    browser = context.mocks.browser.blobDownload();
  const film = sharedFile("telemetry1.mp4", "video/mp4", "#t=12");
  const { grants } = await publicConversation(
    context,
    [film],
    [promptFiles([film])],
  );
  click(await findAction("button", "Preview " + film.name));
  const panel = await screen.findByTestId("public-artifact-lightbox");
  await waitFor(() => {
    return expect(panel.querySelector("video")).toHaveAttribute(
      "src",
      film.url + film.fragment,
    );
  });
  expect(events()).toStrictEqual([]);
  click(await findAction("button", "Enter fullscreen", panel));
  await expect(
    findAction("button", "Exit fullscreen", panel),
  ).resolves.toBeVisible();
  expect(events()).toStrictEqual([]);
  const fresh = film.url + "?save=renewed";
  grants.set(film.name, { ...film, download: fresh });
  click(await findAction("button", "Download", panel));
  await waitFor(() => {
    return expect(browser.downloads).toStrictEqual([
      { url: fresh, filename: film.name, blob: null },
    ]);
  });
  expect(events()).toStrictEqual([
    { action: "download", artifact_type: "video", surface: "shared_preview" },
  ]);
});
