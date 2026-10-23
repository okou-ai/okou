import {
  tailscaleContract,
  type TailscaleConfig,
  type TailscaleImpactPreview,
} from "@okouai/api-contracts/contracts/tailscale";
import { TAILSCALE_ERROR_CODES } from "@okouai/api-contracts/contracts/tailscale-errors";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  mockOrganization,
  emitMockedClerkEvent,
} from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

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

async function page(role: "admin" | "member" = "member", enabled = true) {
  context.mocks.data.org({ id: orgId, name: "Engineering", role });
  await setupPage({
    context,
    auth,
    path: "/connectors?scope=private-network",
    featureSwitches: { [FeatureSwitchKey.TailscaleAccess]: enabled },
  });
}

async function networkSection() {
  return await screen.findByRole("region", { name: "Tailscale" });
}

test("VNC-only references prevent personal Tailscale deletion", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, {
      configs: [
        {
          ...config,
          vncHosts: [
            {
              id: config.id,
              displayName: "VNC authentication",
              roles: ["kdc"],
            },
          ],
        },
      ],
    });
  });
  await page();
  const section = await networkSection();
  expect(
    (await within(section).findByText("VNC authentication")).closest("li"),
  ).toHaveTextContent("VNC authentication · VNC · Authentication server");
  expect(
    within(section).getByText("Used by 1 of your hosts:"),
  ).toBeInTheDocument();
  expect(getAction("button", "Delete Tailscale", section)).toBeDisabled();
});

async function createForm() {
  const section = await networkSection();
  const trigger = await waitFor(() => {
    return getAction("button", "Add Tailscale", section);
  });
  click(trigger);
  const dialog = await screen.findByRole("dialog");
  const fields = within(dialog);
  await fill(fields.getByLabelText("Name"), "New network");
  await fill(fields.getByLabelText("Registration tags"), "tag:okou, tag:build");
  await fill(fields.getByLabelText("OAuth client ID"), "test-client-id");
  await fill(fields.getByLabelText("OAuth client secret"), "secret-canary");
  return dialog;
}

test("The default-off switch hides Tailscale management and performs no configuration reads", async () => {
  const reads: unknown[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    reads.push(true);
    return respond(200, { configs: [config] });
  });
  await page("member", false);
  await screen.findByRole("heading", { name: "Cloudflare Access" });
  expect(screen.queryByRole("region", { name: "Tailscale" })).toBeNull();
  expect(reads).toHaveLength(0);
});

test("Members see shared metadata without management or other owners' hosts", async () => {
  await page();
  const section = await networkSection();
  await within(section).findByText(shared.name);
  const organization = within(section).getByRole("region", {
    name: "Organization",
  });
  const personal = within(section).getByRole("region", { name: "Personal" });
  expect(within(personal).getByText(config.name)).toBeVisible();
  expect(queryAction("button", "Edit Tailscale", organization)).toBeNull();
  expect(queryAction("button", "Delete Tailscale", organization)).toBeNull();
  click(getAction("button", "Add Tailscale", section));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).queryByRole("combobox", { name: "Who can use this" }),
  ).toBeNull();
});

test("The collapsed setup guide preserves the creation draft and clears secrets after saving", async () => {
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, {
      ...config,
      id: body.id,
      name: body.name,
      tags: body.tags,
    });
  });
  await page();
  const dialog = await createForm();
  const secret = within(dialog).getByLabelText("OAuth client secret");
  expect(secret).toHaveAttribute("type", "password");
  const guide = within(dialog).getByRole("region", {
    name: "How do I configure Tailscale?",
  });
  const toggle = within(guide).getByText("How do I configure Tailscale?");
  const steps = within(guide).getByRole("tablist", { hidden: true });
  expect(steps).not.toBeVisible();
  click(toggle);
  expect(steps).toBeVisible();
  expect(within(guide).getByRole("tabpanel", { name: "Tags" })).toBeVisible();
  click(getAction("tab", "OAuth", guide));
  expect(within(guide).getByRole("tabpanel", { name: "OAuth" })).toBeVisible();
  expect(getAction("link", "Trust credentials", guide)).toHaveAttribute(
    "href",
    "https://console.tailscale.com/admin/settings/trust-credentials",
  );
  click(getAction("tab", "General access rules", guide));
  expect(within(guide).getAllByRole("tabpanel")).toHaveLength(1);
  expect(within(guide).getByText("All users and devices")).toBeVisible();
  expect(within(guide).getByText("All ports and protocols")).toBeVisible();
  click(toggle);
  expect(steps).not.toBeVisible();
  expect(within(dialog).getByLabelText("Name")).toHaveValue("New network");
  expect(within(dialog).getByLabelText("Registration tags")).toHaveValue(
    "tag:okou, tag:build",
  );
  expect(within(dialog).getByLabelText("OAuth client ID")).toHaveValue(
    "test-client-id",
  );
  expect(secret).toHaveValue("secret-canary");
  click(toggle);
  expect(
    within(guide).getByRole("tabpanel", { name: "General access rules" }),
  ).toBeVisible();
  expect(getAction("button", "Save", dialog)).toBeEnabled();
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
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

