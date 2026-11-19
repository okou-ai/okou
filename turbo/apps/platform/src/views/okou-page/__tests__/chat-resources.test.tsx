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
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactSummary,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  createChatResourcesHelpers,
  RESOURCE_ARTIFACT_ID,
  resourceButton,
  resourcePanel,
  resourceState,
} from "./chat-resources-test-helpers.ts";

const context = testContext();
const { setupOverflowResources, setupResources } =
  createChatResourcesHelpers(context);

test("An empty chat's resources open while loading and then show the empty hint", async () => {
  context.mocks.browser.matchMedia(true);
  mockArtifactConversation(context, {
    catalog: [],
    artifactRuns: () => {
      return [];
    },
    chatEvents: [],
  });
  const response = context.mocks.deferred<void>();
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
  expect(resourceState()).toStrictEqual({ open: false, visible: false });

  click(resourceButton());

  const panel = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  expect(
    within(panel).getByRole("status", { name: "Loading artifacts" }),
  ).toBeInTheDocument();
  expect(within(panel).queryByText("No artifacts yet")).not.toBeInTheDocument();

  response.resolve();
  await expect(
    within(panel).findByText("No artifacts yet"),
  ).resolves.toBeInTheDocument();
  expect(
    within(panel).getByText(
      "Files, websites, and other artifacts made in this chat will show up here.",
    ),
  ).toBeInTheDocument();
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
});

test("Resources open while loading, show their artifact and child chat, and keep them on reopen", async () => {
  context.mocks.browser.matchMedia(true);
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
  const response = context.mocks.deferred<void>();
  let resourcesAvailable = true;
  const readsAfterReopen: string[] = [];
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    await response.promise;
    if (!resourcesAvailable) {
      readsAfterReopen.push("artifacts");
    }
    return respond(200, {
      artifacts: resourcesAvailable
        ? [artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf")]
        : [],
      nextCursor: null,
    });
  });
  context.mocks.api(chatRelationsContract.children, async ({ respond }) => {
    await response.promise;
    if (!resourcesAvailable) {
      readsAfterReopen.push("child chats");
    }
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

  click(resourceButton());
  const panel = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  expect(
    within(panel).getByRole("status", { name: "Loading artifacts" }),
  ).toBeInTheDocument();

  response.resolve();
  await expect(
    within(panel).findByText("report.pdf"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByText("Research child")).toBeInTheDocument();
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();

  click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resourcesAvailable = false;
  click(resourceButton());
  const reopened = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  expect(within(reopened).getByText("report.pdf")).toBeInTheDocument();
  expect(within(reopened).getByText("Research child")).toBeInTheDocument();
  // The reopened panel reuses its loaded resources instead of re-reading.
  expect(readsAfterReopen).toStrictEqual([]);
});

test("The closed resource trigger names itself in a tooltip until the panel opens", async () => {
  await setupResources({ open: false });
  expect(resourceState()).toStrictEqual({ open: false, visible: false });
  const user = userEvent.setup();

  await user.hover(resourceButton());
  const tooltip = await screen.findByText("Artifacts and chats");
  await user.click(resourceButton());

  await waitFor(() => {
    expect(tooltip).not.toBeInTheDocument();
  });
  expect(resourceState()).toStrictEqual({ open: true, visible: true });
});

test("The artifacts list expands and collapses in place", async () => {
  const { panel } = await setupOverflowResources(4);
  const section = within(panel).getByRole("region", { name: "Artifacts" });
  expect(within(section).getAllByRole("listitem")).toHaveLength(3);
  expect(within(section).queryByText("report-4.pdf")).not.toBeInTheDocument();

  buttonNamed("Show more", section).focus();
  await userEvent.keyboard("{Enter}");

  await within(section).findByText("report-4.pdf");
  expect(within(section).getAllByRole("listitem")).toHaveLength(4);
  expect(resourceState()).toStrictEqual({ open: true, visible: true });
  expect(
    screen.queryByTestId("thread-sidebar-artifacts"),
  ).not.toBeInTheDocument();

  buttonNamed("Collapse", section).focus();
  await userEvent.keyboard("{Enter}");

  expect(within(section).getAllByRole("listitem")).toHaveLength(3);
  expect(within(section).queryByText("report-4.pdf")).not.toBeInTheDocument();
});

test("The floating resources show artifacts while transcript links stay outside", async () => {
  await setupResources();
  const panel = resourcePanel()!;
  await within(panel).findByText("report.pdf");
  expect(
    within(panel).getByRole("heading", { name: "Artifacts" }),
  ).toBeInTheDocument();
  const guide = await waitFor(() => {
    const link = queryAllByRoleFast("link").find((item) => {
      return item.textContent?.trim() === "Current guide";
    });
    if (!link) {
      throw new Error("The transcript link is missing");
    }
    return link;
  });
  expect(panel).not.toContainElement(guide);
  expect(queryAllByRoleFast("link", panel)).toHaveLength(0);
  expect(resourceButton()).toHaveAttribute("aria-haspopup", "dialog");
  expect(resourceButton()).toHaveAttribute("aria-expanded", "true");

  click(buttonNamed("Close artifacts and chats", panel));

  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});
