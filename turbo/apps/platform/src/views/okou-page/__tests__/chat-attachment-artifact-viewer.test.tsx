import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import type { HostedSiteFilesResponse } from "@okouai/api-contracts/contracts/host";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { strFromU8, unzipSync } from "fflate";
import { HttpResponse } from "msw";
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

async function expectPrivateTextPreview(
  root: HTMLElement,
  filename: string,
): Promise<void> {
  await expect(
    within(root).findByText(`private preview for ${filename}`),
  ).resolves.toBeInTheDocument();
}

test("A private attachment reuses one URL across reopen and split view", async () => {
  const filename = "private-notes.txt";
  const contentType = "text/plain";
  const fileId = "private-private-notes-txt";
  const canonicalUrl = privateAttachmentUrl(fileId);
  const firstUrl = `https://private-files.example/${filename}?signature=first`;
  const nextUrl = `https://private-files.example/${filename}?signature=next`;
  mockAttachmentChat(context, {
    chatEvents: [
      userImageMessage(`user-${fileId}`, [
        {
          type: "file",
          fileId,
          filenameSnapshot: filename,
          contentType,
        },
      ]),
    ],
    artifacts: [
      artifactFile(filename, {
        id: fileId,
        contentType,
        url: canonicalUrl,
      }),
    ],
  });
  let resolveCount = 0;
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    expect(query.file_id).toBe(fileId);
    const url = resolveCount === 0 ? firstUrl : nextUrl;
    resolveCount += 1;
    return respond(200, {
      url,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
    });
  });
  context.mocks.http.get(
    `https://private-files.example/${filename}`,
    ({ request }) => {
      const renewed = new URL(request.url).searchParams.get("signature");
      return HttpResponse.text(
        `${renewed === "first" ? "private" : "unexpected renewed"} preview for ${filename}`,
      );
    },
  );

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const filenameNode = await screen.findByText(filename);
  const trigger = filenameNode.closest("button");
  if (!trigger) {
    throw new Error(`Expected a preview trigger for ${filename}`);
  }

  click(trigger);
  await expectPrivateTextPreview(
    await screen.findByTestId("attachment-lightbox"),
    filename,
  );
  await closeFocusedPreview();

  click(trigger);
  await expectPrivateTextPreview(
    await screen.findByTestId("attachment-lightbox"),
    filename,
  );

  click(await findNamedButton("Open in split view"));
  await expectPrivateTextPreview(
    await screen.findByTestId("artifact-sidebar"),
    filename,
  );
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
    [leftFirst]: [
      "https://private-files.example/left-shared.png?signature=first",
      "https://private-files.example/left-shared.png?signature=next",
    ],
    [leftSecond]: [
      "https://private-files.example/left-second.png?signature=first",
      "https://private-files.example/left-second.png?signature=next",
    ],
    [rightFirst]: [
      "https://private-files.example/right-shared.png?signature=first",
      "https://private-files.example/right-shared.png?signature=next",
    ],
    [rightSecond]: [
      "https://private-files.example/right-second.png?signature=first",
      "https://private-files.example/right-second.png?signature=next",
    ],
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
    "https://private-files.example/right-second.png?signature=first",
  );
  expect(screen.getByTestId("attachment-lightbox-image")).not.toHaveAttribute(
    "src",
    "https://private-files.example/left-second.png?signature=first",
  );

  await closeFocusedPreview();

  click(await findNamedLink("Preview shared.png", leftPane));
  click(await findNamedButton("Next image artifact"));
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      "https://private-files.example/left-second.png?signature=first",
    );
  });
  click(await findNamedButton("Open in split view"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByTestId("artifact-sidebar-body-image"),
  ).resolves.toHaveAttribute(
    "src",
    "https://private-files.example/left-second.png?signature=first",
  );
  click(await findNamedButton("Previous image artifact", sidebar));
  await waitFor(() => {
    expect(
      within(sidebar).getByTestId("artifact-sidebar-body-image"),
    ).toHaveAttribute(
      "src",
      "https://private-files.example/left-shared.png?signature=first",
    );
  });
});