test("An administrator can explicitly create an organization network", async () => {
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, {
      ...shared,
      id: body.id,
      name: body.name,
      tags: body.tags,
    });
  });
  await page("admin");
  const dialog = await createForm();
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "Who can use this" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "Organization" }),
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toMatchObject([{ scope: "organization" }]);
});

test("Editing metadata does not read or resend stored OAuth credentials", async () => {
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.update, ({ body, respond }) => {
    requests.push(body);
    return respond(200, {
      ...config,
      name: body.name ?? config.name,
      revision: 2,
    });
  });
  await page();
  const section = await networkSection();
  await within(section).findByText(config.name);
  click(
    getAction(
      "button",
      "Edit Tailscale",
      within(section).getByRole("region", { name: "Personal" }),
    ),
  );
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).queryByRole("region", {
      name: "How do I configure Tailscale?",
    }),
  ).toBeNull();
  expect(within(dialog).queryByLabelText("OAuth client secret")).toBeNull();
  await fill(within(dialog).getByLabelText("Name"), "Renamed network");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { expectedRevision: 1, name: "Renamed network", tags: ["tag:okou"] },
  ]);
});

test("Own SSH references block personal network deletion", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, {
      configs: [
        {
          ...config,
          sshHosts: [
            {
              id: "b0000000-0000-4000-8000-000000000001",
              displayName: "Private server",
            },
          ],
        },
      ],
    });
  });
  await page();
  await screen.findByText("Private server");
  const section = await networkSection();
  expect(getAction("button", "Delete Tailscale", section)).toBeDisabled();
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(
    getAction("button", "Why can't I delete this network?", section),
  );
  const explanation = await screen.findByRole("dialog", {
    name: "Delete Tailscale",
  });
  expect(
    within(explanation).getByText(
      "Your SSH or VNC hosts still use this network. Rebind or delete those hosts first.",
    ),
  ).toBeInTheDocument();
});

