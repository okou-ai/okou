import {
  isInaccessible,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";

import {
  click,
  fill,
  holdElementAnimations,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  builtinConnector,
  connectorAccount,
  chatConnectorOverviewFixture,
  createComposerConnectorHelpers,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

async function setup(count: number) {
  const catalog = Array.from({ length: count }, (_, index) => {
    return builtinConnector({
      slug: connectorSlugSchema.parse(`scroll-${index + 1}`),
      label: `Scroll ${index + 1}`,
    });
  });
  const accounts = catalog.flatMap((connector, index) => {
    const accountCount = index === 6 || index === 7 ? 15 : 1;
    return Array.from({ length: accountCount }, (_, account) => {
      return connectorAccount({
        id: crypto.randomUUID(),
        target: { kind: "builtin", connectorSlug: connector.slug },
        displayName: `Account ${account + 1}`,
        isDefault: account === (accountCount > 1 ? 10 : 0),
      });
    });
  });
  installComposerConnectorFixture({ catalog, accounts });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    locale: "en-US",
    featureSwitches: { [FeatureSwitchKey.ConnectorChatAccountAccess]: true },
  });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  const popup = await screen.findByRole("dialog", { name: "Connectors" });
  await within(popup).findByText("Scroll 1", { exact: true });
  return { popup, trigger, catalog, accounts };
}

async function connectorButton(popup: HTMLElement, label: string) {
  const text = await within(popup).findByText(label, { exact: true });
  const button = text.closest("button");
  if (!button) {
    throw new Error(`Connector button not found: ${label}`);
  }
  return button;
}

async function openAccountPanel(popup: HTMLElement, label = "Scroll 7") {
  click(await connectorButton(popup, label));
  const submenu = await screen.findByRole("dialog", { name: label });
  const panel = within(submenu).getByRole("group", { name: label });
  await waitFor(() => {
    const account = within(panel).getByLabelText("Account 1 access", {
      selector: '[role="switch"]',
    });
    expect(isInaccessible(account)).toBeFalsy();
  });
  return { submenu, panel };
}

test.each([12, 30])(
  "Preserve the %i-connector overview position while accounts open alongside it",
  async (count) => {
    const user = userEvent.setup();
    const { popup } = await setup(count);
    const overview = () => {
      return within(popup).getByRole("list", { name: "Connectors" });
    };
    overview().scrollTop = 180;
    const { panel } = await openAccountPanel(popup);
    expect(overview().scrollTop).toBe(180);
    expect(panel.scrollTop).toBe(0);
    panel.scrollTop = 140;
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Scroll 7" })).toBeNull();
    });
    const row = await connectorButton(popup, "Scroll 7");
    expect(row).toHaveFocus();
    expect(overview().scrollTop).toBe(180);
    const reopened = await openAccountPanel(popup);
    expect(reopened.panel.scrollTop).toBe(0);
    await user.keyboard("{Escape}");
    overview().scrollTop = 220;
    const other = await openAccountPanel(popup, "Scroll 8");
    expect(other.panel.scrollTop).toBe(0);
    expect(overview().scrollTop).toBe(220);
  },
);

test("Keep connector search focus and reset its scroll position on a new query", async () => {
  const { popup } = await setup(30);
  const search = within(popup).getByPlaceholderText("Find connectors...");
  const overview = within(popup).getByRole("list", { name: "Connectors" });
  overview.scrollTop = 180;
  await openAccountPanel(popup);
  await fill(search, "Scroll 2");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Scroll 7" })).toBeNull();
  });
  expect(search).toHaveFocus();
  const results = within(popup).getByRole("list", { name: "Connectors" });
  expect(results.scrollTop).toBe(0);
  await within(results).findByText("Scroll 2", { exact: true });
});

test("Start a fresh overview when reopening before the previous popup finishes closing", async () => {
  const { popup, trigger } = await setup(30);
  within(popup).getByRole("list", { name: "Connectors" }).scrollTop = 180;
  const finish = holdElementAnimations(popup);
  try {
    click(trigger);
    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });
    expect(popup).toBeVisible();
    click(trigger);
    const reopened = await screen.findByRole("dialog", { name: "Connectors" });
    expect(
      within(reopened).getByRole("list", { name: "Connectors" }).scrollTop,
    ).toBe(0);
    await waitFor(() => {
      expect(
        within(reopened).getByPlaceholderText("Find connectors..."),
      ).toHaveFocus();
    });
  } finally {
    finish();
  }
});

test.each([1, 30])(
  "Keep focus after removing an open connector from a %i-connector overview",
  async (count) => {
    const { popup, catalog, accounts } = await setup(count);
    const index = count === 1 ? 0 : 6;
    const connector = catalog[index]!;
    await openAccountPanel(popup, connector.label);
    context.mocks.api(
      chatConnectorAccessContract.overviewTarget,
      ({ respond }) => {
        return respond(200, { connector: null });
      },
    );
    context.mocks.ably.trigger("connector:changed", {
      connectorSlug: connector.slug,
    });
    await waitFor(() => {
      expect(
        within(popup).queryByText(connector.label, { exact: true }),
      ).toBeNull();
      expect(
        screen.queryByRole("dialog", { name: connector.label }),
      ).toBeNull();
      expect(popup.contains(document.activeElement)).toBeTruthy();
    });
    await findFastControl("button", "Add connectors", popup);
    context.mocks.api(
      chatConnectorAccessContract.overviewTarget,
      ({ respond }) => {
        return respond(200, {
          connector: chatConnectorOverviewFixture({
            target: { kind: "builtin", connectorSlug: connector.slug },
            label: connector.label,
            accounts,
          }),
        });
      },
    );
    context.mocks.ably.trigger("connector:changed", {
      connectorSlug: connector.slug,
    });
    await within(popup).findByText(connector.label, { exact: true });
    expect(screen.queryByRole("dialog", { name: connector.label })).toBeNull();
  },
);
