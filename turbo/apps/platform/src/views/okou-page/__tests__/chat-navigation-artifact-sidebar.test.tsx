import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import type {
  ArtifactCatalogListQuery,
  ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  artifactSummary,
  artifactRun,
  buttonNamed,
  fileArtifactDetail,
  hostedSiteArtifactDetail,
  imageArtifactDetail,
  liveBrowserSession,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();

const EMPTY_CSV_ID = "a0000000-0000-4000-a000-000000000930";
const UNAVAILABLE_CSV_ID = "a0000000-0000-4000-a000-000000000931";
const MARKDOWN_ID = "a0000000-0000-4000-a000-000000000932";
const HOSTED_SITE_ID = "a0000000-0000-4000-a000-000000000933";
const IMAGE_ID = "a0000000-0000-4000-a000-000000000934";
const THREAD_FILE_ID = "a0000000-0000-4000-a000-000000000935";
const DELETED_ID = "a0000000-0000-4000-a000-000000000936";

const EMPTY_CSV_FILE_ID = "f0000000-0000-4000-a000-000000000930";
const UNAVAILABLE_CSV_FILE_ID = "f0000000-0000-4000-a000-000000000931";
const MARKDOWN_FILE_ID = "f0000000-0000-4000-a000-000000000932";
const HOSTED_SITE_RECORD_ID = "f0000000-0000-4000-a000-000000000933";
const IMAGE_FILE_ID = "f0000000-0000-4000-a000-000000000934";

const EMPTY_CSV_URL = "https://files.example.test/empty.csv";
const UNAVAILABLE_CSV_URL = "https://files.example.test/unavailable.csv";
const MARKDOWN_URL = "https://files.example.test/architecture.md";
const HOSTED_SITE_URL = "https://launch-site.example.test/";
const IMAGE_URL = "https://files.example.test/launch-graphic.png";

function useWideScreen(): void {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
}

function artifactList(): HTMLElement {
  return screen.getByTestId("thread-sidebar-artifacts");
}

function artifactPreview(): HTMLElement {
  return screen.getByTestId("artifact-sidebar");
}

function openArtifactsControl(): HTMLElement {
  return buttonNamed("Open artifacts");
}

function officeFileEvents(
  fileId: string,
  filename: string,
  contentType: string,
): MockChatEventInput[] {
  return [
    {
      id: `message-${fileId}`,
      role: "user",
      content: "Review this Office document",
      fileParts: [
        {
          type: "file",
          fileId,
          filenameSnapshot: filename,
          contentType,
        },
      ],
      runId: "office-preview-run",
      seqId: 1,
      createdAt: "2026-09-01T12:00:00.000Z",
    },
    {
      id: `message-${fileId}-completed`,
      role: "assistant",
      content: null,
      runId: "office-preview-run",
      runLifecycleEvent: "completed",
      seqId: 2,
      createdAt: "2026-09-01T12:00:01.000Z",
    },
  ];
}

async function setupGeneratedFilePreview(
  filename: string,
  contentType: string,
  url = `https://cdn.vm7.io/artifacts/tests/office/${filename}`,
): Promise<string> {
  mockArtifactConversation(context, {
    catalog: [],
    artifactRuns: () => {
      return [
        artifactRun({
          contentType,
          fileId: `file-${filename}`,
          filename,
          url,
        }),
      ];
    },
    chatEvents: [
      {
        id: `message-${filename}`,
        role: "assistant",
        content: `![${filename}](${url})`,
        runId: "navigation-artifact-run",
        seqId: 1,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
      {
        id: `message-${filename}-completed`,
        role: "assistant",
        content: null,
        runId: "navigation-artifact-run",
        runLifecycleEvent: "completed",
        seqId: 2,
        createdAt: "2026-09-01T12:00:01.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  return url;
}

function expectOfficeViewerUrl(frame: HTMLElement, sourceUrl: string): void {
  const frameUrl = frame.getAttribute("src");
  if (!frameUrl) {
    throw new Error("Office preview iframe has no source URL");
  }
  const parsed = new URL(frameUrl);
  expect(parsed.origin).toBe("https://view.officeapps.live.com");
  expect(parsed.pathname).toBe("/op/embed.aspx");
  expect(parsed.searchParams.get("src")).toBe(sourceUrl);
}

warmMermaidParser();

test("Keep attachment cards closed until the user selects one", async () => {
  useWideScreen();
  mockArtifactConversation(context, {
    catalog: [],
    activeRunIds: ["navigation-running-work"],
    chatEvents: [
      {
        id: "navigation-completed-user",
        role: "user",
        content: "Create the completed report",
        runId: "navigation-completed-work",
        seqId: 1,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
      {
        id: "navigation-completed-artifact",
        role: "assistant",
        content: "![completed.pdf](/f/navigation/completed/completed.pdf)",
        runId: "navigation-completed-work",
        runEventId: "completed-artifact-event",
        sequenceNumber: 1,
        seqId: 2,
        createdAt: "2026-09-01T12:00:01.000Z",
      },
      {
        id: "navigation-completed-marker",
        eventType: "run.completed",
        content: null,
        runId: "navigation-completed-work",
        seqId: 3,
        createdAt: "2026-09-01T12:00:01.500Z",
      },
      {
        id: "navigation-running-user",
        role: "user",
        content: "Create the running report",
        runId: "navigation-running-work",
        seqId: 4,
        createdAt: "2026-09-01T12:00:02.000Z",
      },
      {
        id: "navigation-running-artifact",
        role: "assistant",
        content: "![running.pdf](/f/navigation/running/running.pdf)",
        runId: "navigation-running-work",
        runEventId: "running-artifact-event",
        sequenceNumber: 1,
        seqId: 5,
        createdAt: "2026-09-01T12:00:03.000Z",
      },
    ],
  });

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    const cards = document.querySelectorAll(
      'a[data-testid="attachment-preview-pdf"]',
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAccessibleName("Open pdf preview for completed.pdf");
    expect(cards[1]).toHaveAccessibleName("Open pdf preview for running.pdf");
    expect(cards[0]).toBeVisible();
    expect(cards[1]).toBeVisible();
  });

  expect(
    document.querySelector('[data-testid="artifact-sidebar"]'),
  ).not.toBeInTheDocument();
  expect(
    document.querySelector('[data-testid="thread-sidebar-artifacts"]'),
  ).not.toBeInTheDocument();
});

test("Preview a DOCX attachment in the dialog and split view", async () => {
  const filename = "release-plan.docx";
  const url = await setupGeneratedFilePreview(
    filename,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  click(await screen.findByLabelText(`Preview ${filename}`));

  const dialog = await screen.findByTestId("attachment-lightbox");
  const dialogFrame = await within(dialog).findByTitle(`${filename} preview`);
  expect(dialogFrame).toBeVisible();
  expectOfficeViewerUrl(dialogFrame, url);
  click(buttonNamed("Open in split view", dialog));

  const splitView = await screen.findByTestId("artifact-sidebar");
  const splitFrame = await within(splitView).findByTitle(`${filename} preview`);
  expect(splitFrame).toBeVisible();
  expectOfficeViewerUrl(splitFrame, url);
});

test("Preview a PPTX attachment in the dialog and split view", async () => {
  const filename = "quarterly-review.pptx";
  const url = await setupGeneratedFilePreview(
    filename,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );

  click(await screen.findByLabelText(`Preview ${filename}`));

  const dialog = await screen.findByTestId("attachment-lightbox");
  const dialogFrame = await within(dialog).findByTitle(`${filename} preview`);
  expect(dialogFrame).toBeVisible();
  expectOfficeViewerUrl(dialogFrame, url);
  click(buttonNamed("Open in split view", dialog));

  const splitView = await screen.findByTestId("artifact-sidebar");
  const splitFrame = await within(splitView).findByTitle(`${filename} preview`);
  expect(splitFrame).toBeVisible();
  expectOfficeViewerUrl(splitFrame, url);
});

test("Preview an XLSX attachment in the dialog and split view", async () => {
  const filename = "launch-budget.xlsx";
  const url = await setupGeneratedFilePreview(
    filename,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );

  click(await screen.findByLabelText(`Preview ${filename}`));

  const dialog = await screen.findByTestId("attachment-lightbox");
  const dialogFrame = await within(dialog).findByTitle(`${filename} preview`);
  expect(dialogFrame).toBeVisible();
  expectOfficeViewerUrl(dialogFrame, url);
  click(buttonNamed("Open in split view", dialog));

  const splitView = await screen.findByTestId("artifact-sidebar");
  const splitFrame = await within(splitView).findByTitle(`${filename} preview`);
  expect(splitFrame).toBeVisible();
  expectOfficeViewerUrl(splitFrame, url);
});

test("Use a public URL for a private Office attachment preview", async () => {
  const fileId = "office-private-file";
  const filename = "private-plan.docx";
  const contentType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const privateUrl = `https://storage.example.test/${filename}?signature=test`;
  const publicUrl = `https://cdn.vm7.io/artifacts/tests/office/${filename}`;
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    expect(query.file_id).toBe(fileId);
    return respond(200, {
      url: privateUrl,
      publicUrl,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: officeFileEvents(fileId, filename, contentType),
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  click(await screen.findByLabelText(`Preview ${filename}`));

  const dialog = await screen.findByTestId("attachment-lightbox");
  const frame = await within(dialog).findByTitle(`${filename} preview`);
  expectOfficeViewerUrl(frame, publicUrl);
  expect(frame.getAttribute("src")).not.toContain(privateUrl);
});

test("Preserve private and public attachments on tab return", async () => {
  const fileId = "f0000000-0000-4000-a000-000000000936";
  const filename = "private-plan.docx";
  const contentType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const firstUrl = `https://storage.example.test/${filename}?signature=first`;
  const refreshedUrl = `https://storage.example.test/${filename}?signature=refreshed`;
  const publicFileId = "f0000000-0000-4000-a000-000000000937";
  const publicFilename = "existing-image.png";
  const publicUrl = `https://cdn.vm7.io/artifacts/tests/${publicFilename}`;
  const storageOrigin = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
  const firstPublicResourceUrl = `${storageOrigin}/uploads/${publicFilename}?X-Amz-Signature=first`;
  const publicThumbnailUrl = `https://a.okou.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/${firstPublicResourceUrl}`;
  let publicResourceUrl = firstPublicResourceUrl;
  let resourceUrl = firstUrl;
  const visibility = context.mocks.browser.visibilityState("visible");
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    if (query.file_id === publicFileId) {
      return respond(200, {
        url: publicResourceUrl,
        publicUrl,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }
    expect(query.file_id).toBe(fileId);
    return respond(200, {
      url: resourceUrl,
      publicUrl: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: [
      ...officeFileEvents(fileId, filename, contentType),
      {
        id: "existing-public-image",
        role: "assistant",
        content: `![${publicFilename}](https://api.okou.ai/api/web/download-file?file_id=${publicFileId}&filename=${publicFilename})`,
        runId: "office-preview-run",
        seqId: 3,
        createdAt: "2026-09-01T12:00:02.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  const publicImage = await screen.findByAltText(publicFilename);
  expect(publicImage).toHaveAttribute("src", publicThumbnailUrl);
  click(await screen.findByLabelText(`Preview ${filename}`));
  const dialog = await screen.findByTestId("attachment-lightbox");
  const frame = await within(dialog).findByTitle(`${filename} preview`);
  expectOfficeViewerUrl(frame, firstUrl);
  expect(within(dialog).queryByLabelText(/^share$/i)).not.toBeInTheDocument();

  act(() => {
    visibility.changeTo("hidden");
  });
  resourceUrl = refreshedUrl;
  publicResourceUrl = `${storageOrigin}/uploads/${publicFilename}?X-Amz-Signature=refreshed`;
  await act(() => {
    visibility.changeTo("visible");
  });
  await waitFor(() => {
    const refreshedFrame = within(dialog).getByTitle(`${filename} preview`);
    expect(refreshedFrame).toBeVisible();
    expectOfficeViewerUrl(refreshedFrame, firstUrl);
  });
  expect(screen.getByAltText(publicFilename)).toHaveAttribute(
    "src",
    publicThumbnailUrl,
  );
});

test("Render a generated private image from the authenticated file reference", async () => {
  const filename = "private-image.png";
  const fileId = "f0000000-0000-4000-a000-000000000938";
  const resourceUrl =
    "https://private-r2.example/private-image.png?signature=image";
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      expect(params.reference).toBe(
        artifactReferencePath(fileId, filename).slice("/artifacts/".length),
      );
      return respond(200, {
        url: resourceUrl,
        expiresAt: "2099-01-01T00:00:00Z",
        filename,
        contentType: "image/png",
        target: { kind: "file", id: fileId },
      });
    },
  );
  await setupGeneratedFilePreview(
    filename,
    "image/png",
    artifactReferencePath(fileId, filename),
  );
  const embedded = await screen.findByAltText(filename);
  expect(embedded).toHaveAttribute("src", resourceUrl);
  click(embedded);
  const dialog = await screen.findByTestId("attachment-lightbox");
  expect(
    within(dialog).getByTestId("attachment-lightbox-image"),
  ).toHaveAttribute("src", resourceUrl);
  expect(within(dialog).queryByLabelText(/^share$/i)).not.toBeInTheDocument();
});

test.each(["https://a.okou.io", "https://files.sites.vm7.io"])(
  "public CDN images use the file viewer on %s",
  async (origin) => {
    const filename = "shared-image.png";
    const url = `${origin}/${"a".repeat(24)}.png`;
    await setupGeneratedFilePreview(filename, "image/png", url);
    const image = await screen.findByAltText(filename);
    expect(image).toHaveAttribute("src", url);
    click(image);
    const dialog = await screen.findByTestId("attachment-lightbox");
    expect(
      within(dialog).getByTestId("attachment-lightbox-image"),
    ).toHaveAttribute("src", url);
  },
);

test("Explain empty and unavailable CSV previews", async () => {
  useWideScreen();
  const empty = artifactSummary(EMPTY_CSV_ID, "file", "Empty export.csv");
  const unavailable = artifactSummary(
    UNAVAILABLE_CSV_ID,
    "file",
    "Unavailable export.csv",
  );
  const details = new Map<string, ArtifactDetail>([
    [
      EMPTY_CSV_ID,
      fileArtifactDetail(empty, {
        contentType: "text/csv",
        fileId: EMPTY_CSV_FILE_ID,
        filename: "empty.csv",
        url: EMPTY_CSV_URL,
      }),
    ],
    [
      UNAVAILABLE_CSV_ID,
      fileArtifactDetail(unavailable, {
        contentType: "text/csv",
        fileId: UNAVAILABLE_CSV_FILE_ID,
        filename: "unavailable.csv",
        url: UNAVAILABLE_CSV_URL,
      }),
    ],
  ]);
  context.mocks.http.get(EMPTY_CSV_URL, () => {
    return new Response("", { status: 200 });
  });
  context.mocks.http.get(UNAVAILABLE_CSV_URL, () => {
    return new Response("Preview source unavailable", { status: 503 });
  });
  mockArtifactConversation(context, {
    catalog: [empty, unavailable],
    details,
  });

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(openArtifactsControl()).toBeVisible();
  });
  click(openArtifactsControl());
  await waitFor(() => {
    expect(
      buttonNamed("Preview Empty export.csv", artifactList()),
    ).toBeVisible();
    expect(
      buttonNamed("Preview Unavailable export.csv", artifactList()),
    ).toBeVisible();
  });

  click(buttonNamed("Preview Empty export.csv", artifactList()));
  await waitFor(() => {
    expect(within(artifactPreview()).getByText("Empty CSV.")).toBeVisible();
  });

  click(buttonNamed("Back to all artifacts", artifactPreview()));
  await waitFor(() => {
    expect(
      buttonNamed("Preview Unavailable export.csv", artifactList()),
    ).toBeVisible();
  });
  click(buttonNamed("Preview Unavailable export.csv", artifactList()));
  await waitFor(() => {
    expect(
      within(artifactPreview()).getByText("CSV preview unavailable."),
    ).toBeVisible();
  });
});

test("Expand a diagram from a Markdown artifact", async () => {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1600,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    900,
  );
  useWideScreen();
  const summary = artifactSummary(MARKDOWN_ID, "file", "Architecture notes.md");
  context.mocks.http.get(MARKDOWN_URL, () => {
    return new Response(
      "# Deployment flow\n\n```mermaid\nflowchart LR\n  Build --> Deploy\n```",
      {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      },
    );
  });
  mockArtifactConversation(context, {
    catalog: [summary],
    details: new Map([
      [
        MARKDOWN_ID,
        fileArtifactDetail(summary, {
          contentType: "text/markdown",
          fileId: MARKDOWN_FILE_ID,
          filename: "architecture.md",
          url: MARKDOWN_URL,
        }),
      ],
    ]),
  });

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(openArtifactsControl()).toBeVisible();
  });
  click(openArtifactsControl());
  await waitFor(() => {
    expect(
      buttonNamed("Preview Architecture notes.md", artifactList()),
    ).toBeVisible();
  });
  click(buttonNamed("Preview Architecture notes.md", artifactList()));
  await waitFor(() => {
    expect(buttonNamed("Expand diagram", artifactPreview())).toBeEnabled();
    expect(
      artifactPreview().querySelector('[data-mermaid-status="rendered"]'),
    ).toBeVisible();
  });

  click(buttonNamed("Expand diagram", artifactPreview()));
  await waitFor(() => {
    const expanded = within(artifactPreview()).getByAltText("diagram.svg");
    expect(expanded).toBeVisible();
    expect(expanded).toHaveAttribute(
      "data-testid",
      "artifact-sidebar-body-image",
    );
    expect(
      artifactPreview().querySelector('[data-mermaid-status="rendered"]'),
    ).not.toBeInTheDocument();
  });
});

test("Preview a hosted site artifact in the thread sidebar", async () => {
  useWideScreen();
  const summary = artifactSummary(HOSTED_SITE_ID, "hosted-site", "Launch site");
  mockArtifactConversation(context, {
    catalog: [summary],
    details: new Map([
      [
        HOSTED_SITE_ID,
        hostedSiteArtifactDetail(summary, {
          siteId: HOSTED_SITE_RECORD_ID,
          slug: "launch-site",
          url: HOSTED_SITE_URL,
        }),
      ],
    ]),
  });

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(openArtifactsControl()).toBeVisible();
  });
  click(openArtifactsControl());
  await waitFor(() => {
    expect(buttonNamed("Preview Launch site", artifactList())).toBeVisible();
  });
  click(buttonNamed("Preview Launch site", artifactList()));

  await waitFor(() => {
    const frame = artifactPreview().querySelector(
      '[data-testid="artifact-sidebar-body-html"]',
    );
    expect(frame).toBeInstanceOf(HTMLIFrameElement);
    expect(frame).toBeVisible();
    expect(frame).toHaveAttribute("src", HOSTED_SITE_URL);
    expect(frame).toHaveAccessibleName("Launch site preview");
  });
});

test("Zoom and reset an image artifact preview", async () => {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1600,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    900,
  );
  useWideScreen();
  const summary = artifactSummary(IMAGE_ID, "image", "Launch graphic");
  mockArtifactConversation(context, {
    catalog: [summary],
    details: new Map([
      [
        IMAGE_ID,
        imageArtifactDetail(summary, {
          fileId: IMAGE_FILE_ID,
          filename: "launch-graphic.png",
          url: IMAGE_URL,
        }),
      ],
    ]),
  });

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(openArtifactsControl()).toBeVisible();
  });
  click(openArtifactsControl());
  await waitFor(() => {
    expect(buttonNamed("Preview Launch graphic", artifactList())).toBeVisible();
  });
  click(buttonNamed("Preview Launch graphic", artifactList()));

  await waitFor(() => {
    expect(
      within(artifactPreview()).getByAltText("launch-graphic.png"),
    ).toBeVisible();
    expect(buttonNamed("Zoom in", artifactPreview())).toBeVisible();
    expect(buttonNamed("Zoom out", artifactPreview())).toBeVisible();
    expect(buttonNamed("Reset zoom", artifactPreview())).toBeVisible();
    expect(
      within(artifactPreview()).getByTestId(
        "artifact-sidebar-image-zoom-level",
      ),
    ).toHaveTextContent("100%");
  });

  click(buttonNamed("Zoom in", artifactPreview()));
  await waitFor(() => {
    expect(
      within(artifactPreview()).getByTestId(
        "artifact-sidebar-image-zoom-level",
      ),
    ).toHaveTextContent("115%");
  });

  click(buttonNamed("Reset zoom", artifactPreview()));
  await waitFor(() => {
    expect(
      within(artifactPreview()).getByTestId(
        "artifact-sidebar-image-zoom-level",
      ),
    ).toHaveTextContent("100%");
  });
});

test("Keep the utility sidebar selected by the user", async () => {
  useWideScreen();
  const chatEvents: MockChatEventInput[] = [];
  let browserStarted = false;
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents,
    browserSession: () => {
      return browserStarted ? liveBrowserSession() : null;
    },
  });

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(openArtifactsControl()).toBeVisible();
  });
  click(openArtifactsControl());
  await waitFor(() => {
    expect(artifactList()).toBeVisible();
    expect(
      context.mocks.ably.hasSubscription("browserSessionChanged"),
    ).toBeTruthy();
  });

  browserStarted = true;
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: NAVIGATION_ARTIFACT_THREAD_ID,
  });
  chatEvents.push(
    {
      id: "navigation-background-browser-open",
      eventType: "browser.open",
      content: null,
      runId: undefined,
      seqId: 1,
      createdAt: "2026-09-01T12:02:00.000Z",
    },
    {
      id: "navigation-background-browser-card",
      role: "assistant",
      content: `[Background research browser](/browsers/${NAVIGATION_ARTIFACT_THREAD_ID})`,
      runId: "navigation-background-browser-run",
      runEventId: "navigation-background-browser-card-event",
      sequenceNumber: 1,
      seqId: 2,
      createdAt: "2026-09-01T12:02:01.000Z",
    },
  );
  act(() => {
    createChatEvent(NAVIGATION_ARTIFACT_THREAD_ID);
  });

  await waitFor(() => {
    const browserCard = document.querySelector("[data-browser-session-card]");
    expect(browserCard).toBeVisible();
    expect(browserCard).toHaveAccessibleName(
      "Open background-research browser",
    );
    expect(artifactList()).toBeVisible();
    expect(
      document.querySelector("[data-browser-session-sidebar]"),
    ).not.toBeInTheDocument();
  });
});

