import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  connectedPersonalClaudeCodeProvider,
  connectedPersonalCodexProvider,
  createSidebarAccountHelpers,
  openAccountMenu,
} from "./sidebar-account-test-helpers.ts";

const context = testContext();
const { mockAdminAccountSidebar } = createSidebarAccountHelpers(context);

test.each([
  { provider: "ChatGPT", activation: "pointer" },
  { provider: "Claude", activation: "Enter" },
  { provider: "ChatGPT", activation: "Space" },
])(
  "Open Model settings from $provider in the account menu using $activation",
  async ({ provider, activation }) => {
    const user = userEvent.setup();
    context.mocks.browser.matchMedia(false);
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
      connectedPersonalClaudeCodeProvider(),
    ]);

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      auth: {
        user: {
          id: "test-user-123",
          fullName: "Alex Rivera",
          email: "alex.rivera@example.test",
        },
      },
      featureSwitches: { [FeatureSwitchKey.SidebarSubscriptionUsage]: true },
    });

    click(screen.getByLabelText("Open menu"));
    await screen.findByRole("dialog", { name: "Sidebar" });
    const menu = await openAccountMenu();
    const section = await within(menu).findByRole("region", {
      name: `${provider} usage`,
    });
    const information = within(section).getByLabelText(`${provider} usage`);

    if (activation === "pointer") {
      click(information);
    } else {
      within(menu).getByTestId("account-menu-credit-balance").focus();
      await user.keyboard(
        provider === "Claude" ? "{ArrowDown}{ArrowDown}" : "{ArrowDown}",
      );
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }

    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await expect(
      within(settings).findByRole("heading", { name: "Use more models" }),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("settings")).toBe(
        "model",
      );
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
      expect(settings).toContainElement(document.activeElement as HTMLElement);
    });
  },
);
