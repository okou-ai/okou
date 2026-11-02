import {
  cloudflareAccessContract,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_cloudflare_access";
const impactAcknowledgement =
  "I understand these members' hosts will remain saved but cannot connect until their owners rebind them.";
const timestamp = "2026-09-22T00:00:00.000Z";
const config: ScopedCloudflareAccessConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Protected applications",
  scope: "personal",
  revision: 1,
  generation: 1,
  sshHosts: [],
  vncHosts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});

beforeEach(() => {
  // The guided directory is empty only when both providers return empty lists.
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
});

async function page(
  path = "/connectors?scope=private-network",
  role: "admin" | "member" = "member",
) {
  context.mocks.data.org({ id: orgId, name: "Engineering", role });
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

async function createForm() {
  click(getAction("button", "Add network"));
  await screen.findByRole("heading", { name: "Add a private network" });
  click(screen.getByText("Cloudflare Access", { exact: true }));
  await screen.findByRole("dialog", { name: "Create a Service Token" });
  click(getAction("button", "Enter existing credentials"));
  const name = await screen.findByLabelText("Network name");
  return name.closest("form")!;
}

async function emptyDirectory() {
  const directory = await screen.findByRole("region", {
    name: "Private networks",
  });
  await within(directory).findByRole("heading", {
    name: "No networks added yet",
  });
  expect(getAction("button", "Add network", directory)).toBeInTheDocument();
}

async function editForm() {
  click(getAction("button", "Edit settings"));
  const name = await screen.findByLabelText("Network name");
  return name.closest("form")!;
}

async function tokenFields(form: HTMLElement, name = config.name) {
  await fill(within(form).getByLabelText("Network name"), name);
  await fill(within(form).getByLabelText("Client ID"), "test-client-id");
  await fill(
    within(form).getByLabelText("Client Secret"),
    "test-client-secret",
  );
}

async function sharedDetails() {
  await page(
    `/connectors?scope=private-network&remoteResource=cloudflare:${config.id}`,
    "admin",
  );
  await screen.findByRole("heading", { name: config.name });
}

test("An admin can edit and delete a shared configuration through scoped mutations", async () => {
  let current: ScopedCloudflareAccessConfig | null = {
    ...config,
    scope: "organization",
  };
  const updates: unknown[] = [];
  const deletes: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({ view: "scoped" });
    return respond(200, { configs: current ? [current] : [] });
  });
  context.mocks.api(
    cloudflareAccessContract.update,
    ({ body, query, respond }) => {
      updates.push({ body, query });
      current = {
        ...config,
        scope: "organization",
        name: body.name ?? config.name,
        revision: 2,
      };
      return respond(200, current);
    },
  );
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(200, {
      expectedRevision: 2,
      ownHostCount: 0,
      otherHostCount: 0,
      affectedOwners: [],
      impactSnapshot: "a".repeat(64),
    });
  });
  context.mocks.api(
    cloudflareAccessContract.delete,
    ({ body, query, respond }) => {
      deletes.push({ body, query });
      current = null;
      return respond(204);
    },
  );
  await sharedDetails();
  const form = await editForm();
  await fill(within(form).getByLabelText("Network name"), "Updated gateway");
  click(getAction("button", "Save network", form));
  await screen.findByRole("heading", { name: "Updated gateway" });
  expect(updates).toStrictEqual([
    {
      query: { view: "scoped" },
      body: { expectedRevision: 1, name: "Updated gateway" },
    },
  ]);
  click(getAction("button", "Delete Cloudflare Access"));
  const deletion = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  await waitFor(() => {
    expect(
      getAction("button", "Delete Cloudflare Access", deletion),
    ).toBeEnabled();
  });
  click(getAction("button", "Delete Cloudflare Access", deletion));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(getAction("button", "Back to private networks"));
  await emptyDirectory();
  expect(deletes).toStrictEqual([
    {
      query: { view: "scoped" },
      body: { expectedRevision: 2, impactSnapshot: "a".repeat(64) },
    },
  ]);
});

