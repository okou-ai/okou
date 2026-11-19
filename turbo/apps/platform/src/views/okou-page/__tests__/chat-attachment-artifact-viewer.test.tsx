import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import {
  artifactReferencePath,
  artifactReferencesContract,
  artifactShareReferencePath,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  chatThreadArtifactsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { HostedSiteFilesResponse } from "@okouai/api-contracts/contracts/host";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { strFromU8, unzipSync } from "fflate";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  SECOND_ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
  getNamedButton,
  getNamedLink,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  mockSplitAttachmentChats,
  privateAttachmentUrl,
  publicArtifactUrl,
  queryNamedButton,
  queryNamedLink,
  type AttachmentChatEvent,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const CREATED_AT = "2026-03-10T00:00:01Z";
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
// Hosted-site headers show the publication time in the product's short
// date format; Testing Library compares text with whitespace collapsed.
const UPDATED_AT = `Updated at ${new Date(CREATED_AT).toLocaleString("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})}`.replace(/\s+/gu, " ");
const THUMBNAIL_PREFIX =
  "https://cdn.vm7.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/";

function assistantMessage(content: string): AttachmentChatEvent {
  return {
    id: "artifact-viewer-assistant-message",
    role: "assistant",
    content,
    runId: ATTACHMENT_RUN_ID,
    runEventId: "artifact-viewer-event-1",
    sequenceNumber: 1,
    createdAt: CREATED_AT,
  };
}

function userFilesMessage(
  id: string,
  parts: UserMessageDocument["parts"],
): AttachmentChatEvent {
  return {
    id,
    role: "user",
    content: null,
    runId: ATTACHMENT_RUN_ID,
    createdAt: CREATED_AT,
    userMessage: { version: 1, parts },
  };
}

function imagePart(fileId: string, filename: string) {
  return {
    type: "file" as const,
    fileId,
    filenameSnapshot: filename,
    contentType: "image/png",
  };
}

function privateImage(fileId: string, filename: string) {
  return artifactFile(filename, {
    id: fileId,
    contentType: "image/png",
    url: privateAttachmentUrl(fileId),
  });
}

async function closePreview(): Promise<void> {
  click(getNamedButton("Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
}

function lightboxImage(): HTMLElement {
  return screen.getByTestId("attachment-lightbox-image");
}

test("A private attachment reuses its first URL across reopen and split view", async () => {
  const filename = "private-notes.txt";
  const fileId = "private-private-notes-txt";
  mockAttachmentChat(context, {
    chatEvents: [
      userFilesMessage(`user-${fileId}`, [
        {
          type: "file",
          fileId,
          filenameSnapshot: filename,
          contentType: "text/plain",
        },
      ]),
    ],
    artifacts: [
      artifactFile(filename, {
        id: fileId,
        contentType: "text/plain",
        url: privateAttachmentUrl(fileId),
      }),
    ],
  });
  let resolutions = 0;
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    expect(query.file_id).toBe(fileId);
    const signature = resolutions === 0 ? "first" : "renewed";
    resolutions += 1;
    const url = `https://private-files.example/${filename}?signature=${signature}`;
    return respond(200, {
      downloadUrl: new URL("?download=1", url).href,
      url,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
    });
  });
  context.mocks.http.get(
    `https://private-files.example/${filename}`,
    ({ request }) => {
      const signature = new URL(request.url).searchParams.get("signature");
      return HttpResponse.text(`${signature} copy of ${filename}`);
    },
  );
  const firstCopy = `first copy of ${filename}`;

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const trigger = (await screen.findByText(filename)).closest("button");
  if (!trigger) {
    throw new Error(`Expected a preview trigger for ${filename}`);
  }

  click(trigger);
  const firstPreview = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(firstPreview).findByText(firstCopy),
  ).resolves.toBeInTheDocument();
  await closePreview();

  click(trigger);
  const reopened = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(reopened).findByText(firstCopy),
  ).resolves.toBeInTheDocument();

  click(await findNamedButton("Open in split view"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByText(firstCopy),
  ).resolves.toBeInTheDocument();
});

