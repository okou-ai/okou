import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import {
  getAction,
  findAction,
} from "./connector-integrations-test-helpers.ts";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { waitFor, screen, within } from "@testing-library/react";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
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

function githubAccounts(members: Record<string, boolean>) {
  const accounts = Object.entries(members).map(
    ([displayName, enabled], index) => {
      return {
        record: connectorAccountFixture(target, {
          displayName,
          isDefault: index === 0,
        }),
        enabled,
      };
    },
  );
  mockSavedConnectorAccounts(context, () => {
    return accounts.map((a) => {
      return a.record;
    });
  });
  const defaults = () => {
    return accounts.map(({ record, enabled }) => {
      return {
        connectionId: record.id,
        displayName: record.displayName,
        isDefault: record.isDefault,
        defaultEnabled: enabled,
      };
    });
  };
  context.mocks.api(
    chatConnectorAccessContract.accountDefaults,
    ({ respond }) => {
      return respond(200, defaults());
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.updateAccountDefault,
    ({ params, body, respond }) => {
      const row = accounts.find((a) => {
        return a.record.id === params.connectionId;
      });
      if (!row) {
        throw new Error("Unknown GitHub connection");
      }
      row.enabled = body.enabled;
      return respond(200, {
        connectionId: row.record.id,
        displayName: row.record.displayName,
        isDefault: row.record.isDefault,
        defaultEnabled: row.enabled,
      });
    },
  );
  const deletion = { ready: Promise.resolve(), failure: false, affected: 0 };
  context.mocks.api(
    connectorAccountsContract.deletionImpact,
    ({ params, respond }) => {
      return respond(200, {
        connectionId: params.connectionId,
        explicitSelectionCount: deletion.affected,
        hasSibling: accounts.length > 1,
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.delete,
    async ({ params, respond }) => {
      await deletion.ready;
      if (deletion.failure) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Disconnect failed" },
        });
      }
      const index = accounts.findIndex((a) => {
        return a.record.id === params.connectionId;
      });
      if (index === -1) {
        throw new Error("Unknown account deletion");
      }
      accounts.splice(index, 1);
      return respond(200, {
        deletedConnectionId: params.connectionId,
        resolvedSelectionCount: deletion.affected,
        promotedDefaultConnectionId: accounts[0]?.record.id ?? null,
      });
    },
  );
  return deletion;
}
async function manageAccounts() {
  await setupPage({ context, path: "/connectors?scope=connected" });
  click(await findButton(manage));
  return screen.findByRole("dialog", { name: manage });
}
async function disconnectDialog(label: string) {
  const row = await screen.findByRole("group", { name: label });
  click(getAction("button", "Account actions", row));
  click(
    await screen.findByText("Disconnect", { selector: '[role="menuitem"]' }),
  );
  return screen.findByRole("dialog", { name: "Disconnect " + label + "?" });
}
test("connectors-accounts-001 disabling the saved default leaves the other GitHub account available", async () => {
  githubAccounts({ Work: true, Personal: true });
  const manager = await manageAccounts();
  const work = await within(manager).findByRole("switch", {
    name: "Enable Work by default",
    checked: true,
  });
  expect(
    within(manager).getByRole("switch", { name: "Enable Personal by default" }),
  ).toBeChecked();
  click(work);
  await within(manager).findByRole("switch", {
    name: "Enable Work by default",
    checked: false,
  });
  expect(
    within(manager).getByRole("switch", { name: "Enable Personal by default" }),
  ).toBeChecked();
  expect(
    within(manager).getByText(
      "Choose which GitHub accounts Okou can use across your chats. You can change access in each chat.",
    ),
  ).toBeInTheDocument();
});
test("connectors-accounts-003 enabling Personal persists after Work is removed", async () => {
  githubAccounts({ Work: true, Personal: false });
  const manager = await manageAccounts();
  await within(manager).findByRole("switch", {
    name: "Enable Work by default",
    checked: true,
  });
  const personal = within(manager).getByRole("switch", {
    name: "Enable Personal by default",
  });
  expect(personal).not.toBeChecked();
  click(personal);
  await within(manager).findByRole("switch", {
    name: "Enable Personal by default",
    checked: true,
  });
  const confirmation = await disconnectDialog("Work");
  click(getAction("button", "Disconnect account", confirmation));
  await waitFor(() => {
    return expect(
      within(manager).queryByRole("group", { name: "Work", hidden: true }),
    ).toBeNull();
  });
  await within(manager).findByRole("switch", {
    name: "Enable Personal by default",
    checked: true,
  });
  expect(within(manager).queryByText("Work")).toBeNull();
});
test("connectors-accounts-018 retrying the last account deletion preserves the impact explanation until success", async () => {
  const deletion = githubAccounts({ octocat: true });
  deletion.affected = 2;
  deletion.failure = true;
  const pending = context.mocks.deferred<void>();
  deletion.ready = pending.promise;
  const manager = await manageAccounts();
  const confirm = await disconnectDialog("octocat");
  expect(
    within(confirm).getByText(
      "This disconnects the account from Okou. 2 threads will return to default inheritance. The provider account will not be deleted.",
    ),
  ).toBeInTheDocument();
  click(getAction("button", "Disconnect account", confirm));
  await expect(
    findAction("button", "Disconnecting...", confirm),
  ).resolves.toBeDisabled();
  pending.resolve();
  await expect(
    screen.findByText("Disconnect failed"),
  ).resolves.toBeInTheDocument();
  const retry = getAction("button", "Disconnect account", confirm);
  expect(retry).toBeEnabled();
  deletion.failure = false;
  click(retry);
  await expect(
    within(manager).findByText("No accounts found"),
  ).resolves.toBeInTheDocument();
  expect(getAction("button", "Add account", manager)).toBeEnabled();
  expect(
    screen.queryByRole("dialog", { name: "Disconnect octocat?" }),
  ).toBeNull();
});
test("connectors-accounts-019 late deletion of Work leaves Personal's confirmation actionable", async () => {
  const deletion = githubAccounts({ Work: true, Personal: true });
  const pending = context.mocks.deferred<void>();
  deletion.ready = pending.promise;
  const manager = await manageAccounts();
  const work = await disconnectDialog("Work");
  click(getAction("button", "Disconnect account", work));
  await expect(
    findAction("button", "Disconnecting...", work),
  ).resolves.toBeDisabled();
  click(getAction("button", "Cancel", work));
  const personal = await disconnectDialog("Personal");
  pending.resolve();
  await waitFor(() => {
    return expect(within(manager).queryByText("Work")).toBeNull();
  });
  expect(within(manager).getByText("Personal")).toBeInTheDocument();
  expect(getAction("button", "Disconnect account", personal)).toBeEnabled();
  expect(
    screen.getByRole("dialog", { name: "Disconnect Personal?" }),
  ).toBeInTheDocument();
});
test("connectors-accounts-020 reviewing Personal reconnects that account while Work remains default", async () => {
  const work = connectorAccountFixture(target, {
    displayName: "Work",
    isDefault: true,
  });
  const personal = connectorAccountFixture(target, {
    displayName: "Personal",
    isDefault: false,
    scopeMismatch: true,
  });
  mockSavedConnectorAccounts(context, () => {
    return [work, personal];
  });
  context.mocks.api(
    connectorAccountsContract.scopeDiff,
    ({ params, respond }) => {
      const added =
        params.connectionId === personal.id ? "read:user" : "read:org";
      return respond(200, {
        addedScopes: [added],
        currentScopes: ["repo", added],
        storedScopes: ["repo"],
        removedScopes: [],
      });
    },
  );
  const destination = "https://provider.example.org/oauth/personal";
  const popup = Object.assign(context.mocks.browser.authWindow(), {
    location: { href: "about:blank" },
  });
  context.mocks.browser.open(popup);
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, params, respond }) => {
      expect(params.connectorSlug).toBe("github");
      expect(body.account).toStrictEqual({
        intent: "reconnect",
        connectionId: personal.id,
      });
      return respond(200, {
        authorizationUrl: destination,
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  const manager = await manageAccounts();
  const row = await within(manager).findByRole("group", { name: "Personal" });
  click(getAction("button", "Account actions", row));
  click(
    await screen.findByText("Review permissions", {
      selector: '[role="menuitem"]',
    }),
  );
  const scope = await screen.findByText("read:user");
  const review = scope.closest('[role="dialog"]');
  if (!review) {
    throw new Error("Missing scope review");
  }
  click(getAction("button", "Reconnect", review));
  const connect = await screen.findByRole("dialog", { name: /GitHub/i });
  click(await findAction("button", "Reconnect", connect));
  await waitFor(() => {
    return expect(popup.location.href).toBe(destination);
  });
});
