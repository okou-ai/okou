import { httpConnectorFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  cloudflareAccessContract,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
  customConnectorByIdContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chooseConnectorAuthentication,
  customConnector,
  getConnectorAction,
  getConnectorCard,
  mockSavedConnectorAccounts,
  queryConnectorAction,
  queryConnectorCard,
} from "./connector-page-test-helpers.ts";

const context = testContext();

const CORPORATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const REPLACEMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const PERSONAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const RETIRED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";

function accessConfig(
  id: string,
  name: string,
  scope: "personal" | "organization",
  customConnectors: readonly CustomConnectorResponse[] = [],
): ScopedCloudflareAccessConfig {
  return {
    id,
    name,
    scope,
    revision: 3,
    generation: 2,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    sshHosts: [],
    vncHosts: [],
    customConnectors: customConnectors.map((connector) => {
      return {
        id: connector.id,
        displayName: connector.displayName,
        kind: connector.kind,
      };
    }),
  };
}

const corporate = accessConfig(
  CORPORATE_ID,
  "Corporate gateway",
  "organization",
);
const replacement = accessConfig(
  REPLACEMENT_ID,
  "Replacement gateway",
  "organization",
);
const personal = accessConfig(PERSONAL_ID, "Personal gateway", "personal");

function boundTo(config: ScopedCloudflareAccessConfig) {
  return {
    networkBinding: {
      type: "cloudflare_access" as const,
      configId: config.id,
      status: "available" as const,
      name: config.name,
      generation: config.generation,
    },
  };
}

interface ConnectorStore {
  connectors: CustomConnectorResponse[];
  readonly creates: CreateCustomConnectorBody[];
  readonly updates: UpdateCustomConnectorBody[];
}

function withBinding(
  connector: Readonly<Record<string, unknown>>,
  binding: UpdateCustomConnectorBody["networkBinding"],
  configs: readonly ScopedCloudflareAccessConfig[],
): Record<string, unknown> {
  if (binding === undefined) {
    return { ...connector };
  }
  const { networkBinding: _previous, ...rest } = connector;
  const config = configs.find((candidate) => {
    return candidate.id === binding?.configId;
  });
  return binding && config ? { ...rest, ...boundTo(config) } : rest;
}

/** Org custom HTTP connector API that keeps definitions and records writes. */
function mockConnectorStore(
  initial: readonly CustomConnectorResponse[],
  configs: () => readonly ScopedCloudflareAccessConfig[],
  role: "admin" | "member" = "admin",
): ConnectorStore {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role });
  const store: ConnectorStore = {
    connectors: [...initial],
    creates: [],
    updates: [],
  };
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: store.connectors });
  });
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    store.creates.push(body);
    const { networkBinding: requested, ...definitionBody } = body;
    const created = httpConnectorFixture(
      withBinding(
        {
          ...definitionBody,
          kind: "http",
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
          slug: "_protected-api",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
        },
        requested,
        configs(),
      ),
    );
    store.connectors = [...store.connectors, created];
    return respond(201, created);
  });
  context.mocks.api(
    customConnectorByIdContract.update,
    ({ params, body, respond }) => {
      store.updates.push(body);
      const current = store.connectors.find((connector) => {
        return connector.id === params.id;
      });
      if (!current) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
      }
      const merged = withBinding(
        { ...current, ...body, networkBinding: current.networkBinding },
        body.networkBinding,
        configs(),
      );
      const updated = httpConnectorFixture(merged);
      store.connectors = store.connectors.map((connector) => {
        return connector.id === params.id ? updated : connector;
      });
      return respond(200, updated);
    },
  );
  return store;
}

function mockAccessConfigs(
  read: () =>
    | readonly ScopedCloudflareAccessConfig[]
    | Promise<readonly ScopedCloudflareAccessConfig[] | "failed">
    | "failed",
): void {
  context.mocks.api(cloudflareAccessContract.list, async ({ respond }) => {
    const configs = await read();
    return configs === "failed"
      ? respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Lookup failed" },
        })
      : respond(200, { configs: [...configs] });
  });
}

/**
 * Cloudflare Access lookups stay pending until the test settles them. Startup
 * catch-up may repeat a lookup; every read observes the same stage.
 */
function stagedAccessLookup(
  available: readonly ScopedCloudflareAccessConfig[],
) {
  let stage: "pending" | "failed" | "available" = "pending";
  const settled = context.mocks.deferred<void>();
  mockAccessConfigs(async () => {
    if (stage === "pending") {
      await settled.promise;
    }
    return stage === "failed" ? "failed" : available;
  });
  return {
    fail() {
      stage = "failed";
      settled.resolve();
    },
    recover() {
      stage = "available";
    },
  };
}

