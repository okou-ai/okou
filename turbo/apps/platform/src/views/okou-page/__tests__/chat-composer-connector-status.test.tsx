import { catalogFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  ACME_CONNECTOR_ID,
  FEISHU_CONNECTOR_ID,
  builtinConnector,
  connectorAccount,
  httpConnector,
  installComposerConnectorFixture,
  manualAuthMethod,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  context,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

function savedAccounts(target: ConnectorAccountTarget, expired = false) {
  const defaultAccount = {
    ...connectorAccount({
      id: crypto.randomUUID(),
      target,
      displayName: "Work",
      isDefault: true,
    }),
    connectionStatus: expired
      ? ("reconnect-required" as const)
      : ("connected" as const),
    reconnectReason: expired
      ? ("authorization_expired_or_revoked" as const)
      : null,
  };
  return [
    defaultAccount,
    connectorAccount({
      id: crypto.randomUUID(),
      target,
      displayName: "Personal",
      isDefault: false,
    }),
  ];
}

function acme(connected = false) {
  return httpConnector({
    id: ACME_CONNECTOR_ID,
    slug: "_acme-search",
    displayName: "Acme Search",
    hasAccount: connected,
  });
}

async function openDirectory() {
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  await user.click(await findFastControl("button", "Connectors"));
  await user.click(await findFastControl("button", "Add connectors"));
  return screen.findByRole("dialog", { name: "Connectors" });
}

async function openCustom(dialog: HTMLElement) {
  click(await findFastControl("radio", "Custom", dialog));
}

test("Saved connectors with unavailable defaults stay visible for account repair", async () => {
  const builtinTarget = { kind: "builtin", connectorSlug: "github" } as const;
  const customTarget = {
    kind: "custom",
    customConnectorId: ACME_CONNECTOR_ID,
  } as const;
  const builtinAccounts = savedAccounts(builtinTarget, true);
  const customAccounts = savedAccounts(customTarget, true);
  const fixture = installComposerConnectorFixture({
    catalog: [
      catalogFixture({
        ...builtinConnector({ slug: "github", label: "GitHub" }),
      }),
    ],
    customConnectors: [acme()],
    accounts: [...builtinAccounts, ...customAccounts],
  });
  const dialog = await openDirectory();
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "github",
  );
  await expect(
    findFastControl("button", "Open GitHub details", dialog),
  ).resolves.toBeVisible();
  await fill(within(dialog).getByPlaceholderText("Find connectors..."), "");
  await openCustom(dialog);
  await expect(
    findFastControl("button", "Connect Acme Search", dialog),
  ).resolves.toBeVisible();
  expect(fixture.customValueRequests).toStrictEqual([]);
  expect(fixture.customAuthorizationUpdates).toStrictEqual([]);
  expect(fixture.manualConnectionRequests).toStrictEqual([]);
});

test("Healthy saved accounts stay connected while zero-account connectors remain available to add", async () => {
  const builtinTarget = { kind: "builtin", connectorSlug: "github" } as const;
  const customTarget = {
    kind: "custom",
    customConnectorId: ACME_CONNECTOR_ID,
  } as const;
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: "github", label: "GitHub" }),
      builtinConnector({ slug: "notion", label: "Notion", hasAccount: false }),
    ],
    customConnectors: [acme(true)],
    accounts: [...savedAccounts(builtinTarget), ...savedAccounts(customTarget)],
  });
  const dialog = await openDirectory();
  await within(dialog).findByText("Notion");
  expect(within(dialog).queryByText("GitHub")).toBeNull();
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "github",
  );
  await expect(
    findFastControl("button", "Open GitHub details", dialog),
  ).resolves.toHaveTextContent("Connected");
  await fill(within(dialog).getByPlaceholderText("Find connectors..."), "");
  await openCustom(dialog);
  await expect(
    findFastControl("button", "Connect Acme Search", dialog),
  ).resolves.toHaveTextContent("Connected");
  expect(within(dialog).queryByText("Needs attention")).toBeNull();
});

