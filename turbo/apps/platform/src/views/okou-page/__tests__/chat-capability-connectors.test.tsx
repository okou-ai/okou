import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { mockOAuthCompletions } from "./connector-page-test-helpers.ts";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  bankingUserContract,
  type BankingAccessRequestStatusResponse,
} from "@okouai/api-contracts/contracts/banking";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorsMainContract,
  connectorNoAuthGrantContract,
  connectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorsContract,
  customConnectorValuesContract,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  CAPABILITY_AGENT_ID,
  context,
  completedConversation,
  type CapturedChatSend,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import {
  bankingActionUrl,
  browserAuthMethod,
  catalogConnector,
  connectedConnectorResponse,
  connectorActionUrl,
  CONNECTOR_CONNECTION_ID,
  customConnector,
  CUSTOM_CONNECTOR_ID,
  noAuthMethod,
} from "./chat-capability-connector-test-helpers.ts";

const BANK_ACCOUNT_ID = "e0000000-0000-4000-a000-000000000911";
const BANK_CONNECTION_ID = "e0000000-0000-4000-a000-000000000912";
const BANK_SESSION_ID = "e0000000-0000-4000-a000-000000000913";

function installActionConversation(args: {
  readonly lines: readonly string[];
  readonly sends?: CapturedChatSend[];
}): void {
  installCapabilityChat({
    events: completedConversation(args.lines.join("\n\n")),
    onSend(send) {
      args.sends?.push(send);
    },
  });
}

function normalizedText(element: HTMLElement): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function queryControl(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast(role, container).find((element) => {
      return (
        element.getAttribute("aria-label") === name ||
        normalizedText(element) === name
      );
    }) ?? null
  );
}

function getControl(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const control = queryControl(role, name, container);
  if (!control) {
    throw new Error(`${name} ${role} was not available`);
  }
  return control;
}

function getButton(name: string, container?: ParentNode): HTMLElement {
  return getControl("button", name, container);
}

function sentPrompts(sends: readonly CapturedChatSend[]): string[] {
  return sends.map((send) => {
    return send.prompt;
  });
}

function installCatalogLookup(
  lookup: (slug: ConnectorSlug) => ReturnType<typeof catalogConnector> | null,
): void {
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    const connector = lookup(params.connectorSlug);
    return connector
      ? respond(200, { connector })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
  });
}

function installCustomConnectorApi(args: {
  readonly connector: () => CustomConnectorResponse;
  readonly grants?: AgentCustomConnectorGrant[];
  readonly authorizationUpdates?: AgentCustomConnectorGrant[][];
}): void {
  let grants = args.grants ?? [];
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [args.connector()] });
  });
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, { grants });
  });
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, respond }) => {
      args.authorizationUpdates?.push([...body.grants]);
      grants = [...body.grants];
      return respond(200, { grants });
    },
  );
}

function mockOpenedWindow(): {
  readonly calls: ReturnType<typeof context.mocks.browser.open>["calls"];
  readonly navigations: string[];
  readonly openedWindow: ReturnType<typeof context.mocks.browser.authWindow>;
} {
  const navigations: string[] = [];
  const openedWindow = context.mocks.browser.authWindow();
  const location = {
    _href: "about:blank",
    get href(): string {
      return this._href;
    },
    set href(value: string) {
      this._href = value;
      navigations.push(value);
    },
    replace(value: string | URL): void {
      this._href = String(value);
      navigations.push(String(value));
    },
  };
  Object.defineProperty(openedWindow, "location", {
    configurable: true,
    value: location,
  });
  const browserOpen = context.mocks.browser.open(openedWindow);
  return { calls: browserOpen.calls, navigations, openedWindow };
}

function emptyBankingStatus(): BankingAccessRequestStatusResponse {
  return {
    agent: { id: CAPABILITY_AGENT_ID, name: "Finance Assistant" },
    connection: null,
    session: null,
    grant: null,
  };
}

function connectedBankingStatus(
  grant: BankingAccessRequestStatusResponse["grant"] = null,
): BankingAccessRequestStatusResponse {
  return {
    agent: { id: CAPABILITY_AGENT_ID, name: "Finance Assistant" },
    connection: {
      id: BANK_CONNECTION_ID,
      status: "active",
      accounts: [
        {
          id: BANK_ACCOUNT_ID,
          name: "Operating account",
          institutionName: "Example Bank",
          type: "checking",
          last4: "4321",
          repairRequired: false,
        },
      ],
      repairInstitutions: [],
    },
    session: {
      id: BANK_SESSION_ID,
      mode: "connect",
      status: "completed",
      institutionLoginId: null,
    },
    grant,
  };
}