test("Credential replacement is explicit, clears discarded secrets and updates tags with the revision", async () => {
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.update, ({ body, respond }) => {
    requests.push(body);
    return respond(200, {
      ...config,
      tags: body.tags ?? config.tags,
      revision: 2,
    });
  });
  await page();
  const section = await networkSection();
  await within(section).findByText(config.name);
  click(getAction("button", "Edit Tailscale", section));
  const dialog = await screen.findByRole("dialog");
  const replace = within(dialog).getByRole("checkbox", {
    name: "Replace OAuth credentials",
  });
  await userEvent.click(replace);
  const oldSecret = within(dialog).getByLabelText("OAuth client secret");
  await fill(oldSecret, "discarded-secret-canary");
  await userEvent.click(replace);
  expect(oldSecret).toHaveValue("");
  expect(within(dialog).queryByLabelText("OAuth client secret")).toBeNull();
  await userEvent.click(replace);
  expect(within(dialog).getByLabelText("OAuth client secret")).toHaveValue("");
  await fill(
    within(dialog).getByLabelText("OAuth client ID"),
    "rotated-client",
  );
  await fill(
    within(dialog).getByLabelText("OAuth client secret"),
    "rotated-secret",
  );
  await fill(within(dialog).getByLabelText("Registration tags"), "tag:build");
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
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

test("Realtime impact refresh invalidates an old acknowledgement without discarding the dialog", async () => {
  let currentImpact = impact;
  context.mocks.api(tailscaleContract.impactPreview, ({ respond }) => {
    return respond(200, currentImpact);
  });
  await page("admin");
  const section = await networkSection();
  await within(section).findByText(shared.name);
  click(
    getAction(
      "button",
      "Delete Tailscale",
      within(section).getByRole("region", { name: "Organization" }),
    ),
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(/Other Owner/u);
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
    context.mocks.ably.trigger("tailscale:changed", { orgId });
  });
  await waitFor(() => {
    return expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
  });
  expect(getAction("button", "Delete Tailscale", dialog)).toBeDisabled();
  expect(within(dialog).getByText(shared.name)).toBeVisible();
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
  await page("admin");
  const section = await networkSection();
  await within(section).findByText(shared.name);
  click(
    getAction(
      "button",
      "Delete Tailscale",
      within(section).getByRole("region", { name: "Organization" }),
    ),
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(/Other Owner/u);
  expect(getAction("button", "Delete Tailscale", dialog)).toBeDisabled();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: acknowledgement }),
  );
  click(getAction("button", "Delete Tailscale", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
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
  await page("admin");
  const section = await networkSection();
  await within(section).findByText(shared.name);
  click(getAction("button", "Delete Tailscale", section));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(/Other Owner/u);
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
    return expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
  });
  expect(requests).toHaveLength(0);
  expect(getAction("button", "Delete Tailscale", dialog)).toBeDisabled();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: acknowledgement }),
  );
  click(getAction("button", "Delete Tailscale", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { expectedRevision: 2, impactSnapshot: "d".repeat(64) },
  ]);
});

test("An impact conflict refreshes the snapshot and requires explicit review and acknowledgement", async () => {
  let currentImpact = impact;
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.impactPreview, ({ respond }) => {
    return respond(200, currentImpact);
  });
  context.mocks.api(
    tailscaleContract.convertToPersonal,
    ({ body, respond }) => {
      requests.push(body);
      if (requests.length === 1) {
        currentImpact = {
          ...impact,
          otherHostCount: 3,
          impactSnapshot: "b".repeat(64),
        };
        return respond(409, {
          error: {
            code: TAILSCALE_ERROR_CODES.IMPACT_CONFLICT,
            message: "private-provider-detail",
          },
        });
      }
      return respond(200, {
        ...shared,
        scope: "personal",
        revision: 2,
        generation: 2,
      });
    },
  );
  await page("admin");
  const section = await networkSection();
  await within(section).findByText(shared.name);
  click(
    getAction(
      "button",
      "Make personal",
      within(section).getByRole("region", { name: "Organization" }),
    ),
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(/Other Owner/u);
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: acknowledgement }),
  );
  click(getAction("button", "Make personal", dialog));
  await within(dialog).findByText(
    "The affected hosts changed. Review the latest impact before confirming again.",
  );
  expect(document.body.textContent).not.toContain("private-provider-detail");
  click(getAction("button", "Review latest impact", dialog));
  await within(dialog).findByText(/Affected: 1 member and 3 hosts\./u);
  expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
  expect(getAction("button", "Make personal", dialog)).toBeDisabled();
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: acknowledgement }),
  );
  click(getAction("button", "Make personal", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { expectedRevision: 1, impactSnapshot: "a".repeat(64) },
    { expectedRevision: 1, impactSnapshot: "b".repeat(64) },
  ]);
});

test("An uncertain create retries its original UUID and leaves one saved network", async () => {
  let created: TailscaleConfig | null = null;
  const requests: { id: string }[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: created ? [created] : [] });
  });
  context.mocks.api(tailscaleContract.create, ({ body, respond }) => {
    requests.push(body);
    if (created) {
      return respond(204);
    }
    created = { ...config, id: body.id, name: body.name, tags: body.tags };
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "private-secret-detail" },
    });
  });
  await page();
  const dialog = await createForm();
  click(getAction("button", "Save", dialog));
  await within(dialog).findByRole("alert");
  expect(within(dialog).getByLabelText("OAuth client secret")).toBeDisabled();
  click(getAction("button", "Retry", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  await screen.findByText("New network");
  expect(screen.getAllByText("New network")).toHaveLength(1);
  expect(requests).toStrictEqual([requests[0], requests[0]]);
  expect(document.body.textContent).not.toContain("private-secret-detail");
});

