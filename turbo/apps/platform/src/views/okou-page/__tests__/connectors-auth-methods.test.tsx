import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import {
  builtinConnectorOauthStartContract,
  builtinConnectorOpenIdStartContract,
  builtinConnectorsMainContract,
  builtinConnectorAutomaticContract,
  builtinConnectorExternalCodeSessionContract,
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
  builtinConnectorOauthDeviceAuthSessionContract,
} from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";

import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  getConnectorCard,
  getConnectorIcon,
  getConnectorSwitch,
  listAgent,
  mockConnectors,
  mockOAuthCompletions,
  mockPublicConnectorStatus,
  publicStatusItem,
  mockConnectorAgentAccess,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function createAuthWindow(onNavigate?: (href: string) => void): Window {
  const authWindow = context.mocks.browser.authWindow();
  let href = "";
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: {
      get href() {
        return href;
      },
      set href(value: string) {
        href = value;
        onNavigate?.(value);
      },
    },
  });
  return authWindow;
}

function storeConnectedConnector(
  slug: ConnectorSlug,
  authMethod: string,
  externalUsername: string | null = null,
): BuiltinConnectorResponse {
  const connector = {
    id: crypto.randomUUID(),
    slug,
    authMethod,
    externalId: null,
    externalUsername,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } satisfies BuiltinConnectorResponse;
  context.mocks.data.connectors([connector]);
  context.mocks.ably.trigger("connector:changed", { connectorSlug: slug });
  return connector;
}

function mockConnectedCatalogTarget(
  connector: ReturnType<typeof publicStatusItem>,
  hasSavedAccount: () => boolean,
) {
  context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      builtinConnectors: hasSavedAccount()
        ? [
            {
              slug: connector.slug,
              label: connector.label,
              icon: connector.icon,
              hasPermissions: connector.permissionSummary.hasPermissions,
            },
          ]
        : [],
      customConnectors: [],
    });
  });
}

function mockAgentConnectorAccess(connectorSlug: ConnectorSlug): void {
  const authorizedAgentIds = new Set<string>();
  context.mocks.api(
    userBuiltinConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: authorizedAgentIds.has(params.id)
          ? [connectorSlug]
          : [],
      });
    },
  );
  mockConnectorAgentAccess(context, (agentId) => {
    return {
      enabledConnectorSlugs: authorizedAgentIds.has(agentId)
        ? [connectorSlug]
        : [],
    };
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ params, body, respond }) => {
      if (body.enabledConnectorSlugs.includes(connectorSlug)) {
        if (body.operation === "add") {
          authorizedAgentIds.add(params.id);
        } else {
          authorizedAgentIds.delete(params.id);
        }
      }
      context.mocks.ably.trigger("composerAgentConnectorsChanged", {
        agentId: params.id,
      });
      return respond(200, {
        enabledConnectorSlugs: authorizedAgentIds.has(params.id)
          ? [connectorSlug]
          : [],
      });
    },
  );
}

function oauthMethod(label = "OAuth") {
  return {
    id: "oauth",
    label,
    description: null,
    grantKind: "auth-code" as const,
    supportsRefresh: true,
    manualFields: [],
    startOptions: [],
  };
}

