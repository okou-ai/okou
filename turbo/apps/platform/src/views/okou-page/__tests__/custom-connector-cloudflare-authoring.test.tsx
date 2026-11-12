import {
  cloudflareAccessContract,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  customConnectorByIdContract,
  customConnectorsContract,
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chooseConnectorAuthentication,
  customConnector,
  mcpCustomConnector,
  getConnectorAction,
  getConnectorCard,
  mockCustomConnectorStory,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const gateway = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Corporate gateway",
  scope: "organization",
  revision: 1,
  generation: 1,
  sshHosts: [],
  vncHosts: [],
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
} as const satisfies ScopedCloudflareAccessConfig;
const replacement = {
  ...gateway,
  id: "a0000000-0000-4000-8000-000000000002",
  name: "Replacement gateway",
} as const satisfies ScopedCloudflareAccessConfig;
const personal = {
  ...gateway,
  id: "a0000000-0000-4000-8000-000000000003",
  name: "Personal gateway",
  scope: "personal",
} as const satisfies ScopedCloudflareAccessConfig;

function binding(config: ScopedCloudflareAccessConfig = gateway) {
  return {
    type: "cloudflare_access" as const,
    configId: config.id,
    status: "available" as const,
    name: config.name,
    generation: config.generation,
  };
}

function definition(kind: "http" | "mcp"): CustomConnectorResponse {
  return kind === "http"
    ? customConnector({ displayName: "Protected HTTP", storageVersion: 7 })
    : mcpCustomConnector({ displayName: "Protected MCP", storageVersion: 7 });
}

function story(initial: readonly CustomConnectorResponse[] = []) {
  mockCustomConnectorStory(context);
  let connectors = [...initial];
  const updates: UpdateCustomConnectorBody[] = [];
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors });
  });
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ query, respond }) => {
    return respond(200, {
      configs: [
        {
          ...gateway,
          ...(query.includeCustomConnectors === "true"
            ? {
                customConnectors: connectors
                  .filter((connector) => {
                    return connector.networkBinding?.configId === gateway.id;
                  })
                  .map(({ id, displayName, kind }) => {
                    return { id, displayName, kind };
                  }),
              }
            : {}),
        },
        replacement,
        personal,
      ],
    });
  });
  context.mocks.api(
    customConnectorByIdContract.update,
    ({ params, body, respond }) => {
      const previous = connectors.find((connector) => {
        return connector.id === params.id;
      });
      if (!previous) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
      }
      updates.push(body);
      const selected = body.networkBinding;
      const updated = {
        ...previous,
        displayName: body.displayName,
        storageVersion: body.storageVersion ?? previous.storageVersion,
        networkBinding:
          selected === undefined
            ? previous.networkBinding
            : selected === null
              ? undefined
              : binding(
                  selected.configId === replacement.id ? replacement : gateway,
                ),
      };
      connectors = connectors.map((connector) => {
        return connector.id === params.id ? updated : connector;
      });
      return respond(200, updated);
    },
  );
  return {
    updates,
    recordCreated(connector: CustomConnectorResponse) {
      connectors = [...connectors, connector];
    },
  };
}

async function page(
  path = "/connectors?scope=custom",
  enabled = true,
  role: "admin" | "member" = "admin",
) {
  const orgId = "org_cloudflare_authoring";
  context.mocks.data.org({ id: orgId, name: "Engineering", role });
  await setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]: enabled,
    },
    auth: {
      user: { id: "cloudflare-author", fullName: "Cloudflare Author" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
  });
}

async function choose(dialog: HTMLElement, name: string) {
  click(within(dialog).getByLabelText("Cloudflare Access"));
  click(await screen.findByRole("option", { name }));
}

async function edit(name: string) {
  getConnectorCard(name);
  const more = await waitFor(() => {
    return getConnectorAction("button", "More options");
  });
  click(more);
  click(
    getConnectorAction("menuitem", "Edit", await screen.findByRole("menu")),
  );
  return await screen.findByRole("dialog", { name: "Edit custom connector" });
}