test("Connect banking, grant access, continue, and revoke it", async () => {
  const sends: CapturedChatSend[] = [];
  const purpose = "Review recent cash-flow activity";
  const continuation = "Continue the banking review";
  let status = emptyBankingStatus();
  const popup = mockOpenedWindow();
  const savedRequests: {
    readonly accountIds: string[];
    readonly agentId: string;
    readonly duration: "1h" | "24h" | "7d" | "30d";
    readonly purpose: string;
  }[] = [];
  let revokeCount = 0;
  installActionConversation({
    lines: [
      "Banking access is needed for this task.",
      bankingActionUrl({ reason: purpose, callbackPrompt: continuation }),
    ],
    sends,
  });
  context.mocks.api(bankingUserContract.accessRequestStatus, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(
    bankingUserContract.createConnectSession,
    ({ body, respond }) => {
      expect(body).toStrictEqual({
        agentId: CAPABILITY_AGENT_ID,
        mode: "connect",
      });
      status = {
        ...emptyBankingStatus(),
        session: {
          id: BANK_SESSION_ID,
          mode: "connect",
          status: "pending",
          institutionLoginId: null,
        },
      };
      return respond(200, {
        sessionId: BANK_SESSION_ID,
        url: "https://bank.example.test/connect",
      });
    },
  );
  context.mocks.api(bankingUserContract.saveAgentGrant, ({ body, respond }) => {
    savedRequests.push(body);
    status = connectedBankingStatus({
      status: "active",
      accountIds: [...body.accountIds],
      purpose: body.purpose,
      expiresAt: "2026-08-08T10:00:00.000Z",
    });
    return respond(200, status);
  });
  context.mocks.api(bankingUserContract.revokeAgentGrant, ({ respond }) => {
    revokeCount += 1;
    status = connectedBankingStatus(null);
    return respond(200, status);
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  const summary = await screen.findByTestId("banking-action-card");
  expect(within(summary).getByText(purpose)).toBeInTheDocument();
  click(getButton("View details", summary));
  const card = await screen.findByRole("dialog", {
    name: "Banking access request",
  });
  expect(within(card).getByText(purpose)).toBeInTheDocument();
  click(getButton("Connect a bank", card));

  expect(popup.calls).toStrictEqual([
    { url: "about:blank", target: "_blank", features: null },
  ]);
  await waitFor(() => {
    expect(popup.navigations).toContain("https://bank.example.test/connect");
  });
  const waitingNotice = await within(card).findByText(
    "Waiting for Mastercard Data Connect. Finish there, then return to Chat.",
  );
  expect(waitingNotice).toBeVisible();

  status = connectedBankingStatus();
  const account = await within(card).findByRole("checkbox", {
    name: /Operating account/u,
  });
  await userEvent.setup({ delay: null }).click(account);
  await waitFor(() => {
    expect(
      within(card).getByRole("checkbox", { name: /Operating account/u }),
    ).toBeChecked();
  });
  expect(
    within(card).getByRole("combobox", { name: "Access duration" }),
  ).toHaveTextContent("7 days");
  click(getButton("Grant access", card));

  const activeAccess = await within(card).findByText(
    "Access active for 1 account",
  );
  expect(activeAccess).toBeVisible();
  expect(savedRequests).toStrictEqual([
    {
      accountIds: [BANK_ACCOUNT_ID],
      agentId: CAPABILITY_AGENT_ID,
      duration: "7d",
      purpose,
    },
  ]);
  click(getButton("Continue", card));
  await waitFor(() => {
    expect(sentPrompts(sends)).toStrictEqual([continuation]);
  });

  click(getButton("Revoke", card));
  expect(
    within(card).getByText("Revoke this Agent's banking access?"),
  ).toBeVisible();
  click(getButton("Revoke", card));

  const accountSelection = await within(card).findByText("Select accounts");
  expect(accountSelection).toBeVisible();
  expect(revokeCount).toBe(1);
  expect(within(card).getByRole("checkbox")).not.toBeChecked();
  expect(getButton("Grant access", card)).toBeDisabled();
});

test("Connect and authorize a custom MCP connector", async () => {
  const sends: CapturedChatSend[] = [];
  const authorizationUpdates: AgentCustomConnectorGrant[][] = [];
  let connected = false;
  const connector = () => {
    return customConnector({
      slug: "_workspace-search",
      displayName: "Workspace Search",
      connected,
      kind: "mcp",
    });
  };
  installCustomConnectorApi({ connector, authorizationUpdates });
  context.mocks.api(customConnectorValuesContract.set, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      { key: "apiSecret", kind: "secret", value: "secret-value" },
    ]);
    connected = true;
    return respond(200, connector());
  });
  installActionConversation({
    lines: [
      connectorActionUrl({
        slug: "_workspace-search",
        callbackPrompt: "Resume workspace search",
      }),
    ],
    sends,
  });

  await setupPage({
    context,
    host: "app.okou.ai",
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: true },
  });

  await readyChat();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Connect", card));
  const secret = await screen.findByLabelText("API secret");
  await fill(secret, "secret-value");
  click(getButton("Save"));

  await waitFor(() => {
    expect(getButton("Authorized", card)).toBeDisabled();
  });
  expect(authorizationUpdates).toStrictEqual([
    [{ customConnectorId: CUSTOM_CONNECTOR_ID, permissionNames: [] }],
  ]);
  expect(screen.queryByText("Permissions")).not.toBeInTheDocument();
  expect(sentPrompts(sends)).toStrictEqual(["Resume workspace search"]);
});

