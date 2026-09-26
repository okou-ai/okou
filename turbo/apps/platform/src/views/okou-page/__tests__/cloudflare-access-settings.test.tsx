import {
  cloudflareAccessContract,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_cloudflare_access";
const timestamp = "2026-09-22T00:00:00.000Z";
const config: ScopedCloudflareAccessConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Protected applications",
  scope: "personal",
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

function expectConversionActionsInOrder(dialog: HTMLElement) {
  const actions = queryAllByRoleFast("button", dialog)
    .map((button) => {
      return button.textContent?.trim();
    })
    .filter((label) => {
      return label === "Cancel" || label === "Make personal";
    });
  expect(actions).toStrictEqual(["Cancel", "Make personal"]);
}

test("The scoped page shows shared configurations to members without management or other users' metadata", async () => {
  const shared = {
    ...config,
    id: "a0000000-0000-4000-8000-000000000002",
    name: "Team gateway",
    scope: "organization" as const,
    sshHosts: [],
  };
  context.mocks.api(cloudflareAccessContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({ view: "scoped" });
    return respond(200, { configs: [config, shared] });
  });
  await page();
  const personal = await screen.findByRole("region", { name: "Personal" });
  const organization = screen.getByRole("region", { name: "Organization" });
  expect(within(personal).getByText(config.name)).toBeVisible();
  expect(within(organization).getByText(shared.name)).toBeVisible();
  expect(
    queryAction("button", "Edit Cloudflare Access", organization),
  ).toBeNull();
  expect(
    queryAction("button", "Delete Cloudflare Access", organization),
  ).toBeNull();
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.trim() === "Add Cloudflare Access";
    }),
  ).toHaveLength(1);
  expect(document.body.textContent).not.toContain("other-member-host");
  expect(document.body.textContent).not.toContain("client-secret-canary");
  click(getAction("button", "Add Cloudflare Access"));
  expect(
    within(await screen.findByRole("dialog")).queryByRole("combobox", {
      name: "Who can use this",
    }),
  ).toBeNull();
});

test("An admin can create a shared configuration from the single Add entry", async () => {
  const requests: unknown[] = [];
  context.mocks.api(
    cloudflareAccessContract.create,
    ({ body, query, respond }) => {
      requests.push({ body, query });
      return respond(201, {
        ...config,
        id: body.id,
        name: body.name,
        scope: "organization",
      });
    },
  );
  await page(undefined, "admin");
  click(getAction("button", "Add Cloudflare Access"));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(
    screen.getByRole("combobox", { name: "Who can use this" }),
  );
  click(await screen.findByRole("option", { name: "Organization" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Who can use this" }),
    ).toHaveTextContent("Organization");
  });
  expect(dialog.isConnected).toBeTruthy();
  await tokenFields(dialog, "Shared gateway");
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  expect(
    Array.from(dialog.querySelectorAll(":invalid")).map((element) => {
      return element.outerHTML;
    }),
  ).toStrictEqual([]);
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  expect(requests[0]).toMatchObject({
    query: { view: "scoped" },
    body: { name: "Shared gateway", scope: "organization" },
  });
});

test("An admin can edit and delete a shared configuration through scoped mutations", async () => {
  const shared: ScopedCloudflareAccessConfig = {
    ...config,
    name: "Shared gateway",
    scope: "organization",
  };
  let configs: ScopedCloudflareAccessConfig[] = [shared];
  const updates: unknown[] = [];
  const deletes: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(
    cloudflareAccessContract.update,
    ({ body, query, respond }) => {
      updates.push({ body, query });
      const renamed = {
        ...shared,
        name: body.name ?? shared.name,
        revision: 2,
      };
      configs = [renamed];
      return respond(200, renamed);
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
      configs = [];
      return respond(204);
    },
  );
  await page(undefined, "admin");
  const organization = await screen.findByRole("region", {
    name: "Organization",
  });
  await within(organization).findByText("Shared gateway");
  click(getAction("button", "Edit Cloudflare Access", organization));
  const edit = await screen.findByRole("dialog");
  await fill(within(edit).getByLabelText("Name"), "Updated gateway");
  click(getAction("button", "Save", edit));
  await waitFor(() => {
    expect(updates).toHaveLength(1);
  });
  await screen.findByText("Updated gateway");
  expect(updates).toStrictEqual([
    {
      query: { view: "scoped" },
      body: { expectedRevision: 1, name: "Updated gateway" },
    },
  ]);
  click(
    getAction(
      "button",
      "Delete Cloudflare Access",
      screen.getByRole("region", { name: "Organization" }),
    ),
  );
  const deletion = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(
      getAction("button", "Delete Cloudflare Access", deletion),
    ).toBeEnabled();
  });
  click(getAction("button", "Delete Cloudflare Access", deletion));
  await screen.findByText("0 Cloudflare Access configured");
  expect(
    within(screen.getByRole("region", { name: "Organization" })).getByText(
      "No configurations here yet.",
    ),
  ).toBeInTheDocument();
  expect(deletes).toStrictEqual([
    {
      query: { view: "scoped" },
      body: { expectedRevision: 2, impactSnapshot: "a".repeat(64) },
    },
  ]);
});

