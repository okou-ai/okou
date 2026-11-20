import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { unzipSync } from "fflate";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { renderMarkdownDocx } from "../../../lib/markdown-docx/render.ts";
import type { DocumentExportRequest } from "../../../lib/message-pdf/types.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  artifactSummary,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  findWorkHistoryToggle,
  promptEvent,
  queryWorkHistoryToggle,
  readyChat,
  RUN_PATH,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const RUN_ID = "a0000000-0000-4000-a000-000000000281";

function artifactUrl(id: string, filename: string): string {
  return `https://cdn.vm7.io/artifacts/run-folding/${id}/${filename}`;
}

function assistantGroupFor(element: Element): HTMLElement {
  const group = element.closest<HTMLElement>('[data-role="assistant"]');
  if (!group) {
    throw new Error("Expected content inside one assistant response");
  }
  return group;
}

function expectDocumentOrder(...elements: readonly Element[]): void {
  for (let index = 1; index < elements.length; index += 1) {
    expect(
      elements[index - 1]!.compareDocumentPosition(elements[index]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
}

function myOkouAvatarButtons(): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return button.getAttribute("aria-label") === "My Okou";
  });
}

function namedLinks(name: string): HTMLElement[] {
  return queryAllByRoleFast("link").filter((link) => {
    return link.getAttribute("aria-label") === name;
  });
}

function queryNamedLink(name: string): HTMLElement | null {
  return namedLinks(name)[0] ?? null;
}

function findNamedLink(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const link = queryNamedLink(name);
    if (!link) {
      throw new Error(`Link ${name} was not visible`);
    }
    return link;
  });
}

function relatedArtifactRows(dialog: HTMLElement, url: string): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      `[data-chat-run-related-artifact-url="${url}"]`,
    ),
  );
}

function relatedArtifactRow(dialog: HTMLElement, url: string): HTMLElement {
  const rows = relatedArtifactRows(dialog, url);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function menuItemNamed(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("menuitem").find((item) => {
    return item.getAttribute("aria-label") === name;
  });
}

async function openRelatedArtifacts(): Promise<HTMLElement> {
  click(await screen.findByTestId("chat-run-related-artifacts-trigger"));
  return screen.findByTestId("chat-run-related-artifacts-dialog");
}

async function setupArtifactRun(
  outputEvents: ReturnType<typeof assistantEvent>[],
  sidebarPreviews = false,
  markdownFirstOutput = false,
): Promise<void> {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "artifact-projection-user",
        runId: RUN_ID,
        seqId: 1,
        text: "Prepare the artifact summary",
      }),
      ...outputEvents,
      completedEvent({
        id: "artifact-projection-complete",
        runId: RUN_ID,
        seqId: outputEvents.length + 2,
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: sidebarPreviews,
      [FeatureSwitchKey.MarkdownFirstOutput]: markdownFirstOutput,
    },
  });
  await readyChat();
}

test("Show format download items and report conversion failures in a toast", async () => {
  const markdownUrl = artifactUrl("generated-report", "summary.md");
  context.mocks.http.get(markdownUrl, () => {
    return new HttpResponse(null, { status: 500 });
  });
  await setupArtifactRun(
    [
      assistantEvent({
        id: "markdown-output-artifact",
        runId: RUN_ID,
        seqId: 2,
        text: `[summary.md](${markdownUrl})`,
      }),
      assistantEvent({
        id: "markdown-output-main",
        runId: RUN_ID,
        seqId: 3,
        text: "Final Markdown summary",
      }),
    ],
    false,
    true,
  );

  const dialog = await openRelatedArtifacts();
  const row = relatedArtifactRow(dialog, markdownUrl);
  const actions = row.parentElement?.parentElement;
  if (!actions) {
    throw new Error("Expected the generated Markdown artifact actions");
  }
  const exportButton = queryAllByRoleFast("button", actions).find((button) => {
    return button.getAttribute("aria-label") === "Download options";
  });
  if (!exportButton) {
    throw new Error("Expected Markdown export options on the artifact row");
  }
  click(exportButton);
  await waitFor(() => {
    expect(menuItemNamed("Download as PDF")).toBeDefined();
  });
  expect(menuItemNamed("Download as PDF")).toBeDefined();
  expect(menuItemNamed("Download as DOCX")).toBeDefined();
  const pdf = menuItemNamed("Download as PDF");
  if (!pdf) {
    throw new Error("Expected Markdown PDF download");
  }
  expect(pdf).toHaveTextContent("Download as PDF");
  click(pdf);
  const error = await screen.findByText(
    "Export failed. Select an export option to try again.",
  );
  expect(error.closest("[data-sonner-toast]")).toHaveAttribute(
    "data-type",
    "error",
  );
  expect(error.closest('[role="menu"]')).toBeNull();
  click(exportButton);
  await waitFor(() => {
    expect(menuItemNamed("Download as PDF")).toBeDefined();
  });
});

