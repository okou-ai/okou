import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const IOS_SAFARI_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

function mockIOSSafari(standalone: boolean): void {
  context.mocks.browser.userAgent(IOS_SAFARI_USER_AGENT);
  context.mocks.browser.standaloneDisplayMode(standalone);
}

function getButton({
  label,
  text,
  container = document.body,
}: {
  readonly label?: string;
  readonly text?: string;
  readonly container?: ParentNode;
}): HTMLButtonElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return label
      ? candidate.getAttribute("aria-label") === label
      : candidate.textContent?.trim() === text;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label ?? text ?? "unnamed"}`);
  }
  return button;
}

test("An iOS user can open or dismiss the install prompt", async () => {
  mockIOSSafari(false);

  await setupPage({ context, path: "/", host: "app.okou.ai" });

  await expect(
    screen.findByText("Install Okou for a better experience"),
  ).resolves.toBeVisible();
  expect(getButton({ label: "Dismiss install banner" })).toBeEnabled();
  click(getButton({ label: "Install app" }));

  const dialog = await screen.findByRole("dialog", { name: "Install Okou" });
  expect(
    within(dialog).getByText("In Safari, tap the Share button."),
  ).toBeVisible();
  expect(within(dialog).getByText("Choose Add to Home Screen.")).toBeVisible();
  click(getButton({ text: "Got it", container: dialog }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Install Okou" })).toBeNull();
  });

  click(getButton({ label: "Dismiss install banner" }));

  await waitFor(() => {
    expect(
      screen.queryByText("Install Okou for a better experience"),
    ).toBeNull();
  });
});

test("The standalone app hides the install banner", async () => {
  mockIOSSafari(true);

  await setupPage({ context, path: "/", host: "app.okou.ai" });

  expect(getButton({ label: "Open menu" })).toBeEnabled();
  expect(screen.queryByText("Install Okou for a better experience")).toBeNull();
});