test.each(["none", "oauth"] as const)(
  "Connect a builtin Automatic method resolving to %s",
  async (resolution) => {
    const slug = "server-authored-tools";
    const methodId = "smart-connect";
    const authorizationUrl = "https://oauth.test/tools/authorize";
    const oauthAttemptId = crypto.randomUUID();
    mockConnectors(context, []);
    context.mocks.data.agents([
      listAgent("c0000000-0000-4000-a000-000000000001", "Default"),
    ]);
    mockAgentConnectorAccess(slug);
    const catalogItem = publicStatusItem({
      connectorSlug: slug,
      label: "Partner Tools",
      authMethods: [
        {
          id: methodId,
          label: "Connect",
          description: null,
          grantKind: "automatic",
          supportsRefresh: true,
          manualFields: [],
          startOptions: [],
        },
      ],
    });
    mockPublicConnectorStatus(context, [catalogItem]);
    let savedAccount: BuiltinConnectorResponse | undefined;
    mockConnectedCatalogTarget(catalogItem, () => {
      return savedAccount !== undefined;
    });
    const completedAttempts = mockOAuthCompletions(context);
    if (resolution !== "oauth") {
      context.mocks.api(connectorAccountsContract.oauthCompletion, () => {
        throw new Error("No-auth completion must not request an OAuth receipt");
      });
    }
    const authWindow = createAuthWindow((href) => {
      if (href !== authorizationUrl) {
        return;
      }
      savedAccount = storeConnectedConnector(slug, methodId);
      completedAttempts.set(oauthAttemptId, savedAccount.id);
      context.mocks.ably.trigger("connector:changed", { connectorSlug: slug });
    });
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      builtinConnectorAutomaticContract.start,
      ({ body, respond }) => {
        expect(body).toMatchObject({
          authMethod: methodId,
          account: { intent: "add" },
        });
        if (resolution !== "oauth") {
          savedAccount = storeConnectedConnector(slug, methodId);
          return respond(200, {
            result: "connected",
            connectionId: savedAccount.id,
          });
        }
        return respond(200, {
          result: "authorization",
          authorizationUrl,
          oauthAttemptId,
        });
      },
    );
    await setupPage({ context, path: "/connectors?keywords=partner+tools" });
    await expect(
      screen.findByText("Partner Tools"),
    ).resolves.toBeInTheDocument();
    click(getConnectorAction("button", "Connect Partner Tools"));
    const naming = await screen.findByRole("dialog", {
      name: "Name your Partner Tools account",
    });
    expect(authWindow).toMatchObject(
      resolution !== "oauth"
        ? { closed: true }
        : { location: { href: authorizationUrl } },
    );
    click(getConnectorAction("button", "Skip", naming));
    await waitFor(() => {
      expect(
        getConnectorAction("button", "Manage Partner Tools access"),
      ).toHaveTextContent("Used by Default");
    });
  },
);

function noAuthMethod() {
  return {
    id: "api",
    label: "Public catalog",
    description: "Enable public catalog data.",
    grantKind: "none" as const,
    supportsRefresh: true,
    manualFields: [],
    startOptions: [],
  };
}

function manualMethod(args: {
  readonly id: string;
  readonly label: string;
  readonly fieldId: string;
  readonly fieldLabel: string;
  readonly placeholder: string;
}) {
  return {
    id: args.id,
    label: args.label,
    description: null,
    grantKind: "manual" as const,
    supportsRefresh: true,
    manualFields: [
      {
        id: args.fieldId,
        label: args.fieldLabel,
        required: true,
        placeholder: args.placeholder,
        inputType: "password" as const,
      },
    ],
    startOptions: [],
  };
}

test("Show Mercury disclosures before connecting an account", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "mercury",
      label: "Mercury",
      authMethods: [
        oauthMethod(),
        manualMethod({
          id: "api-token",
          label: "API token",
          fieldId: "token",
          fieldLabel: "API token",
          placeholder: "Enter your Mercury API token",
        }),
      ],
    }),
  ]);
  await setupPage({
    context,
    path: "/connectors?keywords=mercury",
  });

  const card = await waitFor(() => {
    return getConnectorCard("Mercury");
  });
  expect(
    getConnectorAction("link", "Powered by Mercury", card),
  ).toHaveAttribute("href", "https://mercury.com");
  expect(card).toHaveTextContent(
    "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
  );

  click(getConnectorAction("button", "Connect Mercury", card));
  const dialog = await screen.findByRole("dialog", { name: "Mercury" });
  expect(
    getConnectorAction("link", "Powered by Mercury", dialog),
  ).toHaveAttribute("href", "https://mercury.com");
  expect(dialog).toHaveTextContent(
    "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
  );
});

