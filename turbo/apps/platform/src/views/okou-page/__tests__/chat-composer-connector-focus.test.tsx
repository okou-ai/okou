import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorAccountTargetKey } from "@okouai/api-contracts/contracts/connector-accounts";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  builtinConnector,
  connectorAccount,
  SCOUT_AGENT_ID,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

async function openLoadingConnectors(chatAccounts: boolean) {
  const user = userEvent.setup({ delay: null });
  const authorization = context.mocks.deferred<void>();
  const catalog = Array.from({ length: 21 }, (_, index) => {
    return builtinConnector({
      slug: `focus-app-${index}` as ConnectorSlug,
      label: `Focus app ${index}`,
    });
  });
  const accounts = catalog.map((connector) => {
    return connectorAccount({
      id: crypto.randomUUID(),
      target: { kind: "builtin", connectorSlug: connector.slug },
      displayName: `${connector.label} account`,
      isDefault: true,
    });
  });
  installComposerConnectorFixture({
    catalog,
    accounts,
    builtinAuthorizations: {
      [SCOUT_AGENT_ID]: catalog.map((connector) => {
        return connector.slug;
      }),
    },
    authorizationGates: { [SCOUT_AGENT_ID]: authorization.promise },
  });
  if (chatAccounts) {
    context.mocks.api(
      chatConnectorAccessContract.accountDefaults,
      async ({ query, respond }) => {
        await authorization.promise;
        return respond(
          200,
          accounts
            .filter((account) => {
              return (
                connectorAccountTargetKey(account.target) ===
                connectorAccountTargetKey(query)
              );
            })
            .map((account) => {
              return {
                connectionId: account.id,
                displayName: account.displayName,
                isDefault: account.isDefault,
                defaultEnabled: true,
              };
            }),
        );
      },
    );
  }
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ConnectorChatAccountAccess]: chatAccounts,
    },
  });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Connectors" });
  const add = await findFastControl("button", "Add connectors", dialog);
  expect(
    within(dialog).queryByPlaceholderText("Find connectors..."),
  ).toBeNull();
  return { user, authorization, trigger, dialog, add };
}

async function prepareLoadedConnectorSearch(chatAccounts: boolean) {
  const { user, authorization, trigger, dialog } =
    await openLoadingConnectors(chatAccounts);
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

describe.each([false, true])(
  "connector search, Chat accounts=%s",
  (chatAccounts) => {
    it("keeps filtered connectors accessible without losing search focus", async () => {
      await prepareLoadedConnectorSearch(chatAccounts);
      expect(screen.getByPlaceholderText("Find connectors...")).toHaveFocus();
      const list = screen.getByRole("list", { name: "Connectors" });
      expect(within(list).getByRole("listitem")).toHaveTextContent(
        "Focus app 20",
      );
    });

    it("focuses the loaded connector search during reopen", async () => {
      const { user, trigger } =
        await prepareLoadedConnectorSearch(chatAccounts);
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

    it("does not take focus after keyboard navigation when search loads", async () => {
      const { user, authorization, dialog, add } =
        await openLoadingConnectors(chatAccounts);
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

    it("preserves trigger focus when closed before loading", async () => {
      const { user, authorization, trigger } =
        await openLoadingConnectors(chatAccounts);
      await user.keyboard("{Escape}");
      authorization.resolve(undefined);

      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
        expect(trigger).toHaveFocus();
      });
    });

    it("keeps mobile connector search unfocused after loading", async () => {
      context.mocks.browser.matchMedia((query) => {
        return query === "(pointer: coarse)";
      });
      const { authorization, dialog } =
        await openLoadingConnectors(chatAccounts);
      authorization.resolve(undefined);

      const search =
        await within(dialog).findByPlaceholderText("Find connectors...");
      expect(search).not.toHaveFocus();
    });
  },
);

test("Searching connector names returns from account navigation to connector results", async () => {
  const { user, authorization, trigger, dialog } =
    await openLoadingConnectors(true);
  authorization.resolve(undefined);
  const search =
    await within(dialog).findByPlaceholderText("Find connectors...");
  await fill(search, "Focus app 20");
  const label = await within(dialog).findByText("Focus app 20");
  const row = label.closest("button");
  if (!row) {
    throw new Error("Connector row was not available");
  }
  click(row);
  await within(dialog).findByRole("combobox", {
    name: "Focus app 20 account access",
  });
  await fill(search, "Focus app 1");
  await within(dialog).findByText("Focus app 1");
  expect(within(dialog).queryByText("Focus app 20")).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
});
