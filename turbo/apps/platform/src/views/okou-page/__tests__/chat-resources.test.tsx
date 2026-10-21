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

test("Keep an empty chat's panel closed until the trigger is pressed", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  mockArtifactConversation(context, {
    catalog: [],
    artifactRuns: () => {
      return [];
    },
    chatEvents: [],
  });
  const answered = { catalog: false, children: false, communications: false };
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    answered.catalog = true;
    return respond(200, { artifacts: [], nextCursor: null });
  });
  context.mocks.api(chatRelationsContract.children, ({ respond }) => {
    answered.children = true;
    return respond(200, { items: [] });
  });
  context.mocks.api(chatRelationsContract.communications, ({ respond }) => {
    answered.communications = true;
    return respond(200, { items: [] });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  await screen.findByTestId("chat-thread-header-title");
  // The saved default asks for the panel, so every source answers first.
  await waitFor(() => {
    expect(answered).toStrictEqual({
      catalog: true,
      children: true,
      communications: true,
    });
  });
  expect(resourceButton()).toBeEnabled();
  expect(resourceState()).toStrictEqual({ open: false, visible: false });
  click(resourceButton());
  const panel = await screen.findByRole("region", { name: "Resources" });
  await expect(
    within(panel).findByText(
      "Artifacts and related chats from this chat appear here.",
    ),
  ).resolves.toBeInTheDocument();
});

test("Draw a pressed panel only once its artifacts and related chats have answered", async () => {
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
  click(resourceButton());
  // The press is acknowledged at once; the panel waits for every source.
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "true");
  });
  expect(resourceButton()).toBeEnabled();
  expect(resourcePanel()).not.toBeInTheDocument();
  response.resolve();
  const panel = await screen.findByRole("region", { name: "Resources" });
  expect(within(panel).getByText("report.pdf")).toBeInTheDocument();
  expect(within(panel).getByText("Research child")).toBeInTheDocument();
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
  expect(resourceButton()).toHaveAttribute("aria-busy", "false");
});

test("Cancel a pending panel with a second press", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({ chatResourcesEnabledByDefault: false });
  mockArtifactConversation(context, { catalog: [], chatEvents: [] });
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    await response.promise;
    return respond(200, {
      artifacts: [artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf")],
      nextCursor: null,
    });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  await screen.findByTestId("chat-thread-header-title");
  click(resourceButton());
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "true");
  });
  click(resourceButton());
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  expect(resourceState()).toStrictEqual({ open: false, visible: false });
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

test("Show all three artifacts without an overflow control at the limit", async () => {
  const { panel } = await setupOverflowResources(3);
  const section = within(panel).getByRole("region", { name: "Artifacts" });
  expect(within(section).getAllByRole("listitem")).toHaveLength(3);
  expect(
    queryAllByRoleFast("button", section).find((button) => {
      return button.getAttribute("aria-label") === "Show more";
    }),
  ).toBeUndefined();
  expect(within(panel).queryByText("View all")).not.toBeInTheDocument();
});

test("Expand and collapse the artifacts list in place", async () => {
  const { panel } = await setupOverflowResources(4);
  const section = within(panel).getByRole("region", { name: "Artifacts" });
  expect(within(section).getAllByRole("listitem")).toHaveLength(3);
  expect(within(panel).queryByText("report-4.pdf")).not.toBeInTheDocument();
  const more = buttonNamed("Show more", section);
  more.focus();
  await userEvent.keyboard("{Enter}");

  await within(section).findByText("report-4.pdf");
  expect(resourceState()).toStrictEqual({ open: true, visible: true });
  expect(within(section).getAllByRole("listitem")).toHaveLength(4);
  expect(buttonNamed("Collapse", section)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    screen.queryByTestId("thread-sidebar-artifacts"),
  ).not.toBeInTheDocument();

  buttonNamed("Collapse", section).focus();
  await userEvent.keyboard("{Enter}");
  expect(within(section).getAllByRole("listitem")).toHaveLength(3);
  expect(within(section).queryByText("report-4.pdf")).not.toBeInTheDocument();
  expect(buttonNamed("Show more", section)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(resourceState()).toStrictEqual({ open: true, visible: true });
});

test("Show artifacts in the floating panel while links remain in the transcript", async () => {
  await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  const panel = resourcePanel()!;
  expect(resourceButton()).not.toHaveAttribute("aria-haspopup");
  expect(resourceButton()).toHaveAttribute("aria-expanded", "true");
  expect(resourceButton()).toHaveAttribute("aria-controls", panel.id);
  await within(panel).findByText("report.pdf");
  await screen.findByText("Current guide");
  expect(
    within(panel).getByRole("heading", { name: "Artifacts" }),
  ).toBeInTheDocument();
  expect(
    within(panel).queryByRole("region", { name: "Links" }),
  ).not.toBeInTheDocument();
  expect(within(panel).queryByText("Current guide")).not.toBeInTheDocument();
  expect(queryAllByRoleFast("link", panel)).toHaveLength(0);
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.getAttribute("aria-label") === "Resources";
    }),
  ).toHaveLength(1);
  expect(
    screen.queryByTestId("thread-sidebar-artifacts"),
  ).not.toBeInTheDocument();
});

test.each([0, 20])(
  "Show empty resources for a link-only chat with a link in message %i",
  async (linkIndex) => {
    installResourceGeometry(480);
    context.mocks.browser.matchMedia(true);
    context.mocks.data.userPreferences({
      chatResourcesEnabledByDefault: false,
    });
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
              index === linkIndex
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
    expect(resourceButton()).toBeEnabled();
    expect(resourcePanel()).not.toBeInTheDocument();
    click(resourceButton());
    const panel = await screen.findByRole("region", { name: "Resources" });
    await within(panel).findByText(
      "Artifacts and related chats from this chat appear here.",
    );
    expect(queryAllByRoleFast("link", panel)).toHaveLength(0);
  },
);
