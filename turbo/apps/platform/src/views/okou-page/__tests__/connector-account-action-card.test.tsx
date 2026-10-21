import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { agentConnectorAccessContract } from "@okouai/api-contracts/contracts/agent-connector-access";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountSelection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import {
  chatEventsContract,
  chatThreadConnectorSelectionContract,
} from "@okouai/api-contracts/contracts/chat-threads";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { catalogFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000902";
const CONNECTION_ID = "f0000000-0000-4000-a000-000000000901";

function button(name: string, card: HTMLElement): HTMLElement {
  const result = queryAllByRoleFast("button", card).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!result) {
    throw new Error(`Missing button ${name}`);
  }
  return result;
}

test("a saved account selection keeps callback failure visible and retries only the callback", async () => {
  const github = connectorSlugSchema.parse("github");
  const selection: ConnectorAccountSelection = {
    connectionId: CONNECTION_ID,
    target: { kind: "builtin", connectorSlug: github },
  };
  const account: ConnectorAccountConnection = {
    setupStatus: "complete",
    missingRequiredFields: [],
    configuredFieldKeys: [],
    id: CONNECTION_ID,
    target: selection.target,
    authMethod: "oauth",
    displayName: "Work GitHub",
    isDefault: false,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: [],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
  };
  const url = new URL(
    `https://app.okou.ai/agents/${AGENT_ID}/connector-accounts/${CONNECTION_ID}/select`,
  );
  url.searchParams.set("kind", "builtin");
  url.searchParams.set("connectorSlug", github);
  url.searchParams.set("threadId", THREAD_ID);
  url.searchParams.set("callbackPrompt", "Continue with the saved account");
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "account-request",
        role: "assistant",
        runId: "run-account-request",
        content: url.toString(),
        createdAt: "2026-10-05T12:00:00.000Z",
      },
    ],
  });
  context.mocks.api(agentConnectorAccessContract.agent, ({ respond }) => {
    return respond(200, {
      enabledConnectorSlugs: [github],
      customConnectorIds: [],
    });
  });
  context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
    return respond(200, account);
  });
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, {
      connector: catalogFixture({
        slug: github,
        label: "GitHub",
        description: "GitHub connector",
        icon: {
          url: "https://icons.example.test/github.svg",
          invertInDarkMode: false,
        },
        category: "productivity",
        generation: [],
        tags: [],
        authMethods: [],
        permissionSummary: {
          hasPermissions: false,
          permissionCount: 0,
          hasCategories: false,
          hasDefaultPolicyOverrides: false,
        },
        singleAuthCodeAuthMethodId: null,
        connectNotice: null,
      }),
    });
  });
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [] });
  });
  let selections: ConnectorAccountSelection[] = [];
  let saves = 0;
  context.mocks.api(chatThreadConnectorSelectionContract.get, ({ respond }) => {
    return respond(200, {
      selections,
      selectedConnections: selections.length ? [account] : [],
    });
  });
  context.mocks.api(
    chatThreadConnectorSelectionContract.update,
    ({ body, respond }) => {
      saves += 1;
      selections = [body];
      return respond(200, body);
    },
  );
  let callbacks = 0;
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.prompt).toBe("Continue with the saved account");
    callbacks += 1;
    return callbacks === 1
      ? respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Chat unavailable" },
        })
      : respond(201, { threadId: THREAD_ID });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  const card = await screen.findByTestId("connector-account-action-card");
  click(button("Switch", card));
  await within(card).findByText("Couldn't switch accounts. Try again.");
  await within(card).findByText("Switched to Work GitHub");
  click(button("Retry", card));
  await waitFor(() => {
    expect(queryAllByRoleFast("button", card)).toHaveLength(0);
  });
  expect(card).toHaveTextContent("Switched to Work GitHub");
  expect(saves).toBe(1);
  expect(callbacks).toBe(2);
});
