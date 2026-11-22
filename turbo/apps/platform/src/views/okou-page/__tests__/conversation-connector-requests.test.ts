import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { builtinConnectorNoAuthGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  RUN_PATH,
  createChatCapabilityHelpers,
  completedConversation,
} from "./chat-capability-test-helpers.ts";
import {
  catalogConnector,
  connectorActionUrl,
  noAuthMethod,
} from "./chat-capability-connector-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
test("chat-capability-connectors-013 Enabling public data from the conversation resumes the requested work", async () => {
  const definition = catalogConnector({
    slug: "public-data",
    label: "Public data",
    method: noAuthMethod(),
  });
  const target = { kind: "builtin", connectorSlug: definition.slug } as const;
  const account = connectorAccountFixture(target, { authMethod: "public" });
  const requested = context.mocks.deferred<void>();
  const allow = context.mocks.deferred<void>();
  let enabled = false;
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, { connector: definition });
  });
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      const selected =
        enabled &&
        query.kind === "builtin" &&
        query.connectorSlug === definition.slug
          ? account
          : null;
      return respond(200, {
        connections: selected ? [selected] : [],
        defaultConnection: selected,
        nextCursor: null,
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      return enabled && account.id === params.connectionId
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Missing account" },
          });
    },
  );
  context.mocks.api(
    builtinConnectorNoAuthGrantContract.connect,
    async ({ params, body, respond }) => {
      if (
        params.connectorSlug !== definition.slug ||
        body.authMethod !== "public"
      ) {
        return respond(400, {
          error: { code: "BAD_REQUEST", message: "Wrong connector or grant" },
        });
      }
      requested.resolve();
      await allow.promise;
      enabled = true;
      context.mocks.ably.trigger("connector:changed", {
        connectorSlug: definition.slug,
      });
      return respond(200, { connectionId: account.id });
    },
  );
  const callbackPrompt = "Resume with public data";
  const link = new URL(
    connectorActionUrl({ slug: definition.slug, callbackPrompt }),
  );
  const message =
    "Review this connector request. [Open connector](" +
    link.pathname +
    link.search +
    ")";
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation(message),
  });
  await setupPage({ context, path: RUN_PATH });
  const card = await screen.findByTestId("connector-action-card");
  try {
    click(await findFastControl("button", "Connect", card));
    await requested.promise;
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(callbackPrompt, { exact: true })).toBeNull();
    allow.resolve();
    await screen.findByText(callbackPrompt, { exact: true });
    await waitFor(() => {
      return expect(
        within(screen.getByTestId("connector-action-card")).getByText(
          "Connected",
          { selector: "button" },
        ),
      ).toBeDisabled();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    if (!allow.settled()) {
      allow.resolve();
    }
  }
});
