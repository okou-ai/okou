import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  customConnectorOAuth2Contract,
  customConnectorsContract,
  type CustomConnectorHttpResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  findAction,
} from "./connector-integrations-test-helpers.ts";
import { customConnector } from "./connector-page-test-helpers.ts";

const context = testContext();
const MANAGED_CONNECTION_ID = "f7000000-0000-4000-a000-000000000a41";
const ACCOUNT_LIST_ERROR = "Ordinary connector accounts are unavailable";
const ACCOUNT_LOOKUP_ERROR = "Connector account not found";

function managedWorkspace(updatedAt: string): CustomConnectorHttpResponse {
  return customConnector({
    id: "f7000000-0000-4000-a000-000000000a40",
    slug: "_managed-workspace",
    displayName: "Managed workspace",
    prefixTemplates: ["https://open.feishu.cn/open-apis/"],
    fields: [],
    headerInjections: [],
    authMode: "oauth",
    oauthConfig: {
      providerAdapter: "feishu",
      clientId: "cli_managed_workspace",
      authorizationUrl:
        "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
      tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: [],
      authorizationParams: {},
    },
    connected: true,
    connectedAccountId: MANAGED_CONNECTION_ID,
    connectedAccountUpdatedAt: updatedAt,
    missingRequiredFields: [],
    configuredFieldKeys: [],
  });
}

test("Preserve the feishu managed default connection lifecycle", async () => {
  const server = { connector: managedWorkspace("2026-03-01T00:00:00.000Z") };
  const reconnectIntent = context.mocks.deferred<unknown>();
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [server.connector] });
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: ACCOUNT_LIST_ERROR },
    });
  });
  context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: ACCOUNT_LOOKUP_ERROR },
    });
  });
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ params, body, respond }) => {
      expect(params.id).toBe(server.connector.id);
      reconnectIntent.resolve(body.account);
      // The integration already holds the workspace grant, so the provider
      // refreshes the same managed account without a consent page.
      server.connector = managedWorkspace("2026-03-02T00:00:00.000Z");
      return respond(200, {
        result: "connected",
        connector: server.connector,
        connectionId: MANAGED_CONNECTION_ID,
      });
    },
  );
  const authWindow = context.mocks.browser.authWindow();
  context.mocks.browser.open(authWindow);
  await setupPage({ context, path: "/connectors/_managed-workspace/connect" });
  await expect(
    screen.findByRole("heading", { name: "Managed workspace connected" }),
  ).resolves.toBeInTheDocument();

  click(await findAction("button", "Reconnect"));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Managed workspace",
  });
  click(getAction("button", "Continue", dialog));

  await expect(reconnectIntent.promise).resolves.toStrictEqual({
    intent: "reconnect",
    connectionId: MANAGED_CONNECTION_ID,
  });
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(authWindow.closed).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Managed workspace connected" }),
  ).toBeInTheDocument();
  expect(screen.queryByText(ACCOUNT_LIST_ERROR)).toBeNull();
  expect(screen.queryByText(ACCOUNT_LOOKUP_ERROR)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
