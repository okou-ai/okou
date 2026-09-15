import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  ACME_CONNECTOR_ID,
  builtinConnector,
  connectorAccount,
  httpConnector,
  installComposerConnectorFixture,
  manualAuthMethod,
  oauthAuthMethod,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  context,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const GMAIL_SLUG = "gmail" as ConnectorSlug;
const NOTION_SLUG = "notion" as ConnectorSlug;
const SLACK_SLUG = "slack" as ConnectorSlug;

function catalog() {
  return [
    builtinConnector({
      slug: GMAIL_SLUG,
      label: "Gmail",
      connected: false,
      category: "mail",
      popularityRank: 0,
      authMethods: [manualAuthMethod()],
    }),
    builtinConnector({
      slug: NOTION_SLUG,
      label: "Notion",
      connected: false,
      category: "productivity",
      popularityRank: 1,
      authMethods: [manualAuthMethod()],
    }),
    builtinConnector({ slug: SLACK_SLUG, label: "Slack" }),
  ];
}

async function loadPage(directoryEnabled: boolean) {
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ConnectorDirectory]: directoryEnabled,
    },
  });
  await expect(screen.findByTestId("start-cards")).resolves.toBeVisible();
}

async function openAddConnectors(directoryEnabled: boolean) {
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", "Add connectors"));
  return await screen.findByRole("dialog", {
    name: directoryEnabled ? "Connectors" : /Available connectors/u,
  });
}

async function dismiss(
  dialog: HTMLElement,
  dismissal: "Close" | "Escape" | "backdrop",
) {
  if (dismissal === "Close") {
    click(within(dialog).getByLabelText("Close"));
  } else if (dismissal === "Escape") {
    await userEvent.setup({ delay: null }).keyboard("{Escape}");
  } else {
    const viewport = dialog.closest('[data-slot="dialog-viewport"]');
    if (!(viewport instanceof HTMLElement)) {
      throw new Error("Expected the connector dialog viewport");
    }
    await userEvent.setup({ delay: null }).click(viewport);
  }
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
}

function expectFreshList(dialog: HTMLElement) {
  expect(within(dialog).getByPlaceholderText("Find connectors...")).toHaveValue(
    "",
  );
  expect(within(dialog).getByText("Gmail")).toBeVisible();
  expect(within(dialog).getByText("Notion")).toBeVisible();
  expect(within(dialog).queryByRole("heading", { name: "Slack" })).toBeNull();
}

function directoryTab(dialog: HTMLElement, name: "Custom" | "Discover") {
  const tab = queryAllByRoleFast("radio", dialog).find((radio) => {
    return radio.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`Expected directory tab ${name}`);
  }
  return tab;
}

describe.each([true, false])(
  "reopen Add connectors (directory: %s)",
  (directoryEnabled) => {
    it.each(["Close", "Escape", "backdrop"] as const)(
      "reset a dismissed list's search after %s",
      async (dismissal) => {
        installComposerConnectorFixture({ catalog: catalog() });
        context.mocks.data.userPreferences({ locale: "en-US" });
        await loadPage(directoryEnabled);
        const dialog = await openAddConnectors(directoryEnabled);
        await fill(
          within(dialog).getByPlaceholderText("Find connectors..."),
          "Notion",
        );
        await expect(
          within(dialog).findByText("Notion"),
        ).resolves.toBeVisible();
        expect(within(dialog).queryByText("Gmail")).toBeNull();

        await dismiss(dialog, dismissal);
        const reopened = await openAddConnectors(directoryEnabled);
        expectFreshList(reopened);
      },
    );

    it("return to the list after cancelling a custom connector's setup", async () => {
      installComposerConnectorFixture({
        catalog: catalog(),
        customConnectors: [
          httpConnector({
            id: ACME_CONNECTOR_ID,
            slug: "acme-search",
            displayName: "Acme Search",
            connected: false,
          }),
        ],
      });
      await loadPage(directoryEnabled);
      const dialog = await openAddConnectors(directoryEnabled);
      if (directoryEnabled) {
        click(directoryTab(dialog, "Custom"));
      }
      await fill(
        within(dialog).getByPlaceholderText("Find connectors..."),
        "Acme",
      );
      click(await findFastControl("button", "Connect Acme Search", dialog));
      const secret = await screen.findByLabelText("Secret");
      await fill(secret, "discarded-secret");
      const setup = screen.getByRole("dialog");
      click(await findFastControl("button", "Cancel", setup));
      await waitFor(() => {
        expect(setup).not.toBeInTheDocument();
      });

      const reopened = await openAddConnectors(directoryEnabled);
      expectFreshList(reopened);
    });

    it("complete an OAuth connection after closing and reopening the list", async () => {
      const fixture = installComposerConnectorFixture({
        catalog: [
          builtinConnector({
            slug: GMAIL_SLUG,
            label: "Gmail",
            connected: false,
            authMethods: [oauthAuthMethod()],
          }),
          catalog()[1]!,
        ],
      });
      const authWindow = context.mocks.browser.authWindow();
      Object.defineProperty(authWindow, "location", {
        configurable: true,
        value: { href: "about:blank" },
      });
      context.mocks.browser.open(authWindow);
      await loadPage(directoryEnabled);
      const dialog = await openAddConnectors(directoryEnabled);
      await fill(
        within(dialog).getByPlaceholderText("Find connectors..."),
        "Gmail",
      );
      click(await findFastControl("button", "Connect Gmail", dialog));
      await waitFor(() => {
        expect(authWindow.location.href).toBe(
          "https://accounts.example.test/gmail",
        );
      });

      await dismiss(dialog, "Close");
      const reopened = await openAddConnectors(directoryEnabled);
      expectFreshList(reopened);
      expect(authWindow.closed).toBeFalsy();

      const account = connectorAccount({
        id: "f0000000-0000-4000-a000-000000000064",
        target: { kind: "builtin", connectorSlug: GMAIL_SLUG },
        displayName: "Work",
        isDefault: true,
      });
      context.mocks.data.connectors([{ ...account, slug: GMAIL_SLUG }]);
      fixture.completeOAuth(account.id);
      authWindow.close();
      await expect(
        screen.findByText("Gmail connected and authorized for Scout"),
      ).resolves.toBeVisible();
      await waitFor(() => {
        expect(reopened).not.toBeInTheDocument();
      });
    });
  },
);

