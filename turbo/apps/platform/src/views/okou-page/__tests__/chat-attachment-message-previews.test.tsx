import mermaid from "@okouai/mermaid-lite";
import type {
  ChatThreadArtifactFile,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
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
  userMessage,
  type AttachmentChatEvent,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

warmMermaidParser();
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

test("Image navigation stays within the current message", async () => {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1600,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    900,
  );
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

  click(await findNamedButton("Zoom in"));
  await waitFor(() => {
    expect(
      screen.getByTestId("artifact-dialog-image-zoom-level"),
    ).toHaveTextContent("115%");
  });
  click(getNamedButton("Enter fullscreen"));
  await findNamedButton("Exit fullscreen");
  expect(
    screen.getByTestId("artifact-dialog-image-zoom-level"),
  ).toHaveTextContent("115%");
  click(getNamedButton("Exit fullscreen"));
  await findNamedButton("Enter fullscreen");
  expect(
    screen.getByTestId("artifact-dialog-image-zoom-level"),
  ).toHaveTextContent("115%");
  fireEvent.keyDown(document, { key: "ArrowRight" });
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "gallery-second.png",
    );
    expect(
      screen.getByTestId("artifact-dialog-image-zoom-level"),
    ).toHaveTextContent("100%");
  });
  click(getNamedButton("Previous image artifact"));
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "gallery-first.png",
    );
  });
  expect(queryNamedButton("Previous image artifact")).toBeNull();

  click(getNamedButton("Enter fullscreen"));
  click(getNamedButton("Next image artifact"));
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "gallery-second.png",
    );
  });
  expect(getNamedButton("Exit fullscreen")).toBeVisible();
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

async function setupPersistedAttachmentMessage(): Promise<{
  readonly markdownShareUrl: string;
}> {
  const specifications = [
    ["private-audio", "voice.mp3", "audio/mpeg"],
    ["private-video", "demo.mp4", "video/mp4"],
    ["private-json", "payload.json", "application/json"],
    ["private-csv", "metrics.csv", "text/csv"],
    ["private-pdf", "brief.pdf", "application/pdf"],
    ["private-html", "prototype.html", "text/html"],
    ["private-markdown", "notes.md", "text/markdown"],
    ["private-text", "summary.txt", "text/plain"],
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
  context.mocks.http.get("https://private-files.example/payload.json", () => {
    return HttpResponse.json({ status: "ready", count: 3 });
  });
  context.mocks.http.get("https://private-files.example/metrics.csv", () => {
    return HttpResponse.text("metric,value\nlatency,42");
  });
  context.mocks.http.get("https://private-files.example/notes.md", () => {
    return HttpResponse.text("# Review notes\n\nEverything is ready.");
  });
  context.mocks.http.get("https://private-files.example/summary.txt", () => {
    return HttpResponse.text("Plain text summary");
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
  return { markdownShareUrl };
}

test("Persisted audio attachments open from their private URL", async () => {
  await setupPersistedAttachmentMessage();

  click(await findNamedButton("Open audio preview for voice.mp3"));
  await expect(
    screen.findByLabelText("Audio preview for voice.mp3"),
  ).resolves.toHaveAttribute("src", "https://private-files.example/voice.mp3");
  await closeFocusedPreview();
});

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

test("Persisted JSON attachments render their contents", async () => {
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Open json preview for payload.json"));
  await expect(screen.findByText(/"status": "ready"/u)).resolves.toBeVisible();
  await closeFocusedPreview();
});

test("Persisted CSV attachments render their rows and values", async () => {
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Open csv preview for metrics.csv"));
  await expect(screen.findByText("latency")).resolves.toBeVisible();
  expect(screen.getByText("42")).toBeVisible();
  await closeFocusedPreview();
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

test("Persisted HTML attachments use the document sidebar", async () => {
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Open html preview for prototype.html"));
  click(await findNamedButton("Open in split view"));
  await expect(
    screen.findByTestId("artifact-sidebar-body-html"),
  ).resolves.toBeVisible();
  expect(screen.queryByTestId("presentation-artifact-viewport")).toBeNull();
  click(getNamedButton("Close artifact"));
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar-body-html")).toBeNull();
  });
});

test("Persisted Markdown attachments render and share their public URL", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const { markdownShareUrl } = await setupPersistedAttachmentMessage();

  click(getNamedButton("Open markdown preview for notes.md"));
  await expect(screen.findByText("Review notes")).resolves.toBeVisible();
  click(await findNamedLink("Share"));
  await waitFor(() => {
    expect(clipboard.writes).toContain(markdownShareUrl);
  });
  await closeFocusedPreview();
});

test("Persisted text attachments render their contents", async () => {
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Open text preview for summary.txt"));
  await expect(screen.findByText("Plain text summary")).resolves.toBeVisible();
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
  const markdown =
    "![quarterly chart](https://cdn.vm7.io/artifacts/tests/chat-attachments/chart.png)";
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(userMessage([{ type: "text", text: markdown }])),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const literalText = await screen.findByText(markdown);
  const userMessageContainer =
    literalText.closest<HTMLElement>('[data-role="user"]');
  if (!userMessageContainer) {
    throw new Error("Expected a user-authored message container");
  }
  expect(literalText).toBeVisible();
  expect(userMessageContainer.querySelector("img")).toBeNull();
  expect(
    userMessageContainer.querySelector('[data-testid^="attachment-preview-"]'),
  ).toBeNull();
});

async function setupMarkdownDiagramAttachments(): Promise<void> {
  const files = [
    { id: "diagram-first", filename: "first.md", label: "First" },
    { id: "diagram-second", filename: "second.md", label: "Second" },
  ];
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(
        userMessage(
          files.map((file) => {
            return filePart(file.id, file.filename, "text/markdown");
          }),
        ),
      ),
    ],
    artifacts: files.map((file) => {
      return artifactFile(file.filename, {
        id: file.id,
        contentType: "text/markdown",
        url: publicArtifactUrl(file.filename),
      });
    }),
  });
  mockPrivateUrlSequence(
    context,
    Object.fromEntries(
      files.map((file) => {
        return [file.id, [publicArtifactUrl(file.filename)]];
      }),
    ),
  );
  for (const file of files) {
    context.mocks.http.get(publicArtifactUrl(file.filename), () => {
      return HttpResponse.text(
        `# ${file.label} notes\n\n\`\`\`mermaid\nflowchart LR\n  ${file.label} --> Preview\n\`\`\``,
      );
    });
  }
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  await findNamedButton("Open markdown preview for first.md");
}