test("Download a Word export with document title styles without changing Markdown headings", async () => {
  const markdownUrl = artifactUrl("generated-preview", "summary.md");
  const headings = [
    ["Summary report", 1, "Title"],
    ["Chapter", 2, "Heading1"],
    ["Section", 3, "Heading2"],
    ["Subsection", 4, "Heading3"],
    ["Detail", 5, "Heading4"],
    ["Note", 6, "Heading5"],
    ["Appendix", 1, "Title"],
  ] as const;
  const source = [
    "# Summary **report**",
    "## Chapter",
    "### Section",
    "#### Subsection",
    "##### Detail",
    "###### Note",
    "# Appendix",
    "[Back to summary](#summary-report)",
    "[Back to chapter](#chapter)",
    "```markdown\n# Literal heading\n```",
  ].join("\n\n");
  const browser = context.mocks.browser.blobDownload();
  context.mocks.browser.dedicatedWorker(async (message) => {
    const request = message as DocumentExportRequest;
    if (!("kind" in request) || request.kind !== "docx") {
      throw new Error("Expected a DOCX export request");
    }
    return { ok: true, blob: await renderMarkdownDocx(request.input) };
  });
  context.mocks.http.get(markdownUrl, () => {
    return HttpResponse.text(source);
  });
  await setupArtifactRun(
    [
      assistantEvent({
        id: "markdown-preview-artifact",
        runId: RUN_ID,
        seqId: 2,
        text: `[summary.md](${markdownUrl})`,
      }),
      assistantEvent({
        id: "markdown-preview-main",
        runId: RUN_ID,
        seqId: 3,
        text: "Final Markdown preview summary",
      }),
    ],
    false,
    true,
  );

  const dialog = await openRelatedArtifacts();
  click(relatedArtifactRow(dialog, markdownUrl));
  const preview = await screen.findByTestId("attachment-lightbox");
  const title = await within(preview).findByRole("heading", {
    level: 1,
    name: "Summary report",
  });
  expect(title.querySelector("strong")).toHaveTextContent("report");
  for (const [name, level] of headings) {
    expect(
      within(preview).getByRole("heading", { level, name }),
    ).toBeInTheDocument();
  }
  const exportButton = queryAllByRoleFast("button", preview).find((button) => {
    return button.getAttribute("aria-label") === "Download options";
  });
  if (!exportButton) {
    throw new Error("Expected Markdown export options in the artifact preview");
  }
  click(exportButton);
  await waitFor(() => {
    expect(menuItemNamed("Download as PDF")).toBeDefined();
  });
  expect(menuItemNamed("Download as PDF")).toBeDefined();
  const docx = menuItemNamed("Download as DOCX");
  if (!docx) {
    throw new Error("Expected Markdown DOCX download");
  }
  expect(docx).toHaveTextContent("Download as DOCX");
  click(docx);
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  const [download] = browser.downloads;
  expect(download?.filename).toBe("summary.docx");
  const blob = download?.blob;
  if (!blob) {
    throw new Error("Expected a downloaded Word document");
  }
  const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const parser = new DOMParser();
  const documentXml = parser.parseFromString(
    new TextDecoder().decode(archive["word/document.xml"]),
    "application/xml",
  );
  const paragraphs = Array.from(documentXml.getElementsByTagName("w:p"));
  for (const [name, level, style] of headings) {
    const paragraph = paragraphs.find((candidate) => {
      return candidate.textContent === name;
    });
    expect(
      paragraph?.getElementsByTagName("w:pStyle")[0]?.getAttribute("w:val"),
    ).toBe(style);
    expect(
      within(preview).getByRole("heading", { level, name }),
    ).toBeInTheDocument();
  }
  const wordTitle = paragraphs.find((paragraph) => {
    return paragraph.textContent === "Summary report";
  });
  expect(wordTitle?.getElementsByTagName("w:b")).toHaveLength(1);
  const code = paragraphs.find((paragraph) => {
    return paragraph.textContent === "# Literal heading";
  });
  expect(code?.getElementsByTagName("w:pStyle")[0]?.getAttribute("w:val")).toBe(
    "SourceCode",
  );
  const bookmarks = Array.from(
    documentXml.getElementsByTagName("w:bookmarkStart"),
    (bookmark) => {
      return bookmark.getAttribute("w:name");
    },
  );
  const anchors = Array.from(
    documentXml.getElementsByTagName("w:hyperlink"),
    (link) => {
      return link.getAttribute("w:anchor");
    },
  );
  expect(bookmarks).toStrictEqual(
    expect.arrayContaining(["summary-report", "chapter"]),
  );
  expect(anchors).toStrictEqual(["summary-report", "chapter"]);
});

