import {
  tailscaleContract,
  type TailscaleConfig,
  type TailscaleImpactPreview,
} from "@okouai/api-contracts/contracts/tailscale";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  mockOrganization,
  emitMockedClerkEvent,
} from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_tailscale_settings";
const auth = Object.freeze({
  user: { id: "tailscale-owner", fullName: "Tailscale Owner" },
  organization: {
    activeOrg: { id: orgId, name: "Engineering" },
    memberships: [{ id: orgId }],
  },
});
const config: TailscaleConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Development network",
  scope: "personal",
  tags: ["tag:okou"],
  revision: 1,
  generation: 1,
  sshHosts: [],
  vncHosts: [],
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
});
const shared: TailscaleConfig = Object.freeze({
  ...config,
  id: "a0000000-0000-4000-8000-000000000002",
  name: "Team network",
  scope: "organization",
});
const impact: TailscaleImpactPreview = Object.freeze({
  expectedRevision: 1,
  ownHostCount: 0,
  otherHostCount: 2,
  affectedOwners: [{ userId: "other-owner", displayName: "Other Owner" }],
  impactSnapshot: "a".repeat(64),
});
const acknowledgement =
  "I understand these members' hosts will remain saved but cannot connect until their owners rebind them.";

beforeEach(() => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [config, shared] });
  });
});

async function page(
  path = "/connectors?scope=private-network",
  role: "admin" | "member" = "member",
) {
  context.mocks.data.org({ id: orgId, name: "Engineering", role });
  await setupPage({ context, auth, path });
}

async function createForm() {
  click(getAction("button", "Add network"));
  await screen.findByRole("heading", { name: "Add a private network" });
  click(screen.getByText("Tailscale", { exact: true }));
  await screen.findByRole("dialog", { name: "Download Tailscale" });
  click(getAction("button", "Enter existing credentials"));
  const name = await screen.findByLabelText("Network name");
  const form = name.closest("form")!;
  await fill(name, "New network");
  click(within(form).getByText("Allowed tags", { selector: "summary" }));
  await fill(
    within(form).getByLabelText("Allowed tags"),
    "tag:okou, tag:build",
  );
  await fill(within(form).getByLabelText("Client ID"), "test-client-id");
  await fill(within(form).getByLabelText("Client Secret"), "secret-canary");
  return form;
}

async function editPersonal() {
  await page(
    `/connectors?scope=private-network&remoteResource=tailscale:${config.id}`,
  );
  await screen.findByRole("heading", { name: config.name });
  click(getAction("button", "Edit settings"));
  const name = await screen.findByLabelText("Network name");
  return name.closest("form")!;
}

async function sharedDeletion() {
  await page(
    `/connectors?scope=private-network&remoteResource=tailscale:${shared.id}`,
    "admin",
  );
  await screen.findByRole("heading", { name: shared.name });
  click(getAction("button", "Delete Tailscale"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete Tailscale",
  });
  await within(dialog).findByText(/Other Owner/u);
  return dialog;
}

test("Creating a network saves the entered tags and clears credentials", async () => {
  let configs: TailscaleConfig[] = [];
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(tailscaleContract.create, ({ body, respond }) => {
    requests.push(body);
    const created = {
      ...config,
      id: body.id,
      name: body.name,
      tags: body.tags,
    };
    configs = [created];
    return respond(201, created);
  });
  await page();
  const form = await createForm();
  const secret = within(form).getByLabelText("Client Secret");
  expect(secret).toHaveAttribute("type", "password");
  click(getAction("button", "Save network", form));
  await screen.findByText("New network");
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      scope: "personal",
      name: "New network",
      tags: ["tag:okou", "tag:build"],
      credentials: {
        clientId: "test-client-id",
        clientSecret: "secret-canary",
      },
    },
  ]);
  expect(secret).toHaveValue("");
  expect(document.body.textContent).not.toContain("secret-canary");
});

