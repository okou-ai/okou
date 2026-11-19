import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  getLinkByName,
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
warmMermaidParser();
const FILE_ID = "f0000000-0000-4000-a000-000000000942";
const SITE = "https://app.okou.ai/artifacts/lightsite1.html#slide-2";
const VIDEO = "https://app.okou.ai/artifacts/lightvid01.mp4#t=2";
const IMAGE = "https://app.okou.ai/artifacts/lightimg01.png";
const DOCUMENT = "https://app.okou.ai/artifacts/lightdoc01.pdf";
const NOTE = "https://app.okou.ai/artifacts/lightnote1.md";
const SITE_COVER = "https://app.okou.ai/artifacts/siteshot01.webp";
const VIDEO_COVER = "https://app.okou.ai/artifacts/vidcover01.jpg";
const R2_ORIGIN = `https://${"b".repeat(32)}.r2.cloudflarestorage.com`;
const SITE_URL = `https://ps-${"b".repeat(48)}.okou.app/`;
const SITE_DOWNLOAD_URL = `${R2_ORIGIN}/snapshots/site.html?X-Amz-Signature=download&response-content-disposition=attachment`;
const VIDEO_URL = `${R2_ORIGIN}/snapshots/launch.mp4?X-Amz-Signature=preview`;
const SITE_COVER_URL = `${R2_ORIGIN}/snapshots/site.webp?X-Amz-Signature=cover`;
const VIDEO_COVER_URL = `${R2_ORIGIN}/snapshots/video.jpg?X-Amz-Signature=cover`;
const THUMBNAIL_PREFIX =
  "https://a.okou.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/";

interface SnapshotResource {
  url: string;
  filename: string;
  contentType: string;
  kind: "file" | "html";
  previewImageUrl?: string;
  downloadUrl: string;
  status?: 404;
}

function mockSnapshotResources() {
  const site: SnapshotResource = {
    url: SITE_URL,
    downloadUrl: SITE_DOWNLOAD_URL,
    filename: "lightsite1.html",
    contentType: "text/html",
    kind: "html",
    previewImageUrl: SITE_COVER,
  };
  const resources: Readonly<Record<string, SnapshotResource>> = {
    "lightsite1.html": site,
    "lightvid01.mp4": {
      url: VIDEO_URL,
      downloadUrl: `${R2_ORIGIN}/snapshots/launch.mp4?X-Amz-Signature=download`,
      filename: "lightvid01.mp4",
      contentType: "video/mp4",
      kind: "file",
      previewImageUrl: VIDEO_COVER,
    },
    "siteshot01.webp": {
      url: SITE_COVER_URL,
      downloadUrl: `${R2_ORIGIN}/snapshots/site.webp?X-Amz-Signature=download`,
      filename: "site.webp",
      contentType: "image/webp",
      kind: "file",
    },
    "vidcover01.jpg": {
      url: VIDEO_COVER_URL,
      downloadUrl: `${R2_ORIGIN}/snapshots/video.jpg?X-Amz-Signature=download`,
      filename: "video.jpg",
      contentType: "image/jpeg",
      kind: "file",
    },
  };
  const resolvedWithAuthorization: boolean[] = [];
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, request, respond }) => {
      resolvedWithAuthorization.push(request.headers.has("authorization"));
      const resource = resources[params.reference];
      if (!resource) {
        throw new Error(`Unexpected artifact reference: ${params.reference}`);
      }
      if (resource.status) {
        return respond(resource.status, {
          error: { code: "NOT_FOUND", message: "Artifact unavailable" },
        });
      }
      return respond(200, {
        url: resource.url,
        filename: resource.filename,
        contentType: resource.contentType,
        expiresAt: "2099-01-01T00:00:00Z",
        sharedThreadSnapshot: true,
        target: { kind: resource.kind, id: FILE_ID },
        ...(resource.previewImageUrl
          ? { previewImageUrl: resource.previewImageUrl }
          : {}),
        downloadUrl: resource.downloadUrl,
      });
    },
  );
  context.mocks.api(
    artifactReferencesContract.publicUrl,
    ({ params, respond }) => {
      const resource = resources[params.reference];
      if (!resource) {
        throw new Error(`Unexpected artifact reference: ${params.reference}`);
      }
      if (resource.status) {
        return respond(resource.status, {
          error: { code: "NOT_FOUND", message: "Artifact unavailable" },
        });
      }
      return respond(200, {
        url: resource.url,
        downloadUrl: resource.downloadUrl,
        expiresAt: "2099-01-01T00:00:00Z",
        sharedThreadSnapshot: true,
        preview: {
          filename: resource.filename,
          contentType: resource.contentType,
          previewImageUrl: resource.previewImageUrl,
        },
      });
    },
  );
  return { site, resolvedWithAuthorization };
}

