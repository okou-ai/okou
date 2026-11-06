import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactSummary,
  fileArtifactDetail,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_AGENT_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

export function createChatResourcesHelpers(context: TestContext) {
  return {
    setupResources: (options?: Parameters<typeof setupResources>[1]) => {
      return setupResources(context, options);
    },
    setupOverflowResources: (
      count: number,
      options?: Parameters<typeof setupOverflowResources>[2],
    ) => {
      return setupOverflowResources(context, count, options);
    },
  };
}

const REPORT_URL = "https://files.example.test/report.pdf";
export const RESOURCE_ARTIFACT_ID = "e0000000-0000-4000-a000-000000000999";

/** Open the chat's resource panel and wait for its complete content. */
export async function openResources() {
  // The trigger takes presses once its chat has settled.
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-disabled", "false");
  });
  click(resourceButton());
  return await screen.findByRole("dialog", { name: "Artifacts and chats" });
}

export async function setupResources(
  context: TestContext,
  options: {
    readonly open?: boolean;
    readonly desktop?: boolean;
    readonly sourceUrl?: boolean;
    readonly aliasUrl?: string;
    readonly mock?: () => void;
  } = {},
) {
  context.mocks.browser.matchMedia(options.desktop ?? true);
  const report = {
    ...artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf"),
    ...(options.sourceUrl === false ? {} : { sourceUrl: REPORT_URL }),
    ...(options.aliasUrl ? { aliasUrl: options.aliasUrl } : {}),
  };
  mockArtifactConversation(context, {
    catalog: [report],
    details: new Map([
      [
        report.id,
        fileArtifactDetail(report, {
          fileId: "b0000000-0000-4000-a000-000000000999",
          filename: "report.pdf",
          contentType: "application/pdf",
          url: REPORT_URL,
        }),
      ],
    ]),
    chatEvents: [
      {
        id: "resources-user",
        role: "user",
        content: "Find useful resources",
        runId: "resources-run",
        createdAt: "2026-09-01T10:00:00Z",
      },
      {
        id: "resources-old",
        role: "assistant",
        content:
          "[Old title](https://example.test/guide?q=one#section) and [Report](https://files.example.test/report.pdf)" +
          (options.aliasUrl ? ` [Hosted alias](${options.aliasUrl})` : ""),
        runId: "resources-run",
        createdAt: "2026-09-01T10:00:01Z",
      },
      {
        id: "resources-new",
        role: "assistant",
        content:
          "[Current guide](https://example.test/guide?q=one#section) [Reference](https://example.test/reference) `https://example.test/code` [Unsafe](javascript:alert%281%29)",
        runId: "resources-run",
        createdAt: "2026-09-01T10:00:02Z",
      },
    ],
  });
  options.mock?.();
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
  });
  await screen.findByText("Find useful resources");
  if (options.open ?? true) {
    await openResources();
  }
}

export function resourceButton() {
  return buttonNamed("Artifacts and chats");
}
export function resourcePanel() {
  return screen.queryByRole("dialog", { name: "Artifacts and chats" });
}
export function composer() {
  const editor = document.querySelector<HTMLElement>(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!editor) {
    throw new Error("Composer not mounted");
  }
  return editor;
}

export function resourceState() {
  return {
    open: resourceButton().getAttribute("aria-expanded") === "true",
    visible: resourcePanel() !== null,
  };
}

export async function setupOverflowResources(
  context: TestContext,
  count: number,
  options: {
    readonly paginated?: boolean;
    readonly withLinks?: boolean;
    readonly mock?: (catalog: readonly ArtifactSummary[]) => void;
    readonly featureSwitches?: Parameters<
      typeof setupPage
    >[0]["featureSwitches"];
  } = {},
) {
  const media = context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({
    timezone: "Etc/UTC",
    locale: "en-US",
  });
  const catalog = Array.from({ length: count }, (_, index) => {
    return artifactSummary(
      `e0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
      "file",
      `report-${index + 1}.pdf`,
    );
  });
  mockArtifactConversation(context, {
    catalog,
    details: new Map(
      catalog.map((artifact, index) => {
        return [
          artifact.id,
          fileArtifactDetail(artifact, {
            fileId: `b0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
            filename: artifact.title,
            contentType: "application/pdf",
            url: `https://files.example.test/report-${index + 1}.pdf`,
          }),
        ];
      }),
    ),
    chatEvents: [
      {
        id: "resources-overflow",
        role: "assistant",
        content:
          options.withLinks === false
            ? "The report is ready."
            : catalog
                .map((_, index) => {
                  return `[Reference ${index + 1}](https://example.test/reference-${index + 1})`;
                })
                .join(" "),
        runId: "resources-run",
        createdAt: "2026-09-01T10:00:01Z",
      },
    ],
  });
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    if (params.id !== NAVIGATION_ARTIFACT_THREAD_ID) {
      return respond(404, {
        error: {
          code: "CHAT_THREAD_NOT_FOUND",
          message: "Chat thread not found",
        },
      });
    }
    return respond(200, {
      id: NAVIGATION_ARTIFACT_THREAD_ID,
      agentId: NAVIGATION_ARTIFACT_AGENT_ID,
      title: "Artifact navigation",
      selectedModel: null,
      modelSettings: {},
      serviceTier: null,
      pinnedAt: null,
      archived: false,
      muted: false,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
  });
  if (options.paginated) {
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      const offset = query.cursor ? Number(query.cursor) : 0;
      const end = offset + 60;
      return respond(200, {
        artifacts: catalog.slice(offset, end),
        nextCursor: end < catalog.length ? String(end) : null,
      });
    });
  }
  options.mock?.(catalog);
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: options.featureSwitches,
  });
  const panel = await openResources();
  await within(panel).findByText("report-1.pdf");
  return { panel, media };
}