test("Expose an artifact referenced only by history from the main result actions", async () => {
  const reportUrl = artifactUrl("supporting-report", "supporting-report.pdf");
  await setupArtifactRun([
    assistantEvent({
      id: "history-only-artifact",
      runId: RUN_ID,
      seqId: 2,
      text: `Generated supporting evidence.\n\n![Report](${reportUrl})`,
    }),
    assistantEvent({
      id: "history-only-review",
      runId: RUN_ID,
      seqId: 3,
      text: "Reviewed the release notes.",
    }),
    assistantEvent({
      id: "history-only-validation",
      runId: RUN_ID,
      seqId: 4,
      text: "Validated the release artifacts.",
    }),
    assistantEvent({
      id: "history-only-readiness",
      runId: RUN_ID,
      seqId: 5,
      text: "Confirmed the release readiness.",
    }),
    assistantEvent({
      id: "history-only-main",
      runId: RUN_ID,
      seqId: 6,
      text: "Final release summary",
    }),
  ]);

  const main = screen.getByText("Final release summary");
  const assistantGroup = assistantGroupFor(main);
  const actions = assistantGroup.querySelector<HTMLElement>(
    '[data-testid="chat-event-actions"]',
  );
  if (!actions) {
    throw new Error("Expected the main result action bar");
  }
  expect(actions).toBeVisible();
  expectDocumentOrder(main, actions);
  expect(screen.queryByText("Generated supporting evidence.")).toBeNull();
  expect(
    queryNamedLink("Open pdf preview for supporting-report.pdf"),
  ).toBeNull();
  const mainMessage = main.closest<HTMLElement>("[data-chat-run-work-main]");
  if (!mainMessage) {
    throw new Error("Expected the result inside the main message region");
  }
  expect(mainMessage).toContainElement(actions);
  const artifactTrigger = screen.getByTestId(
    "chat-run-related-artifacts-trigger",
  );
  expect(actions).toContainElement(artifactTrigger);
  expect(artifactTrigger).toHaveAccessibleName("1 artifact");
  expect(myOkouAvatarButtons()).toHaveLength(1);
  const dialog = await openRelatedArtifacts();
  expect(relatedArtifactRow(dialog, reportUrl)).toHaveTextContent("Report");
  expect(queryWorkHistoryToggle("collapsed")).toBeVisible();

  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByTestId("chat-run-related-artifacts-dialog"),
    ).toBeNull();
  });
  click(await findWorkHistoryToggle("collapsed"));
  const history = screen.getByText("Generated supporting evidence.");
  expect(history).toBeVisible();
  await expect(
    findNamedLink("Open pdf preview for supporting-report.pdf"),
  ).resolves.toBeVisible();
  expect(queryWorkHistoryToggle("expanded")).toBeVisible();
});

test("A carried image keeps its label and opens a lightbox over the dialog", async () => {
  const url = artifactUrl("linked-evidence", "evidence.png");
  await setupArtifactRun([
    assistantEvent({
      id: "linked-artifact-history",
      runId: RUN_ID,
      seqId: 2,
      text: `Review [**Supporting evidence**](${url}) before continuing.`,
    }),
    assistantEvent({
      id: "linked-artifact-main",
      runId: RUN_ID,
      seqId: 3,
      text: "Final linked evidence summary",
    }),
  ]);

  const dialog = await openRelatedArtifacts();
  const artifact = relatedArtifactRow(dialog, url);
  expect(artifact).toHaveTextContent("Supporting evidence");
  click(artifact);
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", url);
  expect(dialog).toBeVisible();
  await closeRelatedArtifactPreview(dialog);
});

