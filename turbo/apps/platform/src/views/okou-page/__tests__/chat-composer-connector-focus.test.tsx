import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  builtinConnector,
  SCOUT_AGENT_ID,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

async function openLoadingConnectors() {
  const user = userEvent.setup({ delay: null });
  const authorization = context.mocks.deferred<void>();
  const catalog = Array.from({ length: 21 }, (_, index) => {
    return builtinConnector({
      slug: `focus-app-${index}` as ConnectorSlug,
      label: `Focus app ${index}`,
    });
  });
  installComposerConnectorFixture({
    catalog,
    builtinAuthorizations: {
      [SCOUT_AGENT_ID]: catalog.map((connector) => {
        return connector.slug;
      }),
    },
    authorizationGates: { [SCOUT_AGENT_ID]: authorization.promise },
  });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Connectors" });
  const add = await findFastControl("button", "Add connectors", dialog);
  expect(
    within(dialog).queryByPlaceholderText("Find connectors..."),
  ).toBeNull();
  return { user, authorization, trigger, dialog, add };
}

async function prepareLoadedConnectorSearch() {
  const { user, authorization, trigger, dialog } =
    await openLoadingConnectors();
  await waitFor(() => {
    expect(dialog.contains(document.activeElement)).toBeTruthy();
  });
  authorization.resolve(undefined);
  const search =
    await within(dialog).findByPlaceholderText("Find connectors...");
  await waitFor(() => {
    expect(search).toHaveFocus();
  });
  await fill(search, "Focus app 20");
  expect(search).toHaveValue("Focus app 20");
  expect(within(dialog).getByText("Focus app 20")).toBeInTheDocument();
  expect(within(dialog).queryByText("Focus app 0")).toBeNull();
  return { user, trigger };
}

test("Focus the loaded connector search during filter", async () => {
  await prepareLoadedConnectorSearch();
  expect(screen.getByPlaceholderText("Find connectors...")).toHaveFocus();
});

test("Focus the loaded connector search during reopen", async () => {
  const { user, trigger } = await prepareLoadedConnectorSearch();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  click(trigger);
  const reopenedSearch =
    await screen.findByPlaceholderText("Find connectors...");
  await waitFor(() => {
    expect(reopenedSearch).toHaveFocus();
  });
  expect(reopenedSearch).toHaveValue("");
});

test("A delayed connector search does not take focus after keyboard navigation", async () => {
  const { user, authorization, dialog, add } = await openLoadingConnectors();
  await waitFor(() => {
    expect(dialog.contains(document.activeElement)).toBeTruthy();
  });
  expect(add).not.toHaveFocus();
  await user.keyboard("{Tab}");
  expect(add).toHaveFocus();

  authorization.resolve(undefined);
  await within(dialog).findByPlaceholderText("Find connectors...");
  expect(add).toHaveFocus();
});

test("Closing the connector panel before loading preserves the trigger focus", async () => {
  const { user, authorization, trigger } = await openLoadingConnectors();
  await user.keyboard("{Escape}");
  authorization.resolve(undefined);

  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

test("A mobile connector search stays unfocused after loading", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)";
  });
  const { authorization, dialog } = await openLoadingConnectors();
  authorization.resolve(undefined);

  const search =
    await within(dialog).findByPlaceholderText("Find connectors...");
  expect(search).not.toHaveFocus();
});