function setupCustomScope(
  options: { readonly path?: string; readonly cloudflare?: boolean } = {},
): Promise<void> {
  return setupPage({
    context,
    path: options.path ?? "/connectors?scope=custom",
    featureSwitches: {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]:
        options.cloudflare ?? true,
    },
  });
}

function advancedSummary(dialog: HTMLElement): HTMLElement {
  const summary = within(dialog)
    .getByText("Advanced settings")
    .closest("summary");
  if (!summary) {
    throw new Error("Expected the advanced settings summary");
  }
  return summary;
}

function advancedSettings(dialog: HTMLElement): HTMLDetailsElement {
  const details = advancedSummary(dialog).closest("details");
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Expected the advanced settings disclosure");
  }
  return details;
}

async function chooseAccess(dialog: HTMLElement, option: string) {
  click(within(dialog).getByRole("combobox", { name: "Cloudflare Access" }));
  click(await screen.findByRole("option", { name: option }));
}

async function openCreateDialog(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(getConnectorAction("button", "New custom connector")).toBeEnabled();
  });
  click(getConnectorAction("button", "New custom connector"));
  return await screen.findByRole("dialog", { name: "New custom connector" });
}

async function openEditDialog(label: string): Promise<HTMLElement> {
  const row = await waitFor(() => {
    const card = getConnectorCard(label).parentElement;
    if (!card) {
      throw new Error(`Expected ${label} card row`);
    }
    return card;
  });
  click(getConnectorAction("button", "More options", row));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Edit");
    }),
  );
  return await screen.findByRole("dialog", { name: "Edit custom connector" });
}

test("Create a http connector with organization Cloudflare Access", async () => {
  mockAccessConfigs(() => {
    return [corporate, personal];
  });
  const store = mockConnectorStore([], () => {
    return [corporate, personal];
  });
  await setupCustomScope();
  const dialog = await openCreateDialog();
  await fill(within(dialog).getByLabelText("Display name"), "Protected API");
  await fill(
    within(dialog).getByLabelText(/^Prefixes/u),
    "https://api.acme.test/v1/",
  );
  await chooseConnectorAuthentication(dialog, "No authentication");

  click(advancedSummary(dialog));
  click(within(dialog).getByRole("combobox", { name: "Cloudflare Access" }));
  const options = await screen.findAllByRole("option");
  expect(
    options.map((option) => {
      return option.textContent;
    }),
  ).toStrictEqual(["No Cloudflare Access", "Corporate gateway"]);
  click(screen.getByRole("option", { name: "Corporate gateway" }));
  click(advancedSummary(dialog));

  await waitFor(() => {
    expect(advancedSettings(dialog).open).toBeFalsy();
  });
  expect(advancedSummary(dialog)).toHaveTextContent(
    "Advanced settingsCloudflare Access · Corporate gateway",
  );
  click(getConnectorAction("button", "Create", dialog));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(store.creates).toMatchObject([
    {
      displayName: "Protected API",
      prefixTemplates: ["https://api.acme.test/v1/"],
      authMode: "none",
      storageVersion: 1,
      networkBinding: { type: "cloudflare_access", configId: CORPORATE_ID },
    },
  ]);
  await waitFor(() => {
    expect(getConnectorCard("Protected API")).toHaveTextContent(
      "https://api.acme.test/v1/ · Cloudflare Access: Corporate gateway",
    );
  });
});

test("A member following a dependency link sees the connector without admin editing controls", async () => {
  const protectedApi = customConnector({
    displayName: "Protected API",
    prefixTemplates: ["https://api.acme.test/v1/"],
    ...boundTo(corporate),
  });
  mockAccessConfigs(() => {
    return [
      accessConfig(CORPORATE_ID, "Corporate gateway", "organization", [
        protectedApi,
      ]),
    ];
  });
  mockConnectorStore(
    [protectedApi],
    () => {
      return [corporate];
    },
    "member",
  );

  await setupCustomScope({
    path: `/connectors?scope=custom&editCustomConnector=${protectedApi.id}`,
  });

  await waitFor(() => {
    expect(getConnectorCard("Protected API")).toHaveTextContent(
      "https://api.acme.test/v1/",
    );
  });
  expect(
    screen.queryByRole("dialog", { name: "Edit custom connector" }),
  ).toBeNull();
  expect(
    queryConnectorAction(
      "button",
      "More options",
      getConnectorCard("Protected API").parentElement ?? document.body,
    ),
  ).toBeNull();
});