test("A user's attachment preview withholds the sharing an agent artifact offers", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const firstAttachment = "share-gate-attachment-first";
  const secondAttachment = "share-gate-attachment-second";
  const agentImageUrl = publicArtifactUrl("agent-chart.png");
  mockAttachmentChat(context, {
    chatEvents: [
      userImageMessage("share-gate-user-message", [
        {
          type: "file",
          fileId: firstAttachment,
          filenameSnapshot: "brief.png",
          contentType: "image/png",
        },
        {
          type: "file",
          fileId: secondAttachment,
          filenameSnapshot: "sketch.png",
          contentType: "image/png",
        },
        { type: "text", text: "Reference images" },
      ]),
      assistantMessage(`![agent-chart.png](${agentImageUrl})`),
    ],
    artifacts: [
      artifactFile("brief.png", {
        id: firstAttachment,
        contentType: "image/png",
        url: privateAttachmentUrl(firstAttachment),
      }),
      artifactFile("sketch.png", {
        id: secondAttachment,
        contentType: "image/png",
        url: privateAttachmentUrl(secondAttachment),
      }),
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

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  click(await findNamedLink("Preview brief.png"));
  const briefDialog = await screen.findByRole("dialog", {
    name: "brief.png preview",
  });
  // The resolved private address proves the token the share action reads has
  // already settled, so a missing control is a decision, not a pending state.
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      "https://private-files.example/brief.png",
    );
  });
  expect(getNamedButton("Download options", briefDialog)).toBeInTheDocument();
  expect(queryNamedLink("Share", briefDialog)).toBeNull();
  expect(queryNamedButton("Share", briefDialog)).toBeNull();

  click(await findNamedButton("Next image artifact", briefDialog));
  const sketchDialog = await screen.findByRole("dialog", {
    name: "sketch.png preview",
  });
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      "https://private-files.example/sketch.png",
    );
  });
  expect(queryNamedLink("Share", sketchDialog)).toBeNull();
  expect(queryNamedButton("Share", sketchDialog)).toBeNull();

  await closeFocusedPreview();

  const agentImage = await screen.findByAltText("agent-chart.png");
  const agentPreview = agentImage.closest<HTMLElement>("a, button");
  if (!agentPreview) {
    throw new Error("Expected the agent image to open a preview");
  }
  click(agentPreview);
  const agentDialog = await screen.findByRole("dialog", {
    name: "agent-chart.png preview",
  });
  click(await findNamedLink("Share", agentDialog));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([agentImageUrl]);
  });
});

