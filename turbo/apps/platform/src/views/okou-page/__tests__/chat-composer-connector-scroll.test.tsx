import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  builtinConnector,
  SCOUT_THREAD_ID,
  createComposerConnectorHelpers,
  chatConnectorOverviewFixture,
  connectorAccount,
} from "./chat-composer-connectors-test-helpers.ts";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  namedMenuAccounts,
  openChatMenu,
} from "./composer-menu-page-fixture.ts";
const context = testContext();
function scrollTo(view: HTMLElement, position: number) {
  view.scrollTop = position;
  fireEvent.scroll(view);
}
async function accounts(n: number) {
  const label = `Scroll ${n}`;
  const overview = screen.getByRole("list", { name: "Connectors" });
  const text = await within(overview).findByText(label, { exact: true });
  const target = text.closest("button");
  if (!target) {
    throw new Error(`No account button contains ${label}`);
  }
  click(target);
  const panel = await screen.findByRole("group", { name: label });
  return { target, panel };
}
test("chat-composer-connector-scroll-001 Returning to either account panel starts at the top and preserves the overview position", async () => {
  namedMenuAccounts(context, "Scroll", 12);
  await openChatMenu(context);
  const overview = await screen.findByRole("list", { name: "Connectors" });
  scrollTo(overview, 180);
  const first = await accounts(7);
  expect(first.panel.scrollTop).toBe(0);
  scrollTo(first.panel, 140);
  expect(first.panel.scrollTop).toBe(140);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(first.target).toHaveFocus();
  });
  expect(overview.scrollTop).toBe(180);
  expect((await accounts(7)).panel.scrollTop).toBe(0);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(first.target).toHaveFocus();
  });
  expect(overview.scrollTop).toBe(180);
  scrollTo(overview, 220);
  expect((await accounts(8)).panel.scrollTop).toBe(0);
  expect(overview.scrollTop).toBe(220);
});
test("chat-composer-connector-scroll-003 A filtered result list starts at the top with focus in search", async () => {
  namedMenuAccounts(context, "Scroll", 30);
  await openChatMenu(context);
  const list = await screen.findByRole("list", { name: "Connectors" });
  scrollTo(list, 180);
  const { panel } = await accounts(7);
  expect(panel).toBeVisible();
  const search = screen.getByRole("textbox", { name: "Find connectors..." });
  await fill(search, "Scroll 2");
  await expect(findFastControl("button", /Scroll 2\b/)).resolves.toBeVisible();
  expect(screen.queryByRole("group", { name: "Scroll 7" })).toBeNull();
  expect(search).toHaveFocus();
  expect(screen.getByRole("list", { name: "Connectors" }).scrollTop).toBe(0);
});
async function reopenRestoredAccount(companions: number) {
  const connector = builtinConnector({
    slug: "github",
    label: "Review archive",
  });
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    threadId: SCOUT_THREAD_ID,
    catalog: [connector],
  });
  const target = { kind: "builtin", connectorSlug: "github" } as const;
  const restored = chatConnectorOverviewFixture({
    target,
    label: "Review archive",
    accounts: [
      connectorAccount({
        target,
        id: crypto.randomUUID(),
        displayName: "Review team",
        isDefault: true,
      }),
    ],
  });
  const neighbors = Array.from({ length: companions }, (_, index) => {
    const neighbor = {
      kind: "custom",
      customConnectorId: crypto.randomUUID(),
    } as const;
    const label = `Archive companion ${index}`;
    return chatConnectorOverviewFixture({
      target: neighbor,
      label,
      accounts: [
        connectorAccount({
          target: neighbor,
          id: crypto.randomUUID(),
          displayName: label,
          isDefault: true,
        }),
      ],
    });
  });
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [...neighbors, restored]);
  });
  let available = false;
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ respond }) => {
      return respond(200, { connector: available ? restored : null });
    },
  );
  await openChatMenu(context);
  const row = await findFastControl("button", "Review archive");
  const directory = await screen.findByRole("list", { name: "Connectors" });
  expect(within(directory).queryAllByText(/^Archive companion /u)).toHaveLength(
    companions,
  );
  click(row);
  await expect(
    screen.findByRole("group", { name: "Review archive" }),
  ).resolves.toBeVisible();
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  await waitFor(() => {
    return expect(queryFastControl("button", "Review archive")).toBeNull();
  });
  expect(screen.queryByRole("group", { name: "Review archive" })).toBeNull();
  await expect(
    findFastControl("button", "Add connectors"),
  ).resolves.toBeVisible();
  available = true;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  const returned = await findFastControl("button", "Review archive");
  expect(returned).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("group", { name: "Review archive" })).toBeNull();
  click(returned);
  return screen.findByRole("dialog", { name: "Review archive" });
}

test("chat-composer-connector-scroll-005 A removed account panel stays closed when its connector returns", async () => {
  await expect(reopenRestoredAccount(0)).resolves.toBeVisible();
});

test("Restoring an account among 29 neighbors leaves its panel closed until selected", async () => {
  await expect(reopenRestoredAccount(29)).resolves.toBeVisible();
});
