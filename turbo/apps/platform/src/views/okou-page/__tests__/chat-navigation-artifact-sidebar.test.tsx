import type { ArtifactCatalogListQuery } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  artifactRun,
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  hostedSiteArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();

const MARKDOWN_ID = "a0000000-0000-4000-a000-000000000932";
const HOSTED_SITE_ID = "a0000000-0000-4000-a000-000000000933";
const THREAD_FILE_ID = "a0000000-0000-4000-a000-000000000935";
const MARKDOWN_FILE_ID = "f0000000-0000-4000-a000-000000000932";
const HOSTED_SITE_RECORD_ID = "f0000000-0000-4000-a000-000000000933";
const MARKDOWN_URL = "https://files.example.test/architecture.md";
const HOSTED_SITE_URL = "https://launch-site.example.test/";

warmMermaidParser();

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

function resourcesControl(): HTMLElement {
  return buttonNamed("Artifacts and chats");
}

function menuItemNamed(name: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected menu item ${name}`);
  }
  return item;
}

async function openChat(): Promise<void> {
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
}

async function showGeneratedAttachment(
  filename: string,
  contentType: string,
  url: string,
): Promise<void> {
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
  await openChat();
}

function expectOfficeViewer(frame: HTMLElement, sourceUrl: string): void {
  expect(frame).toBeVisible();
  const parsed = new URL(frame.getAttribute("src") ?? "");
  expect(parsed.origin).toBe("https://view.officeapps.live.com");
  expect(parsed.pathname).toBe("/op/embed.aspx");
  expect(parsed.searchParams.get("src")).toBe(sourceUrl);
}

function expectKeyboardFocusableOfficeViewer(
  frame: HTMLElement,
  sourceUrl: string,
): void {
  expectOfficeViewer(frame, sourceUrl);
  expect(frame).not.toHaveAttribute("tabindex", "-1");
  frame.focus();
  expect(frame).toHaveFocus();
}

async function previewInDialogThenSplitView(
  filename: string,
  contentType: string,
  expectPreview: (frame: HTMLElement, sourceUrl: string) => void,
): Promise<void> {
  const url = `https://cdn.vm7.io/artifacts/tests/office/${filename}`;
  await showGeneratedAttachment(filename, contentType, url);

  click(await screen.findByLabelText(`Preview ${filename}`));

  const dialog = await screen.findByTestId("attachment-lightbox");
  expectPreview(await within(dialog).findByTitle(`${filename} preview`), url);
  click(buttonNamed("Open in split view", dialog));

  const splitView = await screen.findByTestId("artifact-sidebar");
  expectPreview(
    await within(splitView).findByTitle(`${filename} preview`),
    url,
  );
}

test("A DOCX attachment previews in the Office viewer in the dialog and split view", async () => {
  await previewInDialogThenSplitView(
    "release-plan.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    expectKeyboardFocusableOfficeViewer,
  );
  expect(screen.getByTestId("artifact-sidebar")).toBeVisible();
});

test("A PPTX attachment previews in the Office viewer in the dialog and split view", async () => {
  await previewInDialogThenSplitView(
    "quarterly-review.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    expectKeyboardFocusableOfficeViewer,
  );
  expect(screen.getByTestId("artifact-sidebar")).toBeVisible();
});

test("An XLSX attachment previews in the Office viewer in the dialog and split view", async () => {
  await previewInDialogThenSplitView(
    "launch-budget.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    expectOfficeViewer,
  );
  expect(screen.getByTestId("artifact-sidebar")).toBeVisible();
});

test("A public image uses a protected thumbnail and opens its original", async () => {
  const filename = "shared-image.png";
  const url = "https://a.okou.io/a1b2c3d4e5.png";
  await showGeneratedAttachment(filename, "image/png", url);

  const image = await screen.findByAltText(filename);
  expect(image).toHaveAttribute(
    "src",
    `${url}?thumbnail=1&width=800&height=720&fit=scale-down&quality=85`,
  );
  click(image);

  const dialog = await screen.findByTestId("attachment-lightbox");
  expect(
    within(dialog).getByTestId("attachment-lightbox-image"),
  ).toHaveAttribute("src", url);
});

