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
  chatThreadArtifactsContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { pathname } from "../../../signals/location.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactRun,
  artifactSummary,
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
  return (nextGutter: number, notifyResize = true) => {
    act(() => {
      gutter = nextGutter;
      if (notifyResize) {
        fireEvent(window, new Event("resize"));
      }
    });
  };
}

async function setupResources(
  options: {
    readonly gutter?: number;
    readonly enabled?: boolean;
    readonly preferred?: boolean;
    readonly desktop?: boolean;
  } = {},
) {
  const resize = installResourceGeometry(options.gutter ?? 480);
  context.mocks.browser.matchMedia(options.desktop ?? true);
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

function resourceButton() {
  return buttonNamed("Open artifacts");
}
function resourcePanel() {
  return screen.queryByRole("region", { name: "Resources" });
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
    open: resourceButton().getAttribute("aria-pressed") === "true",
    visible: resourcePanel() !== null,
  };
}

async function setupOverflowResources(count: number) {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  const catalog = Array.from({ length: count }, (_, index) => {
    return artifactSummary(
      `e0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
      "file",
      `report-${index + 1}.pdf`,
    );
  });
  mockArtifactConversation(context, {
    catalog,
    artifactRuns: () => {
      return catalog.map((artifact, index) => {
        return artifactRun({
          artifactId: artifact.id,
          fileId: `b0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
          filename: artifact.title,
          contentType: "application/pdf",
          url: `https://files.example.test/report-${index + 1}.pdf`,
        });
      });
    },
    chatEvents: [
      {
        id: "resources-overflow",
        role: "assistant",
        content: catalog
          .map((_, index) => {
            return `[Reference ${index + 1}](https://example.test/reference-${index + 1})`;
          })
          .join(" "),
        runId: "resources-run",
        createdAt: "2026-09-01T10:00:01Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Reference 1");
  return panel;
}

test("Show all six resources without an overflow control at the limit", async () => {
  const panel = await setupOverflowResources(6);
  for (const name of ["Artifacts", "Links"]) {
    const section = within(panel).getByRole("region", { name });
    expect(within(section).getAllByRole("listitem")).toHaveLength(6);
    expect(
      queryAllByRoleFast("button", section).find((button) => {
        return button.getAttribute("aria-label") === "View all";
      }),
    ).toBeUndefined();
  }
  expect(buttonNamed("View all", panel)).toBeInTheDocument();
});

test.each(["Artifacts", "Links"] as const)(
  "Keep both previews bounded and open the complete %s list from its ellipsis",
  async (name) => {
    const panel = await setupOverflowResources(7);
    expect(
      within(panel)
        .getAllByRole("heading")
        .map((heading) => {
          return heading.textContent;
        }),
    ).toStrictEqual(["Artifacts", "Links"]);
    for (const sectionName of ["Artifacts", "Links"]) {
      const section = within(panel).getByRole("region", { name: sectionName });
      expect(within(section).getAllByRole("listitem")).toHaveLength(6);
      expect(buttonNamed("View all", section)).toBeInTheDocument();
    }
    expect(within(panel).queryByText("report-7.pdf")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Reference 7")).not.toBeInTheDocument();

    const section = within(panel).getByRole("region", { name });
    const more = buttonNamed("View all", section);
    more.focus();
    await userEvent.keyboard("{Enter}");

    const all = await screen.findByRole("complementary", { name });
    await within(all).findByText(
      name === "Artifacts" ? "report-7.pdf" : "Reference 7",
    );
    expect(
      within(all).queryByText(
        name === "Artifacts" ? "Reference 1" : "report-1.pdf",
      ),
    ).not.toBeInTheDocument();
    expect(buttonNamed(`Close ${name.toLowerCase()}`, all)).toBeInTheDocument();
    expect(
      queryAllByRoleFast("link", all).map((link) => {
        return {
          href: link.getAttribute("href"),
          target: link.getAttribute("target"),
        };
      }),
    ).toStrictEqual(
      name === "Links"
        ? Array.from({ length: 7 }, (_, index) => {
            return {
              href: `https://example.test/reference-${index + 1}`,
              target: "_blank",
            };
          })
        : [],
    );
  },
);

test("Keep the footer View all showing complete artifacts and links", async () => {
  const panel = await setupOverflowResources(7);
  click(within(panel).getByText("View all"));
  const all = await screen.findByRole("complementary", { name: "Resources" });
  await within(all).findByText("report-7.pdf");
  expect(within(all).getByText("Reference 7")).toBeInTheDocument();
});

test("Open in the actual right gutter and preserve links while removing duplicates and output URLs", async () => {
  await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  const panel = resourcePanel()!;
  expect(resourceButton()).not.toHaveAttribute("aria-haspopup");
  expect(resourceButton()).toHaveAttribute("aria-expanded", "true");
  expect(resourceButton()).toHaveAttribute("aria-controls", panel.id);
  await within(panel).findByText("report.pdf");
  await within(panel).findByText("Current guide");
  expect(
    within(panel).getByRole("heading", { name: "Artifacts" }),
  ).toBeInTheDocument();
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
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.getAttribute("aria-label") === "Open artifacts";
    }),
  ).toHaveLength(1);
  expect(screen.queryByText("Show resources")).not.toBeInTheDocument();
  expect(
    screen.queryByTestId("thread-sidebar-artifacts"),
  ).not.toBeInTheDocument();
});