test("Add an AWS account through external-code authorization", async () => {
  mockConnectors(context, []);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000002", "Research Agent"),
  ]);
  mockAgentConnectorAccess("aws");
  const authWindow = createAuthWindow();
  const browserOpen = context.mocks.browser.open(authWindow);
  context.mocks.api(
    builtinConnectorExternalCodeSessionContract.complete,
    ({ respond }) => {
      const connector = storeConnectedConnector("aws", "cli");
      return respond(200, {
        status: "complete",
        connectionId: connector.id,
      });
    },
  );
  context.mocks.api(
    builtinConnectorExternalCodeSessionContract.create,
    ({ body, params, respond }) => {
      expect(params.connectorSlug).toBe("aws");
      expect(body.account).toStrictEqual({ intent: "add" });
      return respond(200, {
        sessionId: "00000000-0000-4000-8000-000000000002",
        sessionToken: "mock-aws-external-code-session-token",
        connectorSlug: "aws",
        status: "pending",
        authorizationUrl: "https://oauth.test/aws/external-code",
        expiresIn: 600,
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors?keywords=aws",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect AWS");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "AWS" });
  expect(dialog).toHaveTextContent(
    /temporary AWS connector expires after up to 12 hours/u,
  );

  click(getConnectorAction("button", "Start AWS sign-in", dialog));
  await expect(
    waitFor(() => {
      return getConnectorAction("button", "Open AWS sign-in", dialog);
    }),
  ).resolves.toBeInTheDocument();
  click(getConnectorAction("button", "Open AWS sign-in", dialog));
  expect(
    browserOpen.calls.some((call) => {
      return call.url === "https://oauth.test/aws/external-code";
    }),
  ).toBeTruthy();
  await fill(
    within(dialog).getByTestId("connector-external-code-input"),
    "AWS-CODE",
  );
  click(within(dialog).getByTestId("connector-external-code-complete"));

  const naming = await screen.findByRole("dialog", {
    name: "Name your AWS account",
  });
  click(getConnectorAction("button", "Skip", naming));

  const awsCard = getConnectorCard("AWS");
  await expect(
    within(awsCard).findByText("Connected"),
  ).resolves.toBeInTheDocument();
  expect(
    getConnectorAction("button", "Manage AWS access", awsCard),
  ).toHaveTextContent("Used by Research Agent");
});

test("Add an account through OpenID", async () => {
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  const slug = "server-authored-steam";
  mockConnectors(context, []);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000001", "Default"),
    listAgent("c0000000-0000-4000-a000-000000000002", "Research"),
  ]);
  mockAgentConnectorAccess(slug);
  const catalogItem = publicStatusItem({
    connectorSlug: slug,
    label: "Partner Steam",
    icon: {
      url: "https://icons.example.test/partner-steam.svg",
      invertInDarkMode: false,
    },
    authMethods: [
      {
        id: "partner-openid",
        label: "Partner OpenID",
        description: null,
        grantKind: "openid-auth",
        supportsRefresh: true,
        manualFields: [],
        startOptions: [],
      },
    ],
  });
  mockPublicConnectorStatus(context, [catalogItem]);
  let savedAccount: BuiltinConnectorResponse | undefined;
  mockConnectedCatalogTarget(catalogItem, () => {
    return savedAccount !== undefined;
  });
  const authorizationUrl = "https://openid.test/partner-steam/authorize";
  const authWindow = createAuthWindow((href) => {
    if (href !== authorizationUrl) {
      return;
    }
    savedAccount = storeConnectedConnector(slug, "partner-openid");
    completedAttempts.set(oauthAttemptId, savedAccount.id);
    context.mocks.ably.trigger("connector:changed", { connectorSlug: slug });
  });
  context.mocks.browser.open(authWindow);
  context.mocks.api(
    builtinConnectorOpenIdStartContract.start,
    ({ body, respond }) => {
      expect(body).toMatchObject({
        account: { intent: "add" },
        authMethod: "partner-openid",
      });
      return respond(200, {
        authorizationUrl,
        oauthAttemptId,
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors?keywords=partner+steam",
  });

  await expect(screen.findByText("Partner Steam")).resolves.toBeInTheDocument();
  expect(getConnectorIcon("Partner Steam")).toHaveAttribute(
    "src",
    "https://icons.example.test/partner-steam.svg",
  );
  click(getConnectorAction("button", "Connect Partner Steam"));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(authorizationUrl);
  });
  const naming = await screen.findByRole("dialog", {
    name: "Name your Partner Steam account",
  });
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Manage Partner Steam access"),
    ).toHaveTextContent("Used by 2 agents");
  });
});

test("Choose a credential-free method", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      authMethods: [oauthMethod("Public OAuth"), noAuthMethod()],
    }),
  ]);
  let selectedMethod: string | null = null;
  context.mocks.api(
    builtinConnectorNoAuthGrantContract.connect,
    ({ body, respond }) => {
      selectedMethod = body.authMethod;
      const connector = storeConnectedConnector("stripe", body.authMethod);
      return respond(200, { connectionId: connector.id });
    },
  );
  await setupPage({
    context,
    path: "/connectors?keywords=public+stripe",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Stripe");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Public Stripe" });
  expect(within(dialog).getByText("Public OAuth")).toBeInTheDocument();
  expect(within(dialog).getByText("Public catalog")).toBeInTheDocument();
  expect(
    within(dialog).getByText("Enable public catalog data."),
  ).toBeInTheDocument();

  click(getConnectorAction("button", "Enable Public Stripe", dialog));

  await waitFor(() => {
    expect(selectedMethod).toBe("api");
    expect(
      within(getConnectorCard("Public Stripe")).getByText("Connected"),
    ).toBeInTheDocument();
  });
});