test("An expanded Markdown diagram closes back into the fullscreen document", async () => {
  const browser = context.mocks.browser.blobDownload();
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
      { status: 200, headers: { "Content-Type": "text/markdown" } },
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
  await openChat();
  await openResourceArtifact("Architecture notes.md");
  await waitFor(() => {
    expect(buttonNamed("Expand diagram", artifactPreview())).toBeEnabled();
    expect(
      artifactPreview().querySelector('[data-mermaid-status="rendered"]'),
    ).toBeVisible();
  });
  const inlineUrl =
    within(artifactPreview())
      .getByRole("img", { name: "Diagram" })
      .getAttribute("src") ?? "";
  const inlineSvg = await browser.blobForUrl(inlineUrl)?.text();

  click(buttonNamed("Enter fullscreen", artifactPreview()));
  await waitFor(() => {
    expect(
      buttonNamed("Exit fullscreen", artifactPreview()),
    ).toBeInTheDocument();
  });
  click(within(artifactPreview()).getByText("Diagram source"));
  const trigger = buttonNamed("Expand diagram", artifactPreview());
  click(trigger);

  const diagram = await screen.findByTestId("artifact-diagram-lightbox");
  const expandedUrl =
    (await within(diagram).findByAltText("diagram.svg")).getAttribute("src") ??
    "";
  expect(expandedUrl).not.toBe(inlineUrl);
  await expect(browser.blobForUrl(expandedUrl)?.text()).resolves.toBe(
    inlineSvg,
  );
  expect(browser.revokedUrls).not.toContain(expandedUrl);

  click(buttonNamed("Close", diagram));
  await waitFor(() => {
    expect(
      screen.queryByTestId("artifact-diagram-lightbox"),
    ).not.toBeInTheDocument();
  });
  expect(browser.revokedUrls).toContain(expandedUrl);
  expect(browser.revokedUrls).not.toContain(inlineUrl);
  expect(trigger).toHaveFocus();
  expect(buttonNamed("Exit fullscreen", artifactPreview())).toBeInTheDocument();
  expect(
    within(artifactPreview()).getByText("Diagram source").closest("details"),
  ).toHaveAttribute("open");

  await userEvent.keyboard("{Escape}");
  expect(within(artifactPreview()).getByRole("document")).toHaveFocus();
  expect(buttonNamed("Exit fullscreen", artifactPreview())).toBeInTheDocument();
});

test("A hosted site preview survives list and fullscreen changes until closed from its menu", async () => {
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
  await openChat();

  await openResourceArtifact("Launch site");
  await screen.findByTitle("Launch site preview");
  click(buttonNamed("Back to all artifacts", artifactPreview()));
  await screen.findByTestId("thread-sidebar-artifacts");
  click(buttonNamed("Enter fullscreen", artifactList()));
  await waitFor(() => {
    expect(buttonNamed("Exit fullscreen", artifactList())).toBeInTheDocument();
  });
  click(buttonNamed("Exit fullscreen", artifactList()));
  await waitFor(() => {
    expect(buttonNamed("Enter fullscreen", artifactList())).toBeInTheDocument();
  });
  click(buttonNamed("Preview Launch site", artifactList()));

  await waitFor(() => {
    const frame = within(artifactPreview()).getByTestId(
      "artifact-sidebar-body-html",
    );
    expect(frame).toBeVisible();
    expect(frame).toHaveAttribute("src", HOSTED_SITE_URL);
    expect(frame).toHaveAccessibleName("Launch site preview");
  });

  click(buttonNamed("Enter fullscreen", artifactPreview()));
  await waitFor(() => {
    expect(buttonNamed("Exit fullscreen", artifactPreview())).toBeVisible();
  });
  const fullscreenFrame = within(artifactPreview()).getByTestId(
    "artifact-sidebar-body-html",
  );
  expect(fullscreenFrame).toHaveAttribute("src", HOSTED_SITE_URL);
  expect(fullscreenFrame).toHaveAccessibleName("Launch site preview");
  click(buttonNamed("Exit fullscreen", artifactPreview()));
  await waitFor(() => {
    expect(buttonNamed("Enter fullscreen", artifactPreview())).toBeVisible();
  });
  click(buttonNamed("Enter fullscreen", artifactPreview()));
  await waitFor(() => {
    expect(buttonNamed("Exit fullscreen", artifactPreview())).toBeVisible();
  });
  click(buttonNamed("More artifact actions", artifactPreview()));
  click(
    await waitFor(() => {
      return menuItemNamed("Close preview menu");
    }),
  );

  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });
  expect(screen.queryByTitle("Launch site preview")).not.toBeInTheDocument();
  expect(resourcesControl()).toBeVisible();
});

test("Back to chats leaves the mobile artifact pane for the chat list", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(display-mode: standalone)";
  });
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
  await openChat();
  await openResourceArtifact("Launch site");
  await waitFor(() => {
    expect(screen.getByTitle("Launch site preview")).toBeVisible();
    expect(screen.getByLabelText("Back to chats")).toBeVisible();
  });
  const backToChats = screen.getByLabelText("Back to chats");
  const chatsPath = backToChats.getAttribute("href");

  click(backToChats);

  await waitFor(() => {
    expect(window.location.pathname).toBe(chatsPath);
  });
  expect(screen.queryByTitle("Launch site preview")).not.toBeInTheDocument();
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  expect(
    screen.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
});

test("Artifacts and chats lists the current thread's artifacts", async () => {
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
  await openChat();
  await waitFor(() => {
    expect(resourcesControl()).toBeVisible();
  });

  click(resourcesControl());

  const resources = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  await waitFor(() => {
    expect(
      within(resources).getByText("Thread release notes.txt"),
    ).toBeVisible();
  });
  expect(listQueries).toContainEqual(
    expect.objectContaining({ chatThreadId: NAVIGATION_ARTIFACT_THREAD_ID }),
  );
});
