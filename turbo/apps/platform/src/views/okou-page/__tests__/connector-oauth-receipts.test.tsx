import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  mockSavedConnectorAccounts,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const STRIPE_ATTEMPT_ID = "5a7c2f9e-41b8-4c6d-9e0a-3f1b2c4d5e6f";

test("Preserve the pending OAuth receipt outcome when the final receipt is missing", async () => {
  const stripe = publicStatusItem({
    connectorSlug: "stripe",
    label: "Stripe",
    singleAuthCodeAuthMethodId: "oauth",
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        grantKind: "auth-code",
        description: null,
        supportsRefresh: true,
        manualFields: [],
        startOptions: [],
      },
    ],
  });
  context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
    return respond(200, { connectors: [stripe], totalConnectorCount: 1 });
  });
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  context.mocks.api(builtinConnectorOauthStartContract.start, ({ respond }) => {
    return respond(200, {
      authorizationUrl: "https://stripe.test/oauth/authorize",
      oauthAttemptId: STRIPE_ATTEMPT_ID,
    });
  });
  const receiptPending = context.mocks.deferred<void>();
  const pendingReceiptRead = context.mocks.deferred<void>();
  let receiptReads = 0;
  context.mocks.api(
    connectorAccountsContract.oauthCompletion,
    async ({ params, respond }) => {
      expect(params.attemptId).toBe(STRIPE_ATTEMPT_ID);
      receiptReads += 1;
      if (receiptReads === 1) {
        pendingReceiptRead.resolve();
        await receiptPending.promise;
      }
      return respond(404, {
        error: { code: "NOT_FOUND", message: "OAuth completion not found" },
      });
    },
  );
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = false;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  context.mocks.browser.open(authWindow);

  await setupPage({ context, path: "/connectors" });
  const connect = await waitFor(() => {
    const action = getConnectorAction("button", "Connect Stripe");
    expect(action).toBeEnabled();
    return action;
  });
  click(connect);
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://stripe.test/oauth/authorize",
    );
  });
  await pendingReceiptRead.promise;
  expect(getConnectorAction("button", "Connect Stripe")).toBeDisabled();

  authWindow.closed = true;

  await waitFor(() => {
    expect(getConnectorAction("button", "Connect Stripe")).toBeEnabled();
    expect(receiptReads).toBe(2);
  });
  expect(screen.queryByText(/OAuth completion is unavailable/u)).toBeNull();
});
