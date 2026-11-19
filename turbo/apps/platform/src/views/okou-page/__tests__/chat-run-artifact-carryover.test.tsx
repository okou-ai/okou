import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  artifactSummary,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  findWorkHistoryToggle,
  promptEvent,
  queryWorkHistoryToggle,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const RUN_ID = "a0000000-0000-4000-a000-000000000281";

function artifactUrl(id: string, filename: string): string {
  return `https://cdn.vm7.io/artifacts/run-folding/${id}/${filename}`;
}

function queryNamedLink(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("link", document.body).find((link) => {
    return link.getAttribute("aria-label") === name;
  });
}

function relatedArtifactRow(dialog: HTMLElement, url: string): HTMLElement {
  const rows = dialog.querySelectorAll<HTMLElement>(
    `[data-chat-run-related-artifact-url="${url}"]`,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function openRelatedArtifacts(): Promise<HTMLElement> {
  click(await screen.findByTestId("chat-run-related-artifacts-trigger"));
  return screen.findByTestId("chat-run-related-artifacts-dialog");
}

async function openArtifactRun(
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
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: false,
    },
  });
  await readyChat();
}

test("A historical artifact is offered from the final result actions", async () => {
  const reportUrl = artifactUrl("supporting-report", "supporting-report.pdf");
  await openArtifactRun([
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
  const actions = main
    .closest<HTMLElement>("[data-chat-run-work-main]")
    ?.querySelector<HTMLElement>('[data-testid="chat-event-actions"]');
  const trigger = screen.getByTestId("chat-run-related-artifacts-trigger");
  expect(actions).toContainElement(trigger);
  expect(trigger).toHaveAccessibleName("1 artifact");
  expect(screen.queryByText("Generated supporting evidence.")).toBeNull();
  expect(
    queryNamedLink("Open pdf preview for supporting-report.pdf"),
  ).toBeUndefined();

  const dialog = await openRelatedArtifacts();
  expect(relatedArtifactRow(dialog, reportUrl)).toHaveTextContent("Report");
  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByTestId("chat-run-related-artifacts-dialog"),
    ).toBeNull();
  });
  click(await findWorkHistoryToggle("collapsed"));

  await expect(
    screen.findByText("Generated supporting evidence."),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(
      queryNamedLink("Open pdf preview for supporting-report.pdf"),
    ).toBeVisible();
  });
});

test("A carried image keeps its label and opens over the related artifacts", async () => {
  const url = artifactUrl("linked-evidence", "evidence.png");
  await openArtifactRun([
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
});

test("A carried file without a preview downloads over an existing artifact sidebar", async () => {
  const browser = context.mocks.browser.blobDownload();
  const url = artifactUrl("sidebar-preview", "archive.zip");
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
  context.mocks.http.get(url, () => {
    return HttpResponse.text("archive bytes");
  });
  await openArtifactRun([
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
    name: "archive.zip preview",
  });

  expect(lightbox).toBeVisible();
  expect(dialog).toBeVisible();
  expect(
    within(lightbox).getByText("No inline preview available for this file."),
  ).toBeVisible();
  const download = queryAllByRoleFast("button", lightbox).find((candidate) => {
    return candidate.textContent?.trim() === "Download";
  });
  if (!download) {
    throw new Error("Missing Download action");
  }
  click(download);
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]?.filename).toBe("archive.zip");
});

test("Expanding short history reveals formatted text, inline media and an action card", async () => {
  await openArtifactRun([
    assistantEvent({
      id: "non-artifact-history",
      runId: RUN_ID,
      seqId: 2,
      text: [
        "## Historical rich output",
        "A **formatted** release note.",
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
  click(await findWorkHistoryToggle("collapsed"));

  await expect(
    screen.findByRole("heading", { name: "Historical rich output" }),
  ).resolves.toBeVisible();
  expect(screen.getByText("formatted", { selector: "strong" })).toBeVisible();
  expect(screen.getByAltText("Inline chart")).toBeVisible();
  expect(screen.getByTestId("plan-upgrade-card")).toBeVisible();
  expect(screen.queryByTestId("chat-run-related-artifacts-trigger")).toBeNull();
});

test("Artifacts from a revoked output message are ignored", async () => {
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

  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  expect(screen.getByText("The obsolete artifact was withdrawn")).toBeVisible();
  expect(queryNamedLink("Open pdf preview for obsolete.pdf")).toBeUndefined();
  expect(screen.queryByTestId("chat-run-related-artifacts-trigger")).toBeNull();
  expect(queryWorkHistoryToggle("collapsed")).toBeNull();
  expect(queryWorkHistoryToggle("expanded")).toBeNull();
});

function exportMenuItem(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("menuitem", document.body).find((item) => {
    return item.getAttribute("aria-label") === name;
  });
}

test("Show format download items and report conversion failures in a toast", async () => {
  const markdownUrl = artifactUrl("generated-report", "summary.md");
  context.mocks.http.get(markdownUrl, () => {
    return new HttpResponse(null, { status: 500 });
  });
  const outputEvents = [
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
  ];
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
      [FeatureSwitchKey.ArtifactSidebarPreview]: false,
      [FeatureSwitchKey.MarkdownFirstOutput]: true,
    },
  });
  await readyChat();

  const dialog = await openRelatedArtifacts();
  const actions = relatedArtifactRow(dialog, markdownUrl).parentElement
    ?.parentElement;
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

  const pdf = await waitFor(() => {
    const item = exportMenuItem("Download as PDF");
    expect(item).toBeEnabled();
    return item;
  });
  expect(exportMenuItem("Download as DOCX")).toBeEnabled();
  click(pdf!);

  const error = await screen.findByText(
    "Export failed. Select an export option to try again.",
  );
  expect(error.closest("[data-sonner-toast]")).toHaveAttribute(
    "data-type",
    "error",
  );
});
