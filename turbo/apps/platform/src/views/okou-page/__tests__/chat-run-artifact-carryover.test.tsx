import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  context,
  findButton,
  findWorkHistoryToggle,
  installRunChat,
  promptEvent,
  queryWorkHistoryToggle,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

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

function viewAgentProfileLinks(): HTMLElement[] {
  return queryAllByRoleFast("link").filter((link) => {
    return link.getAttribute("aria-label") === "View agent profile";
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

async function openRelatedArtifacts(): Promise<HTMLElement> {
  click(await screen.findByTestId("chat-run-related-artifacts-trigger"));
  return screen.findByTestId("chat-run-related-artifacts-dialog");
}

async function setupArtifactRun(
  outputEvents: ReturnType<typeof assistantEvent>[],
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
  });
  await readyChat();
}

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
  expect(viewAgentProfileLinks()).toHaveLength(1);
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

async function openRelatedArtifactOverSidebar(filename: string, body?: string) {
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
  click(await findButton("Open artifacts"));
  await expect(
    screen.findByTestId("thread-sidebar-artifacts"),
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

test("Open a carried image over an existing artifact sidebar", async () => {
  const { dialog, lightbox, url } =
    await openRelatedArtifactOverSidebar("evidence.png");
  await expect(
    within(lightbox).findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", url);
  await closeRelatedArtifactPreview(dialog);
});

test.each([
  ["walkthrough.mp4", "Video"],
  ["narration.mp3", "Audio"],
])(
  "Open carried media %s over an existing artifact sidebar",
  async (filename, kind) => {
    const { dialog, lightbox, url } =
      await openRelatedArtifactOverSidebar(filename);
    await expect(
      within(lightbox).findByLabelText(`${kind} preview for ${filename}`),
    ).resolves.toHaveAttribute("src", url);
    await closeRelatedArtifactPreview(dialog);
  },
);

test.each([
  ["report.pdf", "#navpanes=0"],
  ["page.html", ""],
])(
  "Open carried document %s over an existing artifact sidebar",
  async (filename, fragment) => {
    const { dialog, lightbox, url } =
      await openRelatedArtifactOverSidebar(filename);
    await expect(
      within(lightbox).findByTitle(`${filename} preview`),
    ).resolves.toHaveAttribute("src", `${url}${fragment}`);
    await closeRelatedArtifactPreview(dialog);
  },
);

test.each([
  ["summary.txt", "Related artifact content"],
  ["notes.md", "# Related artifact content"],
  ["data.json", '{"result":"Related artifact content"}'],
  ["report.csv", "result\nRelated artifact content"],
])(
  "Read carried text %s over an existing artifact sidebar",
  async (filename, body) => {
    const { dialog, lightbox } = await openRelatedArtifactOverSidebar(
      filename,
      body,
    );
    await expect(
      within(lightbox).findByText(/Related artifact content/u),
    ).resolves.toBeVisible();
    await closeRelatedArtifactPreview(dialog);
  },
);

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
  expect(within(dialog).queryByText(/browse all/iu)).toBeNull();
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
  const followupButton = within(keepGoing).getByTitle("Summarize the report");

  expect(actions).toBeVisible();
  expect(followupButton).toBeVisible();
  expect(screen.getByText(/Keep going ·/u)).toBeVisible();
  expect(mainMessage).toContainElement(actions);
  expect(mainMessage).not.toContainElement(keepGoing);
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

test("Carry artifacts across every run in the same run group", async () => {
  const runGroupId = "e0000000-0000-4000-a000-000000000282";
  const nextRunId = "a0000000-0000-4000-a000-000000000282";
  const earlierUrl = artifactUrl("earlier-run", "earlier-run.pdf");
  const automationInput = (
    id: string,
    runId: string,
    seqId: number,
  ): MockChatEventInput => {
    return {
      id,
      role: "user",
      eventType: "input.automation",
      content: null,
      runId,
      runGroupId,
      seqId,
      createdAt: `2026-08-01T10:00:0${String(seqId)}.000Z`,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "automation",
            workflowName: "artifact-review",
            automationBrief: "Review generated artifacts",
          },
        ],
      },
    };
  };
  const inRunGroup = (event: MockChatEventInput): MockChatEventInput => {
    return { ...event, runGroupId };
  };
  installRunChat({
    chatEvents: [
      automationInput("earlier-run-input", RUN_ID, 1),
      inRunGroup(
        assistantEvent({
          id: "earlier-run-artifact",
          runId: RUN_ID,
          seqId: 2,
          text: `Earlier run output\n\n![Report](${earlierUrl})`,
        }),
      ),
      inRunGroup(
        completedEvent({
          id: "earlier-run-complete",
          runId: RUN_ID,
          seqId: 3,
        }),
      ),
      automationInput("next-run-input", nextRunId, 4),
      inRunGroup(
        assistantEvent({
          id: "next-run-main",
          runId: nextRunId,
          seqId: 5,
          text: "Latest run result",
        }),
      ),
      inRunGroup(
        completedEvent({
          id: "next-run-complete",
          runId: nextRunId,
          seqId: 6,
        }),
      ),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();

  expect(screen.getByText("Latest run result")).toBeVisible();
  expect(screen.queryByText("Earlier run output")).toBeNull();
  const dialog = await openRelatedArtifacts();
  expect(relatedArtifactRow(dialog, earlierUrl)).toHaveTextContent("Report");
  expect(queryWorkHistoryToggle("collapsed")).toBeVisible();
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