test("Show artifacts that belong to the current thread", async () => {
  useWideScreen();
  const summary = artifactSummary(
    THREAD_FILE_ID,
    "file",
    "Thread release notes.txt",
  );
  const listQueries: ArtifactCatalogListQuery[] = [];
  mockArtifactConversation(context, {
    catalog: [summary],
    onCatalogList: (query) => {
      listQueries.push(query);
    },
  });

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(openArtifactsControl()).toBeVisible();
  });
  click(openArtifactsControl());

  await waitFor(() => {
    expect(artifactList()).toBeVisible();
    expect(
      within(artifactList()).getByText("Thread release notes.txt"),
    ).toBeVisible();
    expect(
      buttonNamed("Preview Thread release notes.txt", artifactList()),
    ).toBeVisible();
    expect(listQueries).toContainEqual(
      expect.objectContaining({
        chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID,
      }),
    );
  });
});

test("Return to the artifact list when a preview is unavailable", async () => {
  useWideScreen();
  const summary = artifactSummary(DELETED_ID, "file", "Deleted report.txt");
  mockArtifactConversation(context, {
    catalog: [summary],
    details: new Map([[DELETED_ID, null]]),
  });

  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(openArtifactsControl()).toBeVisible();
  });
  click(openArtifactsControl());
  await waitFor(() => {
    expect(
      buttonNamed("Preview Deleted report.txt", artifactList()),
    ).toBeVisible();
  });
  click(buttonNamed("Preview Deleted report.txt", artifactList()));

  await waitFor(() => {
    const unavailable = screen.getByTestId(
      "thread-sidebar-artifact-unavailable",
    );
    expect(
      within(unavailable).getByText("This artifact is no longer available."),
    ).toBeVisible();
    expect(buttonNamed("Back to artifacts", unavailable)).toBeVisible();
  });

  click(
    buttonNamed(
      "Back to artifacts",
      screen.getByTestId("thread-sidebar-artifact-unavailable"),
    ),
  );
  await waitFor(() => {
    expect(artifactList()).toBeVisible();
    expect(
      buttonNamed("Preview Deleted report.txt", artifactList()),
    ).toBeVisible();
  });
});