test("Sidebar-first previews dismiss the related-artifacts dialog rather than stacking a lightbox", async () => {
  const url = artifactUrl("sidebar-evidence", "evidence.pdf");
  await setupArtifactRun(
    [
      assistantEvent({
        id: "sidebar-artifact-history",
        runId: RUN_ID,
        seqId: 2,
        text: `Review [Supporting evidence](${url}) before continuing.`,
      }),
      assistantEvent({
        id: "sidebar-artifact-result",
        runId: RUN_ID,
        seqId: 3,
        text: "Final evidence summary",
      }),
    ],
    true,
  );
  const dialog = await openRelatedArtifacts();
  click(relatedArtifactRow(dialog, url));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByTitle("evidence.pdf preview"),
  ).resolves.toHaveAttribute("src", `${url}#navpanes=0`);
  await waitFor(() => {
    expect(
      screen.queryByTestId("chat-run-related-artifacts-dialog"),
    ).not.toBeInTheDocument();
  });
  expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
});

async function openRelatedArtifactOverSidebar(filename: string, body?: string) {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifactSummary(
          "a0000000-0000-4000-a000-000000000282",
          "file",
          "Supporting report",
        ),
      ],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact not found" },
    });
  });
  const url = artifactUrl("sidebar-preview", filename);
  if (body !== undefined) {
    context.mocks.http.get(url, () => {
      return HttpResponse.text(body);
    });
  }
  await setupArtifactRun([
    assistantEvent({
      id: "sidebar-artifact-history",
      runId: RUN_ID,
      seqId: 2,
      text: `[Supporting artifact](${url})`,
    }),
    assistantEvent({
      id: "sidebar-artifact-main",
      runId: RUN_ID,
      seqId: 3,
      text: "Final sidebar artifact summary",
    }),
  ]);
  await openResourceArtifact("Supporting report");
  await expect(
    screen.findByTestId("thread-sidebar-artifact-unavailable"),
  ).resolves.toBeVisible();

  const dialog = await openRelatedArtifacts();
  click(relatedArtifactRow(dialog, url));
  const lightbox = await screen.findByRole("dialog", {
    name: `${filename} preview`,
  });
  expect(lightbox).toBeVisible();
  expect(dialog).toBeVisible();
  return { dialog, lightbox, url };
}

async function closeRelatedArtifactPreview(dialog: HTMLElement) {
  const viewport = screen
    .getByTestId("attachment-lightbox")
    .closest('[data-slot="dialog-viewport"]');
  if (!viewport) {
    throw new Error("Expected the active artifact preview viewport");
  }
  click(viewport);
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
  expect(dialog).toBeVisible();
}

test("Open a carried generic file over an existing artifact sidebar", async () => {
  const browser = context.mocks.browser.blobDownload();
  const { dialog, lightbox } = await openRelatedArtifactOverSidebar(
    "archive.zip",
    "archive bytes",
  );
  expect(
    within(lightbox).getByText("No inline preview available for this file."),
  ).toBeVisible();

  // Nothing renders here, so the screen has to carry the one action that still
  // applies to the file rather than leaving an icon in the header as its only
  // way out.
  const download = queryAllByRoleFast("button", lightbox).find((candidate) => {
    return candidate.textContent?.trim() === "Download";
  });
  expect(download).toBeDefined();
  click(download as HTMLElement);
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  // Files without a preview take the browser's native download path, so the
  // request carries the name rather than a blob this test could read.
  expect(browser.downloads[0]?.filename).toBe("archive.zip");
  await closeRelatedArtifactPreview(dialog);
});

test("List every carried artifact without a secondary browse step", async () => {
  const urls = Array.from({ length: 12 }, (_, index) => {
    return artifactUrl(
      `complete-list-${String(index)}`,
      `report-${String(index)}.pdf`,
    );
  });
  await setupArtifactRun([
    assistantEvent({
      id: "complete-artifact-list-history",
      runId: RUN_ID,
      seqId: 2,
      text: urls
        .map((url, index) => {
          return `![Report ${String(index)}](${url})`;
        })
        .join("\n\n"),
    }),
    assistantEvent({
      id: "complete-artifact-list-main",
      runId: RUN_ID,
      seqId: 3,
      text: "Final complete artifact list summary",
    }),
  ]);

  const dialog = await openRelatedArtifacts();
  expect(
    dialog.querySelectorAll("[data-chat-run-related-artifact-url]"),
  ).toHaveLength(urls.length);
  expect(relatedArtifactRow(dialog, urls.at(-1)!)).toHaveTextContent(
    "Report 11",
  );
});