function mockArtifactResource(resource: {
  reference: string;
  url: string;
  filename: string;
  contentType: string;
}) {
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      expect(params.reference).toBe(resource.reference);
      return respond(200, {
        downloadUrl: new URL("?download=1", resource.url).href,
        url: resource.url,
        filename: resource.filename,
        contentType: resource.contentType,
        expiresAt: "2099-01-01T00:00:00Z",
        sharedThreadSnapshot: true,
        target: { kind: "file", id: FILE_ID },
      });
    },
  );
}

function mockSharedMessage(content: string) {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [{ messageIndex: 0, role: "assistant", content }],
      }),
    );
  });
}

function buttonLabels(container: ParentNode) {
  return queryAllByRoleFast("button", container).map((button) => {
    return button.getAttribute("aria-label") ?? button.textContent?.trim();
  });
}

function getButtonByName(name: string, container: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

async function closeViewer(dialog: HTMLElement) {
  click(getButtonByName("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
}

test("A signed-out visitor opens a shared site cover in an independent viewer", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const browser = context.mocks.browser.blobDownload();
  const { resolvedWithAuthorization } = mockSnapshotResources();
  mockSharedMessage(`![Launch site](${SITE})`);

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const card = await screen.findByTestId("markdown-artifact-preview-html");
  const cover = await within(card).findByTestId("attachment-preview-thumbnail");
  expect(cover).toHaveAttribute("src", `${THUMBNAIL_PREFIX}${SITE_COVER_URL}`);
  fireEvent.load(cover);
  expect(card).toHaveAttribute("href", SITE);
  expect(card.querySelector("iframe")).not.toBeInTheDocument();

  click(card);

  const dialog = await screen.findByRole("dialog");
  const frame = await within(dialog).findByTestId("artifact-dialog-body-html");
  expect(frame).toHaveAttribute("src", `${SITE_URL}#slide-2`);
  expect(frame).toHaveAttribute("sandbox", "allow-same-origin allow-scripts");
  expect(buttonLabels(dialog)).toStrictEqual(
    expect.arrayContaining(["Copy link", "Download", "Enter fullscreen"]),
  );
  expect(within(dialog).queryByRole("radiogroup")).not.toBeInTheDocument();

  click(getButtonByName("Copy link", dialog));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([SITE]);
  });

  click(getButtonByName("Download", dialog));
  await waitFor(() => {
    expect(browser.downloads).toMatchObject([{ filename: "lightsite1.html" }]);
  });
  expect(frame).toHaveAttribute("src", `${SITE_URL}#slide-2`);

  click(getButtonByName("Enter fullscreen", dialog));
  await waitFor(() => {
    expect(dialog).toHaveAttribute("data-mode", "fullscreen");
  });
  click(getButtonByName("Exit fullscreen", dialog));
  await waitFor(() => {
    expect(dialog).toHaveAttribute("data-mode", "windowed");
  });

  await closeViewer(dialog);
  expect(card).toBeInTheDocument();
  expect(resolvedWithAuthorization.length).toBeGreaterThan(0);
  expect(resolvedWithAuthorization).not.toContain(true);
});

