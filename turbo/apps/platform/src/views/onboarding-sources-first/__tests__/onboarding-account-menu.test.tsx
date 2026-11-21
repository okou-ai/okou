import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";

const context = testContext();
test.each([
  ["onboarding-account-menu-002", "Claude usage", "{Enter}"],
  ["onboarding-account-menu-003", "ChatGPT usage", " "],
])(
  "%s opens model settings from %s using the keyboard",
  async (_id, usage, key) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    const types = ["codex-oauth-token", "claude-code-oauth-token"] as const;
    context.mocks.data.personalModelProviders(
      types.map((type) => {
        return {
          type,
          id: crypto.randomUUID(),
          framework: type === "codex-oauth-token" ? "codex" : "claude-code",
          isActive: true,
          needsReconnect: false,
          lastRefreshErrorCode: null,
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
          subscriptionUsage: {
            fiveHour: {
              usedPercent: 20,
              remainingPercent: 80,
              resetAt: null,
              windowSeconds: 18_000,
            },
            weekly: null,
          },
        };
      }),
    );
    const user = userEvent.setup();
    await setupPage({ context, path: "/onboarding" });
    await user.click(await findAction("button", "Test User"));
    const menu = await screen.findByRole("menu");
    const item = await screen.findByLabelText(usage, {
      selector: '[role="menuitem"]',
    });
    for (const _entry of menu.querySelectorAll('[role="menuitem"]')) {
      if (item === document.activeElement) {
        break;
      }
      await user.keyboard("{ArrowDown}");
    }
    expect(item).toHaveFocus();
    await user.keyboard(key);
    const dialog = await screen.findByRole("dialog");
    await screen.findByText("Use more models");
    expect(new URLSearchParams(window.location.search).get("settings")).toBe(
      "model",
    );
    await waitFor(() => {
      return expect(dialog).toContainElement(
        document.activeElement as HTMLElement,
      );
    });
  },
);