test("A collapsed requirement distinguishes pending, failed and unavailable lookup before a valid rebind", async () => {
  const protectedApi = customConnector({
    displayName: "Protected API",
    prefixTemplates: ["https://api.acme.test/v1/"],
    storageVersion: 7,
    networkBinding: {
      type: "cloudflare_access",
      configId: RETIRED_ID,
      status: "unavailable",
      name: null,
    },
  });
  const lookup = stagedAccessLookup([replacement]);
  const store = mockConnectorStore([protectedApi], () => {
    return [replacement];
  });
  await setupCustomScope();
  const dialog = await openEditDialog("Protected API");
  await fill(within(dialog).getByLabelText("Display name"), "Protected API v2");

  expect(advancedSettings(dialog).open).toBeFalsy();
  await expect(
    within(advancedSummary(dialog)).findByRole("status", {
      name: "Loading Cloudflare Access…",
    }),
  ).resolves.toBeInTheDocument();
  lookup.fail();
  await waitFor(() => {
    expect(advancedSummary(dialog)).toHaveTextContent(
      "Could not load Cloudflare Access.",
    );
  });
  click(advancedSummary(dialog));
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Could not load Cloudflare Access.",
  );

  lookup.recover();
  click(within(dialog).getByRole("combobox", { name: "Cloudflare Access" }));
  await expect(
    screen.findByRole("option", { name: "Replacement gateway" }),
  ).resolves.toBeInTheDocument();
  click(advancedSummary(dialog));
  await waitFor(() => {
    expect(advancedSettings(dialog).open).toBeFalsy();
  });
  expect(advancedSummary(dialog)).toHaveTextContent(
    "Cloudflare Access · Unavailable",
  );
  click(advancedSummary(dialog));
  await chooseAccess(dialog, "Replacement gateway");
  await waitFor(() => {
    expect(advancedSummary(dialog)).toHaveTextContent(
      "Cloudflare Access · Replacement gateway",
    );
  });
  expect(
    within(dialog).queryByText(
      "This configuration is unavailable. Select another one or remove the requirement.",
    ),
  ).toBeNull();
  click(getConnectorAction("button", "Save", dialog));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(store.updates).toMatchObject([
    {
      displayName: "Protected API v2",
      storageVersion: 7,
      authMode: "manual",
      networkBinding: { type: "cloudflare_access", configId: REPLACEMENT_ID },
    },
  ]);
});

test("A configuration load failure and rejected save preserve the connector draft until explicit retry", async () => {
  const lookup = stagedAccessLookup([corporate]);
  const store = mockConnectorStore([], () => {
    return [corporate];
  });
  let createAttempts = 0;
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    createAttempts += 1;
    store.creates.push(body);
    if (createAttempts === 1) {
      return respond(400, {
        error: {
          code: "BAD_REQUEST",
          message:
            "Cloudflare Access must be an available organization configuration from this organization",
        },
      });
    }
    const created = httpConnectorFixture({
      ...body,
      kind: "http",
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      slug: "_draft-api",
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      ...boundTo(corporate),
    });
    store.connectors = [...store.connectors, created];
    return respond(201, created);
  });
  await setupCustomScope();
  const dialog = await openCreateDialog();
  await fill(within(dialog).getByLabelText("Display name"), "Draft API");
  await fill(
    within(dialog).getByLabelText(/^Prefixes/u),
    "https://api.acme.test/v1/",
  );
  await chooseConnectorAuthentication(dialog, "No authentication");
  click(advancedSummary(dialog));
  await expect(
    within(dialog).findAllByRole("status", {
      name: "Loading Cloudflare Access…",
    }),
  ).resolves.not.toHaveLength(0);

  lookup.fail();
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Could not load Cloudflare Access.",
  );
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Draft API",
  );
  lookup.recover();
  await chooseAccess(dialog, "Corporate gateway");
  await waitFor(() => {
    expect(advancedSummary(dialog)).toHaveTextContent(
      "Cloudflare Access · Corporate gateway",
    );
  });
  click(getConnectorAction("button", "Create", dialog));

  await expect(
    screen.findByText(
      "Cloudflare Access must be an available organization configuration from this organization",
    ),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getConnectorAction("button", "Create", dialog)).toBeEnabled();
  });
  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Draft API",
  );
  expect(
    within(dialog).getByRole("combobox", { name: "Cloudflare Access" }),
  ).toHaveTextContent("Corporate gateway");
  click(getConnectorAction("button", "Create", dialog));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(store.creates).toHaveLength(2);
  expect(store.creates[1]).toMatchObject({
    displayName: "Draft API",
    networkBinding: { type: "cloudflare_access", configId: CORPORATE_ID },
  });
  await waitFor(() => {
    expect(queryConnectorCard("Draft API")).not.toBeNull();
  });
});