test("Switching organizations navigates away from an open shared Access editor", async () => {
  const otherOrgId = "org_cloudflare_access_other";
  const shared = {
    ...config,
    name: "Old workspace gateway",
    scope: "organization" as const,
  };
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  await page(undefined, "admin");
  await screen.findByText(shared.name);
  click(
    getAction(
      "button",
      "Edit Cloudflare Access",
      screen.getByRole("region", { name: "Organization" }),
    ),
  );
  await screen.findByRole("dialog", { name: "Edit Cloudflare Access" });

  const clerk = context.mocks.clerk();
  act(() => {
    clerk.organization({
      activeOrg: { id: otherOrgId, name: "Other workspace" },
      memberships: [{ id: orgId }, { id: otherOrgId }],
    });
    clerk.stateChanged();
  });

  await waitFor(() => {
    expect(window.location.pathname).toBe("/");
  });
});

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
  let configs: ScopedCloudflareAccessConfig[] = [];
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
  let configs: ScopedCloudflareAccessConfig[] = [config];
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
  let configs: ScopedCloudflareAccessConfig[] = [];
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
      scope: "personal",
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

test("admin conversion lists affected members and only the aggregate host count before confirmation", async () => {
  const shared: ScopedCloudflareAccessConfig = {
    ...config,
    scope: "organization",
    name: "Team gateway",
  };
  let configs: ScopedCloudflareAccessConfig[] = [shared];
  const submitted: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(
    cloudflareAccessContract.impactPreview,
    ({ query, respond }) => {
      expect(query.operation).toBe("convert");
      return respond(200, {
        expectedRevision: 1,
        ownHostCount: 1,
        otherHostCount: 3,
        affectedOwners: [
          { userId: "user-member-1", displayName: "Member One" },
          { userId: "user-member-2", displayName: "Member Two" },
        ],
        impactSnapshot: "a".repeat(64),
      });
    },
  );
  context.mocks.api(
    cloudflareAccessContract.convertToPersonal,
    ({ body, respond }) => {
      submitted.push(body);
      const personal = { ...shared, scope: "personal" as const, revision: 2 };
      configs = [personal];
      return respond(200, personal);
    },
  );
  await page(undefined, "admin");
  const organization = await screen.findByRole("region", {
    name: "Organization",
  });
  await within(organization).findByText(shared.name);
  click(getAction("button", "Make personal", organization));
  const dialog = await screen.findByRole("dialog", { name: "Make personal" });
  expect(
    within(dialog).getByText(
      /will become your own Personal configuration, even if someone else created it/u,
    ),
  ).toBeInTheDocument();
  const warning = await within(dialog).findByRole("alert");
  expect(warning).toHaveTextContent("2 members and 3 SSH hosts");
  expect(dialog).toHaveTextContent("Member One");
  expect(dialog).toHaveTextContent("Member Two");
  expect(dialog.textContent).not.toContain("user-member-1");
  expect(dialog.textContent).not.toContain("other-member-host");
  const confirm = getAction("button", "Make personal", dialog);
  expectConversionActionsInOrder(dialog);
  expect(getAction("button", "Cancel", dialog)).toBeEnabled();
  expect(confirm).toBeDisabled();
  await userEvent.click(
    within(dialog).getByRole("checkbox", {
      name: /I understand these hosts will need their owners/u,
    }),
  );
  expect(confirm).toBeEnabled();
  click(confirm);
  await waitFor(() => {
    expect(submitted).toStrictEqual([
      { expectedRevision: 1, impactSnapshot: "a".repeat(64) },
    ]);
  });
  expect(
    within(screen.getByRole("region", { name: "Personal" })).getByText(
      shared.name,
    ),
  ).toBeVisible();
});

test("zero-impact conversion needs no other-user warning", async () => {
  const shared: ScopedCloudflareAccessConfig = {
    ...config,
    scope: "organization",
  };
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(200, {
      expectedRevision: 1,
      ownHostCount: 0,
      otherHostCount: 0,
      affectedOwners: [],
      impactSnapshot: "b".repeat(64),
    });
  });
  await page(undefined, "admin");
  const organization = await screen.findByRole("region", {
    name: "Organization",
  });
  await within(organization).findByText(shared.name);
  click(getAction("button", "Make personal", organization));
  const dialog = await screen.findByRole("dialog", { name: "Make personal" });
  expect(
    within(dialog).getByText(
      /will become your own Personal configuration, even if someone else created it/u,
    ),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(getAction("button", "Make personal", dialog)).toBeEnabled();
  });
  expectConversionActionsInOrder(dialog);
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
});

