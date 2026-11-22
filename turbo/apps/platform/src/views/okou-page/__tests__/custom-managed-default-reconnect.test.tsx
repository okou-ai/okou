import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  customConnectorOAuth2Contract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  getConnectorAction,
} from "./connector-page-test-helpers.ts";

const context = testContext();

async function reconnectManagedAccount(
  brand: "feishu" | "lark",
  mismatched = false,
) {
  const connectionId = crypto.randomUUID();
  const managedConnector = (connectedAccountId: string) => {
    return customConnector({
      slug: `_${brand}`,
      displayName: "Managed workspace",
      authMode: "oauth",
      connected: true,
      connectedAccountId,
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      missingRequiredFields: [],
      configuredFieldKeys: [],
      oauthConfig: {
        providerAdapter: "feishu",
        clientId: "managed-client",
        authorizationUrl: "https://managed.example.test/oauth/authorize",
        tokenUrl: "https://managed.example.test/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: [],
        authorizationParams: {},
      },
    });
  };
  const connector = managedConnector(connectionId);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(403, {
      error: {
        code: "FORBIDDEN",
        message: "Ordinary account list unavailable",
      },
    });
  });
  const mutations: ConnectorAccountMutationIntent[] = [];
  context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
    return respond(404, {
      error: {
        code: "NOT_FOUND",
        message: "Managed accounts are not ordinary accounts",
      },
    });
  });
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ body, respond }) => {
      mutations.push(body.account);
      return respond(200, {
        result: "connected",
        connector: mismatched
          ? managedConnector(crypto.randomUUID())
          : connector,
        connectionId,
      });
    },
  );
  const authWindow = context.mocks.browser.authWindow();
  context.mocks.browser.open(authWindow);
  await setupPage({
    context,
    path: `/connectors/${connector.slug}/connect`,
  });
  await screen.findByText("Managed workspace connected");
  click(getConnectorAction("button", "Reconnect"));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Managed workspace",
  });
  click(getConnectorAction("button", "Continue", dialog));
  return { dialog, mutations, authWindow, connectionId };
}

test.each(["feishu", "lark"] as const)(
  "Preserve the %s managed default connection lifecycle",
  async (brand) => {
    const { mutations, authWindow, connectionId } =
      await reconnectManagedAccount(brand);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Connect Managed workspace" }),
      ).toBeNull();
    });
    expect(mutations).toStrictEqual([{ intent: "reconnect", connectionId }]);
    expect(authWindow.closed).toBeTruthy();
    expect(screen.getByText("Managed workspace connected")).toBeInTheDocument();
    expect(
      screen.queryByText(/Managed accounts are not ordinary accounts/u),
    ).toBeNull();
    expect(screen.queryByText(/Ordinary account list unavailable/u)).toBeNull();
  },
);

test("Reject a managed reconnect receipt whose account differs from the connector", async () => {
  const { dialog, mutations, connectionId } = await reconnectManagedAccount(
    "feishu",
    true,
  );
  await expect(
    screen.findByText(/Connector account response identity mismatch/u),
  ).resolves.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  expect(mutations).toStrictEqual([{ intent: "reconnect", connectionId }]);
});