test("A saved custom connector remains available for account management", async () => {
  const target = {
    kind: "custom",
    customConnectorId: ACME_CONNECTOR_ID,
  } as const;
  installComposerConnectorFixture({
    customConnectors: [acme()],
    accounts: savedAccounts(target),
  });
  const dialog = await openDirectory();
  await openCustom(dialog);
  const card = await findFastControl("button", "Connect Acme Search", dialog);
  expect(card).toHaveTextContent("Connected");
});

test("Connecting a custom account updates the directory when it is reopened", async () => {
  installComposerConnectorFixture({ customConnectors: [acme()] });
  const directory = await openDirectory();
  await openCustom(directory);
  const card = await findFastControl(
    "button",
    "Connect Acme Search",
    directory,
  );
  expect(card).toHaveTextContent("No accounts");
  click(card);
  const connect = await screen.findByRole("dialog", {
    name: "Connect Acme Search",
  });
  await fill(within(connect).getByLabelText("Secret"), "replacement-secret");
  click(await findFastControl("button", "Save", connect));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  if (!queryFastControl("button", "Add connectors")) {
    click(await findFastControl("button", "Connectors"));
  }
  click(await findFastControl("button", "Add connectors"));
  const reopened = await screen.findByRole("dialog", { name: "Connectors" });
  await openCustom(reopened);
  await expect(
    findFastControl("button", "Connect Acme Search", reopened),
  ).resolves.toHaveTextContent("Connected");
  expect(within(reopened).queryByText("No accounts")).toBeNull();
});

test("Pending connected membership does not expose an ordinary add action as if no account exists", async () => {
  const gate = context.mocks.deferred<void>();
  installComposerConnectorFixture({
    customConnectors: [acme()],
    accounts: [],
  });
  context.mocks.api(connectedConnectorsContract.list, async ({ respond }) => {
    await gate.promise;
    return respond(200, { builtinConnectors: [], customConnectors: [] });
  });
  const dialog = await openDirectory();
  await openCustom(dialog);
  await within(dialog).findByText("Loading connectors…");
  expect(queryFastControl("button", "Connect Acme Search", dialog)).toBeNull();
  expect(within(dialog).queryByText("No accounts")).toBeNull();
  gate.resolve();
  await expect(
    findFastControl("button", "Connect Acme Search", dialog),
  ).resolves.toHaveTextContent("No accounts");
});

test("Connected inventory failure is retryable and leaves managed Feishu in its own lifecycle", async () => {
  const target = {
    kind: "custom",
    customConnectorId: ACME_CONNECTOR_ID,
  } as const;
  const accounts = savedAccounts(target);
  const fixture = installComposerConnectorFixture({
    customConnectors: [
      acme(),
      httpConnector({
        id: FEISHU_CONNECTOR_ID,
        slug: "_feishu",
        displayName: "Feishu",
        hasAccount: true,
        authMode: "oauth",
        providerAdapter: "feishu",
      }),
    ],
    accounts,
  });
  context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
    return respond(503, {
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Connected inventory unavailable",
      },
    });
  });
  const dialog = await openDirectory();
  await within(dialog).findByText(
    "Accounts are unavailable for this connector.",
  );
  await openCustom(dialog);
  await findFastControl("button", "Connect Feishu", dialog);
  expect(queryFastControl("button", "Connect Acme Search", dialog)).toBeNull();
  expect(within(dialog).queryByText("No accounts")).toBeNull();
  context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      builtinConnectors: [],
      customConnectors: [
        {
          id: ACME_CONNECTOR_ID,
          slug: "_acme-search",
          displayName: "Acme Search",
          permissionBundleRef: null,
          integrationManaged: false,
        },
      ],
    });
  });
  click(await findFastControl("button", "Try again", dialog));
  await findFastControl("button", "Connect Acme Search", dialog);
  expect(fixture.customAuthorizationUpdates).toStrictEqual([]);
});

