import {
  CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES,
  customConnectorOAuth2Contract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  getConnectorCard,
  mcpCustomConnector,
  mockSavedConnectorAccounts,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const DISCOVERY_MESSAGE =
  "The MCP server's OAuth discovery metadata is incomplete or inconsistent. Fix the advertised metadata if you manage the server, or contact the server administrator.";

test.each([
  {
    name: "invalid discovery metadata",
    status: 400,
    code: CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID,
    message: DISCOVERY_MESSAGE,
    report: false,
  },
  {
    name: "temporary provider unavailability",
    status: 502,
    code: CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE,
    message:
      "The MCP OAuth provider is temporarily unavailable or rate-limited. Try again later and check the provider's availability.",
    report: false,
  },
  {
    name: "an unknown setup failure",
    status: 400,
    code: "UNKNOWN_MCP_SETUP_ERROR",
    message: "MCP setup failed",
    report: true,
  },
  {
    name: "an internal failure with a recognized code",
    status: 500,
    code: CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID,
    message: DISCOVERY_MESSAGE,
    report: true,
  },
] as const)(
  "Keep MCP failure feedback and retry available for $name",
  async ({ status, code, message, report }) => {
    const connector = mcpCustomConnector({
      authMode: "automatic",
      fields: [],
      headerInjections: [],
      account: undefined,
    });
    context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    mockSavedConnectorAccounts(context, () => {
      return [];
    });
    context.mocks.api(customConnectorOAuth2Contract.start, ({ respond }) => {
      return respond(status, {
        error: { code, message: "MCP setup failed" },
      });
    });
    const popup = context.mocks.browser.authWindow();
    context.mocks.browser.open(popup);
    const sentry = context.mocks.sentry();
    initSentry();

    await setupPage({ context, path: "/connectors?scope=custom" });
    const connect = await waitFor(() => {
      return getConnectorAction("button", "Connect Acme MCP");
    });
    click(connect);

    await expect(screen.findByText(message)).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(popup.closed).toBeTruthy();
      expect(getConnectorAction("button", "Connect Acme MCP")).toBeEnabled();
      expect(
        screen.queryByRole("dialog", { name: "Connecting your account" }),
      ).toBeNull();
    });
    expect(getConnectorCard("Acme MCP")).toHaveTextContent("No accounts");
    expect(sentry.reports).toMatchObject(
      report ? [{ type: "exception", error: { code, status } }] : [],
    );
  },
);