test("Authorize visible agents only for the first manual account", async () => {
  const researchId = "c0000000-0000-4000-a000-000000000002";
  mockConnectors(context, []);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000001", "Nova"),
    listAgent(researchId, "Research Agent"),
  ]);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "axiom",
      label: "Public Axiom",
      authMethods: [
        manualMethod({
          id: "api-token",
          label: "Public API Token",
          fieldId: "apiToken",
          fieldLabel: "Public API token",
          placeholder: "public-xaat",
        }),
      ],
    }),
  ]);
  let connectedAccount: BuiltinConnectorResponse | undefined;
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ body, respond }) => {
      expect(body.authorizeAgent ?? false).toBe(!connectedAccount);
      connectedAccount = storeConnectedConnector("axiom", body.authMethod);
      return respond(200, { connectionId: connectedAccount.id });
    },
  );
  mockAgentConnectorAccess("axiom");
  await setupPage({
    context,
    path: "/connectors?keywords=axiom",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Axiom");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Public Axiom" });
  await fill(within(dialog).getByPlaceholderText("public-xaat"), "xaat-test");

  click(getConnectorAction("button", "Save", dialog));

  await expect(
    screen.findByText("Public Axiom connected successfully"),
  ).resolves.toBeInTheDocument();
  const naming = await screen.findByRole("dialog", {
    name: "Name your Public Axiom account",
  });
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(
      within(getConnectorCard("Public Axiom")).getByText("Connected"),
    ).toBeInTheDocument();
    expect(
      getConnectorAction(
        "button",
        "Manage Public Axiom access",
        getConnectorCard("Public Axiom"),
      ),
    ).toHaveTextContent("Used by 2 agents");
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  click(getConnectorAction("button", "Manage Public Axiom access"));
  const access = await screen.findByRole("dialog", {
    name: "Manage Public Axiom access",
  });
  click(getConnectorSwitch("Revoke Public Axiom access for Nova", access));
  await waitFor(() => {
    expect(
      getConnectorSwitch("Authorize Public Axiom access for Nova", access),
    ).not.toBeChecked();
  });
  click(getConnectorAction("button", "Close", access));
  click(getConnectorAction("button", "Manage Public Axiom accounts"));
  const manager = await screen.findByRole("dialog", {
    name: "Manage Public Axiom accounts",
  });
  click(getConnectorAction("button", "Add account", manager));
  const addition = await screen.findByRole("dialog", {
    name: "Public Axiom",
  });
  await fill(
    within(addition).getByPlaceholderText("public-xaat"),
    "second-token",
  );
  click(getConnectorAction("button", "Save", addition));
  const secondNaming = await screen.findByRole("dialog", {
    name: "Name your Public Axiom account",
  });
  click(getConnectorAction("button", "Skip", secondNaming));
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Manage Public Axiom access"),
    ).toHaveTextContent("Used by Research Agent");
  });
  click(getConnectorAction("button", "Manage Public Axiom access"));
  const updatedAccess = await screen.findByRole("dialog", {
    name: "Manage Public Axiom access",
  });
  expect(
    getConnectorSwitch("Authorize Public Axiom access for Nova", updatedAccess),
  ).not.toBeChecked();
  expect(
    getConnectorSwitch(
      "Revoke Public Axiom access for Research Agent",
      updatedAccess,
    ),
  ).toBeChecked();
});

