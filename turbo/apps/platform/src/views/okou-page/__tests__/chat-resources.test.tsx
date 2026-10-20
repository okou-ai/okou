import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  artifactSummary,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

import { createDeferredPromise } from "../../../signals/utils.ts";

import {
  context,
  RESOURCE_ARTIFACT_ID,
  installResourceGeometry,
  resourceButton,
  resourcePanel,
  resourceState,
  setupOverflowResources,
  setupResources,
} from "./chat-resources-test-helpers.ts";

test("Keep the resource trigger in a chat without resources and open its empty panel by default", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
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
  await screen.findByTestId("chat-thread-header-title");
  expect(resourceButton()).toBeEnabled();
  const panel = await screen.findByRole("region", { name: "Resources" });
  await expect(
    within(panel).findByText(
      "Artifacts, links, and related chats from this chat appear here.",
    ),
  ).resolves.toBeInTheDocument();
});

test("Keep chat usable before opening pending artifacts and related chats", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({ chatResourcesEnabledByDefault: false });
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: [
      {
        id: "resources-pending-user",
        role: "user",
        content: "Keep chatting while resources load",
        createdAt: "2026-09-01T10:00:00Z",
      },
    ],
  });
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    await response.promise;
    return respond(200, {
      artifacts: [artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf")],
      nextCursor: null,
    });
  });
  context.mocks.api(chatRelationsContract.children, async ({ respond }) => {
    await response.promise;
    return respond(200, {
      items: [
        {
          id: "d0000000-0000-4000-a000-000000000105",
          threadId: "d0000000-0000-4000-a000-000000000102",
          title: "Research child",
          status: "idle",
          sourceRunId: "d0000000-0000-4000-a000-000000000103",
          createdAt: "2026-09-01T10:00:00.000Z",
        },
      ],
    });
  });
  context.mocks.api(
    chatRelationsContract.communications,
    async ({ respond }) => {
      await response.promise;
      return respond(200, { items: [] });
    },
  );
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  await screen.findByText("Keep chatting while resources load");
  expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  expect(resourceButton()).toBeEnabled();
  expect(resourcePanel()).not.toBeInTheDocument();
  click(resourceButton());
  const panel = await screen.findByRole("region", { name: "Resources" });
  await expect(within(panel).findByRole("status")).resolves.toHaveTextContent(
    "Loading",
  );
  expect(
    within(panel).queryByText(
      "Artifacts, links, and related chats from this chat appear here.",
    ),
  ).not.toBeInTheDocument();
  response.resolve();
  await within(panel).findByText("report.pdf");
  await within(panel).findByText("Research child");
  expect(within(panel).queryByText("No artifacts yet")).not.toBeInTheDocument();
});

test("Retry a resource loading error without showing an empty state", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({ chatResourcesEnabledByDefault: false });
  mockArtifactConversation(context, { catalog: [], chatEvents: [] });
  let failed = true;
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return failed
      ? respond(500, {
          error: { message: "Attachments are unavailable" },
        })
      : respond(200, {
          artifacts: [
            artifactSummary(RESOURCE_ARTIFACT_ID, "file", "recovered.pdf"),
          ],
          nextCursor: null,
        });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  await waitFor(() => {
    expect(resourceButton()).toBeInTheDocument();
  });

  click(resourceButton());

  const panel = await screen.findByRole("region", { name: "Resources" });
  await expect(
    within(panel).findByText("Could not load resources"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("No artifacts yet")).not.toBeInTheDocument();

  failed = false;
  click(buttonNamed("Try again", panel));
  await within(panel).findByText("recovered.pdf");
  expect(within(panel).queryByRole("alert")).not.toBeInTheDocument();
});

test("Name the closed resource trigger in a tooltip until the panel opens", async () => {
  await setupResources({ preferred: false });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  const user = userEvent.setup();
  await user.hover(resourceButton());
  const tooltip = await screen.findByText("Resources");
  await user.click(resourceButton());
  await waitFor(() => {
    expect(tooltip).not.toBeInTheDocument();
  });
  expect(resourceState()).toStrictEqual({ open: true, visible: true });
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
  expect(within(panel).queryByText("View all")).not.toBeInTheDocument();
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
      return button.getAttribute("aria-label") === "Resources";
    }),
  ).toHaveLength(1);
  expect(screen.queryByText("Show resources")).not.toBeInTheDocument();
  expect(
    screen.queryByTestId("thread-sidebar-artifacts"),
  ).not.toBeInTheDocument();
});

test("Copy the original link without opening it", async () => {
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