test("An open artifact sidebar keeps one pane for a reselected site and a new audio file", async () => {
  const siteUrl = "https://reference-site.sites.vm7.io";
  const audioUrl = publicArtifactUrl("walkthrough.mp3");
  mockAttachmentChat(context, {
    chatEvents: [
      assistantMessage(
        `[Reference site](${siteUrl})\n\n[Walkthrough](${audioUrl})`,
      ),
    ],
    artifacts: [
      artifactFile("reference-site.html", {
        id: "reference-site",
        contentType: "text/html",
        url: publicArtifactUrl("reference-site.html"),
        aliasUrl: siteUrl,
        artifactKind: "hosted-site",
      }),
      artifactFile("walkthrough.mp3", {
        id: "walkthrough-audio",
        contentType: "audio/mpeg",
        url: audioUrl,
      }),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const siteLink = await findNamedLink("Reference site");
  click(siteLink);
  click(await findNamedButton("Open in split view"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(
      within(sidebar).getByTestId("artifact-sidebar-body-html"),
    ).toBeVisible();
  });

  click(siteLink);
  expect(screen.getAllByTestId("artifact-sidebar")).toStrictEqual([sidebar]);
  expect(
    within(sidebar).getByTestId("artifact-sidebar-body-html"),
  ).toBeVisible();
  expect(screen.queryByTestId("attachment-lightbox")).toBeNull();

  click(getNamedLink("Walkthrough"));
  await waitFor(() => {
    expect(
      within(sidebar).getByTestId("artifact-sidebar-body-audio"),
    ).toHaveAttribute("src", audioUrl);
  });
  expect(screen.getAllByTestId("artifact-sidebar")).toStrictEqual([sidebar]);
  expect(
    within(sidebar).queryByTestId("artifact-sidebar-body-html"),
  ).toBeNull();
  expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
});

test("A public hosted site header links its title to the site address", async () => {
  const siteUrl = "https://reference-site.sites.vm7.io";
  mockAttachmentChat(context, {
    chatEvents: [assistantMessage(`[Reference site](${siteUrl})`)],
    artifacts: [
      artifactFile("reference-site.html", {
        title: "Reference site title",
        id: "reference-site",
        contentType: "text/html",
        url: publicArtifactUrl("reference-site.html"),
        aliasUrl: siteUrl,
        artifactKind: "hosted-site",
      }),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const expectSiteHeader = (surface: HTMLElement) => {
    const link = getNamedLink("Reference site title", surface);
    expect(link).toHaveAttribute("href", `${siteUrl}/`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(surface).getByText(UPDATED_AT)).toBeInTheDocument();
    expect(within(surface).queryByText("reference-site.html")).toBeNull();
    expect(within(surface).queryByText(/Hosted site/)).toBeNull();
    expect(within(surface).queryByText(/1 kB/)).toBeNull();
  };

  click(await findNamedLink("Reference site"));
  expectSiteHeader(await screen.findByTestId("attachment-lightbox"));

  click(await findNamedButton("Open in split view"));
  expectSiteHeader(await screen.findByTestId("artifact-sidebar"));
});

test("A private hosted site header shows its filename as plain text", async () => {
  const siteUrl = publicArtifactUrl("private-site.html");
  mockAttachmentChat(context, {
    chatEvents: [assistantMessage(`[Private site](${siteUrl})`)],
    artifacts: [
      artifactFile("private-site.html", {
        id: "private-site",
        contentType: "text/html",
        url: siteUrl,
        artifactKind: "hosted-site",
      }),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  click(await findNamedLink("Private site"));
  const dialog = await screen.findByTestId("attachment-lightbox");
  const filename = within(dialog).getByText("private-site.html");
  expect(
    within(dialog).getByText(`Hosted site · ${UPDATED_AT}`),
  ).toBeInTheDocument();
  expect(filename.closest("a")).toBeNull();
});

test("Image navigation stays inside each split-view chat", async () => {
  const leftFirst = "left-navigation-first";
  const leftSecond = "left-navigation-second";
  const rightFirst = "right-navigation-first";
  const rightSecond = "right-navigation-second";
  const privateUrl = (name: string) => {
    return `https://private-files.example/${name}?signature=first`;
  };
  mockSplitAttachmentChats(
    context,
    {
      threadId: ATTACHMENT_THREAD_ID,
      title: "Left gallery",
      events: [
        userFilesMessage("left-gallery-message", [
          imagePart(leftFirst, "shared.png"),
          imagePart(leftSecond, "left-second.png"),
          { type: "text", text: "Left gallery images" },
        ]),
      ],
      artifacts: [
        privateImage(leftFirst, "shared.png"),
        privateImage(leftSecond, "left-second.png"),
      ],
    },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Right gallery",
      events: [
        userFilesMessage("right-gallery-message", [
          imagePart(rightFirst, "shared.png"),
          imagePart(rightSecond, "right-second.png"),
          { type: "text", text: "Right gallery images" },
        ]),
      ],
      artifacts: [
        privateImage(rightFirst, "shared.png"),
        privateImage(rightSecond, "right-second.png"),
      ],
    },
  );
  mockPrivateUrlSequence(context, {
    [leftFirst]: [privateUrl("left-shared.png")],
    [leftSecond]: [privateUrl("left-second.png")],
    [rightFirst]: [privateUrl("right-shared.png")],
    [rightSecond]: [privateUrl("right-second.png")],
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}?sidebar=${SECOND_ATTACHMENT_THREAD_ID}`,
  });
  const chatPane = (threadId: string) => {
    return waitFor(() => {
      const pane = document.querySelector<HTMLElement>(
        `[data-chat-thread-container-id="${threadId}"]`,
      );
      if (!pane) {
        throw new Error(`Chat pane ${threadId} is not ready`);
      }
      return pane;
    });
  };
  const leftPane = await chatPane(ATTACHMENT_THREAD_ID);
  const rightPane = await chatPane(SECOND_ATTACHMENT_THREAD_ID);

  click(await findNamedLink("Preview shared.png", rightPane));
  click(await findNamedButton("Next image artifact"));
  await waitFor(() => {
    expect(lightboxImage()).toHaveAttribute("alt", "right-second.png");
  });
  expect(lightboxImage()).toHaveAttribute(
    "src",
    privateUrl("right-second.png"),
  );
  await closePreview();

  click(await findNamedLink("Preview shared.png", leftPane));
  click(await findNamedButton("Next image artifact"));
  await waitFor(() => {
    expect(lightboxImage()).toHaveAttribute("alt", "left-second.png");
  });
  expect(lightboxImage()).toHaveAttribute("src", privateUrl("left-second.png"));

  click(await findNamedButton("Open in split view"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByTestId("artifact-sidebar-body-image"),
  ).resolves.toHaveAttribute("src", privateUrl("left-second.png"));
  click(await findNamedButton("Previous image artifact", sidebar));
  await waitFor(() => {
    expect(
      within(sidebar).getByTestId("artifact-sidebar-body-image"),
    ).toHaveAttribute("src", privateUrl("left-shared.png"));
  });
});

test("User attachment previews offer downloads without sharing while an agent image shares its URL", async () => {
  const firstAttachment = "share-gate-attachment-first";
  const secondAttachment = "share-gate-attachment-second";
  const agentImageUrl = publicArtifactUrl("agent-chart.png");
  mockAttachmentChat(context, {
    chatEvents: [
      userFilesMessage("share-gate-user-message", [
        imagePart(firstAttachment, "brief.png"),
        imagePart(secondAttachment, "sketch.png"),
        { type: "text", text: "Reference images" },
      ]),
      assistantMessage(`![agent-chart.png](${agentImageUrl})`),
    ],
    artifacts: [
      privateImage(firstAttachment, "brief.png"),
      privateImage(secondAttachment, "sketch.png"),
      artifactFile("agent-chart.png", {
        id: "share-gate-agent-image",
        contentType: "image/png",
        url: agentImageUrl,
      }),
    ],
  });
  mockPrivateUrlSequence(context, {
    [firstAttachment]: ["https://private-files.example/brief.png"],
    [secondAttachment]: ["https://private-files.example/sketch.png"],
  });
  const clipboard = context.mocks.browser.clipboardWriteText();

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  // The resolved private address proves the preview's sharing decision has
  // settled, so an absent Share control is not a pending state.
  const expectPrivatePreview = async (filename: string) => {
    const dialog = await screen.findByRole("dialog", {
      name: `${filename} preview`,
    });
    await waitFor(() => {
      expect(lightboxImage()).toHaveAttribute(
        "src",
        `https://private-files.example/${filename}`,
      );
    });
    expect(getNamedButton("Download options", dialog)).toBeVisible();
    expect(queryNamedLink("Share", dialog)).toBeNull();
    expect(queryNamedButton("Share", dialog)).toBeNull();
    return dialog;
  };

  click(await findNamedLink("Preview brief.png"));
  await expectPrivatePreview("brief.png");
  await closePreview();
  click(await findNamedLink("Preview sketch.png"));
  await expectPrivatePreview("sketch.png");
  await closePreview();

  const agentPreview = (
    await screen.findByAltText("agent-chart.png")
  ).closest<HTMLElement>("a, button");
  if (!agentPreview) {
    throw new Error("Expected the agent image to open a preview");
  }
  click(agentPreview);
  const agentDialog = await screen.findByRole("dialog", {
    name: "agent-chart.png preview",
  });
  click(await findNamedButton("Share", agentDialog));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([agentImageUrl]);
  });
});

test("A private site card uses its resolved screenshot without the thread artifact list", async () => {
  const deploymentId = "00000000-0000-4000-8000-000000000019";
  const screenshotId = "00000000-0000-4000-8000-000000000020";
  const site = artifactReferencePath(deploymentId, "index.html");
  const screenshot = artifactReferencePath(screenshotId, "preview.webp");
  const screenshotUrl = `${R2_ORIGIN}/private/screenshot%20%2B.bin?X-Amz-Signature=owner&X-Amz-Security-Token=token%2B%2F%3D`;
  const previewUrl = `https://pv-${"a".repeat(48)}.sites.vm7.io/`;
  mockAttachmentChat(context, {
    chatEvents: [assistantMessage(`![Private report](${site})`)],
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Artifact list unavailable",
      },
    });
  });
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      const isScreenshot =
        params.reference === screenshot.slice("/artifacts/".length);
      const url = isScreenshot ? screenshotUrl : previewUrl;
      return respond(200, {
        downloadUrl: new URL("?download=1", url).href,
        url,
        filename: isScreenshot ? "preview.webp" : "index.html",
        contentType: isScreenshot ? "image/webp" : "text/html",
        target: isScreenshot
          ? { kind: "file", id: screenshotId }
          : { kind: "html", id: deploymentId },
        ...(isScreenshot ? {} : { previewImageUrl: screenshot }),
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    },
  );

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const card = await screen.findByTestId("attachment-preview-html");
  const thumbnail = await within(card).findByTestId(
    "attachment-preview-thumbnail",
  );
  expect(thumbnail).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${screenshotUrl}`,
  );

  fireEvent.load(thumbnail);
  expect(thumbnail).toBeVisible();
  expect(
    within(card).queryByTestId("attachment-preview-html-viewport"),
  ).toBeNull();

  click(card);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    const frame = within(dialog).getByTestId("artifact-dialog-site-frame");
    expect(
      frame instanceof HTMLIFrameElement
        ? frame
        : frame.querySelector("iframe"),
    ).toHaveAttribute("src", previewUrl);
  });
});

test.each([
  { filename: "restricted.png", status: 404, code: "NOT_FOUND" },
  { filename: "restricted.pdf", status: 403, code: "FORBIDDEN" },
  { filename: "restricted.txt", status: 401, code: "UNAUTHORIZED" },
] as const)(
  "An inaccessible $filename ($status) shows an access card in the lightbox",
  async ({ filename, status, code }) => {
    const reference = artifactShareReferencePath("restricted", filename);
    mockAttachmentChat(context, {
      chatEvents: [
        assistantMessage(
          `[Restricted artifact](${new URL(reference, "http://localhost").href})`,
        ),
      ],
    });
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(status, {
        error: { code, message: "Artifact unavailable" },
      });
    });

    await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
    click(await findNamedLink("Restricted artifact"));

    const dialog = await screen.findByTestId("attachment-lightbox");
    await expect(
      within(dialog).findByRole("heading", {
        name: "You can’t view this artifact",
      }),
    ).resolves.toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /It may not exist, or it may be shared with a different account or organization\./u,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /Ask the person who shared this link to check access\./u,
      ),
    ).toBeInTheDocument();
    expect(getNamedButton("Switch account", dialog)).toBeEnabled();
  },
);

const PUBLICATION_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000021";
const PUBLICATION_SITE_ID = "00000000-0000-4000-8000-000000000022";
const PUBLICATION_HOST = "https://launch-site.sites.vm7.io/";
const PUBLICATION_PAGE = "<!doctype html><h1>Launch</h1>";
const PUBLICATION_STYLE = "h1 { color: teal }";

function hostedFile(
  path: string,
  content: string,
  contentType: string,
): HostedSiteFilesResponse["files"][number] {
  return {
    path,
    size: content.length,
    sha256: "a".repeat(64),
    contentType,
    downloadUrl: `https://storage.example.test/signed${path}`,
  };
}