test("Changing organizations unmounts the draft, clears secrets and hides old network metadata", async () => {
  context.mocks.data.org({ id: "org_next", name: "Next", role: "member" });
  await page();
  const dialog = await createForm();
  const secret = within(dialog).getByLabelText("OAuth client secret");
  await act(() => {
    mockOrganization({
      activeOrg: { id: "org_next", name: "Next" },
      memberships: [{ id: "org_next" }],
    });
    emitMockedClerkEvent();
  });
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(secret).toHaveValue("");
  expect(screen.queryByText(config.name)).toBeNull();
  expect(screen.queryByText(shared.name)).toBeNull();
  await act(() => {
    mockOrganization(auth.organization);
    emitMockedClerkEvent();
  });
  await screen.findByText(config.name);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Promotion requires explicit sharing acknowledgement and preserves the resource identity", async () => {
  const requests: unknown[] = [];
  context.mocks.api(
    tailscaleContract.convertToOrganization,
    ({ params, body, respond }) => {
      requests.push({ params: { configId: params.configId }, body });
      return respond(200, {
        ...config,
        scope: "organization",
        revision: 2,
        generation: 2,
      });
    },
  );
  await page("admin");
  const section = await networkSection();
  await within(section).findByText(config.name);
  click(
    getAction(
      "button",
      "Make organization",
      within(section).getByRole("region", { name: "Personal" }),
    ),
  );
  const dialog = await screen.findByRole("dialog");
  expect(getAction("button", "Make organization", dialog)).toBeDisabled();
  await userEvent.click(within(dialog).getByRole("checkbox"));
  click(getAction("button", "Make organization", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { params: { configId: config.id }, body: { expectedRevision: 1 } },
  ]);
});

test("Revision review preserves a draft and permits restoring the original metadata", async () => {
  let current = config;
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(tailscaleContract.update, ({ body, respond }) => {
    requests.push(body);
    if (requests.length === 1) {
      current = {
        ...config,
        name: "Server rename",
        revision: 2,
        generation: 2,
      };
      return respond(409, {
        error: {
          code: TAILSCALE_ERROR_CODES.REVISION_CONFLICT,
          message: "private-provider-detail",
        },
      });
    }
    return respond(200, {
      ...current,
      name: body.name ?? current.name,
      revision: 3,
    });
  });
  await page();
  const section = await networkSection();
  await within(section).findByText(config.name);
  click(getAction("button", "Edit Tailscale", section));
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Name"), "My draft");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText("Server rename");
  expect(within(dialog).getByLabelText("Name")).toHaveValue("My draft");
  expect(getAction("button", "Save", dialog)).toBeDisabled();
  await fill(within(dialog).getByLabelText("Name"), config.name);
  click(getAction("button", "Keep my changes with this version", dialog));
  await waitFor(() => {
    return expect(getAction("button", "Save", dialog)).toBeEnabled();
  });
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { expectedRevision: 1, name: "My draft", tags: ["tag:okou"] },
    { expectedRevision: 2, name: config.name, tags: ["tag:okou"] },
  ]);
});

test("Escape discards a secret draft and returns focus to the Add control", async () => {
  await page();
  const section = await networkSection();
  const trigger = getAction("button", "Add Tailscale", section);
  await userEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  const secret = within(dialog).getByLabelText("OAuth client secret");
  await fill(secret, "escape-secret-canary");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(secret).toHaveValue("");
  expect(trigger).toHaveFocus();
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
  const secret = within(first).getByLabelText("OAuth client secret");
  click(getAction("button", "Save", first));
  await started.promise;
  await act(() => {
    mockOrganization({
      activeOrg: { id: "org_next", name: "Next" },
      memberships: [{ id: "org_next" }],
    });
    emitMockedClerkEvent();
  });
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(secret).toHaveValue("");
  await act(() => {
    mockOrganization(auth.organization);
    emitMockedClerkEvent();
  });
  const next = await createForm();
  await fill(within(next).getByLabelText("Name"), "Second draft");
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  expect(within(next).getByLabelText("Name")).toHaveValue("Second draft");
  expect(within(next).getByLabelText("OAuth client secret")).toHaveValue(
    "secret-canary",
  );
});