test("Keep completed result actions before recommended followups", async () => {
  const reportUrl = artifactUrl("followup-report", "followup-report.pdf");
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "followup-actions-user",
        runId: RUN_ID,
        seqId: 1,
        text: "Prepare the followup report",
      }),
      assistantEvent({
        id: "followup-actions-history",
        runId: RUN_ID,
        seqId: 2,
        text: `Generated the supporting report.\n\n![Report](${reportUrl})`,
      }),
      assistantEvent({
        id: "followup-actions-main",
        runId: RUN_ID,
        seqId: 3,
        text: "The followup report is ready",
      }),
      completedEvent({
        id: "followup-actions-complete",
        runId: RUN_ID,
        seqId: 4,
      }),
      {
        id: "followup-actions-recommendations",
        eventType: "output.followups",
        role: "assistant",
        content: null,
        runId: RUN_ID,
        seqId: 5,
        createdAt: "2026-08-01T10:00:05.000Z",
        followups: [{ prompt: "Summarize the report", kind: "talk" }],
      },
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();

  const main = screen.getByText("The followup report is ready");
  const mainMessage = main.closest<HTMLElement>("[data-chat-run-work-main]");
  if (!mainMessage) {
    throw new Error("Expected the result inside the main message region");
  }
  const actions = mainMessage.querySelector<HTMLElement>(
    '[data-testid="chat-event-actions"]',
  );
  if (!actions) {
    throw new Error("Expected the completed result action bar");
  }
  const keepGoing = await screen.findByRole("group", { name: "Keep going" });
  const followupButton = queryAllByRoleFast("button", keepGoing).find(
    (button) => {
      return button.textContent?.trim() === "Summarize the report";
    },
  );

  expect(actions).toBeVisible();
  expect(followupButton).toBeVisible();
  expect(screen.getByText(/Keep going ·/u)).toBeVisible();
  expect(mainMessage).toContainElement(actions);
  expect(assistantGroupFor(main)).toContainElement(keepGoing);
  expect(actions).toContainElement(
    screen.getByTestId("chat-run-related-artifacts-trigger"),
  );
  expectDocumentOrder(main, actions, keepGoing);
});

test("Subtract final artifacts after ordered URL deduplication", async () => {
  const appendixUrl = artifactUrl("appendix", "appendix.pdf");
  const repeatedUrl = artifactUrl("repeated", "repeated.pdf");
  const sourceUrl = artifactUrl("source", "source.pdf");
  await setupArtifactRun([
    assistantEvent({
      id: "artifact-difference-first-history",
      runId: RUN_ID,
      seqId: 2,
      text: [
        "First historical output",
        `![Appendix](${appendixUrl})`,
        `![Report](${repeatedUrl})`,
      ].join("\n\n"),
    }),
    assistantEvent({
      id: "artifact-difference-second-history",
      runId: RUN_ID,
      seqId: 3,
      text: [
        "Second historical output",
        `![Report](${repeatedUrl})`,
        `![Source](${sourceUrl})`,
      ].join("\n\n"),
    }),
    assistantEvent({
      id: "artifact-difference-main",
      runId: RUN_ID,
      seqId: 4,
      text: ["Final artifact summary", `![Report](${repeatedUrl})`].join(
        "\n\n",
      ),
    }),
  ]);

  expect(screen.getByText("Final artifact summary")).toBeVisible();
  expect(screen.queryByText("First historical output")).toBeNull();
  click(await findWorkHistoryToggle("collapsed"));
  const firstHistory = await screen.findByText("First historical output");
  const secondHistory = screen.getByText("Second historical output");
  const main = screen.getByText("Final artifact summary");
  await findNamedLink("Open pdf preview for repeated.pdf");
  const repeatedArtifacts = namedLinks("Open pdf preview for repeated.pdf");
  expect(repeatedArtifacts).toHaveLength(3);
  expectDocumentOrder(
    firstHistory,
    repeatedArtifacts[0]!,
    secondHistory,
    repeatedArtifacts[1]!,
    main,
    repeatedArtifacts[2]!,
  );
  expect(
    screen.getByTestId("chat-run-related-artifacts-trigger"),
  ).toHaveAccessibleName("2 artifacts");
  const dialog = await openRelatedArtifacts();
  expect(relatedArtifactRows(dialog, repeatedUrl)).toHaveLength(0);
  const appendix = relatedArtifactRow(dialog, appendixUrl);
  const source = relatedArtifactRow(dialog, sourceUrl);
  expectDocumentOrder(appendix, source);
});