test("changed conversion impact requires a fresh warning and confirmation", async () => {
  const shared: ScopedCloudflareAccessConfig = {
    ...config,
    scope: "organization",
  };
  const requests: unknown[] = [];
  let count = 1;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(200, {
      expectedRevision: 1,
      ownHostCount: 0,
      otherHostCount: count,
      affectedOwners: [{ userId: "user-member-1", displayName: "Member One" }],
      impactSnapshot: (count === 1 ? "a" : "b").repeat(64),
    });
  });
  context.mocks.api(
    cloudflareAccessContract.convertToPersonal,
    ({ body, respond }) => {
      requests.push(body);
      count = 2;
      return respond(409, {
        error: {
          code: "CLOUDFLARE_ACCESS_IMPACT_CONFLICT",
          message: "Impact changed",
        },
      });
    },
  );
  await page(undefined, "admin");
  const organization = await screen.findByRole("region", {
    name: "Organization",
  });
  await within(organization).findByText(shared.name);
  click(getAction("button", "Make personal", organization));
  const dialog = await screen.findByRole("dialog", { name: "Make personal" });
  await within(dialog).findByText(/1 member and 1 SSH host/u);
  const acknowledge = within(dialog).getByRole("checkbox", {
    name: /I understand these hosts will need their owners/u,
  });
  await userEvent.click(acknowledge);
  click(getAction("button", "Make personal", dialog));
  await within(dialog).findByText(/affected hosts changed/u);
  expect(requests).toStrictEqual([
    { expectedRevision: 1, impactSnapshot: "a".repeat(64) },
  ]);
  expect(queryAction("button", "Make personal", dialog)).toBeNull();
  click(getAction("button", "Review latest impact", dialog));
  await within(dialog).findByText(/1 member and 2 SSH hosts/u);
  expect(getAction("button", "Make personal", dialog)).toBeDisabled();
  expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
});

test("uncertain conversion result requires a fresh named impact review", async () => {
  const shared: ScopedCloudflareAccessConfig = {
    ...config,
    scope: "organization",
  };
  let previewCount = 0;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    previewCount += 1;
    return respond(200, {
      expectedRevision: 1,
      ownHostCount: 0,
      otherHostCount: 1,
      affectedOwners: [{ userId: "user-member-1", displayName: "Member One" }],
      impactSnapshot: (previewCount === 1 ? "a" : "b").repeat(64),
    });
  });
  context.mocks.api(
    cloudflareAccessContract.convertToPersonal,
    ({ respond }) => {
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "private provider detail" },
      });
    },
  );
  await page(undefined, "admin");
  const organization = await screen.findByRole("region", {
    name: "Organization",
  });
  await within(organization).findByText(shared.name);
  click(getAction("button", "Make personal", organization));
  const dialog = await screen.findByRole("dialog", { name: "Make personal" });
  await within(dialog).findByText(/1 member and 1 SSH host/u);
  expect(dialog).toHaveTextContent("Member One");
  await userEvent.click(within(dialog).getByRole("checkbox"));
  click(getAction("button", "Make personal", dialog));
  await within(dialog).findByText(/could not confirm the conversion/u);
  expect(queryAction("button", "Make personal", dialog)).toBeNull();
  expect(dialog.textContent).not.toContain("private provider detail");
  click(getAction("button", "Review latest impact", dialog));
  await waitFor(() => {
    expect(previewCount).toBe(2);
    expect(getAction("button", "Make personal", dialog)).toBeDisabled();
  });
  expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
});

test("conversion preview 403 blocks conversion", async () => {
  const shared = { ...config, scope: "organization" as const };
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(403, {
      error: { code: "CLOUDFLARE_ACCESS_FORBIDDEN", message: "Forbidden" },
    });
  });
  await page(undefined, "admin");
  const organization = await screen.findByRole("region", {
    name: "Organization",
  });
  click(getAction("button", "Make personal", organization));
  const dialog = await screen.findByRole("dialog", { name: "Make personal" });
  await within(dialog).findByText(/no longer available/u);
  expect(queryAction("button", "Make personal", dialog)).toBeNull();
});