test("A signed-in viewer downloads an allowed shared video from its public download URL", async () => {
  const browser = context.mocks.browser.blobDownload();
  const previewUrl = `${R2_ORIGIN}/files/launch.mp4?X-Amz-Signature=preview`;
  const downloadUrl = `${R2_ORIGIN}/files/launch.mp4?X-Amz-Signature=download`;
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: previewUrl,
      downloadUrl,
      downloadAllowed: true,
      filename: "lightvid01.mp4",
      contentType: "video/mp4",
      expiresAt: "2099-01-01T00:00:00Z",
      target: { kind: "file", id: FILE_ID },
    });
  });
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url: previewUrl,
      downloadUrl,
      preview: { filename: "lightvid01.mp4", contentType: "video/mp4" },
    });
  });
  mockSharedMessage(`![Launch video](${VIDEO})`);

  await setupSharedThreadPage(context, {
    host: "app.okou.ai",
    auth: { user: { id: "user_shared_artifact_viewer", fullName: "Viewer" } },
  });

  click(await screen.findByTestId("markdown-artifact-preview-video"));

  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(dialog.querySelector("video")).toHaveAttribute(
      "src",
      `${previewUrl}#t=2`,
    );
  });

  click(getButtonByName("Download", dialog));
  await waitFor(() => {
    expect(browser.downloads).toMatchObject([
      { filename: "lightvid01.mp4", url: downloadUrl },
    ]);
  });
  expect(dialog.querySelector("video")).toHaveAttribute(
    "src",
    `${previewUrl}#t=2`,
  );
});

test("Shared prompt attachments keep their covers and open in the independent viewer", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockSnapshotResources();
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content: "Review these generated files",
            attachments: [
              {
                filename: "video.mp4",
                contentType: "video/mp4",
                size: 120,
                url: VIDEO,
              },
              {
                filename: "site.html",
                contentType: "text/html",
                size: 80,
                url: SITE,
              },
            ],
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const videoCard = await screen.findByTestId(
    "markdown-artifact-preview-video",
  );
  const videoCover = await within(videoCard).findByTestId(
    "chat-video-preview-thumbnail",
  );
  fireEvent.load(videoCover);
  const siteCard = screen.getByTestId("markdown-artifact-preview-html");
  const siteCover = await within(siteCard).findByTestId(
    "attachment-preview-thumbnail",
  );
  fireEvent.load(siteCover);
  expect(videoCover).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${VIDEO_COVER_URL}`,
  );
  expect(siteCover).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${SITE_COVER_URL}`,
  );

  click(videoCard);
  const videoDialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(videoDialog.querySelector("video")).toHaveAttribute(
      "src",
      `${VIDEO_URL}#t=2`,
    );
  });
  click(getButtonByName("Copy link", videoDialog));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([VIDEO]);
  });
  await closeViewer(videoDialog);

  click(siteCard);
  const siteDialog = await screen.findByRole("dialog");
  await expect(
    within(siteDialog).findByTestId("artifact-dialog-body-html"),
  ).resolves.toHaveAttribute("src", `${SITE_URL}#slide-2`);
  click(getButtonByName("Copy link", siteDialog));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([VIDEO, SITE]);
  });
});

test("Revoked download access reports a failure without leaving the shared conversation", async () => {
  const browser = context.mocks.browser.blobDownload();
  const replace = context.mocks.browser.locationReplace();
  const { site } = mockSnapshotResources();
  mockSharedMessage(`![Launch site](${SITE})`);

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  click(await screen.findByTestId("markdown-artifact-preview-html"));
  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByTestId("artifact-dialog-body-html"),
  ).resolves.toHaveAttribute("src", `${SITE_URL}#slide-2`);
  const conversationUrl = window.location.href;
  site.status = 404;

  click(getButtonByName("Download", dialog));

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Download failed",
  );
  expect(browser.downloads).toStrictEqual([]);
  expect(replace.calls).toStrictEqual([]);
  expect(window.location.href).toBe(conversationUrl);
});

test("A shared image keeps its new-tab destination and opens in the conversation", async () => {
  const chartUrl = `${R2_ORIGIN}/snapshots/chart.png?X-Amz-Signature=preview`;
  mockArtifactResource({
    reference: "lightimg01.png",
    url: chartUrl,
    filename: "chart.png",
    contentType: "image/png",
  });
  mockSharedMessage(`![Quarterly chart](${IMAGE})`);

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const thumbnail = await screen.findByAltText("Quarterly chart");
  const link = thumbnail.closest("a");
  if (!link) {
    throw new Error("Expected the shared image to keep its own destination");
  }
  expect(link).toHaveAttribute("href", IMAGE);
  expect(link).toHaveAttribute("target", "_blank");
  await waitFor(() => {
    expect(thumbnail).toHaveAttribute("src", `${THUMBNAIL_PREFIX}${chartUrl}`);
  });
  const conversationUrl = window.location.href;

  click(link);

  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", chartUrl);
  expect(within(dialog).getByText("Quarterly chart")).toBeInTheDocument();
  expect(window.location.href).toBe(conversationUrl);
});

