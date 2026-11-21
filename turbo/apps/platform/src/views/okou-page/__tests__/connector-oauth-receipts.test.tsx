import { mockPublicConnectorStatus } from "./connector-page-test-helpers.ts";
import {
  browserAuthMethod,
  catalogConnector,
} from "./chat-capability-connector-test-helpers.ts";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findButton,
  findEnabledButton,
  queryButton,
} from "./chat-run-test-fixtures.ts";
const context = testContext();
test("connector-oauth-receipts-001 closing the pending Stripe authorization returns to a usable connection action", async () => {
  mockPublicConnectorStatus(context, [
    catalogConnector({
      slug: "stripe",
      label: "Stripe",
      method: browserAuthMethod(),
    }),
  ]);
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  context.mocks.browser.open(popup);
  const attempt = crypto.randomUUID();
  const authorizationUrl = "https://stripe.example.test/approval";
  context.mocks.api(builtinConnectorOauthStartContract.start, ({ respond }) => {
    return respond(200, { authorizationUrl, oauthAttemptId: attempt });
  });
  const pending = context.mocks.deferred<void>();
  const finalLookup = context.mocks.deferred<void>();
  context.mocks.api(
    connectorAccountsContract.oauthCompletion,
    async ({ params, query, respond, never }) => {
      if (
        params.attemptId === attempt &&
        query.kind === "builtin" &&
        query.connectorSlug === "stripe"
      ) {
        if (!popup.closed) {
          pending.resolve();
          return await never();
        }
        finalLookup.resolve();
      }
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Receipt not available yet" },
      });
    },
  );
  await setupPage({ context, path: "/connectors" });
  click(await findButton("Connect Stripe"));

  await pending.promise;
  expect(popup.location.href).toBe(authorizationUrl);
  expect(queryButton("Connect Stripe")).toBeDisabled();
  popup.close();
  await finalLookup.promise;
  await expect(
    findEnabledButton("Connect Stripe"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("OAuth completion is unavailable"),
  ).not.toBeInTheDocument();
});
