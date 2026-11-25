import {
  customConnectorsContract,
  customConnectorByIdContract,
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
  type CreateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  cloudflareAccessContract,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  customConnector,
  mcpCustomConnector,
  chooseConnectorAuthentication,
  getConnectorCard,
} from "./connector-page-test-helpers.ts";
const context = testContext();

const path = "/connectors?scope=custom";
function makeGateway(
  name: string,
  scope: "personal" | "organization" = "organization",
): ScopedCloudflareAccessConfig {
  return {
    id: crypto.randomUUID(),
    scope,
    name,
    generation: 1,
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    sshHosts: [],
    vncHosts: [],
  };
}
function bound(gateway: ScopedCloudflareAccessConfig) {
  return {
    type: "cloudflare_access",
    status: "available",
    configId: gateway.id,
    name: gateway.name,
    generation: gateway.generation,
  } as const;
}
function inventory(current: () => CustomConnectorResponse[]) {
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: current() });
  });
}
async function newHttp(name: string) {
  click(await findFastControl("button", "New custom connector"));
  const form = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(form).getByPlaceholderText("Acme API"), name);
  await fill(
    within(form).getByPlaceholderText("https://api.acme.com/v1/"),
    "https://api.acme.test/v1/",
  );
  await chooseConnectorAuthentication(form, "No authentication");
  return form;
}
function advanced(form: HTMLElement) {
  return within(form).getByText("Advanced settings").closest("summary")!;
}
function picker(form: HTMLElement) {
  return within(form).getByRole("combobox", { name: "Cloudflare Access" });
}
test("custom-connector-cloudflare-authoring-001 creating a public HTTP definition with an organization gateway", async () => {
  let submitted: CreateCustomConnectorBody | undefined;
  const org = makeGateway("Corporate gateway");
  const personal = makeGateway("Personal gateway", "personal");
  let saved: CustomConnectorResponse[] = [];
  inventory(() => {
    return saved;
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [personal, org] });
  });
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    submitted = body;
    const api = customConnector({
      displayName: body.displayName,
      authMode: "none",
      fields: [],
      headerInjections: [],
      networkBinding: bound(org),
    });
    saved = [api];
    return respond(201, api);
  });
  await setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
    },
  });
  const form = await newHttp("Reports endpoint");
  const summary = advanced(form);
  click(summary);
  click(picker(form));
  const choice = await screen.findByRole("option", { name: org.name });
  expect(
    screen.queryByRole("option", { name: personal.name }),
  ).not.toBeInTheDocument();
  click(choice);
  click(summary);
  expect(summary).toHaveTextContent(org.name);
  click(await findFastControl("button", "Create", form));
  await screen.findByText("Reports endpoint");
  expect(submitted).toMatchObject({
    storageVersion: 1,
    authMode: "none",
    networkBinding: { type: "cloudflare_access", configId: org.id },
  });
  expect(getConnectorCard("Reports endpoint")).toHaveTextContent(
    "Cloudflare Access: Corporate gateway",
  );
});
test("custom-connector-cloudflare-authoring-005 a member following the dependency link sees the bound API without editing actions", async () => {
  const org = makeGateway("Corporate gateway");
  const api = customConnector({
    displayName: "Bound reports",
    networkBinding: bound(org),
  });
  org.customConnectors = [
    { id: api.id, kind: "http", displayName: api.displayName },
  ];
  inventory(() => {
    return [api];
  });
  context.mocks.data.org({ role: "member" });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [org] });
  });
  await setupPage({
    context,
    path:
      "/connectors?scope=private-network&remoteResource=cloudflare:" + org.id,
    featureSwitches: {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
    },
  });
  click(await findFastControl("link", api.displayName));
  await screen.findByText(
    "https://api.acme.test/v1/ · Cloudflare Access: Corporate gateway",
  );
  expect(getConnectorCard(api.displayName)).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("More options")).not.toBeInTheDocument();
});
test("custom-connector-cloudflare-authoring-009 rebind the unavailable definition after its configuration lookup recovers", async () => {
  let submitted: UpdateCustomConnectorBody | undefined;
  const gateway = makeGateway("Replacement gateway");
  let api = customConnector({
    storageVersion: 7,
    networkBinding: {
      type: "cloudflare_access",
      configId: crypto.randomUUID(),
      status: "unavailable",
      name: null,
    },
  });
  inventory(() => {
    return [api];
  });
  const failure = context.mocks.deferred<void>();
  let recover = false;
  context.mocks.api(cloudflareAccessContract.list, async ({ respond }) => {
    if (recover) {
      return respond(200, { configs: [gateway] });
    }
    await failure.promise;
    return respond(500, {
      error: { code: "UNAVAILABLE", message: "Service unavailable" },
    });
  });
  context.mocks.api(customConnectorByIdContract.update, ({ body, respond }) => {
    submitted = body;
    api = customConnector({
      displayName: body.displayName,
      networkBinding: bound(gateway),
    });
    return respond(200, api);
  });
  await setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
    },
  });
  click(await findFastControl("button", "More options"));
  click(await screen.findByText("Edit", { selector: '[role="menuitem"]' }));
  const form = await screen.findByRole("dialog");
  const summary = advanced(form);
  await within(summary).findByRole("status", {
    name: "Loading Cloudflare Access…",
  });
  await fill(within(form).getByPlaceholderText("Acme API"), "Renamed reports");
  failure.resolve();
  await within(summary).findByText("Could not load Cloudflare Access.");
  click(summary);
  await expect(within(form).findByRole("alert")).resolves.toHaveTextContent(
    "Could not load Cloudflare Access.",
  );
  recover = true;
  click(picker(form));
  const choice = await screen.findByRole("option", { name: gateway.name });
  expect(summary).toHaveTextContent("Unavailable");
  click(choice);
  expect(summary).toHaveTextContent(gateway.name);
  expect(
    within(form).queryByText(/This configuration is unavailable/),
  ).not.toBeInTheDocument();
  click(await findFastControl("button", "Save", form));
  await screen.findByText("Renamed reports");
  expect(submitted).toMatchObject({
    displayName: "Renamed reports",
    storageVersion: 7,
    authMode: "manual",
    networkBinding: { type: "cloudflare_access", configId: gateway.id },
  });
});
test("custom-connector-cloudflare-authoring-010 a failed lookup and rejected save preserve the HTTP creation draft", async () => {
  const gateway = makeGateway("Corporate gateway");
  const failure = context.mocks.deferred<void>();
  let recover = false;
  let accept = false;
  let saved: CustomConnectorResponse[] = [];
  inventory(() => {
    return saved;
  });
  context.mocks.api(cloudflareAccessContract.list, async ({ respond }) => {
    if (recover) {
      return respond(200, { configs: [gateway] });
    }
    await failure.promise;
    return respond(500, {
      error: { code: "UNAVAILABLE", message: "Service unavailable" },
    });
  });
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    if (!accept) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Gateway configuration changed" },
      });
    }
    const api = customConnector({
      displayName: body.displayName,
      networkBinding: bound(gateway),
    });
    saved = [api];
    return respond(201, api);
  });
  await setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
    },
  });
  const form = await newHttp("Metrics API");
  const summary = advanced(form);
  click(summary);
  failure.resolve();
  await expect(within(form).findByRole("alert")).resolves.toHaveTextContent(
    "Could not load Cloudflare Access.",
  );
  expect(within(form).getByPlaceholderText("Acme API")).toHaveValue(
    "Metrics API",
  );
  expect(
    within(form).getByRole("combobox", { name: "Authentication" }),
  ).toHaveTextContent("No authentication");
  expect(
    within(form).getByPlaceholderText("https://api.acme.com/v1/"),
  ).toHaveValue("https://api.acme.test/v1/");
  recover = true;
  click(picker(form));
  click(await screen.findByRole("option", { name: gateway.name }));
  click(await findFastControl("button", "Create", form));
  await screen.findByText(/configuration changed/i);
  expect(within(form).getByPlaceholderText("Acme API")).toHaveValue(
    "Metrics API",
  );
  expect(picker(form)).toHaveTextContent(gateway.name);
  accept = true;
  click(await findFastControl("button", "Create", form));
  await screen.findByText("Metrics API");
  expect(form).not.toBeInTheDocument();
});
test.each([
  ["011", "http"],
  ["012", "mcp"],
] as const)(
  "custom-connector-cloudflare-authoring-%s freeing a gateway from its %s dependent allows personal scope and deletion",
  async (_id, kind) => {
    const gateway = makeGateway("Corporate gateway");
    let update: { id: string; body: UpdateCustomConnectorBody } | undefined;
    const fields = {
      displayName: "Bound service",
      storageVersion: 7,
      networkBinding: bound(gateway),
    };
    let api: CustomConnectorResponse =
      kind === "http" ? customConnector(fields) : mcpCustomConnector(fields);
    gateway.customConnectors = [
      { id: api.id, kind, displayName: api.displayName },
    ];
    inventory(() => {
      return [api];
    });
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, { configs: [gateway] });
    });
    context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
      return respond(200, {
        expectedRevision: gateway.revision,
        ownHostCount: 0,
        otherHostCount: 0,
        affectedOwners: [],
        impactSnapshot: "a".repeat(64),
      });
    });
    context.mocks.api(
      cloudflareAccessContract.convertToPersonal,
      ({ respond }) => {
        gateway.scope = "personal";
        gateway.revision++;
        return respond(200, gateway);
      },
    );
    context.mocks.api(
      customConnectorByIdContract.update,
      ({ params, body, respond }) => {
        update = { id: params.id, body };
        api = { ...api, networkBinding: undefined };
        gateway.customConnectors = [];
        return respond(200, api);
      },
    );
    await setupPage({
      context,
      path:
        "/connectors?scope=private-network&remoteResource=cloudflare:" +
        gateway.id,
      featureSwitches: {
        [FeatureSwitchKey.CustomConnectorCloudflareAccess]: false,
      },
    });
    await expect(
      findFastControl("button", "Delete Cloudflare Access"),
    ).resolves.toBeDisabled();
    click(await findFastControl("button", "Edit settings"));
    await screen.findByRole("radiogroup", { name: "Who can use this" });
    click(await findFastControl("link", api.displayName));
    const form = await screen.findByRole("dialog");
    click(advanced(form));
    click(picker(form));
    click(await screen.findByRole("option", { name: "No Cloudflare Access" }));
    click(await findFastControl("button", "Save", form));
    await waitFor(() => {
      return expect(form).not.toBeInTheDocument();
    });
    expect(update).toMatchObject({
      id: api.id,
      body: { storageVersion: 7, networkBinding: null },
    });
    click(await findFastControl("radio", /^Private network/i));
    click(await findFastControl("link", "Manage Corporate gateway"));
    click(await findFastControl("button", "Edit settings"));
    const scope = await screen.findByRole("radiogroup", {
      name: "Who can use this",
    });
    const personal = within(scope).getByText("Only me").closest("label")!;
    click(personal);
    expect(queryAllByRoleFast("radio", personal)[0]).toBeChecked();
    click(await findFastControl("button", "Save network"));
    const confirm = await screen.findByRole("dialog", { name: /only to you/i });
    click(await findFastControl("button", "Make personal", confirm));
    await waitFor(() => {
      return expect(confirm).not.toBeInTheDocument();
    });
    await screen.findByRole("heading", { name: gateway.name });
    await expect(
      findFastControl("button", "Delete Cloudflare Access"),
    ).resolves.toBeEnabled();
  },
);
