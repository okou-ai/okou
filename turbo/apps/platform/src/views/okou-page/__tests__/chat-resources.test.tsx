import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
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

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatResourcesHelpers,
  RESOURCE_ARTIFACT_ID,
  installResourceGeometry,
  resourceButton,
  resourcePanel,
  resourceState,
} from "./chat-resources-test-helpers.ts";

const context = testContext();
const { setupOverflowResources, setupResources, recordPreferenceUpdates } =
  createChatResourcesHelpers(context);

test("Keep an empty chat closed through presses while it loads, then show its hint when pressed", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  const preferenceSaved = createDeferredPromise<void>(context.signal);
  recordPreferenceUpdates(true, preferenceSaved.promise);
  mockArtifactConversation(context, {
    catalog: [],
    artifactRuns: () => {
      return [];
    },
    chatEvents: [],
  });
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    await response.promise;
    return respond(200, { artifacts: [], nextCursor: null });
  });
  context.mocks.api(chatRelationsContract.children, ({ respond }) => {
    return respond(200, { items: [] });
  });
  context.mocks.api(chatRelationsContract.communications, ({ respond }) => {
    return respond(200, { items: [] });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
  });
  await screen.findByTestId("chat-thread-header-title");
  // The saved default asks for the panel; the button breathes until it answers.
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "true");
  });
  expect(resourceButton()).toHaveAttribute("aria-disabled", "true");
  expect(resourceButton()).toHaveAttribute(
    "aria-description",
    "Loading artifacts",
  );
  // Taken, this press would be an explicit open that shows the empty hint.
  click(resourceButton());
  response.resolve();
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  expect(resourceButton()).not.toHaveAttribute("aria-disabled");
  expect(resourceState()).toStrictEqual({ open: false, visible: false });
  // The saved preference is already on, so opening the empty hint must not
  // wait for another preference save.
  click(resourceButton());
  const panel = await screen.findByRole("region", {
    name: "Artifacts and chats",
  });
  await expect(
    within(panel).findByText("No artifacts yet"),
  ).resolves.toBeInTheDocument();
  expect(
    within(panel).getByText(
      "Files, websites, and other artifacts made in this chat will show up here.",
    ),
  ).toBeInTheDocument();
  expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  preferenceSaved.resolve();
});

test("Draw complete resources after loading and reuse them when reopened", async () => {
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
  let resourcesAvailable = true;
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    await response.promise;
    return respond(200, {
      artifacts: resourcesAvailable
        ? [artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf")]
        : [],
      nextCursor: null,
    });
  });
  context.mocks.api(chatRelationsContract.children, async ({ respond }) => {
    await response.promise;
    return respond(200, {
      items: resourcesAvailable
        ? [
            {
              id: "d0000000-0000-4000-a000-000000000105",
              threadId: "d0000000-0000-4000-a000-000000000102",
              title: "Research child",
              status: "idle",
              sourceRunId: "d0000000-0000-4000-a000-000000000103",
              createdAt: "2026-09-01T10:00:00.000Z",
            },
          ]
        : [],
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
  });
  await screen.findByText("Keep chatting while resources load");
  expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  click(resourceButton());
  // The press is acknowledged at once; the panel waits for every source.
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "true");
  });
  expect(resourceButton()).toHaveAttribute("aria-disabled", "true");
  expect(resourcePanel()).not.toBeInTheDocument();
  response.resolve();
  const panel = await screen.findByRole("region", {
    name: "Artifacts and chats",
  });
  expect(within(panel).getByText("report.pdf")).toBeInTheDocument();
  expect(within(panel).getByText("Research child")).toBeInTheDocument();
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
  expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  expect(resourceButton()).not.toHaveAttribute("aria-disabled");

  click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  // Reopening keeps the loaded resources, even if the service's list changes.
  resourcesAvailable = false;
  click(resourceButton());
  const reopened = await screen.findByRole("region", {
    name: "Artifacts and chats",
  });
  expect(within(reopened).getByText("report.pdf")).toBeInTheDocument();
  expect(within(reopened).getByText("Research child")).toBeInTheDocument();
  expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  expect(resourceButton()).not.toHaveAttribute("aria-disabled");
});

test("Release the resource button when the gutter narrows and open the pending resources on press", async () => {
  const resize = installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
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
  });
  await screen.findByTestId("chat-thread-header-title");
  // The saved default asks for the panel while it has room.
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "true");
  });
  resize(200);
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  expect(resourceButton()).not.toHaveAttribute("aria-disabled");
  expect(resourceState()).toStrictEqual({ open: false, visible: false });

  click(resourceButton());
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "true");
  });
  expect(resourceButton()).toHaveAttribute("aria-disabled", "true");
  expect(resourcePanel()).not.toBeInTheDocument();
  response.resolve();
  const panel = await screen.findByRole("region", {
    name: "Artifacts and chats",
  });
  expect(within(panel).getByText("report.pdf")).toBeInTheDocument();
  expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  expect(resourceButton()).not.toHaveAttribute("aria-disabled");
});

test("Display a resource loading error without showing an empty state", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({ chatResourcesEnabledByDefault: false });
  mockArtifactConversation(context, { catalog: [], chatEvents: [] });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(500, {
      error: { message: "Attachments are unavailable" },
    });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
  });
  await waitFor(() => {
    expect(resourceButton()).toBeInTheDocument();
  });

  click(resourceButton());

  const panel = await screen.findByRole("region", {
    name: "Artifacts and chats",
  });
  await expect(
    within(panel).findByText("Could not load artifacts"),
  ).resolves.toBeInTheDocument();
});

test("Name the closed resource trigger in a tooltip until the panel opens", async () => {
  await setupResources({ preferred: false });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  const user = userEvent.setup();
  await user.hover(resourceButton());
  const tooltip = await screen.findByText("Artifacts and chats");
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
  expect(queryAllByRoleFast("link", panel)).toHaveLength(0);
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.getAttribute("aria-label") === "Artifacts and chats";
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
    });
    await screen.findByText("Conversation 20");
    expect(screen.queryByText("Conversation 0")).not.toBeInTheDocument();
    expect(resourceButton()).toBeEnabled();
    expect(resourcePanel()).not.toBeInTheDocument();
    click(resourceButton());
    const panel = await screen.findByRole("region", {
      name: "Artifacts and chats",
    });
    await within(panel).findByText("No artifacts yet");
    expect(queryAllByRoleFast("link", panel)).toHaveLength(0);
  },
);