test("Markdown diagrams get fresh URLs when reopened or moved to split view", async () => {
  const browser = context.mocks.browser.blobDownload();
  await setupMarkdownDiagramAttachments();

  click(getNamedButton("Open markdown preview for first.md"));
  const firstImage = await screen.findByRole("img", { name: "Diagram" });
  const firstUrl = firstImage.getAttribute("src");
  if (!firstUrl) {
    throw new Error("Expected the Markdown preview diagram URL");
  }
  const firstSvg = await browser.blobForUrl(firstUrl)?.text();
  expect(browser.blobForUrl(firstUrl)?.type).toBe("image/svg+xml");

  await closeFocusedPreview();
  expect(browser.revokedUrls).toContain(firstUrl);

  click(getNamedButton("Open markdown preview for first.md"));
  const reopened = await screen.findByRole("img", { name: "Diagram" });
  const reopenedUrl = reopened.getAttribute("src");
  expect(reopenedUrl).toMatch(/^blob:/);
  expect(reopenedUrl).not.toBe(firstUrl);

  click(getNamedButton("Open in split view"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  const splitImage = await within(sidebar).findByRole("img", {
    name: "Diagram",
  });
  const splitUrl = splitImage.getAttribute("src");
  if (!splitUrl) {
    throw new Error("Expected the split view diagram URL");
  }
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
  });
  expect(browser.revokedUrls).toContain(reopenedUrl);
  expect(splitUrl).not.toBe(reopenedUrl);
  expect(browser.revokedUrls).not.toContain(splitUrl);
  await expect(browser.blobForUrl(splitUrl)?.text()).resolves.toBe(firstSvg);
});

test("Closing a Markdown preview during layout does not allocate an abandoned image URL", async () => {
  const browser = context.mocks.browser.blobDownload();
  const createUrl = vi.spyOn(URL, "createObjectURL");
  const layoutStarted = context.mocks.deferred<void>();
  const renderGate = context.mocks.deferred<void>();
  const renderDiagram = mermaid.render.bind(mermaid);
  vi.spyOn(mermaid, "render").mockImplementationOnce(async (...args) => {
    layoutStarted.resolve();
    await renderGate.promise;
    return await renderDiagram(...args);
  });
  await setupMarkdownDiagramAttachments();

  click(getNamedButton("Open markdown preview for first.md"));
  await expect(screen.findByText("First notes")).resolves.toBeInTheDocument();
  expect(getNamedButton("Expand diagram")).toBeDisabled();
  await layoutStarted.promise;
  await closeFocusedPreview();

  click(getNamedButton("Open markdown preview for second.md"));
  await expect(screen.findByText("Second notes")).resolves.toBeInTheDocument();
  renderGate.resolve();

  const image = await screen.findByRole("img", { name: "Diagram" });
  const url = image.getAttribute("src");
  if (!url) {
    throw new Error("Expected the active preview diagram URL");
  }
  expect(browser.blobForUrl(url)?.type).toBe("image/svg+xml");
  const activeSvg = await browser.blobForUrl(url)?.text();
  const allocatedDiagrams = createUrl.mock.calls.flatMap(([blob], index) => {
    const result = createUrl.mock.results[index];
    if (
      !(blob instanceof File) ||
      blob.name !== "diagram.svg" ||
      result?.type !== "return"
    ) {
      return [];
    }
    return [{ file: blob, url: result.value }];
  });
  // Ref replay can allocate more than one URL for the active image. None
  // may belong to the closed preview, and every replaced URL must be freed.
  const allocatedSvgs = await Promise.all(
    allocatedDiagrams.map(({ file }) => {
      return file.text();
    }),
  );
  expect(new Set(allocatedSvgs)).toStrictEqual(new Set([activeSvg]));
  const replacedUrls = allocatedDiagrams.flatMap((diagram) => {
    return diagram.url === url ? [] : [diagram.url];
  });
  expect(browser.revokedUrls).toStrictEqual(
    expect.arrayContaining(replacedUrls),
  );
  expect(browser.revokedUrls).not.toContain(url);
});