test("Switching organizations navigates away from an open shared Access editor", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [{ ...config, scope: "organization" }] });
  });
  await sharedDetails();
  const form = await editForm();
  expect(within(form).getByLabelText("Network name")).toHaveValue(config.name);
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.organization({
      activeOrg: { id: "org_cloudflare_access_other", name: "Other workspace" },
      memberships: [{ id: orgId }, { id: "org_cloudflare_access_other" }],
    });
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(form).not.toBeInTheDocument();
  });
  expect(window.location.pathname).toBe("/");
});

test("Returning to Private networks starts a fresh Access draft after leaving the editor", async () => {
  await page();
  const form = await createForm();
  await tokenFields(form, "Abandoned draft");
  const secret = within(form).getByLabelText("Client Secret");
  click(getAction("button", "Back"));
  await emptyDirectory();
  const next = await createForm();
  expect(within(next).getByLabelText("Network name")).toHaveValue("");
  expect(within(next).getByLabelText("Client Secret")).toHaveValue("");
  expect(secret).toHaveValue("");
});

test("The private network directory refreshes from the neutral realtime event", async () => {
  let current = config;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  await page();
  await screen.findByText(config.name);
  current = { ...config, name: "Updated applications", revision: 2 };
  context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
  await expect(screen.findByText(current.name)).resolves.toBeInTheDocument();
});

test("Pasted Service Token headers create a network and clear credentials before personal deletion", async () => {
  let configs: ScopedCloudflareAccessConfig[] = [];
  const requests: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    requests.push(body);
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
  const form = await createForm();
  await fill(within(form).getByLabelText("Network name"), config.name);
  const user = userEvent.setup();
  await user.click(within(form).getByLabelText("Client ID"));
  await user.paste(
    "cf-access-client-secret:\tcreated-secret\r\nCF-ACCESS-CLIENT-ID: created-id\r\n",
  );
  expect(within(form).getByLabelText("Client ID")).toHaveValue("created-id");
  const secret = within(form).getByLabelText("Client Secret");
  expect(secret).toHaveValue("created-secret");
  expect(secret).toHaveAttribute("type", "password");
  click(getAction("button", "Save network", form));
  await screen.findByText(config.name);
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      name: config.name,
      scope: "personal",
      credentials: { clientId: "created-id", clientSecret: "created-secret" },
    },
  ]);
  expect(secret).toHaveValue("");
  click(getAction("link", `Manage ${config.name}`));
  await screen.findByRole("heading", { name: config.name });
  click(getAction("button", "Delete Cloudflare Access"));
  const deletion = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  click(getAction("button", "Delete Cloudflare Access", deletion));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(getAction("button", "Back to private networks"));
  await emptyDirectory();
});

test("An unconfirmed Access creation preserves its frozen credentials", async () => {
  const submitted: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    submitted.push(body);
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Response unavailable" },
    });
  });
  await page();
  const form = await createForm();
  await tokenFields(form);
  const secret = within(form).getByLabelText("Client Secret");
  click(getAction("button", "Save network", form));
  await within(form).findByText("Save failed.");
  expect(secret).toHaveValue("test-client-secret");
  expect(secret).toBeDisabled();
  expect(submitted).toHaveLength(1);
  expect(getAction("button", "Save network", form)).toBeDisabled();
});

test("Changing the owner clears Access secrets", async () => {
  await page();
  const form = await createForm();
  await tokenFields(form);
  const secret = within(form).getByLabelText("Client Secret");
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.user(
      { id: "other-owner", fullName: "Other Owner" },
      { token: "other-token" },
    );
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(form).not.toBeInTheDocument();
  });
  expect(window.location.pathname).toBe("/connectors");
  expect(secret).toHaveValue("");
  expect(screen.queryByLabelText("Client Secret")).toBeNull();
});

test("Access load failure does not expose provider details", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "private provider detail" },
    });
  });
  await page();
  await screen.findByText("Could not load Cloudflare Access.");
  expect(document.body.textContent).not.toContain("private provider detail");
});

test("Deletion preview permission loss blocks shared deletion", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [{ ...config, scope: "organization" }] });
  });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(403, {
      error: { code: "CLOUDFLARE_ACCESS_FORBIDDEN", message: "Forbidden" },
    });
  });
  await sharedDetails();
  click(getAction("button", "Delete Cloudflare Access"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  await within(dialog).findByText(/no longer available/u);
  expect(queryAction("button", "Delete Cloudflare Access", dialog)).toBeNull();
});