const PAGE_FILE = hostedFile(
  "/index.html",
  PUBLICATION_PAGE,
  "text/html; charset=utf-8",
);
const STYLE_FILE = hostedFile(
  "/assets/site.css",
  PUBLICATION_STYLE,
  "text/css",
);

/**
 * Publish one hosted artifact and serve its publication from the delivery host
 * the viewer reads, so a download exercises the real member requests.
 */
function mockHostedPublication(
  listing:
    | { readonly files: readonly HostedSiteFilesResponse["files"][number][] }
    | "unavailable",
): void {
  const canonicalUrl = artifactReferencePath(
    PUBLICATION_DEPLOYMENT_ID,
    "index.html",
  );
  mockAttachmentChat(context, {
    chatEvents: [assistantMessage(`[Launch site](${canonicalUrl})`)],
    artifacts: [
      artifactFile("launch-site.html", {
        id: "hosted-publication",
        contentType: "text/html",
        url: canonicalUrl,
        artifactKind: "hosted-site",
      }),
    ],
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      downloadUrl: new URL("?download=1", PUBLICATION_HOST).href,
      url: PUBLICATION_HOST,
      filename: "index.html",
      contentType: "text/html",
      target: { kind: "html", id: PUBLICATION_DEPLOYMENT_ID },
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  context.mocks.api(artifactDownloadsContract.files, ({ params, respond }) => {
    expect(params.reference).toBe(canonicalUrl.slice("/artifacts/".length));
    if (listing === "unavailable") {
      return respond(500, {
        error: { code: "INTERNAL", message: "Listing unavailable" },
      });
    }
    return respond(200, {
      siteId: PUBLICATION_SITE_ID,
      deploymentId: PUBLICATION_DEPLOYMENT_ID,
      publicSlug: "launch-site",
      url: PUBLICATION_HOST,
      fileCount: listing.files.length,
      size: listing.files.reduce((total, file) => {
        return total + file.size;
      }, 0),
      files: [...listing.files],
    });
  });
  const bodies: Record<string, string> = {
    "/index.html": PUBLICATION_PAGE,
    "/assets/site.css": PUBLICATION_STYLE,
  };
  for (const [path, body] of Object.entries(bodies)) {
    context.mocks.http.get(`${PUBLICATION_HOST.slice(0, -1)}${path}`, () => {
      return HttpResponse.text(body);
    });
  }
}

async function downloadPublication(): Promise<void> {
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink("Launch site"));
  const dialog = await screen.findByRole("dialog");
  click(await findNamedButton("Download options", dialog));
  click(await findNamedMenuItem("Download"));
}

test("A multi-file hosted publication downloads as a zip of every member", async () => {
  mockHostedPublication({ files: [PAGE_FILE, STYLE_FILE] });
  const browser = context.mocks.browser.blobDownload();

  await downloadPublication();

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  const [download] = browser.downloads;
  expect(download?.filename).toBe("launch-site.zip");
  const archive = await download?.blob?.arrayBuffer();
  if (!archive) {
    throw new Error("Expected the publication archive");
  }
  const unpacked = unzipSync(new Uint8Array(archive));
  expect(Object.keys(unpacked).sort()).toStrictEqual([
    "assets/site.css",
    "index.html",
  ]);
  expect(strFromU8(unpacked["index.html"] ?? new Uint8Array())).toBe(
    PUBLICATION_PAGE,
  );
  expect(strFromU8(unpacked["assets/site.css"] ?? new Uint8Array())).toBe(
    PUBLICATION_STYLE,
  );
});

test("A publication whose files cannot be listed reports a failed download", async () => {
  mockHostedPublication("unavailable");
  const browser = context.mocks.browser.blobDownload();

  await downloadPublication();

  await expect(
    screen.findByText("Download failed"),
  ).resolves.toBeInTheDocument();
  expect(browser.downloads).toStrictEqual([]);
});

test("A self-contained hosted page downloads as the page itself", async () => {
  mockHostedPublication({ files: [PAGE_FILE] });
  const browser = context.mocks.browser.blobDownload();

  await downloadPublication();

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]).toMatchObject({
    filename: "launch-site.html",
    url: new URL("?download=1", PUBLICATION_HOST).href,
    blob: null,
  });
});
