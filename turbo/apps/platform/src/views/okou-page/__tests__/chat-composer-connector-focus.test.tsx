import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  namedMenuAccounts,
  openChatMenu,
} from "./composer-menu-page-fixture.ts";
const context = testContext();
test("chat-composer-connector-focus-011 Filtering after inspecting an account closes its panel and restores the launcher on Escape", async () => {
  namedMenuAccounts(context, "Focus app", 21);
  const trigger = await openChatMenu(context);
  const filter = await screen.findByRole("textbox", {
    name: "Find connectors...",
  });
  await fill(filter, "Focus app 20");
  click(await findFastControl("button", /Focus app 20\b/));
  await expect(
    screen.findByRole("switch", { name: "Focus app 20 account access" }),
  ).resolves.toBeVisible();
  await fill(filter, "Focus app 1");
  const results = screen.getByRole("list", { name: "Connectors" });
  await expect(
    findFastControl("button", /Focus app 1\b/, results),
  ).resolves.toBeVisible();
  expect(queryFastControl("button", /Focus app 20\b/, results)).toBeNull();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
});
test("chat-composer-connector-focus-009 A closed menu keeps the launcher focused after the pending overview is consumed", async () => {
  const overview = namedMenuAccounts(context, "Focus app", 21);
  const loading = context.mocks.deferred<void>();
  const began = context.mocks.deferred<void>();
  const consumed = context.mocks.deferred<void>();
  context.mocks.api(
    chatConnectorAccessContract.overview,
    async ({ respond }) => {
      began.resolve();
      await loading.promise;
      return respond(200, overview);
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ query, respond }) => {
      if (query.kind === "builtin" && query.connectorSlug === "github") {
        consumed.resolve();
      }
      return respond(200, { connector: null });
    },
  );
  const trigger = await openChatMenu(context);
  await began.promise;
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  // The target refresh waits for this page's baseline before issuing its GET.
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  loading.resolve();
  await consumed.promise;
  expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
  expect(trigger).toHaveFocus();
  click(trigger);
  await expect(
    findFastControl("button", /Focus app 20\b/),
  ).resolves.toBeVisible();
});

test("Opening the connector directory keeps Add connectors focused as accounts arrive and resets the search on reentry", async () => {
  const rows = namedMenuAccounts(context, "Archive", 21);
  const inventory = context.mocks.deferred<void>();
  context.mocks.api(
    chatConnectorAccessContract.overview,
    async ({ respond }) => {
      await inventory.promise;
      return respond(200, rows);
    },
  );
  const trigger = await openChatMenu(context);
  const add = await findFastControl("button", "Add connectors");
  await waitFor(() => {
    return expect(add).toHaveFocus();
  });
  inventory.resolve();
  const filter = await screen.findByRole("textbox", {
    name: "Find connectors...",
  });
  expect(add).toHaveFocus();
  await fill(filter, "Archive 20");
  await expect(findFastControl("button", /Archive 20/)).resolves.toBeVisible();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  click(trigger);
  const menu = await screen.findByRole("dialog", { name: "Connectors" });
  const freshFilter = await within(menu).findByRole("textbox", {
    name: "Find connectors...",
  });
  expect(freshFilter).toHaveValue("");
  await waitFor(() => {
    return expect(menu).toContainElement(document.activeElement as HTMLElement);
  });
});
