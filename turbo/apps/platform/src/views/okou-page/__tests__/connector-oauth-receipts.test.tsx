import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  mockConnectors,
  mockPublicConnectorStatus,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function authorizationWindow(): Window {
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  context.mocks.browser.open(popup);
  return popup;
}

test.each(["missing", "forbidden"] as const)(
  "Preserve the pending OAuth receipt outcome when the final receipt is %s",
  async (finish) => {
    const receiptStarted = context.mocks.deferred<void>();
    const oauthAttemptId = crypto.randomUUID();
    let firstReceiptRead = true;
    mockConnectors(context, []);
    mockPublicConnectorStatus(context, [
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Stripe",
        singleAuthCodeAuthMethodId: "oauth",
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
            description: null,
            grantKind: "auth-code",
            supportsRefresh: true,
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    const popup = authorizationWindow();
    context.mocks.api(
      builtinConnectorOauthStartContract.start,
      ({ respond }) => {
        return respond(200, {
          authorizationUrl: "https://oauth.test/stripe/authorize",
          oauthAttemptId,
        });
      },
    );
    context.mocks.api(
      connectorAccountsContract.oauthCompletion,
      async ({ never, respond }) => {
        if (firstReceiptRead) {
          firstReceiptRead = false;
          receiptStarted.resolve();
          return await never();
        }
        return finish === "forbidden"
          ? respond(403, {
              error: {
                code: "FORBIDDEN",
                message: "OAuth completion is unavailable",
              },
            })
          : respond(404, {
              error: {
                code: "NOT_FOUND",
                message: "OAuth completion not found",
              },
            });
      },
    );
    await setupPage({ context, path: "/connectors?keywords=stripe" });
    const connect = await waitFor(() => {
      return getConnectorAction("button", "Connect Stripe");
    });
    click(connect);
    await receiptStarted.promise;
    popup.close();
    await waitFor(() => {
      expect(connect).toBeEnabled();
      expect(
        screen.queryAllByText("OAuth completion is unavailable"),
      ).toHaveLength(finish === "forbidden" ? 1 : 0);
    });
  },
);
