import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import {
  isInaccessible,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  builtinConnector,
  chatConnectorOverviewFixture,
  connectorAccount,
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
    featureSwitches: {},
  });
  click(await findFastControl("button", "Connectors"));
  const popup = await screen.findByRole("dialog", { name: "Connectors" });
  await within(popup).findByText("Scroll 1", { exact: true });
  return { popup, catalog, accounts };
}

async function connectorButton(popup: HTMLElement, label: string) {
  const text = await within(popup).findByText(label, { exact: true });
  const button = text.closest("button");
  if (!button) {
    throw new Error(`Connector button not found: ${label}`);
  }
  return button;
}

async function openAccountPanel(popup: HTMLElement, label: string) {
  click(await connectorButton(popup, label));
  const submenu = await screen.findByRole("dialog", { name: label });
  const panel = within(submenu).getByRole("group", { name: label });
  await waitFor(() => {
    const account = within(panel).getByLabelText("Account 1 access", {
      selector: '[role="switch"]',
    });
    expect(isInaccessible(account)).toBeFalsy();
  });
  return panel;
}

test("Preserve the 12-connector overview position while accounts open alongside it", async () => {
  const user = userEvent.setup();
  const { popup } = await setup(12);
  const overview = () => {
    return within(popup).getByRole("list", { name: "Connectors" });
  };
  overview().scrollTop = 180;
  const panel = await openAccountPanel(popup, "Scroll 7");
  expect(panel.scrollTop).toBe(0);
  expect(overview().scrollTop).toBe(180);
  panel.scrollTop = 140;

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Scroll 7" })).toBeNull();
  });
  await expect(connectorButton(popup, "Scroll 7")).resolves.toHaveFocus();
  expect(overview().scrollTop).toBe(180);

  const reopened = await openAccountPanel(popup, "Scroll 7");
  expect(reopened.scrollTop).toBe(0);
  expect(overview().scrollTop).toBe(180);
  await user.keyboard("{Escape}");
  overview().scrollTop = 220;
  const other = await openAccountPanel(popup, "Scroll 8");
  expect(other.scrollTop).toBe(0);
  expect(overview().scrollTop).toBe(220);
});

test("Keep connector search focus and reset its scroll position on a new query", async () => {
  const { popup } = await setup(30);
  const search = within(popup).getByPlaceholderText("Find connectors...");
  within(popup).getByRole("list", { name: "Connectors" }).scrollTop = 180;
  await openAccountPanel(popup, "Scroll 7");

  await fill(search, "Scroll 2");

  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Scroll 7" })).toBeNull();
  });
  expect(search).toHaveFocus();
  const results = within(popup).getByRole("list", { name: "Connectors" });
  expect(results.scrollTop).toBe(0);
  await expect(
    within(results).findByText("Scroll 2", { exact: true }),
  ).resolves.toBeInTheDocument();
});

test("Keep focus after removing an open connector from a 1-connector overview", async () => {
  const { popup, catalog, accounts } = await setup(1);
  const connector = catalog[0]!;
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
    expect(screen.queryByRole("dialog", { name: connector.label })).toBeNull();
    expect(popup.contains(document.activeElement)).toBeTruthy();
  });
  await expect(
    findFastControl("button", "Add connectors", popup),
  ).resolves.toBeInTheDocument();

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

  await expect(
    within(popup).findByText(connector.label, { exact: true }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: connector.label })).toBeNull();
});
