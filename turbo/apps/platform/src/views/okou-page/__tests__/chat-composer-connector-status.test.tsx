import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ACME_CONNECTOR_ID,
  FEISHU_CONNECTOR_ID,
  SCOUT_THREAD_ID,
  builtinConnector,
  connectorAccount,
  httpConnector,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";
import { openChatMenu } from "./composer-menu-page-fixture.ts";
const context = testContext();
function directoryData(saved: boolean, reconnect = false) {
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    threadId: SCOUT_THREAD_ID,
    ...(reconnect
      ? {
          accounts: [
            { kind: "builtin", connectorSlug: "github" } as const,
            { kind: "custom", customConnectorId: ACME_CONNECTOR_ID } as const,
          ].map((target) => {
            return {
              ...connectorAccount({
                id: crypto.randomUUID(),
                target,
                displayName: "Needs reconnection",
                isDefault: true,
              }),
              connectionStatus: "reconnect-required" as const,
              reconnectReason: "credential_expired",
            };
          }),
        }
      : {}),
    catalog: [
      builtinConnector({ slug: "github", label: "GitHub" }),
      builtinConnector({ slug: "notion", label: "Notion", hasAccount: false }),
    ],
    customConnectors: [
      httpConnector({
        id: FEISHU_CONNECTOR_ID,
        slug: "feishu",
        displayName: "Feishu",
        authMode: "oauth",
        providerAdapter: "feishu",
        hasAccount: true,
      }),
      httpConnector({
        id: ACME_CONNECTOR_ID,
        slug: "acme-search",
        displayName: "Acme Search",
        hasAccount: saved,
      }),
    ],
  });
}
async function directory() {
  await openChatMenu(context);
  click(await findFastControl("button", "Add connectors"));
  return await screen.findByRole("dialog", { name: "Connectors" });
}
async function customTab() {
  click(await screen.findByRole("radio", { name: "Custom" }));
}
function acme() {
  return findFastControl("button", "Connect Acme Search");
}
test("chat-composer-connector-status-002 The directory distinguishes saved accounts from an available Notion connection", async () => {
  directoryData(true);
  const catalog = await directory();
  await expect(
    findFastControl("button", "Connect Notion", catalog),
  ).resolves.toBeVisible();
  await fill(within(catalog).getByRole("textbox"), "GitHub");
  const github = await findFastControl(
    "button",
    "Open GitHub details",
    catalog,
  );
  expect(github).toHaveTextContent("Connected");
  await fill(within(catalog).getByRole("textbox"), "");
  await customTab();
  await expect(acme()).resolves.toHaveTextContent("Connected");
});
test("chat-composer-connector-status-003 The saved custom search account remains actionable in Custom", async () => {
  directoryData(true);
  await directory();
  await customTab();
  const card = await acme();
  expect(card).toBeEnabled();
  expect(card).toHaveTextContent("Connected");
  click(card);
  const manager = await screen.findByRole("dialog");
  expect(manager).toHaveTextContent("Acme Search");
  expect(within(manager).getByLabelText("Secret")).toBeVisible();
});
test("chat-composer-connector-status-004 Saving a credential changes the status on a fresh directory visit", async () => {
  directoryData(false);
  await directory();
  await customTab();
  const card = await acme();
  expect(card).toHaveTextContent("No accounts");
  click(card);
  await fill(await screen.findByLabelText("Secret"), "local-search-token");
  click(await findFastControl("button", "Save"));
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  click(await findFastControl("button", "Add connectors"));
  await customTab();
  const refreshed = await acme();
  expect(refreshed).toHaveTextContent("Connected");
  expect(refreshed).not.toHaveTextContent("No accounts");
});
test("chat-composer-connector-status-005 Waiting for account inventory withholds the ordinary custom card", async () => {
  directoryData(false);
  const inventory = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  context.mocks.api(connectedConnectorsContract.list, async ({ respond }) => {
    if (!requested.settled()) {
      requested.resolve();
    }
    await inventory.promise;
    return respond(200, { builtinConnectors: [], customConnectors: [] });
  });
  await directory();
  await customTab();
  await requested.promise;
  // The integration-managed card uses the same directory response as Acme.
  await expect(
    findFastControl("button", "Connect Feishu"),
  ).resolves.toBeVisible();
  expect(
    screen.getByRole("radio", { name: "Custom", checked: true }),
  ).toBeVisible();
  expect(queryFastControl("button", "Connect Acme Search")).toBeNull();
  expect(screen.queryByText("No accounts")).toBeNull();
  inventory.resolve();
  await expect(acme()).resolves.toHaveTextContent("No accounts");
});

test("Accounts requiring reconnection remain discoverable in both directory tabs", async () => {
  directoryData(true, true);
  const catalog = await directory();
  const search = within(catalog).getByRole("textbox");
  await fill(search, "GitHub");
  await expect(
    findFastControl("button", "Open GitHub details", catalog),
  ).resolves.toBeEnabled();
  await fill(search, "");
  await customTab();
  await expect(acme()).resolves.toBeEnabled();
  expect(screen.queryByLabelText("Secret")).toBeNull();
});

test("Feishu still opens its managed connection flow when account inventory fails", async () => {
  directoryData(true);
  context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
    return respond(503, {
      error: { code: "UNAVAILABLE", message: "Saved account service offline" },
    });
  });
  const catalog = await directory();
  await customTab();
  await within(catalog).findByText(
    "Accounts are unavailable for this connector.",
  );
  expect(queryFastControl("button", "Connect Acme Search", catalog)).toBeNull();
  expect(within(catalog).queryByText("No accounts")).toBeNull();
  const managed = await findFastControl("button", "Connect Feishu", catalog);
  click(managed);
  await screen.findByRole("dialog", { name: /Feishu/i });
});
