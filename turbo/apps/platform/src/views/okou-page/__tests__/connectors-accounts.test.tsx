import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  getConnectorCard,
  mockSavedConnectorAccounts,
  mockConnectors,
} from "./connector-page-test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";

const context = testContext();
const target = { kind: "builtin", connectorSlug: "github" } as const;
const manage = "Manage GitHub accounts";
test("connectors-accounts-004 GitHub membership precedes the individual reconnect action", async () => {
  const saved = connectorAccountFixture(target, {
    displayName: "Prepared work account",
    configuredFieldKeys: ["access-token"],
    connectionStatus: "reconnect-required",
    reconnectReason: "authorization_expired_or_revoked",
  });
  mockSavedConnectorAccounts(context, () => {
    return [saved];
  });
  const list = context.mocks.deferred<void>();
  context.mocks.api(
    connectorAccountsContract.connections,
    async ({ respond }) => {
      await list.promise;
      return respond(200, {
        connections: [saved],
        defaultConnection: saved,
        nextCursor: null,
      });
    },
  );
  await setupPage({ context, path: "/connectors" });
  const card = await findButton(manage);
  expect(getConnectorCard("GitHub")).toHaveTextContent("Connected");
  click(card);
  const dialog = await screen.findByRole("dialog", { name: manage });
  await within(dialog).findByRole("status", { name: "Loading accounts…" });
  list.resolve();
  const row = await within(dialog).findByRole("group", {
    name: "Prepared work account",
  });
  expect(queryButton("Reconnect", row)).toBeEnabled();
});

test("connectors-accounts-021 a new account query replaces the empty result with Primary", async () => {
  mockConnectors(
    context,
    ["Primary", "Archive", "Staging", "CI", "One", "Two", "Three"].map(
      (externalUsername) => {
        return { connectorSlug: "github", externalUsername };
      },
    ),
  );
  await setupPage({ context, path: "/connectors" });
  click(await findButton(manage));
  const dialog = await screen.findByRole("dialog", { name: manage });
  const search = await within(dialog).findByLabelText("Find accounts");
  await fill(search, "no-such-account");
  await within(dialog).findByText("No accounts found");
  expect(
    within(dialog).queryByRole("group", { name: "Primary" }),
  ).not.toBeInTheDocument();
  await fill(search, "Primary");
  await within(dialog).findByRole("group", { name: "Primary" });
  expect(
    within(dialog).queryByText("No accounts found"),
  ).not.toBeInTheDocument();
});

test("connectors-accounts-026 reopening GitHub account management reflects an external rename", async () => {
  const saved = connectorAccountFixture(target, { displayName: "Work" });
  mockSavedConnectorAccounts(context, () => {
    return [saved];
  });
  await setupPage({ context, path: "/connectors" });
  const open = await findButton(manage);
  expect(screen.queryByText("Work")).not.toBeInTheDocument();
  click(open);
  await screen.findByRole("group", { name: "Work" });
  click(await findButton("Close"));
  await screen.findByPlaceholderText("Find connectors");
  saved.displayName = "Updated elsewhere";
  click(await findButton(manage));
  const refreshed = await screen.findByRole("dialog", { name: manage });
  await within(refreshed).findByRole("group", { name: "Updated elsewhere" });
  expect(within(refreshed).queryByText("Work")).not.toBeInTheDocument();
});
