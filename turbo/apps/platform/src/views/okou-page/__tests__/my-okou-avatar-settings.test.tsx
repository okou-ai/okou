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
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";

const context = testContext();
const INSTRUCTIONS = "Reply with short bullet points and cite sources.";

function myOkouAvatar(): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === "My Okou";
  });
}

test("The home avatar opens My Okou settings", async () => {
  context.mocks.browser.matchMedia((query) => {
    return [SIDEBAR_DESKTOP_MEDIA_QUERY, "(min-width: 1280px)"].includes(query);
  });
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, {
      orgId: "org_default",
      userId: "test-user-123",
      content: INSTRUCTIONS,
      updatedAt: "2026-11-21T09:00:00.000Z",
      version: "instructions-v4",
    });
  });
  await setupPage({
    context,
    path: "/",
  });
  const avatar = await waitFor(() => {
    const button = myOkouAvatar();
    expect(button).toBeDefined();
    return button as HTMLElement;
  });

  click(avatar);

  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    within(settings).findByText(INSTRUCTIONS),
  ).resolves.toBeInTheDocument();
  expect(settings).toHaveTextContent(
    "Used the next time Okou starts working. Work in progress won’t change.",
  );

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(settings).not.toBeInTheDocument();
  });
  expect(window.location.pathname).toBe("/");
  expect(myOkouAvatar()).toBeDefined();
});