test("Reviewed shared deletion rejects a changed host set and protects member identities", async () => {
  const bodies: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [{ ...config, scope: "organization" }] });
  });
  context.mocks.api(
    cloudflareAccessContract.impactPreview,
    ({ query, respond }) => {
      expect(query.operation).toBe("delete");
      return respond(200, {
        expectedRevision: 1,
        ownHostCount: 0,
        otherHostCount: 3,
        impactSnapshot: "a".repeat(64),
        affectedOwners: [
          { userId: "user-member-1", displayName: "Member One" },
          { userId: "user-former-2", displayName: null },
        ],
      });
    },
  );
  context.mocks.api(cloudflareAccessContract.delete, ({ body, respond }) => {
    bodies.push(body);
    return respond(409, {
      error: {
        code: "CLOUDFLARE_ACCESS_IMPACT_CONFLICT",
        message: "private provider detail",
      },
    });
  });
  await sharedDetails();
  click(getAction("button", "Delete Cloudflare Access"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  await within(dialog).findByText(/2 members and 3 hosts/u);
  expect(dialog).toHaveTextContent("Member One");
  expect(dialog).toHaveTextContent("Name unavailable (ID …former-2)");
  expect(dialog.textContent).not.toContain("user-former-2");
  expect(
    getAction("button", "Delete Cloudflare Access", dialog),
  ).toBeDisabled();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: impactAcknowledgement }),
  );
  click(getAction("button", "Delete Cloudflare Access", dialog));
  await within(dialog).findByText(/affected hosts changed/u);
  expect(bodies).toStrictEqual([
    { expectedRevision: 1, impactSnapshot: "a".repeat(64) },
  ]);
  expect(dialog.textContent).not.toContain("private provider detail");
});

test.each([
  {
    status: 409,
    code: "CLOUDFLARE_ACCESS_IMPACT_CONFLICT",
    message:
      "The network or its linked connections changed. Your draft is kept. Reopen the network and review the latest settings before changing who can use it.",
  },
  {
    status: 500,
    code: "INTERNAL_ERROR",
    message:
      "We could not confirm the change. The saved settings have not been verified.",
  },
] as const)(
  "A restriction with status $status preserves its draft and protects provider details",
  async ({ status, code, message }) => {
    const submitted: unknown[] = [];
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, { configs: [{ ...config, scope: "organization" }] });
    });
    context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
      return respond(200, {
        expectedRevision: 1,
        ownHostCount: 0,
        otherHostCount: 1,
        affectedOwners: [
          { userId: "user-member-1", displayName: "Member One" },
        ],
        impactSnapshot: "a".repeat(64),
      });
    });
    context.mocks.api(
      cloudflareAccessContract.convertToPersonal,
      ({ body, respond }) => {
        submitted.push(body);
        return respond(status, {
          error: { code, message: "private provider detail" },
        });
      },
    );
    await sharedDetails();
    const form = await editForm();
    const name = within(form).getByLabelText("Network name");
    click(within(form).getByText("Only me", { exact: true }));
    click(getAction("button", "Save network", form));
    const dialog = await screen.findByRole("dialog", {
      name: "Make this network available only to you?",
    });
    await within(dialog).findByText("Member One");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    click(getAction("button", "Make personal", dialog));
    await within(dialog).findByText(message);
    expect(getAction("button", "Make personal", dialog)).toBeDisabled();
    expect(name).toHaveValue(config.name);
    expect(submitted).toStrictEqual([
      { expectedRevision: 1, impactSnapshot: "a".repeat(64) },
    ]);
    expect(dialog.textContent).not.toContain("private provider detail");
  },
);

test("Restriction preview permission loss blocks the scope change", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [{ ...config, scope: "organization" }] });
  });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(403, {
      error: { code: "CLOUDFLARE_ACCESS_FORBIDDEN", message: "Forbidden" },
    });
  });
  await sharedDetails();
  const form = await editForm();
  click(within(form).getByText("Only me", { exact: true }));
  click(getAction("button", "Save network", form));
  const dialog = await screen.findByRole("dialog", {
    name: "Make this network available only to you?",
  });
  await within(dialog).findByText(
    "This network is unavailable or you no longer have the required administrator permission.",
  );
  expect(getAction("button", "Make personal", dialog)).toBeDisabled();
});