test("Keep artifacts with the same filename distinct when their URLs differ", async () => {
  const firstUrl = artifactUrl("first-report", "report.pdf");
  const secondUrl = artifactUrl("second-report", "report.pdf");
  await setupArtifactRun([
    assistantEvent({
      id: "same-name-first-history",
      runId: RUN_ID,
      seqId: 2,
      text: `First report version\n\n![Report](${firstUrl})`,
    }),
    assistantEvent({
      id: "same-name-second-history",
      runId: RUN_ID,
      seqId: 3,
      text: `Second report version\n\n![Report](${secondUrl})`,
    }),
    assistantEvent({
      id: "same-name-main",
      runId: RUN_ID,
      seqId: 4,
      text: "Final same-name report summary",
    }),
  ]);

  expect(screen.getByText("Final same-name report summary")).toBeVisible();
  const dialog = await openRelatedArtifacts();
  const first = relatedArtifactRow(dialog, firstUrl);
  const second = relatedArtifactRow(dialog, secondUrl);
  expectDocumentOrder(first, second);
  expect(within(dialog).getAllByText("Report")).toHaveLength(2);
  expect(screen.queryByText("First report version")).toBeNull();
  expect(screen.queryByText("Second report version")).toBeNull();
});

test("Render inline media and action cards after expanding short history", async () => {
  await setupArtifactRun([
    assistantEvent({
      id: "non-artifact-history",
      runId: RUN_ID,
      seqId: 2,
      text: [
        "Historical rich output",
        "![Inline chart](https://example.com/inline-chart.png)",
        "[Compare plans](/?settings=billing&billingView=plans)",
      ].join("\n\n"),
    }),
    assistantEvent({
      id: "non-artifact-main",
      runId: RUN_ID,
      seqId: 3,
      text: "Final result without artifacts",
    }),
  ]);

  expect(screen.getByText("Final result without artifacts")).toBeVisible();
  expect(screen.queryByText("Historical rich output")).toBeNull();
  expect(screen.queryByAltText("Inline chart")).toBeNull();
  expect(screen.queryByTestId("plan-upgrade-card")).toBeNull();
  expect(screen.queryByTestId("chat-run-related-artifacts-trigger")).toBeNull();
  click(await findWorkHistoryToggle("collapsed"));
  await expect(
    screen.findByText("Historical rich output"),
  ).resolves.toBeVisible();
  expect(screen.getByAltText("Inline chart")).toBeVisible();
  expect(screen.getByTestId("plan-upgrade-card")).toBeVisible();
  expect(screen.queryByTestId("chat-run-related-artifacts-trigger")).toBeNull();
  expect(queryWorkHistoryToggle("expanded")).toBeVisible();
});

test("Ignore artifacts from revoked output messages", async () => {
  const obsoleteUrl = artifactUrl("obsolete", "obsolete.pdf");
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "revoked-artifact-user",
        runId: RUN_ID,
        seqId: 1,
        text: "Replace the obsolete artifact",
      }),
      assistantEvent({
        id: "revoked-artifact-output",
        runId: RUN_ID,
        seqId: 2,
        text: obsoleteUrl,
      }),
      {
        id: "revoked-artifact-replacement",
        eventType: "output.message",
        role: "assistant",
        content: "The obsolete artifact was withdrawn",
        runId: RUN_ID,
        revokesEventId: "revoked-artifact-output",
        seqId: 3,
        createdAt: "2026-08-01T10:00:03.000Z",
      },
      completedEvent({
        id: "revoked-artifact-complete",
        runId: RUN_ID,
        seqId: 4,
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();

  expect(screen.getByText("The obsolete artifact was withdrawn")).toBeVisible();
  expect(queryNamedLink("Open pdf preview for obsolete.pdf")).toBeNull();
  expect(screen.queryByTestId("chat-run-related-artifacts-trigger")).toBeNull();
  expect(queryWorkHistoryToggle("collapsed")).toBeNull();
});
