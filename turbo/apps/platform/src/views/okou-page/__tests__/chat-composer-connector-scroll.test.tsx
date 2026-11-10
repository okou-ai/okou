import { screen, waitFor, within } from "@testing-library/react";
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
  const panel = await within(popup).findByRole("group", { name: label });
  await within(panel).findByRole("combobox", { name: "Account 1 access" });
  return panel;
}

async function backToOverview(popup: HTMLElement, panel: HTMLElement) {
  const back = await findFastControl("button", "Back", panel);
  click(back);
  return await within(popup).findByRole("list", { name: "Connectors" });
}

test.each([12, 30])(
  "Start account views at the top and restore the %i-connector overview",
  async (count) => {
    const user = userEvent.setup();
    const { popup } = await setup(count);
    const overview = within(popup).getByRole("list", { name: "Connectors" });
    overview.scrollTop = 180;
    const panel = await openAccountPanel(popup);
    expect(panel.scrollTop).toBe(0);
    expect(panel).toHaveFocus();
    expect(
      within(popup).queryByRole("list", { name: "Connectors" }),
    ).toBeNull();
    panel.scrollTop = 140;
    await user.keyboard("{Tab}{Enter}");
    const restored = await within(popup).findByRole("list", {
      name: "Connectors",
    });
    expect(restored.scrollTop).toBe(180);
    const returnButton = await connectorButton(popup, "Scroll 7");
    expect(returnButton).toHaveFocus();
    await user.keyboard("{Enter}");
    const reopened = await within(popup).findByRole("group", {
      name: "Scroll 7",
    });
    await within(reopened).findByRole("combobox", { name: "Account 1 access" });
    expect(reopened.scrollTop).toBe(0);
    reopened.scrollTop = 120;
    const returned = await backToOverview(popup, reopened);
    expect(returned.scrollTop).toBe(180);
    returned.scrollTop = 220;
    const other = await openAccountPanel(popup, "Scroll 8");
    expect(other.scrollTop).toBe(0);
    const otherReturned = await backToOverview(popup, other);
    expect(otherReturned.scrollTop).toBe(220);
  },
);

test("Keep search focus and discard the previous result position on a new query or popup", async () => {
  const { popup, trigger } = await setup(30);
  const search = within(popup).getByPlaceholderText("Find connectors...");
  const overview = within(popup).getByRole("list", { name: "Connectors" });
  overview.scrollTop = 180;
  const panel = await openAccountPanel(popup);
  panel.scrollTop = 120;
  await fill(search, "Scroll");
  const results = await within(popup).findByRole("list", {
    name: "Connectors",
  });
  expect(results.scrollTop).toBe(0);
  expect(search).toHaveFocus();
  const reopened = await openAccountPanel(popup);
  const returned = await backToOverview(popup, reopened);
  expect(returned.scrollTop).toBe(0);
  returned.scrollTop = 180;
  click(trigger);
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
  });
  click(trigger);
  const fresh = await screen.findByRole("dialog", { name: "Connectors" });
  expect(
    within(fresh).getByRole("list", { name: "Connectors" }).scrollTop,
  ).toBe(0);
  await waitFor(() => {
    expect(
      within(fresh).getByPlaceholderText("Find connectors..."),
    ).toHaveFocus();
  });
});

test("Start a fresh overview when reopening before the previous popup finishes closing", async () => {
  const { popup, trigger } = await setup(30);
  within(popup).getByRole("list", { name: "Connectors" }).scrollTop = 180;
  const finish = holdElementAnimations(popup);
  try {
    click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
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

test("Keep a valid overview focus destination if the returning connector was removed", async () => {
  const { popup } = await setup(30);
  within(popup).getByRole("list", { name: "Connectors" }).scrollTop = 180;
  const panel = await openAccountPanel(popup);
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ respond }) => {
      return respond(200, { connector: null });
    },
  );
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "scroll-7",
  });
  await waitFor(() => {
    expect(
      within(panel).queryByRole("combobox", { name: "Account 1 access" }),
    ).toBeNull();
  });
  expect(
    within(panel).getByText("Accounts are unavailable for this connector."),
  ).toBeInTheDocument();
  const overview = await backToOverview(popup, panel);
  expect(within(overview).queryByText("Scroll 7", { exact: true })).toBeNull();
  expect(overview.scrollTop).toBe(180);
  expect(overview).toHaveFocus();
});

test("Keep popup focus as the final connector disappears and returns", async () => {
  const user = userEvent.setup();
  const { popup, catalog, accounts } = await setup(1);
  const panel = await openAccountPanel(popup, "Scroll 1");
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ respond }) => {
      return respond(200, { connector: null });
    },
  );
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "scroll-1",
  });
  await waitFor(() => {
    expect(
      within(panel).queryByRole("combobox", { name: "Account 1 access" }),
    ).toBeNull();
  });
  await user.keyboard("{Tab}");
  await expect(findFastControl("button", "Back", panel)).resolves.toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(popup.contains(document.activeElement)).toBeTruthy();
  });
  await user.keyboard("{Tab}");
  await expect(
    findFastControl("button", "Add connectors", popup),
  ).resolves.toHaveFocus();
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ respond }) => {
      return respond(200, {
        connector: chatConnectorOverviewFixture({
          target: { kind: "builtin", connectorSlug: catalog[0]!.slug },
          label: catalog[0]!.label,
          accounts,
        }),
      });
    },
  );
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "scroll-1",
  });
  await within(popup).findByText("Scroll 1", { exact: true });
  await expect(
    findFastControl("button", "Add connectors", popup),
  ).resolves.toHaveFocus();
});

test("Return focus inside the connector popup when an open account Select disappears", async () => {
  const user = userEvent.setup();
  const { popup, trigger } = await setup(12);
  const panel = await openAccountPanel(popup);
  await user.click(
    await within(panel).findByRole("combobox", { name: "Account 1 access" }),
  );
  const options = await screen.findByRole("listbox");
  await waitFor(() => {
    expect(options.contains(document.activeElement)).toBeTruthy();
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ respond }) => {
      return respond(200, { connector: null });
    },
  );
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "scroll-7",
  });
  await within(panel).findByText(
    "Accounts are unavailable for this connector.",
  );
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(panel.contains(document.activeElement)).toBeTruthy();
  });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

test("Keep normal Select dismissal and deliberate focus moves with their controls", async () => {
  const user = userEvent.setup();
  const { popup, trigger } = await setup(30);
  const panel = await openAccountPanel(popup);
  const select = await within(panel).findByRole("combobox", {
    name: "Account 1 access",
  });
  await user.click(select);
  await screen.findByRole("listbox");
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(select).toHaveFocus();
  });
  await user.click(select);
  await screen.findByRole("listbox");
  const search = within(popup).getByPlaceholderText("Find connectors...");
  await user.click(search);
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(search).toHaveFocus();
  });
  await user.click(select);
  await screen.findByRole("listbox");
  await user.click(trigger);
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
