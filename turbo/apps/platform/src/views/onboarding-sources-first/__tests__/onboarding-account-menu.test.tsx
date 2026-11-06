import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import {
  connectedPersonalClaudeCodeProvider,
  connectedPersonalCodexProvider,
  createSidebarAccountHelpers,
} from "../../okou-page/__tests__/sidebar-account-test-helpers.ts";
import { mockOnboardingConnectorCatalog } from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const { mockAdminAccountSidebar } = createSidebarAccountHelpers(context);

test.each([
  { provider: "ChatGPT", activation: "pointer" },
  { provider: "Claude", activation: "Enter" },
  { provider: "ChatGPT", activation: "Space" },
])(
  "Open Model settings from $provider usage in the onboarding account menu using $activation",
  async ({ provider, activation }) => {
    const user = userEvent.setup();
    mockAdminAccountSidebar();
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
      connectedPersonalClaudeCodeProvider(),
    ]);
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    mockOnboardingConnectorCatalog(context, []);

    await setupPage({
      context,
      locale: "en-US",
      path: ROUTES.onboarding,
      auth: {
        user: {
          id: "test-user-123",
          fullName: "Alex Rivera",
          email: "alex.rivera@example.test",
        },
      },
    });

    await screen.findByRole("heading", {
      name: "What kind of work do you do?",
    });
    click(await screen.findByLabelText("Alex Rivera"));
    const menu = await screen.findByRole("menu");
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
      expect(settings).toContainElement(document.activeElement as HTMLElement);
    });
  },
);