test("Credential replacement clears discarded secrets and updates tags against the current revision", async () => {
  let current = config;
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(tailscaleContract.update, ({ body, respond }) => {
    requests.push(body);
    current = { ...config, tags: body.tags ?? config.tags, revision: 2 };
    return respond(200, current);
  });
  const form = await editPersonal();
  const replace = within(form).getByRole("checkbox", {
    name: "Replace OAuth credentials",
  });
  await userEvent.click(replace);
  const discarded = within(form).getByLabelText("Client Secret");
  await fill(discarded, "discarded-secret-canary");
  await userEvent.click(replace);
  expect(discarded).toHaveValue("");
  await userEvent.click(replace);
  const secret = within(form).getByLabelText("Client Secret");
  expect(secret).toHaveValue("");
  await fill(within(form).getByLabelText("Client ID"), "rotated-client");
  await fill(secret, "rotated-secret");
  await fill(within(form).getByLabelText("Allowed tags"), "tag:build");
  click(getAction("button", "Save network", form));
  await screen.findByRole("heading", { name: config.name });
  expect(requests).toStrictEqual([
    {
      expectedRevision: 1,
      name: config.name,
      tags: ["tag:build"],
      credentials: {
        clientId: "rotated-client",
        clientSecret: "rotated-secret",
      },
    },
  ]);
});

test("Realtime impact refresh invalidates an old acknowledgement without discarding deletion", async () => {
  let currentImpact = impact;
  context.mocks.api(tailscaleContract.impactPreview, ({ respond }) => {
    return respond(200, currentImpact);
  });
  const dialog = await sharedDeletion();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: acknowledgement }),
  );
  expect(getAction("button", "Delete Tailscale", dialog)).toBeEnabled();
  currentImpact = {
    ...impact,
    otherHostCount: 3,
    impactSnapshot: "c".repeat(64),
  };
  await act(() => {
    return context.mocks.ably.trigger("tailscale:changed", { orgId });
  });
  await within(dialog).findByText(/1 member and 3 hosts/u);
  expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
  expect(getAction("button", "Delete Tailscale", dialog)).toBeDisabled();
  expect(within(dialog).getByText(shared.name)).toBeInTheDocument();
});

test("Shared deletion acknowledges fresh impact without exposing other host identities", async () => {
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.impactPreview, ({ query, respond }) => {
    expect(query).toStrictEqual({ operation: "delete" });
    return respond(200, impact);
  });
  context.mocks.api(tailscaleContract.delete, ({ body, respond }) => {
    requests.push(body);
    return respond(204);
  });
  const dialog = await sharedDeletion();
  expect(getAction("button", "Delete Tailscale", dialog)).toBeDisabled();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: acknowledgement }),
  );
  click(getAction("button", "Delete Tailscale", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { expectedRevision: 1, impactSnapshot: impact.impactSnapshot },
  ]);
});

test("A refreshed shared revision is deleted only after acknowledging its current impact", async () => {
  let current = shared;
  let currentImpact = impact;
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(tailscaleContract.impactPreview, ({ respond }) => {
    return respond(200, currentImpact);
  });
  context.mocks.api(tailscaleContract.delete, ({ body, respond }) => {
    requests.push(body);
    return respond(204);
  });
  const dialog = await sharedDeletion();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: acknowledgement }),
  );
  current = {
    ...shared,
    name: "Changed shared network",
    revision: 2,
    generation: 2,
  };
  currentImpact = {
    ...impact,
    expectedRevision: 2,
    impactSnapshot: "d".repeat(64),
  };
  await act(() => {
    return context.mocks.ably.trigger("tailscale:changed", { orgId });
  });
  await waitFor(() => {
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
  });
  expect(getAction("button", "Delete Tailscale", dialog)).toBeDisabled();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: acknowledgement }),
  );
  click(getAction("button", "Delete Tailscale", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { expectedRevision: 2, impactSnapshot: "d".repeat(64) },
  ]);
});

test("An unconfirmed network creation keeps the credential draft frozen without exposing provider details", async () => {
  context.mocks.api(tailscaleContract.create, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "private-secret-detail" },
    });
  });
  await page();
  const form = await createForm();
  click(getAction("button", "Save network", form));
  await within(form).findByRole("alert");
  expect(within(form).getByLabelText("Client Secret")).toBeDisabled();
  expect(within(form).getByLabelText("Client Secret")).toHaveValue(
    "secret-canary",
  );
  expect(getAction("button", "Save network", form)).toBeDisabled();
  expect(document.body.textContent).not.toContain("private-secret-detail");
});

