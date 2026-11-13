import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000951";

test.each([
  { entry: "home", path: "/", keyboard: false },
  { entry: "chat reply", path: `/chats/${THREAD_ID}`, keyboard: true },
])("The $entry avatar opens My Okou settings", async ({ path, keyboard }) => {
  context.mocks.data.org({ role: "member" });
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, {
      orgId: "test-org-123",
      userId: "test-user-123",
      content: "Use concise updates",
      version: "opaque-v1",
      updatedAt: "2026-11-13T10:00:00Z",
    });
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "avatar-settings-prompt",
        role: "user",
        content: "Help me plan my day",
        runId: "avatar-settings-run",
        createdAt: "2026-11-13T10:00:00Z",
      },
      {
        id: "avatar-settings-answer",
        role: "assistant",
        content: "Let’s plan your day.",
        runId: "avatar-settings-run",
        createdAt: "2026-11-13T10:00:01Z",
      },
    ],
  });
  await setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.SingleAgent]: true,
      [FeatureSwitchKey.HomeCapabilities]: true,
    },
  });

  const avatar = await waitFor(() => {
    const button = queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-label") === "My Okou";
    });
    if (!button) {
      throw new Error("My Okou avatar button not found");
    }
    return button;
  });

  if (keyboard) {
    avatar.focus();
    await userEvent.keyboard("{Enter}");
  } else {
    click(avatar);
  }

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    within(dialog).findByLabelText("Instructions"),
  ).resolves.toHaveTextContent("Use concise updates");
  expect(
    within(dialog).getByText("Your instructions for Okou in this workspace"),
  ).toBeInTheDocument();
  expect(location.pathname).toBe(path);

  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
  expect(location.pathname).toBe(path);
  expect(avatar).toBeInTheDocument();
});