async function save(dialog: HTMLElement) {
  click(getConnectorAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
}

test.each(["http", "mcp"] as const)(
  "Create a %s connector with organization Cloudflare Access",
  async (kind) => {
    const state = story();
    const shared = {
      networkBinding: binding(),
      storageVersion: 1,
      fields: [],
      headerInjections: [],
      queryInjections: [],
    };
    const created =
      kind === "http"
        ? customConnector({
            ...shared,
            displayName: "Protected HTTP",
            authMode: "none",
          })
        : mcpCustomConnector({
            ...shared,
            displayName: "Protected MCP",
            authMode: "automatic",
          });
    context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
      expect(body.networkBinding).toStrictEqual({
        type: "cloudflare_access",
        configId: gateway.id,
      });
      expect(body.storageVersion).toBe(1);
      expect(body.authMode).toBe(kind === "http" ? "none" : "automatic");
      state.recordCreated(created);
      return respond(201, created);
    });
    await page();
    click(getConnectorAction("button", "New custom connector"));
    const dialog = await screen.findByRole("dialog", {
      name: "New custom connector",
    });
    if (kind === "mcp") {
      click(within(dialog).getByLabelText("Connector type"));
      click(
        await screen.findByRole("option", { name: "MCP · Streamable HTTP" }),
      );
      await fill(
        within(dialog).getByLabelText(/MCP endpoint/u),
        "https://mcp.acme.test/server",
      );
    } else {
      await fill(
        within(dialog).getByLabelText(/Prefixes/u),
        "https://api.acme.test/v1/",
      );
      await chooseConnectorAuthentication(dialog, "No authentication");
    }
    await fill(
      within(dialog).getByLabelText("Display name"),
      created.displayName,
    );
    click(within(dialog).getByLabelText("Cloudflare Access"));
    await screen.findByRole("option", { name: gateway.name });
    expect(
      screen.queryByRole("option", { name: personal.name }),
    ).not.toBeInTheDocument();
    click(screen.getByRole("option", { name: gateway.name }));
    click(getConnectorAction("button", "Create", dialog));
    await screen.findByText(`Cloudflare Access: ${gateway.name}`, {
      exact: false,
    });
  },
);

test.each(["http", "mcp"] as const)(
  "Preserve, rebind and clear a %s network requirement without changing app storage",
  async (kind) => {
    const connector = { ...definition(kind), networkBinding: binding() };
    const state = story([connector]);
    await page();
    await screen.findByText(connector.displayName);
    let dialog = await edit(connector.displayName);
    await fill(
      within(dialog).getByLabelText("Display name"),
      "Renamed protected connector",
    );
    await save(dialog);
    expect(state.updates[0]).not.toHaveProperty("networkBinding");
    expect(state.updates[0]?.storageVersion).toBe(7);
    await screen.findByText("Renamed protected connector");
    dialog = await edit("Renamed protected connector");
    await choose(dialog, replacement.name);
    await save(dialog);
    expect(state.updates[1]).toMatchObject({
      networkBinding: { type: "cloudflare_access", configId: replacement.id },
      storageVersion: 7,
      authMode: "manual",
    });
    await screen.findByText(`Cloudflare Access: ${replacement.name}`, {
      exact: false,
    });
    dialog = await edit("Renamed protected connector");
    await choose(dialog, "No Cloudflare Access");
    await save(dialog);
    expect(state.updates[2]).toMatchObject({
      networkBinding: null,
      storageVersion: 7,
    });
    expect(getConnectorCard("Renamed protected connector")).toHaveTextContent(
      kind === "http"
        ? "https://api.acme.test/v1/"
        : "https://mcp.acme.test/server",
    );
  },
);

test("A member following a dependency link sees the connector without admin editing controls", async () => {
  const connector = { ...definition("http"), networkBinding: binding() };
  story([connector]);
  await page(
    `/connectors?scope=custom&editCustomConnector=${connector.id}`,
    true,
    "member",
  );
  await screen.findByText(`Cloudflare Access: ${gateway.name}`, {
    exact: false,
  });
  expect(getConnectorCard(connector.displayName)).toHaveTextContent(
    "https://api.acme.test/v1/",
  );
  expect(
    screen.queryByRole("dialog", { name: "Edit custom connector" }),
  ).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label") === "More options";
    }),
  ).toBeFalsy();
});

test("A network-only OAuth edit preserves the app secret and account storage contract", async () => {
  const oauthConfig = {
    providerAdapter: "standard" as const,
    clientId: "existing-client",
    authorizationUrl: "https://identity.acme.test/authorize",
    tokenUrl: "https://identity.acme.test/token",
    tokenEndpointAuthMethod: "client_secret_post" as const,
    pkceMethod: "S256" as const,
    scopes: ["read"],
    authorizationParams: {},
  };
  const connector = customConnector({
    displayName: "OAuth with Cloudflare",
    authMode: "oauth",
    fields: [],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
    ],
    oauthConfig,
    storageVersion: 7,
    networkBinding: binding(),
  });
  const state = story([connector]);
  await page(`/connectors?scope=custom&editCustomConnector=${connector.id}`);
  const dialog = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  await choose(dialog, replacement.name);
  await save(dialog);
  expect(state.updates[0]).toMatchObject({
    authMode: "oauth",
    storageVersion: 7,
    oauthConfig,
    networkBinding: { type: "cloudflare_access", configId: replacement.id },
  });
  expect(state.updates[0]?.oauthConfig).not.toHaveProperty("clientSecret");
});

