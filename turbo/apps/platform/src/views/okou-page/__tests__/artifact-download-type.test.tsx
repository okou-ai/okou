// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  assistantRow,
  attachment,
  serveReference,
  serveUploaded,
  conversation,
  fileParts,
  userRow,
} from "./attachment-preview-boundaries.ts";
import {
  artifactFile,
  draftAttachment,
  draftForAttachment,
  privateAttachmentUrl,
  findNamedMenuItem,
} from "./chat-attachment-test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  artifactSummary,
  hostedSiteArtifactDetail,
  mockArtifactConversation,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  entryHtml,
  publication,
  servePublication,
} from "./hosted-download-boundaries.ts";
const context = testContext();
test.each([
  ["artifact-download-type-006", "video", "video/mp4", "dialog"],
  ["artifact-download-type-007", "audio", "audio/mpeg", "page"],
] as const)(
  "%s reports the MIME type of the extensionless recording from its own preview",
  async (_id, kind, mime, surface) => {
    const file = attachment("recording", mime),
      sink = context.mocks.posthog(),
      browser = context.mocks.browser.blobDownload();
    serveUploaded(context, [file]);
    const sidebar = surface === "page";
    const draft = draftForAttachment(
      draftAttachment(file.filename, {
        id: file.id,
        contentType: mime,
        url: privateAttachmentUrl(file.id),
      }),
    );
    await conversation(
      context,
      sidebar ? { chatEvents: [userRow(fileParts([file]))] } : { draft },
      sidebar,
    );
    click(
      await findAction("button", "Open " + kind + " preview for recording"),
    );
    const panel = await screen.findByTestId(
      sidebar ? "artifact-sidebar" : "attachment-lightbox",
    );
    await waitFor(() => {
      return expect(panel.querySelector(kind)).toHaveAttribute("src", file.url);
    });
    click(
      await findAction(
        "button",
        sidebar ? "Download artifact" : "Download options",
        panel,
      ),
    );
    click(await findNamedMenuItem("Download"));
    await waitFor(() => {
      return expect(browser.downloads).toStrictEqual([
        { url: file.url, filename: file.filename, blob: null },
      ]);
    });
    expect(
      sink.events
        .filter((e) => {
          return e.name === "artifact_action_clicked";
        })
        .map((e) => {
          return e.properties;
        }),
    ).toStrictEqual([{ action: "download", surface, artifact_type: kind }]);
  },
);

test("artifact-download-type-001 the catalog site downloads as HTML even when its title ends in png", async () => {
  const summary = artifactSummary(
    crypto.randomUUID(),
    "hosted-site",
    "Confidential board review.png",
  );
  const detail = hostedSiteArtifactDetail(summary, {
    siteId: crypto.randomUUID(),
    slug: "launch-site",
    url: publication,
  });
  const sink = context.mocks.posthog(),
    browser = context.mocks.browser.blobDownload();
  mockArtifactConversation(context, {
    catalog: [summary],
    details: new Map([[summary.id, detail]]),
  });
  servePublication(context, "single");
  await setupPage({
    context,
    path: "/artifacts",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });
  click(await screen.findByText(summary.title));
  const panel = await screen.findByTestId("attachment-lightbox");
  click(await findAction("button", "Download options", panel));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    return expect(browser.downloads[0]?.filename).toBe(
      "Confidential board review.html",
    );
  });
  await expect(browser.downloads[0]!.blob!.text()).resolves.toBe(entryHtml);
  expect(sink.events).toContainEqual(
    expect.objectContaining({
      name: "artifact_action_clicked",
      properties: {
        action: "download",
        surface: "dialog",
        artifact_type: "website",
      },
    }),
  );
});
test("artifact-download-type-005 both file actions classify the resolved workbook by its MIME type", async () => {
  const file = attachment(
    "forecast.bin",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  const sink = context.mocks.posthog(),
    browser = context.mocks.browser.blobDownload();
  serveReference(context, file);
  await conversation(context, {
    chatEvents: [assistantRow("[forecast.bin](" + file.path + ")")],
    artifacts: [
      artifactFile(file.filename, {
        url: file.path,
        id: file.id,
        contentType: file.contentType,
      }),
    ],
  });
  click(await findAction("link", "forecast.bin"));
  const panel = await screen.findByTestId("attachment-lightbox");
  click(await findAction("button", "Download", panel));
  const nativeFile = expect.objectContaining({ url: file.url, blob: null });
  await waitFor(() => {
    return expect(browser.downloads[0]).toStrictEqual(nativeFile);
  });
  expect(sink.events).toContainEqual(
    expect.objectContaining({
      name: "artifact_action_clicked",
      properties: {
        action: "download",
        surface: "file_preview",
        artifact_type: "spreadsheet",
      },
    }),
  );
  click(await findAction("button", "Download options", panel));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    return expect(browser.downloads[1]).toStrictEqual(nativeFile);
  });
  expect(sink.events).toContainEqual(
    expect.objectContaining({
      name: "artifact_action_clicked",
      properties: {
        action: "download",
        surface: "dialog",
        artifact_type: "spreadsheet",
      },
    }),
  );
});