test("Connect through device authorization", async () => {
  const approval = context.mocks.deferred<void>();
  mockConnectors(context, []);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000001", "Default"),
    listAgent("c0000000-0000-4000-a000-000000000002", "Research"),
  ]);
  mockAgentConnectorAccess("base44");
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "base44",
      label: "Base44",
      authMethods: [
        {
          id: "oauth",
          label: "OAuth",
          description: "Sign in with Base44 to grant access.",
          grantKind: "device-auth",
          supportsRefresh: true,
          manualFields: [],
          startOptions: [],
        },
      ],
    }),
  ]);
  const browserOpen = context.mocks.browser.open(createAuthWindow());
  context.mocks.api(
    builtinConnectorOauthDeviceAuthSessionContract.poll,
    async ({ respond }) => {
      await approval.promise;
      const connector = storeConnectedConnector(
        "base44",
        "oauth",
        "mock-base44",
      );
      return respond(200, {
        status: "complete",
        connectionId: connector.id,
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Base44");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Base44" });

  click(getConnectorAction("button", "Connect Base44", dialog));

  await expect(
    screen.findByTestId("connector-oauth-device-code"),
  ).resolves.toHaveTextContent("OKOU-DEVICE");
  const approvalDialog = await screen.findByRole("dialog", {
    name: "Base44",
  });
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  click(within(approvalDialog).getByTestId("connector-oauth-device-open"));
  expect(
    browserOpen.calls.some((call) => {
      return call.url?.includes("oauth.test/base44/device") ?? false;
    }),
  ).toBeTruthy();
  approval.resolve();
  const naming = await screen.findByRole("dialog", {
    name: "Name your Base44 account",
  });
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(
      within(getConnectorCard("Base44")).getByText("Connected"),
    ).toBeInTheDocument();
    expect(
      getConnectorAction("button", "Manage Base44 access"),
    ).toHaveTextContent("Used by 2 agents");
  });
});

test.each([
  ["device-auth", "configuration_invalid"],
  ["external-code", "configuration_invalid"],
] as const)(
  "Reject %s completion when account setup is %s",
  async (grantKind, reconnectReason) => {
    const slug = grantKind === "device-auth" ? "base44" : "aws";
    const label = grantKind === "device-auth" ? "Base44" : "AWS";
    let saved: BuiltinConnectorResponse | null = null;
    mockConnectors(context, []);
    context.mocks.data.agents([
      listAgent("c0000000-0000-4000-a000-000000000002", "Research"),
    ]);
    mockAgentConnectorAccess(slug);
    context.mocks.browser.open(createAuthWindow());
    mockPublicConnectorStatus(context, [
      publicStatusItem({
        connectorSlug: slug,
        label,
        authMethods: [
          {
            supportsRefresh: true,
            id: "oauth",
            label: "OAuth",
            description: null,
            grantKind,
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    context.mocks.api(
      connectorAccountsContract.connection,
      ({ params, query, respond }) => {
        if (
          !saved ||
          params.connectionId !== saved.id ||
          query.kind !== "builtin" ||
          query.connectorSlug !== slug
        ) {
          return respond(404, {
            error: { code: "NOT_FOUND", message: "Account not found" },
          });
        }
        const { slug: connectorSlug, ...account } = saved;
        return respond(200, {
          ...account,
          target: { kind: "builtin", connectorSlug },
          isDefault: true,
          displayName: null,
          connectionStatus: "reconnect-required",
          reconnectReason,
          missingRequiredFields: [],
          configuredFieldKeys: [],
        });
      },
    );
    if (grantKind === "device-auth") {
      context.mocks.api(
        builtinConnectorOauthDeviceAuthSessionContract.poll,
        ({ respond }) => {
          saved = storeConnectedConnector(slug, "oauth");
          return respond(200, { status: "complete", connectionId: saved.id });
        },
      );
    } else {
      context.mocks.api(
        builtinConnectorExternalCodeSessionContract.complete,
        ({ respond }) => {
          saved = storeConnectedConnector(slug, "oauth");
          return respond(200, { status: "complete", connectionId: saved.id });
        },
      );
    }
    await setupPage({ context, path: `/connectors?keywords=${slug}` });
    click(
      await waitFor(() => {
        return getConnectorAction("button", `Connect ${label}`);
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: label });
    click(
      getConnectorAction(
        "button",
        grantKind === "device-auth"
          ? `Connect ${label}`
          : `Start ${label} sign-in`,
        dialog,
      ),
    );
    if (grantKind === "external-code") {
      await fill(
        await within(dialog).findByTestId("connector-external-code-input"),
        "AWS-CODE",
      );
      click(within(dialog).getByTestId("connector-external-code-complete"));
    }
    await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
      "This account needs additional setup. Review its connector settings and try again.",
    );
    expect(
      screen.queryByRole("dialog", { name: `Name your ${label} account` }),
    ).not.toBeInTheDocument();
    click(within(dialog).getByLabelText("Close"));
    click(
      await waitFor(() => {
        return getConnectorAction("button", `Manage ${label} access`);
      }),
    );
    const access = await screen.findByRole("dialog", {
      name: `Manage ${label} access`,
    });
    expect(
      getConnectorSwitch(`Authorize ${label} access for Research`, access),
    ).not.toBeChecked();
  },
);

test("Enable a connector that needs no credentials", async () => {
  const researchId = "c0000000-0000-4000-a000-000000000002";
  mockConnectors(context, []);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000001", "Nova"),
    listAgent(researchId, "Research Agent"),
  ]);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      authMethods: [noAuthMethod()],
    }),
  ]);
  const browserOpen = context.mocks.browser.open(createAuthWindow());
  context.mocks.api(
    builtinConnectorNoAuthGrantContract.connect,
    ({ body, respond }) => {
      expect(body.authorizeAgent).toBeTruthy();
      return respond(200, {
        connectionId: storeConnectedConnector("stripe", body.authMethod).id,
      });
    },
  );
  mockAgentConnectorAccess("stripe");
  await setupPage({
    context,
    path: "/connectors",
  });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Stripe");
    }),
  );

  await expect(
    screen.findByText("Public Stripe enabled successfully"),
  ).resolves.toBeInTheDocument();
  const naming = await screen.findByRole("dialog", {
    name: "Name your Public Stripe account",
  });
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(
      within(getConnectorCard("Public Stripe")).getByText("Connected"),
    ).toBeInTheDocument();
    expect(
      getConnectorAction(
        "button",
        "Manage Public Stripe access",
        getConnectorCard("Public Stripe"),
      ),
    ).toHaveTextContent("Used by 2 agents");
  });
  expect(browserOpen.calls).toHaveLength(0);
});

