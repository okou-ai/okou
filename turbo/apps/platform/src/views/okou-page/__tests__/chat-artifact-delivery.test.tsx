// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactFile,
  findNamedButton,
  findNamedMenuItem,
  getNamedButton,
  draftAttachment,
  draftForAttachment,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";
import {
  chatPath,
  openMessageFile,
} from "./chat-artifact-preview-test-helpers.ts";
import {
  assistantRow,
  attachment,
  serveReference,
  serveUploaded,
  conversation,
  fileParts,
  userRow,
} from "./attachment-preview-boundaries.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
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

async function chooseDownload(preview: HTMLElement) {
  click(await findNamedButton("Download artifact", preview));
  click(await findNamedMenuItem("Download"));
}

test.each([
  {
    id: "001",
    filename: "report.png",
    contentType: "image/png",
    bytes: [137, 80, 78, 71, 13, 10, 26, 10],
  },
  {
    id: "002",
    filename: "report.pdf",
    contentType: "application/pdf",
    bytes: [37, 80, 68, 70, 45, 49, 46, 55],
  },
])(
  "chat-artifact-download-$id retains the downloaded $filename bytes until leaving the chat",
  async ({ filename, contentType, bytes }) => {
    context.mocks.browser.requestCacheMode();
    const file = artifactFile(filename, { contentType });
    context.mocks.http.get(file.url, ({ request }) => {
      return request.cache === "reload"
        ? HttpResponse.arrayBuffer(Uint8Array.from(bytes).buffer, {
            headers: { "Content-Type": contentType },
          })
        : new HttpResponse(null, { status: 412 });
    });
    const browser = context.mocks.browser.blobDownload({ deferRead: true });
    const viewer = await openMessageFile(context, file);
    await chooseDownload(viewer);
    await waitFor(() => {
      return expect(browser.downloads[0]?.filename).toBe(filename);
    });
    const saved = browser.downloads[0]!;
    expect(saved.blob?.type).toBe(contentType);
    expect(
      Array.from(new Uint8Array(await saved.blob!.arrayBuffer())),
    ).toStrictEqual(bytes);
    expect(location.pathname).toBe(chatPath);
    click(getNamedButton("Close artifact", viewer));
    await waitFor(() => {
      return expect(
        screen.queryByRole("dialog", { name: filename + " preview" }),
      ).not.toBeInTheDocument();
    });
    expect(browser.blobForUrl(saved.url)).toBe(saved.blob);
    click(screen.getByText("New chat", { selector: "a span" }));
    await waitFor(() => {
      return expect(browser.revokedUrls).toContain(saved.url);
    });
    expect(location.pathname).toBe("/");
    expect(browser.blobForUrl(saved.url)).toBeNull();
  },
);

test.each([
  { id: "003", filename: "photo.png", type: "image", contentType: "image/png" },
  {
    id: "004",
    filename: "report.pdf",
    type: "pdf",
    contentType: "application/pdf",
  },
  {
    id: "008",
    filename: "proposal.DOCX",
    type: "document",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
])(
  "chat-artifact-download-$id delivers each $filename grant from the open preview",
  async ({ filename, type, contentType }) => {
    const previewUrl = "https://media.example.test/review/" + filename;
    let grant = previewUrl + "?mode=preview";
    context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
      return respond(200, {
        url: previewUrl,
        downloadUrl: grant,
        expiresAt: "2099-01-01T00:00:00Z",
        publicUrl: null,
      });
    });
    const browser = context.mocks.browser.blobDownload();
    const analytics = context.mocks.posthog();
    const navigation = context.mocks.browser.locationAssign();
    const viewer = await openMessageFile(
      context,
      artifactFile(filename, {
        url: "https://api.okou.ai/api/web/file-url?file_id=" + filename,
        contentType,
      }),
      { host: "app.okou.ai" },
    );
    for (const token of ["first", "renewed"]) {
      grant = previewUrl + "?ticket=" + token;
      const start = analytics.events.length;
      await chooseDownload(viewer);
      await waitFor(() => {
        return expect(browser.downloads).toContainEqual({
          url: grant,
          filename,
          blob: null,
        });
      });
      expect(analytics.events.slice(start)).toContainEqual(
        expect.objectContaining({
          name: "artifact_action_clicked",
          properties: {
            action: "download",
            surface: "page",
            artifact_type: type,
          },
        }),
      );
      expect(location.pathname).toBe(chatPath);
      expect(navigation.calls).toStrictEqual([]);
    }
  },
);

test("chat-artifact-download-011 keeps the PDF available when download requires a plan", async () => {
  const url = "https://media.example.test/review/report.pdf";
  const file = artifactFile("report.pdf", {
    url: "https://app.okou.ai/artifacts/cafe002611.pdf",
    contentType: "application/pdf",
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url,
      downloadUrl: url + "?save",
      filename: file.filename,
      contentType: file.contentType,
      downloadAllowed: false,
      expiresAt: "2099-01-01T00:00:00Z",
      target: { kind: "file", id: "10000000-0000-4000-8000-000000000026" },
    });
  });
  const browser = context.mocks.browser.blobDownload();
  const viewer = await openMessageFile(context, file, { host: "app.okou.ai" });
  const frame = await within(viewer).findByTitle(/\.pdf preview$/u);
  await chooseDownload(viewer);
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
  expect(frame).toBeInTheDocument();
  expect(frame).toHaveAttribute("src", url + "#navpanes=0");
  expect(browser.downloads).toStrictEqual([]);
});

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
  });
  click(await screen.findByText(summary.title));
  const panel = await screen.findByTestId("artifact-sidebar");
  click(await findAction("button", "Download artifact", panel));
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
        surface: "page",
        artifact_type: "website",
      },
    }),
  );
});
test("artifact-download-type-005 the preview download classifies the resolved workbook by its MIME type", async () => {
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
  const panel = await screen.findByTestId("artifact-sidebar");
  const nativeFile = expect.objectContaining({ url: file.url, blob: null });
  click(await findAction("button", "Download artifact", panel));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    return expect(browser.downloads[0]).toStrictEqual(nativeFile);
  });
  expect(sink.events).toContainEqual(
    expect.objectContaining({
      name: "artifact_action_clicked",
      properties: {
        action: "download",
        surface: "page",
        artifact_type: "spreadsheet",
      },
    }),
  );
});
