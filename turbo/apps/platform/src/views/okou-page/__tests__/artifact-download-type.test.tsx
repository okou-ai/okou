// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  attachment,
  serveUploaded,
  conversation,
  fileParts,
  userRow,
} from "./attachment-preview-boundaries.ts";
import {
  draftAttachment,
  draftForAttachment,
  privateAttachmentUrl,
  findNamedMenuItem,
} from "./chat-attachment-test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
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