test("Connect a single available connector without an unnecessary chooser", async () => {
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  const sends: CapturedChatSend[] = [];
  const slug = "drive-demo";
  const method = browserAuthMethod();
  let connected = false;
  const popup = mockOpenedWindow();
  const item = () => {
    return catalogConnector({
      slug,
      label: "Drive Demo",
      method,
      connected,
    });
  };
  installCatalogLookup((requestedSlug) => {
    return requestedSlug === slug ? item() : null;
  });
  context.mocks.data.connectors([]);
  context.mocks.api(connectorOauthStartContract.start, ({ respond }) => {
    return respond(200, {
      authorizationUrl: "https://provider.example.test/authorize-drive",
      oauthAttemptId,
      connectionId: CONNECTOR_CONNECTION_ID,
    });
  });
  context.mocks.api(userConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: [slug] });
  });
  installActionConversation({
    lines: [
      connectorActionUrl({
        slug,
        callbackPrompt: "Resume after Drive authorization",
      }),
    ],
    sends,
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Connect", card));
  await waitFor(() => {
    expect(popup.navigations).toContain(
      "https://provider.example.test/authorize-drive",
    );
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  connected = true;
  context.mocks.data.connectors([
    connectedConnectorResponse({ slug, authMethod: method.id }),
  ]);
  completedAttempts.set(oauthAttemptId, CONNECTOR_CONNECTION_ID);
  popup.openedWindow.close();
  await waitFor(() => {
    expect(sentPrompts(sends)).toStrictEqual([
      "Resume after Drive authorization",
    ]);
  });
});

test("Enable a single no-auth connector without an unnecessary dialog", async () => {
  const sends: CapturedChatSend[] = [];
  const slug = "public-data-demo";
  const method = noAuthMethod();
  let connected = false;
  const item = () => {
    return catalogConnector({
      slug,
      label: "Public Data Demo",
      method,
      connected,
    });
  };
  installCatalogLookup((requestedSlug) => {
    return requestedSlug === slug ? item() : null;
  });
  context.mocks.api(connectorNoAuthGrantContract.connect, ({ respond }) => {
    connected = true;
    return respond(
      200,
      connectedConnectorResponse({ slug, authMethod: method.id }),
    );
  });
  installActionConversation({
    lines: [
      connectorActionUrl({
        slug,
        callbackPrompt: "Resume with public data",
      }),
    ],
    sends,
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Connect", card));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => {
    expect(sentPrompts(sends)).toStrictEqual(["Resume with public data"]);
  });
});

test("Require an explicit permission selection for a custom connector", async () => {
  const sends: CapturedChatSend[] = [];
  let connected = false;
  const connector = () => {
    return customConnector({
      slug: "_permissioned-search",
      displayName: "Permissioned Search",
      connected,
      permissionBundleRef: "builtin:permissioned-search@1",
      kind: "http",
    });
  };
  installCustomConnectorApi({ connector });
  context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
    connected = true;
    return respond(200, connector());
  });
  installActionConversation({
    lines: [
      connectorActionUrl({
        slug: "_permissioned-search",
        callbackPrompt: "Resume permissioned search",
      }),
    ],
    sends,
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Connect", card));
  await fill(await screen.findByLabelText("API secret"), "permission-secret");
  click(getButton("Save"));
  const authorize = await waitFor(() => {
    return getButton("Authorize", card);
  });
  click(authorize);

  await waitFor(() => {
    expect(getButton("Authorize", card)).toBeEnabled();
  });
  expect(sends).toHaveLength(0);
});

test("Preserve an existing custom connector permission during reconnection", async () => {
  const sends: CapturedChatSend[] = [];
  let connected = false;
  const existingGrant = {
    customConnectorId: CUSTOM_CONNECTOR_ID,
    permissionNames: ["documents.read"],
  } satisfies AgentCustomConnectorGrant;
  const connector = () => {
    return customConnector({
      slug: "_permissioned-documents",
      displayName: "Permissioned Documents",
      connected,
      permissionBundleRef: "builtin:permissioned-documents@1",
      kind: "http",
    });
  };
  installCustomConnectorApi({ connector, grants: [existingGrant] });
  context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
    connected = true;
    return respond(200, connector());
  });
  installActionConversation({
    lines: [
      connectorActionUrl({
        slug: "_permissioned-documents",
        callbackPrompt: "Resume document lookup",
      }),
    ],
    sends,
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Connect", card));
  await fill(await screen.findByLabelText("API secret"), "replacement-secret");
  click(getButton("Save"));

  await waitFor(() => {
    expect(getButton("Authorized", card)).toBeDisabled();
  });
  expect(sentPrompts(sends)).toStrictEqual(["Resume document lookup"]);
});

test("Reconnect an expired connector before resuming the task", async () => {
  const sends: CapturedChatSend[] = [];
  const slug = "expired-drive";
  const method = browserAuthMethod();
  const originalConnection = connectedConnectorResponse({
    slug,
    authMethod: method.id,
    reconnectRequired: true,
    updatedAt: "2026-08-01T09:00:00.000Z",
  });
  let restored = false;
  let completionReads = 0;
  const oauthAttemptId = crypto.randomUUID();
  context.mocks.api(
    connectorAccountsContract.oauthCompletion,
    ({ params, respond }) => {
      expect(params.attemptId).toBe(oauthAttemptId);
      completionReads += 1;
      return restored
        ? respond(200, { connectionId: CONNECTOR_CONNECTION_ID })
        : respond(404, {
            error: { code: "NOT_FOUND", message: "OAuth completion not found" },
          });
    },
  );
  const popup = mockOpenedWindow();
  installCatalogLookup((requestedSlug) => {
    return requestedSlug === slug
      ? catalogConnector({
          slug,
          label: "Expired Drive",
          method,
          connected: true,
          reconnectRequired: !restored,
          connectionId: CONNECTOR_CONNECTION_ID,
          tokenExpiresAt: restored ? null : "2026-07-01T00:00:00.000Z",
        })
      : null;
  });
  context.mocks.api(connectorOauthStartContract.start, ({ respond }) => {
    return respond(200, {
      authorizationUrl: "https://provider.example.test/reconnect-drive",
      oauthAttemptId,
      connectionId: CONNECTOR_CONNECTION_ID,
    });
  });
  context.mocks.api(connectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [
        restored
          ? connectedConnectorResponse({
              slug,
              authMethod: method.id,
              updatedAt: "2026-08-01T10:00:00.000Z",
            })
          : originalConnection,
      ],
      connectorProvidedBindings: [],
    });
  });
  context.mocks.api(userConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: [slug] });
  });
  installActionConversation({
    lines: [
      "Your Drive authorization expired. Reconnect it before I continue the report.",
      connectorActionUrl({
        slug,
        callbackPrompt: "Continue the report after reconnection",
      }),
    ],
    sends,
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  expect(
    screen.getByText(
      "Your Drive authorization expired. Reconnect it before I continue the report.",
    ),
  ).toBeVisible();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Reconnect", card));
  await waitFor(() => {
    expect(popup.navigations).toContain(
      "https://provider.example.test/reconnect-drive",
    );
  });

  const callsBeforeEarlyReturn = completionReads;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: slug });
  await waitFor(() => {
    expect(completionReads).toBeGreaterThan(callsBeforeEarlyReturn);
    expect(sends).toHaveLength(0);
  });

  restored = true;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: slug });
  await waitFor(() => {
    expect(sentPrompts(sends)).toStrictEqual([
      "Continue the report after reconnection",
    ]);
  });
});

test("Share connector authorization across related action cards", async () => {
  const sends: CapturedChatSend[] = [];
  const slug = "shared-documents";
  const method = browserAuthMethod();
  installCatalogLookup((requestedSlug) => {
    return requestedSlug === slug
      ? catalogConnector({
          slug,
          label: "Shared Documents",
          method,
          connected: true,
        })
      : null;
  });
  installActionConversation({
    lines: [
      connectorActionUrl({ slug }),
      connectorActionUrl({
        slug,
        callbackPrompt: "Continue the shared document task",
      }),
      connectorActionUrl({ slug, action: "connect" }),
    ],
    sends,
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  const cards = await screen.findAllByTestId("connector-action-card");
  expect(cards).toHaveLength(3);
  const followupCard = cards[1]!;
  click(getButton("Authorize", followupCard));

  await waitFor(() => {
    for (const card of cards) {
      expect(getButton("Authorized", card)).toBeDisabled();
    }
  });
  expect(sentPrompts(sends)).toStrictEqual([
    "Continue the shared document task",
  ]);
});
