import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorValuesContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  customConnectorAccount,
  getConnectorAction,
  listAgent,
  mockConnectorAgentAccess,
  mockCustomConnectorStory,
  mockSavedConnectorAccounts,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const RESEARCH_ID = "c0000000-0000-4000-a000-000000000051";

test("Cancel a pending custom connection and connect another account", async () => {
  const connector = customConnector();
  mockCustomConnectorStory(context, [{ connector }]);
  const accounts: ConnectorAccountConnection[] = [];
  mockSavedConnectorAccounts(context, () => {
    return accounts;
  });
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const account = accounts.find((candidate) => {
        return candidate.id === params.connectionId;
      });
      return account
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Account not found" },
          });
    },
  );
  const started = context.mocks.deferred<AbortSignal>();
  const firstResponse = context.mocks.deferred<void>();
  const serverCompleted = context.mocks.deferred<void>();
  context.mocks.api(
    customConnectorValuesContract.set,
    async ({ body, request, respond }) => {
      const account = customConnectorAccount(connector.id, {
        configuredFieldKeys: ["secret"],
        isDefault: accounts.length === 0,
      });
      if (body.values[0]?.value === "first-secret") {
        started.resolve(request.signal);
        await firstResponse.promise;
      }
      accounts.push(account);
      if (body.values[0]?.value === "first-secret") {
        serverCompleted.resolve();
      }
      return respond(200, { ...connector, connectionId: account.id });
    },
  );
  await setupPage({ context, path: "/connectors?scope=custom" });
  await waitFor(() => {
    expect(getConnectorAction("button", "Connect Acme Search")).toBeEnabled();
  });
  click(getConnectorAction("button", "Connect Acme Search"));
  const first = await screen.findByRole("dialog", {
    name: "Connect Acme Search",
  });
  await fill(within(first).getByLabelText("Secret"), "first-secret");
  click(getConnectorAction("button", "Save", first));
  const requestSignal = await started.promise;
  click(getConnectorAction("button", "Close", first));
  await waitFor(() => {
    expect(first).not.toBeInTheDocument();
  });
  expect(requestSignal.aborted).toBeTruthy();

  click(getConnectorAction("button", "Connect Acme Search"));
  const second = await screen.findByRole("dialog", {
    name: "Connect Acme Search",
  });
  expect(within(second).getByLabelText("Secret")).toHaveValue("");
  await fill(within(second).getByLabelText("Secret"), "second-secret");
  firstResponse.resolve();
  await serverCompleted.promise;
  expect(within(second).getByLabelText("Secret")).toHaveValue("second-secret");
  click(getConnectorAction("button", "Save", second));
  await expect(
    screen.findByRole("dialog", { name: "Name your Acme Search account" }),
  ).resolves.toBeInTheDocument();
  expect(second).not.toBeInTheDocument();
});

test("Keep a custom connection pending until its account naming continuation is ready", async () => {
  const connector = customConnector();
  mockCustomConnectorStory(context, [{ connector }]);
  context.mocks.data.agents([listAgent(RESEARCH_ID, "Research")]);
  let grants: AgentCustomConnectorGrant[] = [];
  let account: ConnectorAccountConnection | undefined;
  mockSavedConnectorAccounts(context, () => {
    return account ? [account] : [];
  });
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, { grants });
  });
  mockConnectorAgentAccess(context, () => {
    return { grants };
  });
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, respond }) => {
      grants = body.grants;
      return respond(200, { grants });
    },
  );
  context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
    account = customConnectorAccount(connector.id, {
      configuredFieldKeys: ["secret"],
    });
    return respond(200, { ...connector, connectionId: account.id });
  });
  const namingRead = context.mocks.deferred<void>();
  const finishNamingRead = context.mocks.deferred<void>();
  context.mocks.api(
    connectorAccountsContract.connection,
    async ({ respond, withSignal }) => {
      if (!account) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Account not found" },
        });
      }
      if (grants.length > 0) {
        namingRead.resolve();
        await withSignal(finishNamingRead.promise);
      }
      return respond(200, account);
    },
  );
  await setupPage({ context, path: "/connectors?scope=custom" });
  await waitFor(() => {
    expect(getConnectorAction("button", "Connect Acme Search")).toBeEnabled();
  });
  click(getConnectorAction("button", "Connect Acme Search"));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Acme Search",
  });
  await fill(within(dialog).getByLabelText("Secret"), "account-secret");
  click(getConnectorAction("button", "Save", dialog));
  await namingRead.promise;
  expect(getConnectorAction("button", "Saving…", dialog)).toBeDisabled();
  expect(within(dialog).getByLabelText("Secret")).toHaveValue("account-secret");
  expect(
    screen.queryByRole("dialog", { name: "Name your Acme Search account" }),
  ).not.toBeInTheDocument();

  finishNamingRead.resolve();
  const naming = await screen.findByRole("dialog", {
    name: "Name your Acme Search account",
  });
  expect(within(naming).getByLabelText("Account name")).toHaveValue("");
  expect(dialog).not.toBeInTheDocument();
});