test("A private HTML link preview reuses its URL across reopening and split view", async () => {
  mockNow(new Date("2026-09-09T00:00:00.000Z"), context.signal);
  const deploymentId = "00000000-0000-4000-8000-000000000009";
  const canonicalUrl = `${artifactReferencePath(deploymentId, "index.html")}#slide-2`;
  const firstPreview = `https://pv-${"a".repeat(48)}.sites.vm7.io/`;
  const nextPreview = `https://pv-${"b".repeat(48)}.sites.vm7.io/`;
  let currentPreview = firstPreview;
  mockAttachmentChat(context, {
    chatEvents: [assistantMessage(`[Private report](${canonicalUrl})`)],
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
  const openPreview = await findNamedLink("Private report");
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
  click(openPreview);
  await waitFor(() => {
    expect(
      within(sidebar).getByTestId("artifact-sidebar-body-html"),
    ).toHaveAttribute("src", `${firstPreview}#slide-2`);
  });
});

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
    const renewedVideoUrl = `${R2_ORIGIN}/private/generated.mp4?X-Amz-Signature=renewed`;
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
    let videoResolveCount = 0;
    context.mocks.api(
      artifactReferencesContract.resolve,
      ({ params, respond }) => {
        const isPoster =
          params.reference ===
          new URL(storedPoster, "http://localhost").pathname.slice(
            "/artifacts/".length,
          );
        const resolvedVideoUrl =
          videoResolveCount === 0 ? videoUrl : renewedVideoUrl;
        if (!isPoster) {
          videoResolveCount += 1;
        }
        return respond(200, {
          url: isPoster ? posterUrl : resolvedVideoUrl,
          filename: isPoster ? "poster-v2.jpg" : "generated.mp4",
          contentType: isPoster ? "image/jpeg" : "video/mp4",
          target: { kind: "file", id: isPoster ? posterId : videoId },
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      },
    );
    context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
      expect(query.file_id).toBe(videoId);
      const resolvedVideoUrl =
        videoResolveCount === 0 ? videoUrl : renewedVideoUrl;
      videoResolveCount += 1;
      return respond(200, {
        url: resolvedVideoUrl,
        expiresAt: "2099-01-01T00:00:00.000Z",
        publicUrl: null,
      });
    });
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
    let stage = await screen.findByTestId("artifact-dialog-video-stage");
    await waitFor(() => {
      expect(stage.querySelector("video")).toHaveAttribute("src", videoUrl);
    });
    await closeFocusedPreview();

    click(card);
    stage = await screen.findByTestId("artifact-dialog-video-stage");
    await waitFor(() => {
      expect(stage.querySelector("video")).toHaveAttribute("src", videoUrl);
    });

    click(await findNamedButton("Open in split view"));
    const sidebar = await screen.findByTestId("artifact-sidebar");
    await waitFor(() => {
      expect(
        within(sidebar).getByTestId("artifact-sidebar-body-video"),
      ).toHaveAttribute("src", videoUrl);
    });
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

/**
 * Publish one hosted artifact and serve its publication from the delivery host
 * the viewer already reads, so a download exercises the real member requests.
 */
function mockHostedPublication(
  files: readonly HostedSiteFilesResponse["files"][number][],
): { readonly members: readonly string[] } {
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
      url: PUBLICATION_HOST,
      filename: "index.html",
      contentType: "text/html",
      target: { kind: "html", id: PUBLICATION_DEPLOYMENT_ID },
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  context.mocks.api(artifactDownloadsContract.files, ({ params, respond }) => {
    expect(params.reference).toBe(canonicalUrl.slice("/artifacts/".length));
    return respond(200, {
      siteId: PUBLICATION_SITE_ID,
      deploymentId: PUBLICATION_DEPLOYMENT_ID,
      publicSlug: "launch-site",
      url: PUBLICATION_HOST,
      fileCount: files.length,
      size: files.reduce((total, file) => {
        return total + file.size;
      }, 0),
      files: [...files],
    });
  });
  const members: string[] = [];
  const bodies: Record<string, string> = {
    "/index.html": PUBLICATION_PAGE,
    "/assets/site.css": PUBLICATION_STYLE,
  };
  for (const [path, body] of Object.entries(bodies)) {
    context.mocks.http.get(`${PUBLICATION_HOST.slice(0, -1)}${path}`, () => {
      members.push(path);
      return HttpResponse.text(body);
    });
  }
  return { members };
}

test("a multi-file hosted publication downloads as a zip of every member", async () => {
  const { members } = mockHostedPublication([
    hostedFile("/index.html", PUBLICATION_PAGE, "text/html; charset=utf-8"),
    hostedFile("/assets/site.css", PUBLICATION_STYLE, "text/css"),
  ]);
  const downloads = context.mocks.browser.blobDownload();

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink("Launch site"));
  const dialog = await screen.findByRole("dialog");
  click(await findNamedButton("Download options", dialog));
  click(await findNamedMenuItem("Download"));

  await waitFor(() => {
    expect(downloads.downloads).toHaveLength(1);
  });
  expect(members).toStrictEqual(["/index.html", "/assets/site.css"]);
  const [download] = downloads.downloads;
  expect(download?.filename).toBe("launch-site.zip");
  expect(download?.blob?.type).toBe("application/zip");
  const archive = await download?.blob?.arrayBuffer();
  const unpacked = unzipSync(new Uint8Array(archive!));
  expect(Object.keys(unpacked).sort()).toStrictEqual([
    "assets/site.css",
    "index.html",
  ]);
  expect(strFromU8(unpacked["index.html"]!)).toBe(PUBLICATION_PAGE);
  expect(strFromU8(unpacked["assets/site.css"]!)).toBe(PUBLICATION_STYLE);
  expect(screen.queryByText("Download failed")).toBeNull();
});

test("a publication that cannot be listed reports the failure instead of its entry page", async () => {
  mockHostedPublication([
    hostedFile("/index.html", PUBLICATION_PAGE, "text/html; charset=utf-8"),
    hostedFile("/assets/site.css", PUBLICATION_STYLE, "text/css"),
  ]);
  const downloads = context.mocks.browser.blobDownload();
  context.mocks.api(artifactDownloadsContract.files, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL", message: "Listing unavailable" },
    });
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink("Launch site"));
  const dialog = await screen.findByRole("dialog");
  click(await findNamedButton("Download options", dialog));
  click(await findNamedMenuItem("Download"));

  await expect(
    screen.findByText("Download failed"),
  ).resolves.toBeInTheDocument();
  expect(downloads.downloads).toStrictEqual([]);
});

test("a self-contained hosted page downloads as the page itself", async () => {
  mockHostedPublication([
    hostedFile("/index.html", PUBLICATION_PAGE, "text/html; charset=utf-8"),
  ]);
  const downloads = context.mocks.browser.blobDownload();
  context.mocks.http.get(PUBLICATION_HOST, () => {
    return HttpResponse.text(PUBLICATION_PAGE);
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink("Launch site"));
  const dialog = await screen.findByRole("dialog");
  click(await findNamedButton("Download options", dialog));
  click(await findNamedMenuItem("Download"));

  await waitFor(() => {
    expect(downloads.downloads).toHaveLength(1);
  });
  const [download] = downloads.downloads;
  expect(download?.filename).toBe("launch-site.html");
  await expect(download?.blob?.text()).resolves.toBe(PUBLICATION_PAGE);
});