test("Custom definition failure keeps an explicit retry instead of an empty directory", async () => {
  const connector = acme();
  installComposerConnectorFixture({ customConnectors: [connector] });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Definitions unavailable" },
    });
  });
  const dialog = await openDirectory();
  await openCustom(dialog);
  await within(dialog).findByText("Couldn't load custom connectors.");
  expect(queryFastControl("button", "Connect Acme Search", dialog)).toBeNull();
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  click(await findFastControl("button", "Try again", dialog));
  await findFastControl("button", "Connect Acme Search", dialog);
});

test("A saved builtin target with no default sends the user to account management without inventing an account", async () => {
  const target = { kind: "builtin", connectorSlug: "github" } as const;
  const accounts = savedAccounts(target).map((account) => {
    return { ...account, isDefault: false };
  });
  const fixture = installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: "github", label: "GitHub", hasAccount: false }),
    ],
    accounts,
  });
  const dialog = await openDirectory();
  await fill(
    within(dialog).getByPlaceholderText("Find connectors..."),
    "github",
  );
  click(await findFastControl("button", "Open GitHub details", dialog));
  const manage = await findFastControl(
    "link",
    "Manage GitHub accounts",
    dialog,
  );
  expect(manage).toHaveAttribute("href", "/connectors");
  expect(queryFastControl("button", "Connect", dialog)).toBeNull();
  expect(fixture.oauthConnectionRequests).toStrictEqual([]);
});

test("Saved builtin membership keeps account management available without account names", async () => {
  const fixture = installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: "github",
        label: "GitHub",
        authMethods: [manualAuthMethod()],
      }),
    ],
  });
  const directory = await openDirectory();
  await fill(
    within(directory).getByPlaceholderText("Find connectors..."),
    "github",
  );
  click(await findFastControl("button", "Open GitHub details", directory));
  const manage = await findFastControl("link", "Manage GitHub accounts");
  expect(manage).toHaveAttribute("href", "/connectors");
  expect(within(directory).getByText("Connected")).toBeInTheDocument();
  expect(within(directory).queryByText("Unnamed account")).toBeNull();
  expect(fixture.manualConnectionRequests).toStrictEqual([]);
});

test("Saved builtin targets remain manageable when definitions omit account projections", async () => {
  const builtinTarget = { kind: "builtin", connectorSlug: "github" } as const;
  const builtin = builtinConnector({ slug: "github", label: "GitHub" });
  installComposerConnectorFixture({
    catalog: [builtin],
    accounts: savedAccounts(builtinTarget),
  });
  const builtinDefinition = builtin;
  context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
    return respond(200, {
      connectors: [builtinDefinition],
      totalConnectorCount: 1,
    });
  });
  const directory = await openDirectory();
  await fill(
    within(directory).getByPlaceholderText("Find connectors..."),
    "github",
  );
  expect(within(directory).queryByText("Needs attention")).toBeNull();
  click(await findFastControl("button", "Open GitHub details", directory));
  await expect(
    findFastControl("link", "Manage GitHub accounts", directory),
  ).resolves.toBeInTheDocument();
});

test("A custom definition without account projections does not claim a reconnect is required", async () => {
  const target = {
    kind: "custom",
    customConnectorId: ACME_CONNECTOR_ID,
  } as const;
  const connector = acme(true);
  installComposerConnectorFixture({
    customConnectors: [connector],
    accounts: savedAccounts(target),
  });
  const definition = connector;
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [definition] });
  });
  const directory = await openDirectory();
  await openCustom(directory);
  await findFastControl("button", "Connect Acme Search", directory);
  expect(within(directory).queryByText("Needs attention")).toBeNull();
  expect(within(directory).queryByText("Reconnect required")).toBeNull();
});
