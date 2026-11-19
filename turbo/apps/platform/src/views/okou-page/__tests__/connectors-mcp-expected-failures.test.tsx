import {
  customConnectorOAuth2Contract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES } from "@okouai/api-contracts/validators/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  getConnectorCard,
  mcpCustomConnector,
  mockSavedConnectorAccounts,
} from "./connector-page-test-helpers.ts";

const context = testContext();

test.each([
  {
    label: "invalid discovery metadata",
    status: 400 as const,
    code: CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID,
    message:
      "The MCP server's OAuth discovery metadata is incomplete or inconsistent. Fix the advertised metadata if you manage the server, or contact the server administrator.",
  },
  {
    label: "temporary provider unavailability",
    status: 502 as const,
    code: CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE,
    message:
      "The MCP OAuth provider is temporarily unavailable or rate-limited. Check the provider's availability.",
  },
])(
  "Keep MCP failure feedback and retry available for $label",
  async ({ status, code, message }) => {
    context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
    const connector = mcpCustomConnector({
      authMode: "automatic",
      fields: [],
      headerInjections: [],
      account: { missingRequiredFields: [], configuredFieldKeys: [] },
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    mockSavedConnectorAccounts(context, () => {
      return [];
    });
    context.mocks.api(customConnectorOAuth2Contract.start, ({ respond }) => {
      return respond(status, {
        error: { code, message: "Upstream OAuth setup failed" },
      });
    });
    const sentry = context.mocks.sentry();
    const authWindow = context.mocks.browser.authWindow();
    context.mocks.browser.open(authWindow);

    await setupPage({ context, path: "/connectors?scope=custom" });
    const connect = await waitFor(() => {
      const action = getConnectorAction("button", "Connect Acme MCP");
      expect(action).toBeEnabled();
      return action;
    });
    click(connect);

    await expect(screen.findByText(message)).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(authWindow.closed).toBeTruthy();
      expect(getConnectorAction("button", "Connect Acme MCP")).toBeEnabled();
    });
    expect(
      within(getConnectorCard("Acme MCP")).getByText("No accounts"),
    ).toBeInTheDocument();
    expect(
      sentry.reports.filter((report) => {
        return report.type === "exception";
      }),
    ).toHaveLength(0);
  },
);
