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
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

test.each(["feishu", "lark"] as const)(
  "Preserve the %s managed default connection lifecycle",
  async (brand) => {
    const connectionId = crypto.randomUUID();
    const connector = customConnector({
      slug: `_${brand}`,
      displayName: "Managed workspace",
      authMode: "oauth",
      connected: true,
      connectedAccountId: connectionId,
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      missingRequiredFields: [],
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
          connector,
          connectionId: connectionId,
        });
      },
    );
    const authWindow = context.mocks.browser.authWindow();
    context.mocks.browser.open(authWindow);
    await setupPage({
      context,
      path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
    });
    await screen.findByText("Managed workspace connected");
    click(getConnectorAction("button", "Reconnect"));
    const dialog = await screen.findByRole("dialog", {
      name: "Connect Managed workspace",
    });
    click(getConnectorAction("button", "Continue", dialog));
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
