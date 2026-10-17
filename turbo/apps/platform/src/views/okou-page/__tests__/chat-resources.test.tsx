import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  artifactRun,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

import { createDeferredPromise } from "../../../signals/utils.ts";

import {
  context,
  installResourceGeometry,
  resourceButton,
  resourcePanel,
  resourceState,
  setupOverflowResources,
  setupResources,
} from "./chat-resources-test-helpers.ts";

test("Explain an empty resources dropdown without hiding its button", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({ chatResourcesEnabledByDefault: false });
  mockArtifactConversation(context, {
    catalog: [],
    artifactRuns: () => {
      return [];
    },
    chatEvents: [],
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  expect(resourceButton()).toBeInTheDocument();
  expect(resourcePanel()).not.toBeInTheDocument();

  click(resourceButton());

  const panel = await screen.findByRole("region", { name: "Resources" });
  expect(resourceButton()).toHaveAttribute("aria-expanded", "true");
  await within(panel).findByText("No artifacts yet");
  expect(within(panel).queryByRole("listitem")).not.toBeInTheDocument();
});

test("Open the dropdown before its resources finish loading", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({ chatResourcesEnabledByDefault: false });
  mockArtifactConversation(context, { catalog: [], chatEvents: [] });
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(chatThreadArtifactsContract.list, async ({ respond }) => {
    await response.promise;
    return respond(200, {
      runs: [
        artifactRun({
          fileId: "b0000000-0000-4000-a000-000000000999",
          filename: "report.pdf",
          contentType: "application/pdf",
          url: "https://files.example.test/report.pdf",
        }),
      ],
    });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  expect(resourceButton()).toBeInTheDocument();
  expect(resourcePanel()).not.toBeInTheDocument();

  click(resourceButton());

  const panel = await screen.findByRole("region", { name: "Resources" });
  expect(resourceButton()).toHaveAttribute("aria-expanded", "true");
  expect(within(panel).queryByText("report.pdf")).not.toBeInTheDocument();
  expect(within(panel).queryByText("No artifacts yet")).not.toBeInTheDocument();
  response.resolve();
  await within(panel).findByText("report.pdf");
  expect(within(panel).queryByText("No artifacts yet")).not.toBeInTheDocument();
});

test("Show resource loading errors without retry controls in the popup and Links tab", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({ chatResourcesEnabledByDefault: false });
  mockArtifactConversation(context, { catalog: [], chatEvents: [] });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(500, {
      error: { message: "Attachments are unavailable" },
    });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  expect(resourceButton()).toBeInTheDocument();

  click(resourceButton());

  const panel = await screen.findByRole("region", { name: "Resources" });
  await expect(
    within(panel).findByText("Could not load resources"),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", panel).find((button) => {
      return button.textContent?.trim() === "Retry";
    }),
  ).toBeUndefined();
  expect(within(panel).queryByText("No artifacts yet")).not.toBeInTheDocument();

  click(buttonNamed("View all", panel));

  const all = await screen.findByRole("complementary", { name: "Resources" });
  const linksTab = queryAllByRoleFast("tab", all).find((tab) => {
    return tab.textContent?.trim() === "Links";
  });
  expect(linksTab).toBeInTheDocument();
  click(linksTab!);

  const links = within(all).getByRole("tabpanel");
  await expect(
    within(links).findByText("Could not load resources"),
  ).resolves.toBeInTheDocument();
  expect(linksTab).toHaveAttribute("aria-selected", "true");
  expect(
    queryAllByRoleFast("button", links).find((button) => {
      return button.textContent?.trim() === "Retry";
    }),
  ).toBeUndefined();
  expect(
    within(links).queryByText("No links in this chat yet"),
  ).not.toBeInTheDocument();
});

test("Show all three resources without an overflow control at the limit", async () => {
  const { panel } = await setupOverflowResources(3);
  for (const name of ["Artifacts", "Links"]) {
    const section = within(panel).getByRole("region", { name });
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    expect(
      queryAllByRoleFast("button", section).find((button) => {
        return button.getAttribute("aria-label") === "Expand";
      }),
    ).toBeUndefined();
  }
  expect(buttonNamed("View all", panel)).toBeInTheDocument();
});