test("Follow provider-authored external-code instructions", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "playstation",
      label: "PlayStation",
      authMethods: [
        {
          id: "api",
          label: "PlayStation sign-in",
          description:
            "First make sure you are signed in to PlayStation at [https://www.playstation.com/](https://www.playstation.com/).\nClick the button below, then copy the `npsso` value.",
          grantKind: "external-code",
          supportsRefresh: true,
          manualFields: [],
          startOptions: [],
        },
      ],
    }),
  ]);
  context.mocks.browser.open(createAuthWindow());
  await setupPage({ context, path: "/connectors?keywords=playstation" });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect PlayStation");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "PlayStation" });

  click(getConnectorAction("button", "Start PlayStation sign-in", dialog));

  await expect(
    waitFor(() => {
      return getConnectorAction("button", "Open PlayStation sign-in", dialog);
    }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      queryAllByRoleFast("link", dialog).map((link) => {
        return link.textContent;
      }),
    ).toStrictEqual(["https://www.playstation.com/"]);
  });
  expect(
    getConnectorAction("button", "Open PlayStation sign-in", dialog),
  ).toBeInTheDocument();
  expect(within(dialog).getByPlaceholderText("Code")).toBeInTheDocument();
});

test("Complete OAuth only after the current attempt succeeds", async () => {
  const completedAttempts = mockOAuthCompletions(context);
  let oauthAttemptId = crypto.randomUUID();
  const researchId = "c0000000-0000-4000-a000-000000000002";
  let listed = mockConnectors(context, []);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000001", "Nova"),
    listAgent(researchId, "Research Agent"),
  ]);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      authMethods: [
        {
          ...oauthMethod("Public OAuth"),
          description: "Public OAuth description",
        },
        {
          id: "cli",
          label: "Public CLI",
          description: "Public CLI description",
          grantKind: "device-auth",
          supportsRefresh: true,
          manualFields: [],
          startOptions: [],
        },
      ],
    }),
  ]);
  let authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  context.mocks.api(builtinConnectorOauthStartContract.start, ({ respond }) => {
    oauthAttemptId = crypto.randomUUID();
    return respond(200, {
      oauthAttemptId,
      authorizationUrl: "https://oauth.test/stripe/authorize",
    });
  });
  mockAgentConnectorAccess("stripe");
  context.mocks.api(builtinConnectorsMainContract.list, ({ respond }) => {
    return respond(200, { connectors: listed });
  });
  await setupPage({
    context,
    path: "/connectors?keywords=public+stripe",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Stripe");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Public Stripe" });
  click(getConnectorAction("button", "Connect", dialog));
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/stripe/authorize",
    );
  });

  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "stripe",
  });
  authWindow.close();

  await waitFor(() => {
    expect(getConnectorAction("button", "Connect", dialog)).toBeEnabled();
  });
  await waitFor(() => {
    const stripeCard = getConnectorCard("Public Stripe");
    expect(
      within(stripeCard).getByLabelText("Connect Public Stripe"),
    ).toBeInTheDocument();
    expect(within(stripeCard).queryByText("Connected")).toBeNull();
    expect(within(stripeCard).queryByText("Research Agent")).toBeNull();
  });

  authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  click(getConnectorAction("button", "Connect", dialog));
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/stripe/authorize",
    );
  });
  listed = mockConnectors(context, [
    { connectorSlug: "stripe", authMethod: "oauth" },
  ]);
  const connected = listed[0];
  if (!connected) {
    throw new Error("Expected completed Stripe account");
  }
  completedAttempts.set(oauthAttemptId, connected.id);
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "stripe" });

  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Public Stripe" })).toBeNull();
    expect(
      within(getConnectorCard("Public Stripe")).getByText("Connected"),
    ).toBeInTheDocument();
  });
  const naming = await screen.findByRole("dialog", {
    name: "Name your Public Stripe account",
  });
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(
      getConnectorAction(
        "button",
        "Manage Public Stripe access",
        getConnectorCard("Public Stripe"),
      ),
    ).toHaveTextContent("Used by 2 agents");
  });
});

