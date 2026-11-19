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

test.each([
  {
    status: 409,
    code: "CLOUDFLARE_ACCESS_IN_USE",
    message:
      "This Cloudflare Access is still in use. Unbind or rebind its dependent hosts and custom connectors first.",
  },
] as const)(
  "A restriction rejected with $code preserves its draft and protects provider details",
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
