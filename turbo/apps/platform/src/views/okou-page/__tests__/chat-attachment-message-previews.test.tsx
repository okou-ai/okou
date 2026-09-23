import type {
  ChatThreadArtifactFile,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
  getNamedButton,
  getNamedLink,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  privateAttachmentUrl,
  publicArtifactUrl,
  queryNamedButton,
  queryNamedButtons,
  queryNamedLink,
  userMessage,
  type AttachmentChatEvent,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const CREATED_AT = "2026-03-10T00:00:01Z";

function assistantMessage(
  content: string,
  overrides: Partial<AttachmentChatEvent> = {},
): AttachmentChatEvent {
  return {
    id: "attachment-assistant-message",
    role: "assistant",
    content,
    runId: ATTACHMENT_RUN_ID,
    runEventId: "attachment-event-1",
    sequenceNumber: 1,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function sentUserMessage(
  document: UserMessageDocument,
  overrides: Partial<AttachmentChatEvent> = {},
): AttachmentChatEvent {
  return {
    id: "attachment-user-message",
    role: "user",
    content: null,
    runId: ATTACHMENT_RUN_ID,
    createdAt: CREATED_AT,
    userMessage: document,
    ...overrides,
  };
}

function filePart(
  fileId: string,
  filenameSnapshot: string,
  contentType: string,
): Extract<UserMessageDocument["parts"][number], { type: "file" }> {
  return { type: "file", fileId, filenameSnapshot, contentType };
}

async function findPreviewActionForImage(alt: string): Promise<HTMLElement> {
  const image = await screen.findByAltText(alt);
  const action = image.closest<HTMLElement>("a, button");
  if (!action) {
    throw new Error(`Expected ${alt} to have a preview action`);
  }
  return action;
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

async function closeFocusedPreview(): Promise<void> {
  click(getNamedButton("Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
}

test("A rich artifact preview requires a complete address", async () => {
  const complete = publicArtifactUrl("complete-video.mp4");
  const incomplete = complete.slice(0, complete.lastIndexOf("/"));
  const rootRelative = "/complete-video.mp4";
  mockAttachmentChat(context, {
    chatEvents: [
      assistantMessage(
        [
          `Incomplete: ${incomplete}`,
          `Root relative: ${rootRelative}`,
          "Complete:",
          `![Complete video](${complete})`,
        ].join("\n\n"),
      ),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const preview = await findNamedButton("Preview complete-video.mp4");
  expect(queryNamedButtons("Preview complete-video.mp4")).toHaveLength(1);
  const message = preview.closest<HTMLElement>('[data-role="assistant"]');
  if (!message) {
    throw new Error("Expected the assistant message containing the preview");
  }
  expect(message).toHaveTextContent(`Incomplete: ${incomplete}`);
  expect(message).toHaveTextContent(`Root relative: ${rootRelative}`);
  expect(preview).toBeVisible();
});

test("A short Okou artifact link opens as a rich preview", async () => {
  const shortArtifact = "https://a.okou.io/a1b2c3d4e5.pdf";
  mockAttachmentChat(context, {
    chatEvents: [assistantMessage(`[Open the review brief](${shortArtifact})`)],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const preview = await findNamedLink("Open the review brief");
  expect(preview).toHaveAttribute("href", shortArtifact);
  click(preview);
  await waitFor(() => {
    expect(getPreviewFrame("artifact-dialog-document-frame")).toHaveAttribute(
      "src",
      `${shortArtifact}#navpanes=0`,
    );
  });
});

test("An ordinary first-party Markdown image uses a thumbnail and opens its original", async () => {
  const url = "https://static.okou.io/reports/thread-photo.png";
  mockAttachmentChat(context, {
    chatEvents: [assistantMessage(`![Report photo](${url})`)],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const image = await screen.findByAltText("Report photo");
  expect(image).toHaveAttribute(
    "src",
    "https://static.okou.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/reports/thread-photo.png",
  );
  click(await findPreviewActionForImage("Report photo"));
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", url);
});

test("An embedded video's poster uses a thumbnail while playback keeps its original", async () => {
  const url = publicArtifactUrl("embedded-video.mp4");
  const poster = publicArtifactUrl("embedded-poster.jpg");
  mockAttachmentChat(context, {
    chatEvents: [
      assistantMessage(
        `<video src="${url}" poster="${poster}" controls></video>`,
      ),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await waitFor(() => {
    const video = document.querySelector("video[poster]");
    expect(video).toHaveAttribute("src", url);
    expect(video).toHaveAttribute(
      "poster",
      "https://cdn.vm7.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/tests/chat-attachments/embedded-poster.jpg",
    );
  });
});

test("Image navigation stays within the current message", async () => {
  const first = publicArtifactUrl("gallery-first.png");
  const second = publicArtifactUrl("gallery-second.png");
  const third = publicArtifactUrl("gallery-third.png");
  const unrelated = publicArtifactUrl("unrelated-generated.png");
  const notes = publicArtifactUrl("gallery-notes.txt");
  mockAttachmentChat(context, {
    chatEvents: [
      assistantMessage(
        [
          `1. ![gallery-first.png](${first})`,
          `2. ![gallery-second.png](${second})`,
          `3. ![gallery-third.png](${third})`,
          `[Notes](${notes})`,
        ].join("\n"),
      ),
    ],
    artifacts: [
      artifactFile("gallery-first.png", { id: "gallery-first", url: first }),
      artifactFile("gallery-second.png", { id: "gallery-second", url: second }),
      artifactFile("gallery-third.png", { id: "gallery-third", url: third }),
      artifactFile("unrelated-generated.png", {
        id: "gallery-unrelated",
        url: unrelated,
      }),
      artifactFile("gallery-notes.txt", { id: "gallery-notes", url: notes }),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  click(await findPreviewActionForImage("gallery-first.png"));
  await screen.findByRole("dialog", { name: "gallery-first.png preview" });
  expect(queryNamedButton("Previous image artifact")).toBeNull();
  expect(getNamedButton("Next image artifact")).toBeVisible();

  fireEvent.keyDown(document, { key: "ArrowRight" });
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "gallery-second.png",
    );
  });
  click(getNamedButton("Previous image artifact"));
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "gallery-first.png",
    );
  });
  expect(queryNamedButton("Previous image artifact")).toBeNull();
  expect(
    screen.queryByAltText("unrelated-generated.png"),
  ).not.toBeInTheDocument();
});

test("Only exact trusted public links receive rich attachment previews", async () => {
  const currentSite = "https://launch-site.sites.vm7.io";
  const artifactPdf =
    "https://cdn.vm7.io/artifacts/user_test/report-id/report.pdf";
  const historicalImage =
    "https://app.okou.ai/f/user_test/historical-id/history.png";
  const previewImage =
    "https://pr-42-app.vm7.ai/artifacts/user_test/preview-id/preview.png";
  const lookalike =
    "https://app.okou.ai.evil.example/artifacts/user_test/forged-id/forged.pdf";
  const arbitraryOkou =
    "https://files.okou.ai/artifacts/user_test/other-id/other.pdf";
  mockAttachmentChat(context, {
    chatEvents: [
      assistantMessage(
        [
          `[Current site](${currentSite})`,
          `[Artifact PDF](${artifactPdf})`,
          `![history.png](${historicalImage})`,
          `![preview.png](${previewImage})`,
          `[Forged lookalike](${lookalike})`,
          `[Arbitrary Okou](${arbitraryOkou})`,
        ].join("\n\n"),
      ),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const sitePreview = await findNamedLink("Current site");
  expect(sitePreview).toHaveAttribute("href", currentSite);
  click(sitePreview);
  await waitFor(() => {
    expect(getPreviewFrame("artifact-dialog-site-frame")).toHaveAttribute(
      "src",
      currentSite,
    );
  });
  await closeFocusedPreview();

  const pdfPreview = getNamedLink("Artifact PDF");
  expect(pdfPreview).toHaveAttribute("href", artifactPdf);
  click(pdfPreview);
  await waitFor(() => {
    expect(getPreviewFrame("artifact-dialog-document-frame")).toHaveAttribute(
      "src",
      `${artifactPdf}#navpanes=0`,
    );
  });
  await closeFocusedPreview();

  click(await findPreviewActionForImage("history.png"));
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", historicalImage);
  await closeFocusedPreview();
  click(await findPreviewActionForImage("preview.png"));
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", previewImage);
  await closeFocusedPreview();

  expect(getNamedLink("Forged lookalike")).toHaveAttribute("href", lookalike);
  expect(getNamedLink("Arbitrary Okou")).toHaveAttribute("href", arbitraryOkou);
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label")?.includes("forged.pdf") ?? false;
    }),
  ).toBeFalsy();
});

async function setupPersistedAttachmentMessage(): Promise<void> {
  const specifications = [
    ["private-video", "demo.mp4", "video/mp4"],
    ["private-pdf", "brief.pdf", "application/pdf"],
    ["private-markdown", "notes.md", "text/markdown"],
    ["private-presentation", "quarterly-deck.html", "text/html"],
  ] as const;
  const artifacts: ChatThreadArtifactFile[] = specifications.map(
    ([id, filename, contentType]) => {
      return artifactFile(filename, {
        id,
        contentType,
        url: privateAttachmentUrl(id),
        ...(id === "private-presentation"
          ? { artifactKind: "presentation-html" as const }
          : {}),
      });
    },
  );
  const document = userMessage([
    ...specifications.map(([id, filename, contentType]) => {
      return filePart(id, filename, contentType);
    }),
    { type: "text", text: "Files from the completed review" },
  ]);
  mockAttachmentChat(context, {
    chatEvents: [sentUserMessage(document)],
    artifacts,
  });
  const presigned = Object.fromEntries(
    specifications.map(([id, filename]) => {
      return [id, [`https://private-files.example/${filename}`]];
    }),
  );
  const markdownShareUrl = publicArtifactUrl("notes.md");
  mockPrivateUrlSequence(context, presigned, {
    "private-markdown": markdownShareUrl,
  });
  context.mocks.http.get("https://private-files.example/notes.md", () => {
    return HttpResponse.text("# Review notes\n\nEverything is ready.");
  });
  context.mocks.http.get(
    "https://private-files.example/quarterly-deck.html",
    () => {
      return HttpResponse.html("<main>Quarterly presentation</main>");
    },
  );
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await expect(
    screen.findByText("Files from the completed review"),
  ).resolves.toBeVisible();
}

test("Persisted video attachments open in the video sidebar", async () => {
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Preview demo.mp4"));
  await expect(
    screen.findByLabelText("Video preview for demo.mp4"),
  ).resolves.toBeVisible();
  click(getNamedButton("Open in split view"));
  await expect(
    screen.findByTestId("artifact-sidebar-body-video"),
  ).resolves.toBeVisible();
  click(getNamedButton("Close artifact"));
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar-body-video")).toBeNull();
  });
});

test("Persisted PDF attachments use the document sidebar", async () => {
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Open pdf preview for brief.pdf"));
  click(await findNamedButton("Open in split view"));
  await expect(
    screen.findByTestId("artifact-sidebar-body-pdf"),
  ).resolves.toBeVisible();
  expect(screen.queryByTestId("presentation-artifact-viewport")).toBeNull();
  click(getNamedButton("Close artifact"));
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar-body-pdf")).toBeNull();
  });
});

test("Persisted Markdown attachments render without offering sharing", async () => {
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Open markdown preview for notes.md"));
  await expect(screen.findByText("Review notes")).resolves.toBeVisible();
  // The file belongs to the user's own message, so the preview has a download
  // but no share action even though a public URL resolved for it.
  expect(getNamedButton("Download options")).toBeInTheDocument();
  expect(queryNamedLink("Share")).toBeNull();
  await closeFocusedPreview();
});

test("Persisted HTML presentations open and download as presentations", async () => {
  const downloads = context.mocks.browser.blobDownload();
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Open html preview for quarterly-deck.html"));
  await expect(
    screen.findByTestId("presentation-artifact-viewport"),
  ).resolves.toBeVisible();
  click(getNamedButton("Download options"));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    expect(downloads.downloads).toHaveLength(1);
  });
  expect(downloads.downloads[0]?.filename).toBe("quarterly-deck.html");
  expect(screen.queryByText("Download failed")).toBeNull();
});

test("A Slack-originated message keeps its attachment and original source", async () => {
  const fileId = "slack-review-markdown";
  const canonicalUrl = privateAttachmentUrl(fileId);
  const resolvedUrl = "https://private-files.example/slack-review.md";
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(
        userMessage([
          {
            type: "source",
            kind: "slack",
            href: "https://acme.slack.com/archives/C123/p1712345678000100",
          },
          filePart(fileId, "slack-review.md", "text/markdown"),
          { type: "text", text: "Please review the launch notes" },
        ]),
      ),
    ],
    artifacts: [
      artifactFile("slack-review.md", {
        id: fileId,
        contentType: "text/markdown",
        url: canonicalUrl,
      }),
    ],
  });
  mockPrivateUrlSequence(context, { [fileId]: [resolvedUrl] });
  context.mocks.http.get(resolvedUrl, () => {
    return HttpResponse.text(
      "# Slack launch review\n\nThe attachment is intact.",
    );
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await expect(
    screen.findByText("Please review the launch notes"),
  ).resolves.toBeVisible();
  const source = getNamedLink("Open original message in Slack");
  expect(source).toHaveAttribute(
    "href",
    "https://acme.slack.com/archives/C123/p1712345678000100",
  );
  click(getNamedButton("Open markdown preview for slack-review.md"));
  await expect(screen.findByText("Slack launch review")).resolves.toBeVisible();
});

test("A Lark image stored as a binary object uses a thumbnail and opens its original", async () => {
  const fileId = "lark-image";
  const originalUrl =
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/artifacts/lark-image.bin` +
    "?X-Amz-Signature=image-signature";
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(
        userMessage([
          {
            type: "source",
            kind: "feishu",
            href: "https://applink.larksuite.com/client/chat/open?chatId=chat-1",
          },
          filePart(fileId, "image", "image/jpeg"),
          { type: "text", text: "Describe this image" },
        ]),
      ),
    ],
  });
  mockPrivateUrlSequence(context, { [fileId]: [originalUrl] });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const thumbnail = await screen.findByAltText("image");
  expect(thumbnail).toHaveAttribute(
    "src",
    `https://cdn.vm7.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/${originalUrl}`,
  );
  click(await findPreviewActionForImage("image"));
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", originalUrl);
});

test("User attachments appear before their message text", async () => {
  const files = [
    ["ordered-image", "compact.png", "image/png"],
    ["ordered-video", "compact.mp4", "video/mp4"],
    ["ordered-pdf", "details.pdf", "application/pdf"],
    ["ordered-text", "details.txt", "text/plain"],
  ] as const;
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(
        userMessage([
          ...files.map(([id, filename, contentType]) => {
            return filePart(id, filename, contentType);
          }),
          { type: "text", text: "Original message beneath the files" },
        ]),
      ),
    ],
    artifacts: files.map(([id, filename, contentType]) => {
      return artifactFile(filename, {
        id,
        contentType,
        url: privateAttachmentUrl(id),
      });
    }),
  });
  mockPrivateUrlSequence(
    context,
    Object.fromEntries(
      files.map(([id, filename]) => {
        return [id, [`https://private-files.example/${filename}`]];
      }),
    ),
  );

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const text = await screen.findByText("Original message beneath the files");
  const bubble = text.closest<HTMLElement>('[data-slot="chat-user-message"]');
  if (!bubble) {
    throw new Error("Expected the original text bubble");
  }
  const media = screen.getByTestId("message-media-attachments");
  const documents = screen.getByTestId("message-file-attachments");
  expect(media).toContainElement(getNamedLink("Preview compact.png"));
  expect(media).toContainElement(getNamedButton("Preview compact.mp4"));
  expect(documents).toContainElement(
    getNamedButton("Open pdf preview for details.pdf"),
  );
  expect(documents).toContainElement(
    getNamedButton("Open text preview for details.txt"),
  );
  expect(media.compareDocumentPosition(documents)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(documents.compareDocumentPosition(bubble)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(bubble).toHaveTextContent("Original message beneath the files");
});

test("A user's Markdown image syntax stays literal", async () => {
  const url = "https://cdn.vm7.io/artifacts/tests/chat-attachments/chart.png";
  const markdown = `![quarterly chart](${url})`;
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(userMessage([{ type: "text", text: markdown }])),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  // The destination inside the syntax becomes a link, so the message reads as
  // several nodes; every character the author typed is still shown in order.
  const userMessageContainer = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-role="user"]');
    if (!element?.textContent?.includes(markdown)) {
      throw new Error("Expected the literal Markdown to stay visible");
    }
    return element;
  });
  const link = queryAllByRoleFast("link", userMessageContainer).find(
    (candidate) => {
      return candidate.getAttribute("href") === url;
    },
  );
  expect(link).toBeVisible();
  expect(userMessageContainer.querySelector("img")).toBeNull();
  expect(
    userMessageContainer.querySelector('[data-testid^="attachment-preview-"]'),
  ).toBeNull();
});
