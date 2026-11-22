import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  connectorPermissionsContract,
  type ConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createComposerConnectorHelpers,
  builtinConnector,
  connectorAccount,
  permissionDetail,
  chatConnectorOverviewFixture,
  SCOUT_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function directory(review: boolean) {
  const target = { kind: "builtin", connectorSlug: "github" } as const,
    definition = builtinConnector({
      slug: "github",
      label: "GitHub",
      hasPermissions: true,
    });
  const accounts = (
    review ? ["Pending account"] : ["Work account", "Personal account"]
  ).map((name, i) => {
    return {
      ...connectorAccount({
        target,
        id: crypto.randomUUID(),
        displayName: name,
        isDefault: i === 0,
      }),
      scopeMismatch: review,
    };
  });
  const disabled = accounts.map((a) => {
    return {
      connectionId: a.id,
      displayName: a.displayName,
      isDefault: a.isDefault,
      defaultEnabled: false,
      overrideEnabled: null,
      enabled: false,
    };
  });
  const available = {
    target,
    accounts: disabled,
    currentConnectionId: null,
    available: false,
  };
  const entry = chatConnectorOverviewFixture({
    target,
    label: "GitHub",
    hasPermissions: true,
    accounts,
    access: available,
  });
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    catalog: [definition],
    accounts,
    permissionDetails: new Map([
      ["github", permissionDetail("github", "GitHub", ["repos|write"])],
    ]),
  });
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [entry]);
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ respond }) => {
      return respond(200, { connector: entry });
    },
  );
  let rules: ConnectorPermissions["grants"] = [];
  context.mocks.api(connectorPermissionsContract.get, ({ respond }) => {
    return respond(200, { target, grants: rules });
  });
  context.mocks.api(connectorPermissionsContract.apply, ({ body, respond }) => {
    rules = body.grants.map((g) => {
      return { permission: g.permission, action: g.action, expiresAt: null };
    });
    return respond(200, { target, grants: rules });
  });
  context.mocks.api(connectorAccountsContract.scopeDiff, ({ respond }) => {
    return respond(200, {
      addedScopes: ["read:user"],
      removedScopes: [],
      currentScopes: ["read:user"],
      storedScopes: [],
    });
  });
  await setupPage({ context, path: "/chats/" + SCOUT_THREAD_ID });
  const trigger = await findFastControl("button", "Connectors");
  async function open() {
    click(trigger);
    const github = await findFastControl("button", /GitHub/);
    click(github);
  }
  return { trigger, open };
}
function button(name: RegExp) {
  return waitFor(() => {
    const choices = Array.from(
      document.querySelectorAll<HTMLElement>("button,[role=menuitem]"),
    );
    const el = choices.find((e) => {
      return name.test(
        e.getAttribute("aria-label") ?? e.textContent?.trim() ?? "",
      );
    });
    if (!el) {
      throw new Error("Missing action " + name);
    }
    return el;
  });
}
test("chat-composer-chat-connector-access-001 Shared GitHub rules retain a repository denial while both chat accounts stay off", async () => {
  const w = await directory(false);
  await w.open();
  async function checkAccounts() {
    const mine = await screen.findAllByRole("switch", {
      name: /Work account|Personal account/,
    });
    expect(mine).toHaveLength(2);
    for (const toggle of mine) {
      expect(toggle).toHaveAttribute("aria-checked", "false");
    }
  }
  await checkAccounts();
  click(await button(/^(Manage )?Permissions/i));
  const description = await screen.findByText(
    /rules apply to this connector across your chats and accounts/i,
  );
  const dialog = description.closest("[role=dialog]") as HTMLElement;
  await within(dialog).findByText("repos|write");
  click(await findFastControl("button", /^Deny$/, dialog));
  click(await findFastControl("button", "Apply", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  await w.open();
  await checkAccounts();
  click(await button(/^(Manage )?Permissions/i));
  const next = await screen.findByText(
    /rules apply to this connector across your chats and accounts/i,
  );
  const reopened = next.closest("[role=dialog]") as HTMLElement;
  await expect(
    findFastControl("button", /^Deny$/, reopened),
  ).resolves.toHaveAttribute("aria-pressed", "true");
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(w.trigger).toHaveFocus();
  });
});
test("chat-composer-chat-connector-access-015 Reviewing the saved account's added scope leads directly to GitHub reconnect", async () => {
  const w = await directory(true);
  await w.open();
  click(await button(/Manage accounts/i));
  click(await button(/^Account actions$/i));
  click(await button(/Review permissions/i));
  const review = (await screen.findByText("read:user")).closest(
    '[role="dialog"]',
  );
  click(await button(/^Reconnect$/));
  await waitFor(() => {
    return expect(review).not.toBeInTheDocument();
  });
  const dialog = await screen.findByRole("dialog", { name: /GitHub/i });
  await expect(
    findFastControl("button", /^Reconnect$/, dialog),
  ).resolves.toBeVisible();
});
