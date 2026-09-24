import {
  cloudflareAccessContract,
  type CloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_cloudflare_access";
const timestamp = "2026-09-22T00:00:00.000Z";
const config: CloudflareAccessConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Protected applications",
  revision: 1,
  generation: 1,
  sshHosts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});

beforeEach(() => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
});

async function page(path = "/connectors?scope=private-network") {
  await setupPage({
    context,
    path,
    auth: {
      user: { id: "access-owner", fullName: "Access Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
  });
}

async function tokenFields(dialog: HTMLElement, name = config.name) {
  await fill(within(dialog).getByLabelText("Name"), name);
  await fill(
    within(dialog).getByLabelText("Service Token Client ID"),
    "test-client-id",
  );
  await fill(
    within(dialog).getByLabelText("Service Token Client Secret"),
    "test-client-secret",
  );
}

async function pasteTokenHeaders(
  dialog: HTMLElement,
  label: "Service Token Client ID" | "Service Token Client Secret",
  clipboard: string,
) {
  const user = userEvent.setup();
  await user.click(within(dialog).getByLabelText(label));
  await user.paste(clipboard);
}

test("Cloudflare Access is managed in Connectors Private network", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  await page();
  await expect(
    screen.findByRole("heading", { name: "Cloudflare Access" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.search).toBe("?scope=private-network");
  expect(screen.getByText(config.name)).toBeInTheDocument();
  expect(screen.queryByText("Direct")).toBeNull();
  expect(screen.queryByText("Add access")).toBeNull();
  expect(document.title).toContain("Connectors");
});

test("Returning to Private network does not reopen an abandoned Access dialog", async () => {
  await page("/connectors");
  click(getConnectorAction("tab", "Private network"));
  await screen.findByRole("heading", { name: "Cloudflare Access" });
  click(getAction("button", "Add Cloudflare Access"));
  await screen.findByRole("dialog", { name: "Add Cloudflare Access" });

  window.history.back();
  await waitFor(() => {
    expect(window.location.search).toBe("");
  });
  await screen.findByRole("heading", { name: "Remote access" });
  click(getConnectorAction("tab", "Private network"));
  await waitFor(() => {
    expect(window.location.search).toBe("?scope=private-network");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test("Private network adds a configuration through the canonical API", async () => {
  let configs: CloudflareAccessConfig[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    const created = { ...config, id: body.id, name: body.name };
    configs = [created];
    return respond(201, created);
  });
  await page();
  click(
    await waitFor(() => {
      return getAction("button", "Add Cloudflare Access");
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Add Cloudflare Access",
  });
  expect(window.location.search).toBe("?scope=private-network");
  await fill(within(dialog).getByLabelText("Name"), config.name);
  await fill(
    within(dialog).getByLabelText("Service Token Client ID"),
    "client-id",
  );
  await fill(
    within(dialog).getByLabelText("Service Token Client Secret"),
    "client-secret",
  );
  click(getAction("button", "Save", dialog));
  await expect(screen.findByText(config.name)).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("The private network panel refreshes from the neutral realtime event", async () => {
  let configs: CloudflareAccessConfig[] = [config];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  await setupPage({
    context,
    path: "/connectors?scope=private-network",
    auth: {
      user: { id: "access-owner", fullName: "Access Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
  });
  await screen.findByText(config.name);
  configs = [{ ...config, name: "Updated applications", revision: 2 }];
  context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
  await expect(
    screen.findByText("Updated applications"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(config.name)).toBeNull();
});

test("The new Access configuration form masks tokens without prefilling them", async () => {
  await page();
  click(getAction("button", "Add Cloudflare Access"));
  const dialog = await screen.findByRole("dialog", {
    name: "Add Cloudflare Access",
  });
  for (const label of [
    "Service Token Client ID",
    "Service Token Client Secret",
  ]) {
    expect(within(dialog).getByLabelText(label)).toHaveAttribute(
      "type",
      "password",
    );
    expect(within(dialog).getByLabelText(label)).toHaveValue("");
  }
});

test("Cloudflare Access CRUD uses the canonical API", async () => {
  let configs: CloudflareAccessConfig[] = [];
  const createRequests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    createRequests.push(body);
    const created = { ...config, id: body.id, name: body.name };
    configs = [created];
    return respond(201, created);
  });
  context.mocks.api(cloudflareAccessContract.delete, ({ body, respond }) => {
    expect(body).toStrictEqual({ expectedRevision: 1 });
    configs = [];
    return respond(204);
  });
  await page();
  await screen.findByText("0 Cloudflare Access configured");
  click(getAction("button", "Add Cloudflare Access"));
  let dialog = await screen.findByRole("dialog", {
    name: "Add Cloudflare Access",
  });
  await fill(within(dialog).getByLabelText("Name"), config.name);
  await pasteTokenHeaders(
    dialog,
    "Service Token Client ID",
    "cf-access-client-secret:\tcreated-secret\r\nCF-ACCESS-CLIENT-ID: created-id\r\n",
  );
  expect(within(dialog).getByLabelText("Service Token Client ID")).toHaveValue(
    "created-id",
  );
  expect(
    within(dialog).getByLabelText("Service Token Client Secret"),
  ).toHaveValue("created-secret");
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  click(getAction("button", "Save", dialog));
  await screen.findByText("1 Cloudflare Access configured");
  expect(createRequests).toStrictEqual([
    {
      id: expect.any(String),
      name: config.name,
      credentials: {
        clientId: "created-id",
        clientSecret: "created-secret",
      },
    },
  ]);
  expect(secret).toHaveValue("");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await screen.findByText(config.name);
  click(getAction("button", "Delete Cloudflare Access"));
  dialog = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  click(getAction("button", "Delete Cloudflare Access", dialog));
  await screen.findByText("0 Cloudflare Access configured");
});

test("A committed Access creation completes on same-ID retry without another configuration", async () => {
  const submitted: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    submitted.push(body);
    return submitted.length > 1
      ? respond(204)
      : respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Response unavailable" },
        });
  });
  await page();
  click(getAction("button", "Add Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  await tokenFields(dialog);
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText(
    /We couldn't confirm whether your changes were saved/u,
  );
  expect(secret).toHaveValue("test-client-secret");
  expect(secret).toBeDisabled();
  expect(submitted).toHaveLength(1);
  click(getAction("button", "Retry", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(submitted).toHaveLength(2);
  expect(submitted[0]).toHaveProperty("id", expect.any(String));
  expect(submitted[0]).toStrictEqual(submitted[1]);
  expect(secret).toHaveValue("");
});

test("Changing the owner clears Access secrets and hides the previous owner's configurations", async () => {
  await page();
  click(getAction("button", "Add Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  await tokenFields(dialog);
  const secret = within(dialog).getByLabelText("Service Token Client Secret");
  const clerk = context.mocks.clerk();
  clerk.user(
    { id: "other-owner", fullName: "Other Owner" },
    { token: "other-token" },
  );
  clerk.stateChanged();
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(secret).toHaveValue("");
});

test("Renaming changes metadata without requesting a new Service Token", async () => {
  let current = config;
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(cloudflareAccessContract.update, ({ body, respond }) => {
    requests.push(body);
    current = { ...config, name: body.name ?? config.name, revision: 2 };
    return respond(200, current);
  });
  await page();
  await screen.findByText(config.name);
  click(getAction("button", "Edit Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).queryByLabelText("Service Token Client Secret"),
  ).not.toBeInTheDocument();
  await fill(within(dialog).getByLabelText("Name"), "Renamed gateway");
  click(getAction("button", "Save", dialog));
  await screen.findByText("Renamed gateway");
  expect(requests).toStrictEqual([
    { expectedRevision: 1, name: "Renamed gateway" },
  ]);
});

test("Access load failure does not expose provider details", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "private provider detail" },
    });
  });
  await page();
  await screen.findByText("Could not load Cloudflare Access. Try again.");
  expect(
    queryAction("button", "Add Cloudflare Access"),
  ).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("private provider detail");
});