async function addManualAccountForNaming() {
  mockConnectors(context, []);
  const connectionId = crypto.randomUUID();
  let renamed: { readonly id: string; readonly name: string | null } | null =
    null;
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ body, respond }) => {
      const connector = {
        ...storeConnectedConnector("ahrefs", body.authMethod),
        id: connectionId,
        externalEmail: "owner@example.com",
      };
      context.mocks.data.connectors([connector]);
      return respond(200, { connectionId: connector.id });
    },
  );
  context.mocks.api(
    connectorAccountsContract.rename,
    ({ params, body, respond }) => {
      renamed = { id: params.connectionId, name: body.displayName };
      return respond(200, {
        missingRequiredFields: [],
        configuredFieldKeys: [],
        id: connectionId,
        target: { kind: "builtin", connectorSlug: "ahrefs" },
        authMethod: "api-token",
        displayName: body.displayName,
        isDefault: true,
        externalId: null,
        externalUsername: null,
        externalEmail: "owner@example.com",
        oauthScopes: [],
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors?keywords=ahrefs",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Ahrefs");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Ahrefs" });
  await fill(
    within(dialog).getByPlaceholderText("your-ahrefs-api-token"),
    "secret-token",
  );
  click(getConnectorAction("button", "Save", dialog));
  const naming = await screen.findByRole("dialog", {
    name: "Name your Ahrefs account",
  });
  const input = within(naming).getByLabelText("Account name");
  return {
    input,
    naming,
    connectionId,
    getRenamed: () => {
      return renamed;
    },
  };
}

test("Save a name for the exact newly added manual account", async () => {
  const { input, naming, connectionId, getRenamed } =
    await addManualAccountForNaming();
  await fill(input, "Work");
  click(getConnectorAction("button", "Save", naming));

  await waitFor(() => {
    expect(getRenamed()).toStrictEqual({ id: connectionId, name: "Work" });
  });
});

test("Submit a chosen device-authorization start option", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Stripe",
      authMethods: [
        {
          id: "cli",
          label: "Stripe CLI",
          description: "Approve access with Stripe CLI.",
          grantKind: "device-auth",
          supportsRefresh: true,
          manualFields: [],
          startOptions: [
            {
              id: "mode",
              kind: "select",
              label: "Mode",
              required: true,
              defaultValue: null,
              options: [
                { value: "test", label: "Test" },
                { value: "live", label: "Live" },
              ],
            },
          ],
        },
      ],
    }),
  ]);
  context.mocks.browser.open(createAuthWindow());
  const startOptions: Record<string, string>[] = [];
  context.mocks.api(
    builtinConnectorOauthDeviceAuthSessionContract.create,
    ({ body, params, respond }) => {
      startOptions.push(body.options ?? {});
      return respond(200, {
        sessionId: crypto.randomUUID(),
        sessionToken: "stripe-device-token",
        connectorSlug: params.connectorSlug,
        status: "pending",
        userCode: "STRIPE-DEVICE",
        verificationUri: "https://oauth.test/stripe/device",
        verificationUriComplete:
          "https://oauth.test/stripe/device?user_code=STRIPE-DEVICE",
        expiresIn: 300,
        interval: 1,
      });
    },
  );
  context.mocks.http.post(
    "*/api/connectors/stripe/oauth/device/sessions/:sessionId/poll",
    () => {
      return HttpResponse.json(
        {
          error: {
            message: "Stripe device authorization is unavailable",
            code: "UNAVAILABLE",
          },
        },
        { status: 500 },
      );
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Stripe");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Stripe" });
  const mode = within(dialog).getByRole("combobox", { name: "Mode" });
  expect(mode).toHaveTextContent("Select Mode");
  expect(getConnectorAction("button", "Connect Stripe", dialog)).toBeDisabled();
  click(mode);
  click(await screen.findByRole("option", { name: "Live" }));
  expect(mode).toHaveTextContent("Live");
  expect(getConnectorAction("button", "Connect Stripe", dialog)).toBeEnabled();
  click(getConnectorAction("button", "Connect Stripe", dialog));

  await expect(
    screen.findByText("Stripe device authorization is unavailable"),
  ).resolves.toBeInTheDocument();
  expect(startOptions[0]).toStrictEqual({ mode: "live" });
});