test.each(["Artifacts", "Links"] as const)(
  "Expand and collapse the %s list independently in place",
  async (name) => {
    const { panel } = await setupOverflowResources(4);
    expect(
      within(panel)
        .getAllByRole("heading")
        .map((heading) => {
          return heading.textContent;
        }),
    ).toStrictEqual(["Artifacts", "Links"]);
    for (const sectionName of ["Artifacts", "Links"]) {
      const section = within(panel).getByRole("region", { name: sectionName });
      expect(within(section).getAllByRole("listitem")).toHaveLength(3);
      expect(buttonNamed("Expand", section)).toBeInTheDocument();
    }
    expect(within(panel).queryByText("report-4.pdf")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Reference 4")).not.toBeInTheDocument();

    const section = within(panel).getByRole("region", { name });
    const more = buttonNamed("Expand", section);
    more.focus();
    await userEvent.keyboard("{Enter}");

    await within(section).findByText(
      name === "Artifacts" ? "report-4.pdf" : "Reference 4",
    );
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
    expect(within(section).getAllByRole("listitem")).toHaveLength(4);
    expect(
      screen.queryByTestId("thread-sidebar-artifacts"),
    ).not.toBeInTheDocument();
    expect(buttonNamed("Collapse", section)).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const other = within(panel).getByRole("region", {
      name: name === "Artifacts" ? "Links" : "Artifacts",
    });
    expect(within(other).getAllByRole("listitem")).toHaveLength(3);
    click(buttonNamed("Expand", other));
    await within(other).findByText(
      name === "Artifacts" ? "Reference 4" : "report-4.pdf",
    );
    expect(within(other).getAllByRole("listitem")).toHaveLength(4);
    expect(within(section).getAllByRole("listitem")).toHaveLength(4);
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
    expect(
      screen.queryByTestId("thread-sidebar-artifacts"),
    ).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("link", panel).map((link) => {
        return {
          href: link.getAttribute("href"),
          target: link.getAttribute("target"),
        };
      }),
    ).toStrictEqual(
      Array.from({ length: 4 }, (_, index) => {
        return {
          href: `https://example.test/reference-${index + 1}`,
          target: "_blank",
        };
      }),
    );

    buttonNamed("Collapse", section).focus();
    await userEvent.keyboard("{Enter}");
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(section).queryByText(
        name === "Artifacts" ? "report-4.pdf" : "Reference 4",
      ),
    ).not.toBeInTheDocument();
    expect(buttonNamed("Expand", section)).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(other).getAllByRole("listitem")).toHaveLength(4);

    click(buttonNamed("Collapse", other));
    expect(within(other).getAllByRole("listitem")).toHaveLength(3);
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
    expect(
      screen.queryByTestId("thread-sidebar-artifacts"),
    ).not.toBeInTheDocument();
  },
);

test("Browse complete artifacts and links in separate tabs from View all", async () => {
  const { panel } = await setupOverflowResources(7);
  click(within(panel).getByText("View all"));
  const all = await screen.findByRole("complementary", { name: "Resources" });
  await within(all).findByText("report-7.pdf");
  expect(within(all).queryByText("Reference 7")).not.toBeInTheDocument();
  const tabs = queryAllByRoleFast("tab", all);
  expect(tabs).toHaveLength(2);
  expect(tabs[0]).toHaveTextContent("Artifacts7");
  expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  expect(tabs[1]).toHaveTextContent("Links7");
  expect(within(all).queryByRole("searchbox")).not.toBeInTheDocument();
  click(tabs[1]!);
  await within(all).findByText("Reference 7");
  expect(within(all).queryByText("report-7.pdf")).not.toBeInTheDocument();
  expect(tabs[1]).toHaveAttribute("aria-selected", "true");
  tabs[1]!.focus();
  await userEvent.keyboard("{ArrowLeft}{Enter}");
  expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  await within(all).findByText("report-7.pdf");
});

test("Keep loaded gallery pages and fullscreen when switching resource tabs", async () => {
  const { panel } = await setupOverflowResources(2, { paginated: true });
  click(buttonNamed("View all", panel));
  const all = await screen.findByTestId("thread-sidebar-artifacts");
  await within(all).findByText("report-1.pdf");
  expect(queryAllByRoleFast("tab", all)[0]).toHaveTextContent("Artifacts1+");
  const viewport = within(all).getByRole("tabpanel");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 1000 },
    scrollTop: { configurable: true, value: 900 },
  });
  fireEvent.scroll(viewport);
  await within(all).findByText("report-2.pdf");
  expect(queryAllByRoleFast("tab", all)[0]).toHaveTextContent("Artifacts2");
  expect(queryAllByRoleFast("tab", all)[0]).not.toHaveTextContent("+");

  click(buttonNamed("Enter fullscreen", all));
  const fullscreen = await screen.findByTestId("thread-sidebar-artifacts");
  click(queryAllByRoleFast("tab", fullscreen)[1]!);
  await within(fullscreen).findByText("Reference 2");
  expect(buttonNamed("Exit fullscreen", fullscreen)).toBeInTheDocument();
  click(queryAllByRoleFast("tab", fullscreen)[0]!);
  await within(fullscreen).findByText("report-2.pdf");
  expect(within(fullscreen).getByText("report-1.pdf")).toBeInTheDocument();
  expect(buttonNamed("Exit fullscreen", fullscreen)).toBeInTheDocument();
});

test("Explain an empty Links tab and return from an unavailable gallery preview", async () => {
  const { panel } = await setupOverflowResources(1, { withLinks: false });
  click(buttonNamed("View all", panel));
  const all = await screen.findByTestId("thread-sidebar-artifacts");
  await within(all).findByText("report-1.pdf");
  click(queryAllByRoleFast("tab", all)[1]!);
  expect(queryAllByRoleFast("tab", all)[1]).toHaveTextContent("Links0");
  await within(all).findByText("No links in this chat yet");
  click(queryAllByRoleFast("tab", all)[0]!);
  click(buttonNamed("Preview report-1.pdf", all));
  const unavailable = await screen.findByTestId(
    "thread-sidebar-artifact-unavailable",
  );
  click(buttonNamed("Back to artifacts", unavailable));
  const gallery = await screen.findByTestId("thread-sidebar-artifacts");
  await within(gallery).findByText("report-1.pdf");
  expect(gallery).toHaveAccessibleName("Resources");
  expect(queryAllByRoleFast("tab", gallery)[0]).toHaveAttribute(
    "aria-selected",
    "true",
  );
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
  click(queryAllByRoleFast("tab", all)[1]!);
  await within(all).findByText("Current guide");
  expect(all).toHaveAccessibleName("Resources");
  expect(buttonNamed("Close resources", all)).toBeInTheDocument();
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
