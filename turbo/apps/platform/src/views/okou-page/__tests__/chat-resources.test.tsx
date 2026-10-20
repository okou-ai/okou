import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
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

test("Hide the resource trigger and panel when there is no content", async () => {
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
  await screen.findByTestId("chat-thread-header-title");
  expect(screen.queryByLabelText("Open artifacts")).not.toBeInTheDocument();
  expect(resourcePanel()).not.toBeInTheDocument();
});

test("Hide the resource trigger until content has loaded", async () => {
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
  expect(screen.queryByLabelText("Open artifacts")).not.toBeInTheDocument();
  expect(resourcePanel()).not.toBeInTheDocument();
  response.resolve();
  await waitFor(() => {
    expect(resourceButton()).toBeInTheDocument();
  });
  click(resourceButton());
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("report.pdf");
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

test("Show all three artifacts without an overflow control at the limit", async () => {
  const { panel } = await setupOverflowResources(3);
  const section = within(panel).getByRole("region", { name: "Artifacts" });
  expect(within(section).getAllByRole("listitem")).toHaveLength(3);
  expect(
    queryAllByRoleFast("button", section).find((button) => {
      return button.getAttribute("aria-label") === "Expand";
    }),
  ).toBeUndefined();
  expect(within(panel).queryByText("View all")).not.toBeInTheDocument();
});

test("Expand and collapse the artifacts list in place", async () => {
  const { panel } = await setupOverflowResources(4);
  const section = within(panel).getByRole("region", { name: "Artifacts" });
  expect(within(section).getAllByRole("listitem")).toHaveLength(3);
  expect(within(panel).queryByText("report-4.pdf")).not.toBeInTheDocument();
  const more = buttonNamed("Expand", section);
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
  expect(buttonNamed("Expand", section)).toHaveAttribute(
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
      return button.getAttribute("aria-label") === "Open artifacts";
    }),
  ).toHaveLength(1);
  expect(screen.queryByText("Show resources")).not.toBeInTheDocument();
  expect(
    screen.queryByTestId("thread-sidebar-artifacts"),
  ).not.toBeInTheDocument();
});

test.each([0, 20])(
  "Hide resources for a link-only chat with a link in message %i",
  async (linkIndex) => {
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
    expect(screen.queryByLabelText("Open artifacts")).not.toBeInTheDocument();
    expect(resourcePanel()).not.toBeInTheDocument();
  },
);