test.each(["http", "mcp"] as const)(
  "A feature-disabled %s binding remains unavailable and can be explicitly removed",
  async (kind) => {
    const connector = {
      ...definition(kind),
      networkBinding: {
        type: "cloudflare_access" as const,
        configId: gateway.id,
        status: "unavailable" as const,
        name: null,
      },
    };
    const state = story([connector]);
    await page(
      `/connectors?scope=custom&editCustomConnector=${connector.id}`,
      false,
    );
    let dialog = await screen.findByRole("dialog", {
      name: "Edit custom connector",
    });
    expect(
      within(dialog).getByLabelText("Cloudflare Access"),
    ).toHaveTextContent("Unavailable");
    expect(
      within(dialog).getByText(/Cloudflare Access is turned off/u),
    ).toBeInTheDocument();
    await fill(
      within(dialog).getByLabelText("Display name"),
      "Still requires Cloudflare",
    );
    await save(dialog);
    expect(state.updates[0]).not.toHaveProperty("networkBinding");
    await screen.findByText("Still requires Cloudflare");
    dialog = await edit("Still requires Cloudflare");
    await choose(dialog, "No Cloudflare Access");
    await save(dialog);
    expect(state.updates[1]).toMatchObject({
      networkBinding: null,
      storageVersion: 7,
    });
  },
);

test("A configuration load failure and rejected save preserve the connector draft until explicit retry", async () => {
  const state = story();
  const response = context.mocks.deferred<void>();
  let loaded = false;
  let saved = false;
  context.mocks.api(cloudflareAccessContract.list, async ({ respond }) => {
    if (!loaded) {
      await response.promise;
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unavailable" },
      });
    }
    return respond(200, { configs: [gateway] });
  });
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    expect(body.displayName).toBe("Draft survives");
    expect(body.networkBinding).toStrictEqual({
      type: "cloudflare_access",
      configId: gateway.id,
    });
    if (!saved) {
      saved = true;
      return respond(400, {
        error: {
          code: "BAD_REQUEST",
          message: "Configuration changed. Review your selection.",
        },
      });
    }
    const created = customConnector({
      displayName: body.displayName,
      networkBinding: binding(),
      authMode: "none",
      fields: [],
      headerInjections: [],
      queryInjections: [],
    });
    state.recordCreated(created);
    return respond(201, created);
  });
  await page();
  click(getConnectorAction("button", "New custom connector"));
  const dialog = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await within(dialog).findByText("Loading Cloudflare Access…");
  await fill(within(dialog).getByLabelText("Display name"), "Draft survives");
  await fill(
    within(dialog).getByLabelText(/Prefixes/u),
    "https://api.acme.test/v1/",
  );
  await chooseConnectorAuthentication(dialog, "No authentication");
  response.resolve();
  await within(dialog).findByText("Could not load Cloudflare Access.");
  loaded = true;
  click(getConnectorAction("button", "Refresh configurations", dialog));
  await choose(dialog, gateway.name);
  click(getConnectorAction("button", "Create", dialog));
  await screen.findByText("Configuration changed. Review your selection.");
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Draft survives",
  );
  expect(within(dialog).getByLabelText("Cloudflare Access")).toHaveTextContent(
    gateway.name,
  );
  click(getConnectorAction("button", "Create", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
});

test.each(["http", "mcp"] as const)(
  "Resolve a %s dependency through its settings link before a fresh network deletion",
  async (kind) => {
    const connector = { ...definition(kind), networkBinding: binding() };
    const state = story([connector]);
    await page(
      `/connectors?scope=private-network&remoteResource=cloudflare:${gateway.id}`,
      false,
    );
    await screen.findByRole("heading", { name: gateway.name });
    expect(
      getConnectorAction("button", "Delete Cloudflare Access"),
    ).toBeDisabled();
    click(getConnectorAction("button", "Edit settings"));
    const networkName =
      await screen.findByLabelText<HTMLInputElement>("Network name");
    const networkForm = networkName.form;
    if (!networkForm) {
      throw new Error("Expected the Cloudflare configuration form");
    }
    expect(
      within(networkForm).getByLabelText(/^Only me/u, {
        selector: '[role="radio"]',
      }),
    ).toHaveAttribute("aria-disabled", "true");
    click(getConnectorAction("link", connector.displayName, networkForm));
    const dialog = await screen.findByRole("dialog", {
      name: "Edit custom connector",
    });
    expect(within(dialog).getByLabelText("Display name")).toHaveValue(
      connector.displayName,
    );
    await choose(dialog, "No Cloudflare Access");
    await save(dialog);
    expect(state.updates[0]).toMatchObject({
      networkBinding: null,
      storageVersion: 7,
    });
    act(() => {
      return window.history.back();
    });
    const refreshedName =
      await screen.findByLabelText<HTMLInputElement>("Network name");
    const refreshedForm = refreshedName.form;
    if (!refreshedForm) {
      throw new Error("Expected the refreshed Cloudflare configuration form");
    }
    const personalScope = within(refreshedForm).getByLabelText(/^Only me/u, {
      selector: '[role="radio"]',
    });
    click(personalScope);
    expect(personalScope).toHaveAttribute("aria-checked", "true");
    act(() => {
      return window.history.back();
    });
    await screen.findByRole("heading", { name: gateway.name });
    expect(
      getConnectorAction("button", "Delete Cloudflare Access"),
    ).toBeEnabled();
  },
);
