import { httpConnectorFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupTeamPage } from "../../team-page/__tests__/team-page-test-helpers.ts";
import {
  customConnector,
  customConnectorAccount,
  getConnectorAction,
  mockSavedConnectorAccounts,
} from "./connector-page-test-helpers.ts";

const context = testContext();

test.each(["set-default", "delete-default"] as const)(
  "Check the current Job default after a local account %s",
  async (mutation) => {
    const connector = customConnector({
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
    });
    const work = customConnectorAccount(connector.id, {
      displayName: "Work",
    });
    const expired = customConnectorAccount(connector.id, {
      displayName: "Expired",
      isDefault: false,
      connectionStatus: "reconnect-required",
      reconnectReason: "credential_expired",
    });
    let accounts = [work, expired];
    let defaultConnection = work;
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, {
        connectors: [
          httpConnectorFixture({
            ...connector,
            connected: defaultConnection.connectionStatus === "connected",
          }),
        ],
      });
    });
    mockSavedConnectorAccounts(context, () => {
      return accounts;
    });
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      return respond(200, {
        connections: accounts,
        nextCursor: null,
        defaultConnection,
      });
    });
    const promoteExpired = () => {
      defaultConnection = { ...expired, isDefault: true };
      accounts = accounts.map((account) => {
        return account.id === expired.id
          ? defaultConnection
          : { ...account, isDefault: false };
      });
    };
    context.mocks.api(
      connectorAccountsContract.setDefault,
      ({ params, respond }) => {
        expect(params.connectionId).toBe(expired.id);
        promoteExpired();
        return respond(200, defaultConnection);
      },
    );
    context.mocks.api(
      connectorAccountsContract.deletionImpact,
      ({ params, respond }) => {
        return respond(200, {
          connectionId: params.connectionId,
          explicitSelectionCount: 0,
          hasSibling: true,
        });
      },
    );
    context.mocks.api(
      connectorAccountsContract.delete,
      ({ params, respond }) => {
        expect(params.connectionId).toBe(work.id);
        accounts = [expired];
        promoteExpired();
        return respond(200, {
          deletedConnectionId: work.id,
          resolvedSelectionCount: 0,
          promotedDefaultConnectionId: expired.id,
        });
      },
    );
    await setupTeamPage({
      context,
      path: "/connectors?scope=custom",
    });
    click(
      await waitFor(() => {
        return getConnectorAction("button", "Manage Acme Search accounts");
      }),
    );
    const manager = await screen.findByRole("dialog", {
      name: "Manage Acme Search accounts",
    });
    const workRow = await within(manager).findByRole("group", { name: "Work" });
    expect(
      within(workRow).getByRole("radio", { name: "Default" }),
    ).toBeChecked();
    if (mutation === "set-default") {
      click(
        within(
          within(manager).getByRole("group", { name: "Expired" }),
        ).getByRole("radio", { name: "Make default" }),
      );
    } else {
      click(getConnectorAction("button", "Account actions", workRow));
      click(
        await waitFor(() => {
          const action = queryAllByRoleFast("menuitem").find((item) => {
            return item.textContent?.trim() === "Disconnect";
          });
          if (!action) {
            throw new Error("Disconnect account action is unavailable");
          }
          return action;
        }),
      );
      const confirmation = await screen.findByRole("dialog", {
        name: "Disconnect Work?",
      });
      click(getConnectorAction("button", "Disconnect account", confirmation));
    }
    await waitFor(() => {
      const expiredRow = within(manager).getByRole("group", {
        name: "Expired",
      });
      expect(
        within(expiredRow).getByRole("radio", { name: "Default" }),
      ).toBeChecked();
    });
    click(getConnectorAction("button", "Close", manager));
    click(getConnectorAction("link", "Agents"));
    click(
      await waitFor(() => {
        return getConnectorAction("link", "Research Agent");
      }),
    );
    await screen.findByRole("heading", { name: "Research Agent" });
    click(screen.getByRole("switch", { name: "Grant Acme Search access" }));
    await screen.findByText(/fully configured default account/);
    expect(
      screen.getByRole("switch", { name: "Grant Acme Search access" }),
    ).not.toBeChecked();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);