test("only an admin can promote their Personal configuration with explicit audience confirmation", async () => {
  let configs: ScopedCloudflareAccessConfig[] = [config];
  const bodies: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(
    cloudflareAccessContract.convertToOrganization,
    ({ body, respond }) => {
      bodies.push(body);
      const promoted = {
        ...config,
        scope: "organization" as const,
        revision: 2,
      };
      configs = [promoted];
      return respond(200, promoted);
    },
  );
  await page(undefined, "admin");
  const personal = await screen.findByRole("region", { name: "Personal" });
  click(getAction("button", "Make organization", personal));
  const dialog = await screen.findByRole("dialog", {
    name: "Make organization",
  });
  expect(dialog).toHaveTextContent(
    "Service Token and your SSH host bindings stay unchanged",
  );
  expect(getAction("button", "Make organization", dialog)).toBeDisabled();
  await userEvent.click(within(dialog).getByRole("checkbox"));
  click(getAction("button", "Make organization", dialog));
  await waitFor(() => {
    return expect(bodies).toStrictEqual([{ expectedRevision: 1 }]);
  });
  await within(screen.getByRole("region", { name: "Organization" })).findByText(
    config.name,
  );
});

test("a member cannot see the Personal promotion action", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  await page();
  const personal = await screen.findByRole("region", { name: "Personal" });
  await within(personal).findByText(config.name);
  expect(queryAction("button", "Make organization", personal)).toBeNull();
});

test("equal member names are disambiguated without showing per-person host counts", async () => {
  const shared = { ...config, scope: "organization" as const };
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(200, {
      expectedRevision: 1,
      ownHostCount: 0,
      otherHostCount: 5,
      impactSnapshot: "c".repeat(64),
      affectedOwners: [
        { userId: "user_aaaaaaaa", displayName: "Same Name" },
        { userId: "user_bbbbbbbb", displayName: "Same Name" },
      ],
    });
  });
  await page(undefined, "admin");
  const organization = await screen.findByRole("region", {
    name: "Organization",
  });
  click(getAction("button", "Make personal", organization));
  const dialog = await screen.findByRole("dialog", { name: "Make personal" });
  await within(dialog).findByText(/2 members and 5 SSH hosts/u);
  expect(dialog).toHaveTextContent("Same Name (ID …aaaaaaaa)");
  expect(dialog).toHaveTextContent("Same Name (ID …bbbbbbbb)");
  expect(dialog.textContent).not.toContain("user_aaaaaaaa");
  expect(getAction("button", "Make personal", dialog)).toBeDisabled();
});

test("deletion preview 403 blocks deletion", async () => {
  const shared = { ...config, scope: "organization" as const };
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(403, {
      error: { code: "CLOUDFLARE_ACCESS_FORBIDDEN", message: "Forbidden" },
    });
  });
  await page(undefined, "admin");
  const organization = await screen.findByRole("region", {
    name: "Organization",
  });
  click(getAction("button", "Delete Cloudflare Access", organization));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  await within(dialog).findByText(/no longer available/u);
  expect(queryAction("button", "Delete Cloudflare Access", dialog)).toBeNull();
});

test("reviewed shared deletion names affected owners and requires re-review when the host set changes", async () => {
  const shared = {
    ...config,
    scope: "organization" as const,
    name: "Shared gateway",
  };
  let impact = "a".repeat(64);
  const bodies: unknown[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(
    cloudflareAccessContract.impactPreview,
    ({ query, respond }) => {
      expect(query.operation).toBe("delete");
      return respond(200, {
        expectedRevision: 1,
        ownHostCount: 0,
        otherHostCount: impact.startsWith("a") ? 3 : 4,
        impactSnapshot: impact,
        affectedOwners: [
          { userId: "user-member-1", displayName: "Member One" },
          { userId: "user-former-2", displayName: null },
        ],
      });
    },
  );
  context.mocks.api(cloudflareAccessContract.delete, ({ body, respond }) => {
    bodies.push(body);
    impact = "b".repeat(64);
    return respond(409, {
      error: {
        code: "CLOUDFLARE_ACCESS_IMPACT_CONFLICT",
        message: "Impact changed",
      },
    });
  });
  await page(undefined, "admin");
  const organization = await screen.findByRole("region", {
    name: "Organization",
  });
  click(getAction("button", "Delete Cloudflare Access", organization));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  await within(dialog).findByText(/2 members and 3 SSH hosts/u);
  expect(dialog).toHaveTextContent("Member One");
  expect(dialog).toHaveTextContent("Name unavailable (ID …former-2)");
  expect(dialog.textContent).not.toContain("user-former-2");
  expect(dialog.textContent).not.toContain("Former member");
  expect(
    getAction("button", "Delete Cloudflare Access", dialog),
  ).toBeDisabled();
  await userEvent.click(within(dialog).getByRole("checkbox"));
  click(getAction("button", "Delete Cloudflare Access", dialog));
  await within(dialog).findByText(/affected hosts changed/u);
  expect(bodies).toStrictEqual([
    { expectedRevision: 1, impactSnapshot: "a".repeat(64) },
  ]);
  click(getAction("button", "Review latest impact", dialog));
  await within(dialog).findByText(/2 members and 4 SSH hosts/u);
  expect(
    getAction("button", "Delete Cloudflare Access", dialog),
  ).toBeDisabled();
});