test("Changing organizations unmounts the draft and clears secrets", async () => {
  context.mocks.data.org({ id: "org_next", name: "Next", role: "member" });
  await page();
  const form = await createForm();
  const secret = within(form).getByLabelText("Client Secret");
  await act(() => {
    mockOrganization({
      activeOrg: { id: "org_next", name: "Next" },
      memberships: [{ id: "org_next" }],
    });
    emitMockedClerkEvent();
  });
  await screen.findByTestId("connectors-scroll-content");
  expect(window.location.pathname).toBe("/connectors");
  expect(form).not.toBeInTheDocument();
  expect(secret).toHaveValue("");
  expect(screen.queryByLabelText("Client Secret")).toBeNull();
});

test("Leaving the network editor clears a secret draft before starting again", async () => {
  await page();
  const first = await createForm();
  const secret = within(first).getByLabelText("Client Secret");
  click(getAction("button", "Back"));
  await screen.findByText(config.name);
  const next = await createForm();
  expect(secret).toHaveValue("");
  expect(within(next).getByLabelText("Client Secret")).toHaveValue(
    "secret-canary",
  );
});

test("Changing organizations during save clears secrets and fences a late response", async () => {
  const pending = context.mocks.deferred<void>();
  const started = context.mocks.deferred<void>();
  context.mocks.data.org({ id: "org_next", name: "Next", role: "member" });
  context.mocks.api(tailscaleContract.create, async ({ body, respond }) => {
    started.resolve();
    await pending.promise;
    return respond(201, { ...config, id: body.id });
  });
  await page();
  const first = await createForm();
  const secret = within(first).getByLabelText("Client Secret");
  click(getAction("button", "Save network", first));
  await started.promise;
  await act(() => {
    mockOrganization({
      activeOrg: { id: "org_next", name: "Next" },
      memberships: [{ id: "org_next" }],
    });
    emitMockedClerkEvent();
  });
  await screen.findByTestId("connectors-scroll-content");
  expect(window.location.pathname).toBe("/connectors");
  expect(first).not.toBeInTheDocument();
  expect(secret).toHaveValue("");
  expect(screen.queryByLabelText("Client Secret")).toBeNull();
  await act(() => {
    mockOrganization(auth.organization);
    emitMockedClerkEvent();
  });
  click(getAction("link", "Connectors"));
  await screen.findByTestId("connectors-scope-private-network");
  click(screen.getByTestId("connectors-scope-private-network"));
  await screen.findByText(config.name);
  const next = await createForm();
  await fill(within(next).getByLabelText("Network name"), "Second draft");
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  expect(within(next).getByLabelText("Network name")).toHaveValue(
    "Second draft",
  );
  expect(within(next).getByLabelText("Client Secret")).toHaveValue(
    "secret-canary",
  );
});

test("An impact conflict rejects an outdated network restriction without exposing provider details", async () => {
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.impactPreview, ({ respond }) => {
    return respond(200, impact);
  });
  context.mocks.api(
    tailscaleContract.convertToPersonal,
    ({ body, respond }) => {
      requests.push(body);
      return respond(409, {
        error: {
          code: "TAILSCALE_IMPACT_CONFLICT",
          message: "private-provider-detail",
        },
      });
    },
  );
  await page(
    `/connectors?scope=private-network&remoteResource=tailscale:${shared.id}`,
    "admin",
  );
  await screen.findByRole("heading", { name: shared.name });
  click(getAction("button", "Edit settings"));
  await screen.findByLabelText("Network name");
  click(screen.getByText("Only me", { exact: true }));
  click(getAction("button", "Save network"));
  const dialog = await screen.findByRole("dialog", {
    name: "Make this network available only to you?",
  });
  await within(dialog).findByText("Other Owner");
  await userEvent.click(within(dialog).getByRole("checkbox"));
  click(getAction("button", "Make personal", dialog));
  await within(dialog).findByText(
    "The network or its linked connections changed. Your draft is kept. Reopen the network and review the latest settings before changing who can use it.",
  );
  expect(getAction("button", "Make personal", dialog)).toBeDisabled();
  expect(document.body.textContent).not.toContain("private-provider-detail");
  expect(requests).toStrictEqual([
    { expectedRevision: 1, impactSnapshot: "a".repeat(64) },
  ]);
});