test("Start provider sign-in from catalog metadata", async () => {
  const slug = "notion";
  const label = "Notion";
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: slug,
      label,
      authMethods: [oauthMethod()],
      singleAuthCodeAuthMethodId: "oauth",
    }),
  ]);
  const authWindow = createAuthWindow();
  const browserOpen = context.mocks.browser.open(authWindow);
  const starts: {
    readonly slug: string;
    readonly callbackTarget: string | undefined;
  }[] = [];
  mockOAuthCompletions(context);
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, params, respond }) => {
      starts.push({
        slug: params.connectorSlug,
        callbackTarget: body.callbackTarget,
      });
      authWindow.close();
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.connectorSlug}/authorize`,
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  await setupPage({ context, path: "/connectors" });
  const connect = await waitFor(() => {
    return getConnectorAction("button", `Connect ${label}`);
  });
  await waitFor(() => {
    expect(connect).toBeEnabled();
  });
  click(connect);
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      `https://oauth.test/${slug}/authorize`,
    );
  });
  expect(screen.queryByRole("dialog", { name: label })).toBeNull();

  expect(starts).toStrictEqual([{ slug, callbackTarget: "app" }]);
  expect(browserOpen.calls).toHaveLength(1);
});

test("Submit credentials only for the chosen manual method", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "axiom",
      label: "Public Axiom",
      authMethods: [
        manualMethod({
          id: "api-token",
          label: "Public API Token",
          fieldId: "apiToken",
          fieldLabel: "Public API token",
          placeholder: "public-xaat",
        }),
        manualMethod({
          id: "api",
          label: "Public API Key",
          fieldId: "apiKey",
          fieldLabel: "Public API key",
          placeholder: "public-api-key",
        }),
      ],
    }),
  ]);
  let submittedMethod: string | null = null;
  let submittedValues: Record<string, string> | null = null;
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ body, respond }) => {
      submittedMethod = body.authMethod;
      submittedValues = body.values;
      return respond(200, {
        connectionId: storeConnectedConnector("axiom", body.authMethod).id,
      });
    },
  );
  await setupPage({
    context,
    path: "/connectors",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Public Axiom");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Public Axiom" });
  await fill(within(dialog).getByPlaceholderText("public-xaat"), "xaat-test");
  await fill(
    within(dialog).getByPlaceholderText("public-api-key"),
    "api-key-test",
  );
  const saveButtons = queryAllByRoleFast("button", dialog).filter((button) => {
    return button.textContent?.trim() === "Save";
  });
  const secondSave = saveButtons[1];
  if (!secondSave) {
    throw new Error("Expected second Save action");
  }

  click(secondSave);

  await waitFor(() => {
    expect(submittedMethod).toBe("api");
    expect(submittedValues).toStrictEqual({ apiKey: "api-key-test" });
    expect(
      within(getConnectorCard("Public Axiom")).getByText("Connected"),
    ).toBeInTheDocument();
  });
});
