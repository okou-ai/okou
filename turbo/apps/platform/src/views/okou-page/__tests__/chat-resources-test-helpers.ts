import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactSummary,
  fileArtifactDetail,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

export function createChatResourcesHelpers(context: TestContext) {
  return {
    recordPreferenceUpdates: (enabled: boolean, hold?: Promise<void>) => {
      return recordPreferenceUpdates(context, enabled, hold);
    },
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

export function installResourceGeometry(initialGutter: number) {
  let gutter = initialGutter;
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (Object.hasOwn(this.dataset, "scrollContainer")) {
        return new DOMRect(0, 80, 1800, 700);
      }
      if (Object.hasOwn(this.dataset, "messageContainer")) {
        return new DOMRect(900 - gutter, 80, 900, 700);
      }
      return original.call(this);
    },
  );
  return (nextGutter: number, notifyResize = true) => {
    act(() => {
      gutter = nextGutter;
      if (notifyResize) {
        fireEvent(window, new Event("resize"));
      }
    });
  };
}

export async function setupResources(
  context: TestContext,
  options: {
    readonly gutter?: number;
    readonly enabled?: boolean;
    readonly preferred?: boolean;
    readonly desktop?: boolean;
    readonly sourceUrl?: boolean;
    readonly aliasUrl?: string;
    readonly mock?: () => void;
  } = {},
) {
  const resize = installResourceGeometry(options.gutter ?? 480);
  context.mocks.browser.matchMedia(options.desktop ?? true);
  if (options.preferred !== undefined) {
    context.mocks.data.userPreferences({
      chatResourcesEnabledByDefault: options.preferred,
    });
  }
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
    featureSwitches: {
      [FeatureSwitchKey.ChatResourcePanel]: options.enabled ?? true,
    },
  });
  await screen.findByText("Find useful resources");
  return resize;
}

/** Serve user preferences from one record and keep every update body. */
export function recordPreferenceUpdates(
  context: TestContext,
  chatResourcesEnabledByDefault: boolean,
  hold?: Promise<void>,
) {
  let preferences: UserPreferencesResponse = {
    timezone: "Etc/UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
  const updates: UpdateUserPreferencesRequest[] = [];
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences);
  });
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond }) => {
      updates.push({ ...body });
      await hold;
      preferences = { ...preferences, ...body };
      return respond(200, preferences);
    },
  );
  return updates;
}

export function resourceButton() {
  return buttonNamed("Resources");
}
export function resourcePanel() {
  return screen.queryByRole("region", { name: "Resources" });
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
  } = {},
) {
  const resize = installResourceGeometry(480);
  const media = context.mocks.browser.matchMedia(true);
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
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("report-1.pdf");
  return { panel, media, resize };
}