test("A shared document opens in the conversation from its card and its link", async () => {
  const briefUrl = `${R2_ORIGIN}/snapshots/brief.pdf?X-Amz-Signature=preview`;
  mockArtifactResource({
    reference: "lightdoc01.pdf",
    url: briefUrl,
    filename: "brief.pdf",
    contentType: "application/pdf",
  });
  mockSharedMessage(
    `![Launch brief](${DOCUMENT})\n\n[Read the brief](${DOCUMENT})`,
  );

  await setupSharedThreadPage(context, { host: "app.okou.ai" });
  const card = await screen.findByTestId("markdown-artifact-preview-pdf");
  const conversationUrl = window.location.href;

  click(card);

  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(
      within(dialog).getByTestId("artifact-dialog-document-frame"),
    ).toContainHTML(`src="${briefUrl}#navpanes=0"`);
  });
  expect(within(dialog).getByText("Launch brief")).toBeInTheDocument();
  expect(window.location.href).toBe(conversationUrl);
  await closeViewer(dialog);

  click(getLinkByName("Read the brief"));

  const linkDialog = await screen.findByRole("dialog");
  expect(within(linkDialog).getByText("Read the brief")).toBeInTheDocument();
  expect(window.location.href).toBe(conversationUrl);
});

test("A prompt image attachment opens in the conversation instead of a new tab", async () => {
  const screenshotUrl =
    "https://a.okou.io/shared-threads/public/image/screenshot.png";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content: "Match this layout",
            attachments: [
              {
                filename: "screenshot.png",
                contentType: "image/png",
                size: 42,
                url: screenshotUrl,
              },
            ],
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });
  const attachment = await waitFor(() => {
    return getLinkByName("screenshot.png");
  });
  const conversationUrl = window.location.href;
  const newTab = context.mocks.browser.open();

  click(attachment);

  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", screenshotUrl);
  expect(within(dialog).getByText("screenshot.png")).toBeInTheDocument();
  expect(window.location.href).toBe(conversationUrl);
  expect(newTab.calls).toStrictEqual([]);
});

test("A shared note closes its diagram, fullscreen and viewer one Escape at a time", async () => {
  const noteUrl = `${R2_ORIGIN}/snapshots/notes.md?X-Amz-Signature=preview`;
  mockArtifactResource({
    reference: "lightnote1.md",
    url: noteUrl,
    filename: "notes.md",
    contentType: "text/markdown",
  });
  context.mocks.http.get(`${R2_ORIGIN}/snapshots/notes.md`, () => {
    return HttpResponse.text(
      "Ship on Friday, once the rollout window closes.\n\n```mermaid\nflowchart LR\n  Draft --> Ship\n```",
      { headers: { "Content-Type": "text/markdown" } },
    );
  });
  mockSharedMessage(`![Launch notes](${NOTE})`);

  await setupSharedThreadPage(context, { host: "app.okou.ai" });
  click(await screen.findByTestId("markdown-artifact-preview-markdown"));

  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByText(
      "Ship on Friday, once the rollout window closes.",
    ),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByText("Launch notes")).toBeInTheDocument();
  await expect(
    within(dialog).findByRole("img", { name: "Diagram" }),
  ).resolves.toBeInTheDocument();

  click(getButtonByName("Enter fullscreen", dialog));
  await waitFor(() => {
    expect(dialog).toHaveAttribute("data-mode", "fullscreen");
  });
  const expand = getButtonByName("Expand diagram", dialog);
  click(expand);
  const diagram = await screen.findByTestId("artifact-diagram-lightbox");
  await waitFor(() => {
    expect(diagram.contains(document.activeElement)).toBeTruthy();
  });

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByTestId("artifact-diagram-lightbox"),
    ).not.toBeInTheDocument();
  });
  expect(dialog).toHaveAttribute("data-mode", "fullscreen");
  expect(expand).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).toHaveAttribute("data-mode", "windowed");
  });

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});