test.each(["Close", "Escape", "backdrop"] as const)(
  "Reopen on the list after dismissing Slack details with %s",
  async (dismissal) => {
    const user = userEvent.setup({ delay: null });
    installComposerConnectorFixture({ catalog: catalog() });
    await loadPage(true);
    const dialog = await openAddConnectors(true);
    await fill(
      within(dialog).getByPlaceholderText("Find connectors..."),
      "Slack",
    );
    // Complete the pointer gesture before testing an outside pointer gesture.
    await user.click(
      await findFastControl("button", "Open Slack details", dialog),
    );
    await expect(
      within(dialog).findByRole("heading", { name: "Slack" }),
    ).resolves.toBeVisible();

    await dismiss(dialog, dismissal);
    const reopened = await openAddConnectors(true);
    expectFreshList(reopened);
  },
);

test.each(["category", "custom"] as const)(
  "Reset the directory's %s selection on ordinary reopening",
  async (selection) => {
    installComposerConnectorFixture({
      catalog: catalog(),
      categoryMetadata: {
        categories: [
          { id: "mail", label: "Mail", menuLabel: "Mail", groupId: null },
          {
            id: "productivity",
            label: "Productivity",
            menuLabel: "Productivity",
            groupId: null,
          },
        ],
        groups: [],
      },
    });
    await loadPage(true);
    const dialog = await openAddConnectors(true);
    click(await findFastControl("button", "Productivity", dialog));
    await expect(within(dialog).findByText("Notion")).resolves.toBeVisible();
    expect(within(dialog).queryByText("Gmail")).toBeNull();
    if (selection === "custom") {
      click(directoryTab(dialog, "Custom"));
    }
    expect(
      directoryTab(dialog, selection === "custom" ? "Custom" : "Discover"),
    ).toBeChecked();

    await dismiss(dialog, "Close");
    const reopened = await openAddConnectors(true);
    expectFreshList(reopened);
    expect(directoryTab(reopened, "Discover")).toBeChecked();
  },
);

test("Start keyboard navigation at the first connector after reopening", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({ catalog: catalog() });
  await loadPage(true);
  const dialog = await openAddConnectors(true);
  await user.click(within(dialog).getByPlaceholderText("Find connectors..."));
  await user.keyboard("{ArrowDown}{Enter}");
  const setup = await screen.findByRole("dialog", { name: "Notion" });
  await dismiss(setup, "Close");

  const reopened = await openAddConnectors(true);
  await user.click(within(reopened).getByPlaceholderText("Find connectors..."));
  await user.keyboard("{Enter}");
  await expect(
    screen.findByRole("dialog", { name: "Gmail" }),
  ).resolves.toBeVisible();
});