test("Recompute at 408px from the actual gutter on native viewport resize", async () => {
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

test("Recompute the gutter after toggling the chat list at fixed browser width", async () => {
  const setGeometry = await setupResources({ gutter: 408 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  setGeometry(409, false);
  await userEvent.click(buttonNamed("Hide chat list"));
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  setGeometry(408, false);
  await userEvent.click(buttonNamed("Show chat list"));
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Recompute the gutter when an artifact pane opens and its divider moves", async () => {
  const setGeometry = await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  setGeometry(408, false);
  const panel = resourcePanel()!;
  await within(panel).findByText("report.pdf");
  await userEvent.click(
    queryAllByRoleFast("button", panel).find((button) => {
      return button.textContent?.includes("report.pdf");
    })!,
  );
  const handle = await screen.findByRole("separator", {
    name: "Resize sidebar",
  });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  // Keep this element's geometry separate from the transcript prototype mock.
  Object.defineProperty(handle.parentElement!, "getBoundingClientRect", {
    value: () => {
      return new DOMRect(0, 0, 1440, 900);
    },
    configurable: true,
  });
  const pointer = {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
  };
  fireEvent.pointerDown(handle, { ...pointer, clientX: 840 });
  setGeometry(409, false);
  fireEvent.pointerMove(handle, { ...pointer, clientX: 1000 });
  await waitFor(() => {
    expect(
      handle
        .closest<HTMLElement>('[style*="--chat-thread-sidebar-width"]')
        ?.style.getPropertyValue("--chat-thread-sidebar-width"),
    ).toBe("clamp(400px, 440px, calc(100% - 600px))");
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  fireEvent.pointerUp(handle, { ...pointer, buttons: 0 });
});

test("Temporarily dismiss a manually opened narrow panel on composer click without changing preference", async () => {
  const resize = await setupResources({ gutter: 200 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
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
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
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
  await userEvent.click(resourceButton());
  await screen.findByText("Preference update failed");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  expect(screen.getAllByText("Preference update failed")).toHaveLength(1);
});

test("Dismiss a narrow panel when keyboard focus moves to the composer", async () => {
  const resize = await setupResources({ gutter: 200 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(resourceButton());
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
  expect(all).toHaveAccessibleName("Resources");
  expect(buttonNamed("Close resources", all)).toBeInTheDocument();
});

test.each(["messages", "artifacts"] as const)(
  "Hide the previous chat's resources until the next chat's %s finish loading",
  async (pendingSource) => {
    installResourceGeometry(480);
    context.mocks.browser.matchMedia(true);
    const first = continuityThread(92, 1, "First resources");
    const second = continuityThread(92, 2, "Second resources");
    const resourcesRequested = createDeferredPromise<void>(context.signal);
    const resourcesResponse = createDeferredPromise<void>(context.signal);
    const rows = [first, second].map((thread, index) => {
      return continuityEventRow(92, index + 1, thread.id, "input.prompt", {
        payload: {
          userMessage: {
            version: 1,
            parts: [
              {
                type: "text",
                text: `[${thread.title} guide](https://example.test/${index})`,
              },
            ],
          },
        },
      });
    });
    const workspace = installContinuityWorkspace(context, {
      caseId: 92,
      threads: [first, second],
    });
    context.mocks.api(
      chatThreadEventsContract.rows,
      async ({ params, query, respond }) => {
        if (params.threadId === second.id && pendingSource === "messages") {
          if (!resourcesRequested.settled()) {
            resourcesRequested.resolve();
          }
          await resourcesResponse.promise;
        }
        return respond(
          200,
          chatEventRowsResponse(
            rows.filter((row) => {
              return row.chatThreadId === params.threadId;
            }),
            query,
          ),
        );
      },
    );
    context.mocks.api(
      chatThreadEventsContract.catchUp,
      async ({ body, respond }) => {
        if (
          pendingSource === "messages" &&
          body.some(([threadId]) => {
            return threadId === second.id;
          })
        ) {
          if (!resourcesRequested.settled()) {
            resourcesRequested.resolve();
          }
          await resourcesResponse.promise;
        }
        return respond(200, {
          events: Object.fromEntries(
            body.map(([threadId, sinceSeqId]) => {
              return [
                threadId,
                rows.filter((row) => {
                  return (
                    row.chatThreadId === threadId && row.seqId > sinceSeqId
                  );
                }),
              ];
            }),
          ),
          notFoundThreads: [],
        });
      },
    );
    context.mocks.api(
      chatThreadArtifactsContract.list,
      async ({ params, respond }) => {
        if (params.threadId === second.id && pendingSource === "artifacts") {
          if (!resourcesRequested.settled()) {
            resourcesRequested.resolve();
          }
          await resourcesResponse.promise;
        }
        const filename =
          params.threadId === first.id ? "first.pdf" : "second.pdf";
        return respond(200, {
          runs: [
            artifactRun({
              fileId: params.threadId,
              filename,
              contentType: "application/pdf",
              url: `https://files.example.test/${filename}`,
            }),
          ],
        });
      },
    );
    await setupPage({
      context,
      ...workspace.pageOptions,
      path: `/chats/${first.id}`,
      featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
    });
    const previousPanel = await screen.findByRole("region", {
      name: "Resources",
    });
    await within(previousPanel).findByText("First resources guide");
    expect(within(previousPanel).getByText("first.pdf")).toBeInTheDocument();
    const next = queryAllByRoleFast("link").find((link) => {
      return link.getAttribute("href") === `/chats/${second.id}`;
    });
    if (!next) {
      throw new Error("Second chat is missing");
    }
    click(next);
    await resourcesRequested.promise;
    await waitFor(() => {
      expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
        "Second resources",
      );
    });
    expect(resourcePanel()).not.toBeInTheDocument();
    resourcesResponse.resolve();
    await waitFor(() => {
      expect(
        within(resourcePanel()!).getByText("Second resources guide"),
      ).toBeInTheDocument();
    });
    const nextPanel = resourcePanel()!;
    expect(within(nextPanel).getByText("second.pdf")).toBeInTheDocument();
    expect(
      within(nextPanel).queryByText("First resources guide"),
    ).not.toBeInTheDocument();
    expect(within(nextPanel).queryByText("first.pdf")).not.toBeInTheDocument();
  },
);

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
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
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
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
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

test("Use the artifact icon on mobile without a separate switch or duplicate menu entry", async () => {
  await setupResources({ gutter: 16, desktop: false });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  expect(screen.queryByText("Show resources")).not.toBeInTheDocument();
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(composer());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(buttonNamed("More actions"));
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByText("Artifacts")).not.toBeInTheDocument();
});

test("Toggle the artifact panel with the keyboard", async () => {
  const resize = await setupResources({ gutter: 200 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  act(() => {
    resourceButton().focus();
  });
  await userEvent.keyboard(" ");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  await userEvent.keyboard(" ");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Return focus to the resource trigger when Escape dismisses its content", async () => {
  await setupResources();
  const user = userEvent.setup();
  const panel = await screen.findByRole("region", { name: "Resources" });
  act(() => {
    resourceButton().focus();
  });
  expect(resourceButton()).toHaveFocus();
  const link = within(panel).getByText("Current guide");
  act(() => {
    link.focus();
  });
  expect(link).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
    expect(resourceButton()).toHaveFocus();
    expect(resourceButton()).toHaveAttribute("aria-expanded", "false");
  });
});

async function setupResourceNavigation() {
  installResourceGeometry(480);
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  );
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const current = continuityThread(95, 1, "Current resources chat");
  const newer = continuityThread(95, 2, "Newer resources chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 95,
    threads: [current, newer],
  });
  await setupPage({
    context,
    path: `/chats/${current.id}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
    ...workspace.pageOptions,
  });
  await screen.findByRole("region", { name: "Resources" });
  await screen.findByRole("textbox", { name: "Message" });
  return { current, newer, user: userEvent.setup() };
}

test.each([
  {
    name: "adjacent",
    previous: "{Meta>}{Shift>}{ArrowUp}{/Shift}{/Meta}",
    next: "{Meta>}{Shift>}{ArrowDown}{/Shift}{/Meta}",
  },
  {
    name: "numbered",
    previous: "{Meta>}1{/Meta}",
    next: "{Meta>}2{/Meta}",
  },
])(
  "Navigate $name chats while resources stay open",
  async ({ previous, next }) => {
    const { current, newer, user } = await setupResourceNavigation();
    await user.click(composer());
    expect(resourcePanel()).toBeInTheDocument();
    await user.keyboard(previous);
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${newer.id}`);
      expect(document.title).toBe("Newer resources chat | Okou");
    });
    await screen.findByRole("region", { name: "Resources" });
    await user.click(composer());
    await user.keyboard(next);
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${current.id}`);
      expect(document.title).toBe("Current resources chat | Okou");
    });
  },
);

test("Search and start a chat with resources open", async () => {
  const { current, user } = await setupResourceNavigation();
  const editor = composer();
  await user.click(editor);
  await user.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  expect(
    within(dialog).getByPlaceholderText("Search workspace..."),
  ).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
  });
  expect(resourcePanel()).toBeInTheDocument();
  await user.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${current.agentId}/chat`);
  });
});

test("Keep chat shortcuts blocked by the rename dialog while resources are open", async () => {
  const { current, user } = await setupResourceNavigation();
  await user.click(composer());
  await user.keyboard("{F2}");
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  const title = within(dialog).getByPlaceholderText("Chat title");
  await waitFor(() => {
    expect(title).toHaveFocus();
  });
  await user.keyboard("{Meta>}{Shift>}{ArrowUp}o{/Shift}1{/Meta}");
  expect(pathname()).toBe(`/chats/${current.id}`);
  expect(title).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(resourcePanel()).toBeInTheDocument();
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
