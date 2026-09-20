import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  SECOND_ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  getNamedButton,
  getNamedLink,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  mockSplitAttachmentChats,
  privateAttachmentUrl,
  publicArtifactUrl,
  type AttachmentChatEvent,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const CREATED_AT = "2026-03-10T00:00:01Z";
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const THUMBNAIL_PREFIX =
  "https://cdn.vm7.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/";

function assistantMessage(
  content: string,
  overrides: Partial<AttachmentChatEvent> = {},
): AttachmentChatEvent {
  return {
    id: "artifact-viewer-assistant-message",
    role: "assistant",
    content,
    runId: ATTACHMENT_RUN_ID,
    runEventId: "artifact-viewer-event-1",
    sequenceNumber: 1,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function userImageMessage(
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

function composerFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected composer file input");
  }
  return input;
}

async function closeFocusedPreview(): Promise<void> {
  click(getNamedButton("Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
}

function getPreviewFrame(testId: string): HTMLIFrameElement {
  const element = screen.getByTestId(testId);
  const frame =
    element instanceof HTMLIFrameElement
      ? element
      : element.querySelector("iframe");
  if (!frame) {
    throw new Error(`Expected ${testId} to contain a preview frame`);
  }
  return frame;
}

test("A composer image preview does not replace an open artifact sidebar", async () => {
  const siteUrl = "https://workspace-guide.sites.vm7.io";
  mockAttachmentChat(context, {
    chatEvents: [assistantMessage(`[Workspace guide](${siteUrl})`)],
    artifacts: [
      artifactFile("workspace-guide.html", {
        id: "workspace-guide-site",
        contentType: "text/html",
        url: publicArtifactUrl("workspace-guide.html"),
        aliasUrl: siteUrl,
        artifactKind: "hosted-site",
      }),
    ],
  });
  context.mocks.upload.success({
    id: "a0000000-0000-4000-a000-000000000086",
    filename: "sidebar-reference.png",
    contentType: "image/png",
    size: 32,
    url: publicArtifactUrl("sidebar-reference.png"),
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  click(await findNamedLink("Workspace guide"));
  click(await findNamedButton("Open in split view"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  expect(
    within(sidebar).getByTestId("artifact-sidebar-body-html"),
  ).toHaveAttribute("src", siteUrl);

  await screen.findByRole("textbox", { name: "Message" });
  fireEvent.change(composerFileInput(), {
    target: {
      files: [
        new File(["image"], "sidebar-reference.png", { type: "image/png" }),
      ],
    },
  });
  click(await findNamedButton("Open image preview for sidebar-reference.png"));

  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("alt", "sidebar-reference.png");
  expect(screen.getByTestId("artifact-sidebar")).toBeVisible();
  expect(
    within(screen.getByTestId("artifact-sidebar")).getByTestId(
      "artifact-sidebar-body-html",
    ),
  ).toHaveAttribute("src", siteUrl);
});

test("An open artifact sidebar reuses one pane", async () => {
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

  const sitePreview = await findNamedLink("Reference site");
  click(sitePreview);
  click(await findNamedButton("Open in split view"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  expect(
    within(sidebar).getByTestId("artifact-sidebar-body-html"),
  ).toBeVisible();

  click(sitePreview);
  expect(screen.getAllByTestId("artifact-sidebar")).toHaveLength(1);
  expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  expect(
    within(sidebar).getByTestId("artifact-sidebar-body-html"),
  ).toBeVisible();

  click(getNamedLink("Walkthrough"));
  await waitFor(() => {
    expect(
      within(sidebar).getByTestId("artifact-sidebar-body-audio"),
    ).toHaveAttribute("src", audioUrl);
  });
  expect(screen.getAllByTestId("artifact-sidebar")).toHaveLength(1);
  expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
});

test("Artifact thumbnails fall back to a usable live preview", async () => {
  const firstSite = "https://thumbnail-success.sites.vm7.io";
  const secondSite = "https://thumbnail-fallback.sites.vm7.io";
  mockAttachmentChat(context, {
    chatEvents: [
      assistantMessage(
        `![Thumbnail success](${firstSite})\n\n![Thumbnail fallback](${secondSite})`,
      ),
    ],
    artifacts: [
      artifactFile("thumbnail-success.html", {
        id: "thumbnail-success",
        contentType: "text/html",
        url: publicArtifactUrl("thumbnail-success.html"),
        aliasUrl: firstSite,
        artifactKind: "hosted-site",
        previewImageUrl: publicArtifactUrl("thumbnail-success.webp"),
      }),
      artifactFile("thumbnail-fallback.html", {
        id: "thumbnail-fallback",
        contentType: "text/html",
        url: publicArtifactUrl("thumbnail-fallback.html"),
        aliasUrl: secondSite,
        artifactKind: "hosted-site",
        previewImageUrl: publicArtifactUrl("thumbnail-fallback.webp"),
      }),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const previews = await screen.findAllByTestId("attachment-preview-html");
  expect(previews).toHaveLength(2);
  const successfulThumbnail = await within(previews[0]!).findByTestId(
    "attachment-preview-thumbnail",
  );
  expect(successfulThumbnail).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}artifacts/tests/chat-attachments/thumbnail-success.webp`,
  );
  fireEvent.load(successfulThumbnail);
  expect(
    within(previews[0]!).queryByTestId("attachment-preview-html-viewport"),
  ).toBeNull();

  const failedThumbnail = await within(previews[1]!).findByTestId(
    "attachment-preview-thumbnail",
  );
  fireEvent.error(failedThumbnail);
  const fallback = await within(previews[1]!).findByTestId(
    "attachment-preview-html-viewport",
  );
  const fallbackFrame = fallback.querySelector("iframe");
  if (!fallbackFrame) {
    throw new Error("Expected the live hosted-site fallback");
  }
  expect(fallbackFrame).toHaveAttribute("src", secondSite);
  click(previews[1]!);
  await waitFor(() => {
    expect(getPreviewFrame("artifact-dialog-site-frame")).toHaveAttribute(
      "src",
      secondSite,
    );
  });
});

test("Private attachment access stays scoped to the chat that owns it", async () => {
  const leftFileId = "left-shared-private-image";
  const rightFileId = "right-shared-private-image";
  const leftCanonicalUrl = privateAttachmentUrl(leftFileId);
  const rightCanonicalUrl = privateAttachmentUrl(rightFileId);
  mockSplitAttachmentChats(
    context,
    {
      threadId: ATTACHMENT_THREAD_ID,
      title: "Left private chat",
      events: [
        userImageMessage("left-private-message", [
          {
            type: "file",
            fileId: leftFileId,
            filenameSnapshot: "shared.png",
            contentType: "image/png",
          },
          { type: "text", text: "Left private image" },
        ]),
      ],
      artifacts: [
        artifactFile("shared.png", {
          id: leftFileId,
          contentType: "image/png",
          url: leftCanonicalUrl,
        }),
      ],
    },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Right private chat",
      events: [
        userImageMessage("right-private-message", [
          {
            type: "file",
            fileId: rightFileId,
            filenameSnapshot: "shared.png",
            contentType: "image/png",
          },
          { type: "text", text: "Right private image" },
        ]),
      ],
      artifacts: [
        artifactFile("shared.png", {
          id: rightFileId,
          contentType: "image/png",
          url: rightCanonicalUrl,
        }),
      ],
    },
  );
  mockPrivateUrlSequence(context, {
    [leftFileId]: ["https://private-files.example/left-shared.png"],
    [rightFileId]: ["https://private-files.example/right-shared.png"],
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}?sidebar=${SECOND_ATTACHMENT_THREAD_ID}`,
  });

  const leftPane = await waitFor(() => {
    const pane = document.querySelector<HTMLElement>(
      `[data-chat-thread-container-id="${ATTACHMENT_THREAD_ID}"]`,
    );
    if (!pane) {
      throw new Error("Left chat pane is not ready");
    }
    return pane;
  });
  const rightPane = await waitFor(() => {
    const pane = document.querySelector<HTMLElement>(
      `[data-chat-thread-container-id="${SECOND_ATTACHMENT_THREAD_ID}"]`,
    );
    if (!pane) {
      throw new Error("Right chat pane is not ready");
    }
    return pane;
  });

  click(await findNamedLink("Preview shared.png", leftPane));
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute(
    "src",
    "https://private-files.example/left-shared.png",
  );
  await closeFocusedPreview();
  click(await findNamedLink("Preview shared.png", rightPane));
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute(
    "src",
    "https://private-files.example/right-shared.png",
  );
  await closeFocusedPreview();
});

test("Image navigation remains inside its split-view chat", async () => {
  const leftFirst = "left-navigation-first";
  const leftSecond = "left-navigation-second";
  const rightFirst = "right-navigation-first";
  const rightSecond = "right-navigation-second";
  mockSplitAttachmentChats(
    context,
    {
      threadId: ATTACHMENT_THREAD_ID,
      title: "Left gallery",
      events: [
        userImageMessage("left-gallery-message", [
          {
            type: "file",
            fileId: leftFirst,
            filenameSnapshot: "shared.png",
            contentType: "image/png",
          },
          {
            type: "file",
            fileId: leftSecond,
            filenameSnapshot: "left-second.png",
            contentType: "image/png",
          },
          { type: "text", text: "Left gallery images" },
        ]),
      ],
      artifacts: [
        artifactFile("shared.png", {
          id: leftFirst,
          contentType: "image/png",
          url: privateAttachmentUrl(leftFirst),
        }),
        artifactFile("left-second.png", {
          id: leftSecond,
          contentType: "image/png",
          url: privateAttachmentUrl(leftSecond),
        }),
      ],
    },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Right gallery",
      events: [
        userImageMessage("right-gallery-message", [
          {
            type: "file",
            fileId: rightFirst,
            filenameSnapshot: "shared.png",
            contentType: "image/png",
          },
          {
            type: "file",
            fileId: rightSecond,
            filenameSnapshot: "right-second.png",
            contentType: "image/png",
          },
          { type: "text", text: "Right gallery images" },
        ]),
      ],
      artifacts: [
        artifactFile("shared.png", {
          id: rightFirst,
          contentType: "image/png",
          url: privateAttachmentUrl(rightFirst),
        }),
        artifactFile("right-second.png", {
          id: rightSecond,
          contentType: "image/png",
          url: privateAttachmentUrl(rightSecond),
        }),
      ],
    },
  );
  mockPrivateUrlSequence(context, {
    [leftFirst]: ["https://private-files.example/left-shared.png"],
    [leftSecond]: ["https://private-files.example/left-second.png"],
    [rightFirst]: ["https://private-files.example/right-shared.png"],
    [rightSecond]: ["https://private-files.example/right-second.png"],
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}?sidebar=${SECOND_ATTACHMENT_THREAD_ID}`,
  });

  const rightPane = await waitFor(() => {
    const pane = document.querySelector<HTMLElement>(
      `[data-chat-thread-container-id="${SECOND_ATTACHMENT_THREAD_ID}"]`,
    );
    if (!pane) {
      throw new Error("Right chat pane is not ready");
    }
    return pane;
  });
  click(await findNamedLink("Preview shared.png", rightPane));
  click(await findNamedButton("Next image artifact"));

  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "right-second.png",
    );
  });
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "src",
    "https://private-files.example/right-second.png",
  );
  expect(screen.getByTestId("attachment-lightbox-image")).not.toHaveAttribute(
    "src",
    "https://private-files.example/left-second.png",
  );
});

test.each(["link", "card"])(
  "Private HTML %s previews reuse their URL across reopening and split view",
  async (presentation) => {
    mockNow(new Date("2026-09-09T00:00:00.000Z"), context.signal);
    const deploymentId = "00000000-0000-4000-8000-000000000009";
    const canonicalUrl = `${artifactReferencePath(deploymentId, "index.html")}#slide-2`;
    const firstPreview = `https://pv-${"a".repeat(48)}.sites.vm7.io/`;
    const nextPreview = `https://pv-${"b".repeat(48)}.sites.vm7.io/`;
    let currentPreview = firstPreview;
    const visibility = context.mocks.browser.visibilityState("visible");
    mockAttachmentChat(context, {
      chatEvents: [
        assistantMessage(
          `${presentation === "card" ? "!" : ""}[Private report](${canonicalUrl})`,
        ),
      ],
      artifacts: [
        artifactFile("private-report.html", {
          id: "private-html",
          contentType: "text/html",
          url: canonicalUrl,
          artifactKind: "hosted-site",
        }),
      ],
    });
    context.mocks.api(
      artifactReferencesContract.resolve,
      ({ params, respond }) => {
        expect(params.reference).toBe(
          artifactReferencePath(deploymentId, "index.html").slice(
            "/artifacts/".length,
          ),
        );
        const resolvedPreview = currentPreview;
        currentPreview = nextPreview;
        return respond(200, {
          url: resolvedPreview,
          filename: "index.html",
          contentType: "text/html",
          target: { kind: "html", id: deploymentId },
          expiresAt: "2026-09-11T00:00:00.000Z",
        });
      },
    );
    await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
    const openPreview =
      presentation === "card"
        ? await screen.findByTestId("attachment-preview-html")
        : await findNamedLink("Private report");
    click(openPreview);
    await waitFor(() => {
      expect(getPreviewFrame("artifact-dialog-site-frame")).toHaveAttribute(
        "src",
        `${firstPreview}#slide-2`,
      );
    });
    expect(document.querySelector('a[aria-label="Share"]')).toBeNull();
    currentPreview = nextPreview;
    await closeFocusedPreview();
    mockNow(new Date("2026-09-12T00:00:00.000Z"), context.signal);
    click(openPreview);
    await waitFor(() => {
      expect(getPreviewFrame("artifact-dialog-site-frame")).toHaveAttribute(
        "src",
        `${firstPreview}#slide-2`,
      );
    });
    click(await findNamedButton("Open in split view"));
    const sidebar = await screen.findByTestId("artifact-sidebar");
    await waitFor(() => {
      expect(
        within(sidebar).getByTestId("artifact-sidebar-body-html"),
      ).toHaveAttribute("src", `${firstPreview}#slide-2`);
    });
    visibility.changeTo("hidden");
    visibility.changeTo("visible");
    await waitFor(() => {
      expect(
        within(sidebar).getByTestId("artifact-sidebar-body-html"),
      ).toHaveAttribute("src", `${firstPreview}#slide-2`);
    });
    click(openPreview);
    await waitFor(() => {
      expect(
        within(sidebar).getByTestId("artifact-sidebar-body-html"),
      ).toHaveAttribute("src", `${firstPreview}#slide-2`);
    });
  },
);

test("A private site card resizes its authorized screenshot and opens the site on click", async () => {
  const deploymentId = "00000000-0000-4000-8000-000000000019";
  const screenshotId = "00000000-0000-4000-8000-000000000020";
  const site = artifactReferencePath(deploymentId, "index.html");
  const screenshot = artifactReferencePath(screenshotId, "preview.webp");
  const screenshotUrl = `${R2_ORIGIN}/private/screenshot%20%2B.bin?X-Amz-Signature=owner&X-Amz-Security-Token=token%2B%2F%3D`;
  const previewUrl = `https://pv-${"a".repeat(48)}.sites.vm7.io/`;
  let currentPreview = previewUrl;
  mockAttachmentChat(context, {
    chatEvents: [assistantMessage(`![Private report](${site})`)],
    artifacts: [
      artifactFile("private-report.html", {
        id: "private-screenshot",
        contentType: "text/html",
        url: site,
        artifactKind: "hosted-site",
        previewImageUrl: screenshot,
      }),
    ],
  });
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      const isScreenshot =
        params.reference === screenshot.slice("/artifacts/".length);
      return respond(200, {
        url: isScreenshot ? screenshotUrl : currentPreview,
        filename: isScreenshot ? "preview.webp" : "index.html",
        contentType: isScreenshot ? "image/webp" : "text/html",
        target: isScreenshot
          ? { kind: "file", id: screenshotId }
          : { kind: "html", id: deploymentId },
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
  expect(
    within(card).queryByTestId("attachment-preview-html-viewport"),
  ).toBeNull();
  click(card);
  await waitFor(() => {
    expect(getPreviewFrame("artifact-dialog-site-frame")).toHaveAttribute(
      "src",
      previewUrl,
    );
  });
  currentPreview = `https://pv-${"b".repeat(48)}.sites.vm7.io/`;
  await closeFocusedPreview();
  click(card);
  await waitFor(() => {
    expect(getPreviewFrame("artifact-dialog-site-frame")).toHaveAttribute(
      "src",
      previewUrl,
    );
  });
});

test.each([
  { role: "assistant", storedForm: "absolute" },
  { role: "user", storedForm: "absolute" },
  { role: "assistant", storedForm: "relative" },
] as const)(
  "A private video in a $role message with a $storedForm catalog URL resizes its authorized poster and opens the original",
  async ({ role, storedForm }) => {
    const videoId = "00000000-0000-4000-8000-000000000021";
    const posterId = "00000000-0000-4000-8000-000000000022";
    const video = new URL(
      artifactReferencePath(videoId, "generated.mp4"),
      "http://localhost",
    ).href;
    const poster = new URL(
      artifactReferencePath(posterId, "poster-v2.jpg"),
      "http://localhost",
    ).href;
    const storedVideo =
      storedForm === "relative" ? new URL(video).pathname : video;
    const storedPoster =
      storedForm === "relative" ? new URL(poster).pathname : poster;
    const videoUrl = `${R2_ORIGIN}/private/generated.mp4?X-Amz-Signature=owner`;
    const posterUrl = `${R2_ORIGIN}/private/poster%20%2B.bin?X-Amz-Signature=owner&X-Amz-Security-Token=token%2B%2F%3D`;
    mockAttachmentChat(context, {
      chatEvents: [
        role === "assistant"
          ? assistantMessage(`![Generated video](${video})`)
          : userImageMessage("user-video-message", [
              {
                type: "file",
                fileId: videoId,
                filenameSnapshot: "generated.mp4",
                contentType: "video/mp4",
              },
            ]),
      ],
      artifacts: [
        artifactFile("generated.mp4", {
          id: videoId,
          contentType: "video/mp4",
          url: storedVideo,
          previewImageUrl: storedPoster,
        }),
      ],
    });
    context.mocks.api(
      artifactReferencesContract.resolve,
      ({ params, respond }) => {
        const isPoster =
          params.reference ===
          new URL(storedPoster, "http://localhost").pathname.slice(
            "/artifacts/".length,
          );
        return respond(200, {
          url: isPoster ? posterUrl : videoUrl,
          filename: isPoster ? "poster-v2.jpg" : "generated.mp4",
          contentType: isPoster ? "image/jpeg" : "video/mp4",
          target: { kind: "file", id: isPoster ? posterId : videoId },
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      },
    );
    mockPrivateUrlSequence(context, { [videoId]: [videoUrl] });
    await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
    const thumbnail = await screen.findByTestId("chat-video-preview-thumbnail");
    expect(thumbnail).toHaveAttribute("src", `${THUMBNAIL_PREFIX}${posterUrl}`);
    fireEvent.load(thumbnail);
    expect(screen.queryByTestId("chat-video-preview-fallback")).toBeNull();
    const card = thumbnail.closest("button");
    if (!card) {
      throw new Error("Expected a video preview button");
    }
    click(card);
    const stage = await screen.findByTestId("artifact-dialog-video-stage");
    await waitFor(() => {
      expect(stage.querySelector("video")).toHaveAttribute("src", videoUrl);
    });
  },
);
