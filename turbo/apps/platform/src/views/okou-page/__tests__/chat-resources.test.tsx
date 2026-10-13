import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactRun,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

import {
  continuityThread,
  continuityEventRow,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const REPORT_URL = "https://files.example.test/report.pdf";

function installResourceGeometry(initialGutter: number) {
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
  const measurements = new Set<() => void>();
  const NativeResizeObserver = ResizeObserver;
  vi.stubGlobal(
    "ResizeObserver",
    class extends NativeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        this.callback = callback;
      }
      private readonly callback: ResizeObserverCallback;
      override observe(target: Element, options?: ResizeObserverOptions) {
        super.observe(target, options);
        if (
          target instanceof HTMLElement &&
          Object.hasOwn(target.dataset, "messageContainer")
        ) {
          measurements.add(() => {
            this.callback([], this);
          });
        }
      }
    },
  );
  return (nextGutter: number) => {
    act(() => {
      gutter = nextGutter;
      for (const measure of measurements) {
        measure();
      }
    });
  };
}

async function setupResources(
  options: {
    readonly gutter?: number;
    readonly enabled?: boolean;
    readonly preferred?: boolean;
  } = {},
) {
  const resize = installResourceGeometry(options.gutter ?? 480);
  context.mocks.browser.matchMedia(true);
  if (options.preferred !== undefined) {
    context.mocks.data.userPreferences({
      chatResourcesEnabledByDefault: options.preferred,
    });
  }
  mockArtifactConversation(context, {
    catalog: [],
    artifactRuns: () => {
      return [
        artifactRun({
          fileId: "b0000000-0000-4000-a000-000000000999",
          filename: "report.pdf",
          contentType: "application/pdf",
          url: REPORT_URL,
        }),
      ];
    },
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
          "[Old title](https://example.test/guide?q=one#section) and [Report](https://files.example.test/report.pdf)",
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

function resourceSwitch() {
  return screen.getByRole("switch", { name: "Show resources" });
}
function resourcePanel() {
  return screen.queryByRole("dialog", { name: "Resources" });
}
function composer() {
  const editor = document.querySelector<HTMLElement>(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!editor) {
    throw new Error("Composer not mounted");
  }
  return editor;
}

function resourceState() {
  return {
    open: resourceSwitch().getAttribute("aria-checked") === "true",
    visible: resourcePanel() !== null,
  };
}

test("Open in the actual right gutter and preserve links while removing duplicates and output URLs", async () => {
  await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  const panel = resourcePanel()!;
  await within(panel).findByText("report.pdf");
  await within(panel).findByText("Current guide");
  const links = queryAllByRoleFast("link", panel);
  expect(
    links.map((link) => {
      return link.getAttribute("href");
    }),
  ).toStrictEqual([
    "https://example.test/guide?q=one#section",
    "https://example.test/reference",
  ]);
  expect(links[0]).toHaveAttribute("target", "_blank");
  expect(within(panel).queryByText("Old title")).not.toBeInTheDocument();
  expect(within(panel).queryByText("Report")).not.toBeInTheDocument();
  expect(buttonNamed("Open artifacts")).toBeInTheDocument();
});

test("Recompute at 408px from the gutter even when the browser width stays fixed", async () => {
  const resize = await setupResources({ gutter: 408 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(409);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  resize(408);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Temporarily dismiss a manually opened narrow panel on composer click without changing preference", async () => {
  const resize = await setupResources({ gutter: 200 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(resourceSwitch());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await waitFor(() => {
    expect(resourceSwitch()).toBeEnabled();
  });
  await userEvent.click(composer());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(250);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(409);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
});

test("Keep a wide panel open during composer focus and dismiss Escape only temporarily", async () => {
  const resize = await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(composer());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  act(() => {
    resourcePanel()?.focus();
  });
  fireEvent.keyDown(resourcePanel()!, { key: "Escape" });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(300);
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
});

test("Keep the saved off preference when the available gutter becomes wide again", async () => {
  const resize = await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(resourceSwitch());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await waitFor(() => {
    expect(resourceSwitch()).toBeEnabled();
  });
  resize(200);
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Honor a previously saved off preference on entry", async () => {
  await setupResources({ preferred: false });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Keep the existing artifact entry when the rollout switch is off", async () => {
  await setupResources({ enabled: false });
  expect(
    screen.queryByRole("switch", { name: "Show resources" }),
  ).not.toBeInTheDocument();
  click(buttonNamed("Open artifacts"));
  await screen.findByTestId("thread-sidebar-artifacts");
});

test("Roll back the visible state and explain a failed preference save", async () => {
  context.mocks.api(userPreferencesContract.update, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Preference update failed" },
    });
  });
  await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(resourceSwitch());
  await screen.findByText("Could not save your resource preference");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
});

test("Dismiss a narrow panel when keyboard focus moves to the composer", async () => {
  const resize = await setupResources({ gutter: 200 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(resourceSwitch());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  act(() => {
    composer().focus();
  });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
});

test("Copy the original link and open the complete artifact panel", async () => {
  await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const panel = resourcePanel()!;
  const link = await within(panel).findByText("Current guide");
  const row = link.closest("li")!;
  click(buttonNamed("Copy link", row));
  await waitFor(() => {
    expect(clipboard.writes.at(-1)).toBe(
      "https://example.test/guide?q=one#section",
    );
  });
  click(buttonNamed("View all", panel));
  const all = await screen.findByTestId("thread-sidebar-artifacts");
  await within(all).findByText("Current guide");
});

test("Share the saved preference with another chat and discard temporary state on navigation", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  const first = continuityThread(91, 1, "First resources");
  const second = continuityThread(91, 2, "Second resources");
  const workspace = installContinuityWorkspace(context, {
    caseId: 91,
    threads: [first, second],
    chatEventRows: [first, second].map((thread, index) => {
      return continuityEventRow(91, index + 1, thread.id, "input.prompt", {
        payload: {
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: thread.title ?? "Resources" }],
          },
        },
      });
    }),
  });
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${first.id}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(resourceSwitch());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await waitFor(() => {
    expect(resourceSwitch()).toBeEnabled();
  });
  const next = queryAllByRoleFast("link").find((link) => {
    return link.getAttribute("href") === `/chats/${second.id}`;
  });
  if (!next) {
    throw new Error("Second chat is missing");
  }
  click(next);
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Second resources",
    );
  });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(resourceSwitch());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await waitFor(() => {
    expect(resourceSwitch()).toBeEnabled();
  });
  const previous = queryAllByRoleFast("link").find((link) => {
    return link.getAttribute("href") === `/chats/${first.id}`;
  });
  if (!previous) {
    throw new Error("First chat is missing");
  }
  click(previous);
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "First resources",
    );
  });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
});

test("Include links from older messages outside the transcript render window", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: Array.from({ length: 21 }, (_, index) => {
      return [
        {
          id: `history-input-${index}`,
          role: "user" as const,
          content: `Conversation ${index}`,
          runId: `history-run-${index}`,
          createdAt: `2026-09-01T10:${String(index).padStart(2, "0")}:00Z`,
        },
        {
          id: `history-output-${index}`,
          role: "assistant" as const,
          content:
            index === 0
              ? "Old response: [Earlier reference](https://example.test/earlier)"
              : `Answer ${index}`,
          runId: `history-run-${index}`,
          createdAt: `2026-09-01T10:${String(index).padStart(2, "0")}:01Z`,
        },
      ];
    }).flat(),
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  await screen.findByText("Conversation 20");
  expect(screen.queryByText("Conversation 0")).not.toBeInTheDocument();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await within(resourcePanel()!).findByText("Earlier reference");
});
