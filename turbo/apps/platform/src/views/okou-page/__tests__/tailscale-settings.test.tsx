import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import {
  tailscaleContract,
  type CreateTailscaleConfigRequest,
  type TailscaleConfig,
  type TailscaleImpactPreview,
} from "@okouai/api-contracts/contracts/tailscale";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  type RemoteInventory,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const SECRET = "tskey-client-secret-7781";
const PROVIDER_DETAIL = "tailnet acl hash 9f3e rejected the client";

function network(
  index: number,
  name: string,
  overrides: Partial<TailscaleConfig> = {},
): TailscaleConfig {
  return {
    id: remoteId("a", index),
    name,
    scope: "personal",
    tags: ["tag:okou"],
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
    ...overrides,
  };
}

function impact(otherHostCount: number, mark: string): TailscaleImpactPreview {
  return {
    expectedRevision: 1,
    ownHostCount: 0,
    otherHostCount,
    affectedOwners: [{ userId: "user_member", displayName: "Morgan Lee" }],
    impactSnapshot: mark.repeat(64),
  };
}

function choiceButton(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Expected the "${text}" choice`);
  }
  return button;
}

function scopeRadio(label: string): HTMLElement {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => {
      return candidate.textContent?.trim().startsWith(label);
    },
  );
  const radio = owner && queryAllByRoleFast("radio", owner)[0];
  if (!radio) {
    throw new Error(`Expected the "${label}" scope`);
  }
  return radio;
}

function acknowledgement(container: HTMLElement): HTMLElement {
  return within(container).getByRole("checkbox", { name: /^I understand/ });
}

async function openPrivateNetworks(): Promise<void> {
  await setupPage({ context, path: "/connectors?scope=private-network" });
  await waitFor(() => {
    expect(getConnectorAction("button", "Add network")).toBeEnabled();
  });
}

async function startTailscaleDraft(): Promise<void> {
  click(getConnectorAction("button", "Add network"));
  await waitFor(() => {
    expect(
      choiceButton("TailscaleConnect to devices with Tailscale"),
    ).toBeEnabled();
  });
  click(choiceButton("TailscaleConnect to devices with Tailscale"));
  const guide = await screen.findByRole("dialog", {
    name: "Download Tailscale",
  });
  click(getConnectorAction("button", "Enter existing credentials", guide));
  await expect(
    screen.findByRole("heading", { name: "Add a Tailscale network" }),
  ).resolves.toBeInTheDocument();
}

async function fillDraft(name: string): Promise<HTMLElement> {
  await fill(screen.getByLabelText("Network name"), name);
  await fill(screen.getByLabelText("Client ID"), "client-4410");
  const secret = screen.getByLabelText("Client Secret");
  await fill(secret, SECRET);
  return secret;
}

async function openNetwork(name: string): Promise<void> {
  await waitFor(() => {
    expect(getConnectorAction("link", `Manage ${name}`)).toBeInTheDocument();
  });
  click(getConnectorAction("link", `Manage ${name}`));
  await expect(
    screen.findByRole("heading", { name, level: 2 }),
  ).resolves.toBeInTheDocument();
}

function recordCreates(
  inventory: RemoteInventory,
  outcome: "created" | "failed",
): { body?: CreateTailscaleConfigRequest } {
  const last: { body?: CreateTailscaleConfigRequest } = {};
  context.mocks.api(tailscaleContract.create, ({ body, respond }) => {
    last.body = body;
    if (outcome === "failed") {
      return respond(500, {
        error: { code: "TAILSCALE_PROVIDER_ERROR", message: PROVIDER_DETAIL },
      });
    }
    const created = network(9, body.name, {
      id: body.id,
      scope: body.scope,
      tags: body.tags,
    });
    inventory.tailscale = [...inventory.tailscale, created];
    return respond(201, created);
  });
  return last;
}

test("Creating a network saves the entered tags and clears credentials", async () => {
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, {
      id: "org_default",
      name: "Default Org",
      role: "member",
    });
  });
  const inventory = mockRemoteInventory(context);
  const created = recordCreates(inventory, "created");
  await openPrivateNetworks();
  await startTailscaleDraft();
  const secret = await fillDraft("New network");
  click(screen.getByText("Allowed tags", { selector: "summary" }));
  await fill(screen.getByLabelText("Allowed tags"), "tag:okou tag:build");

  click(getConnectorAction("button", "Save network"));

  await openNetwork("New network");
  expect(screen.getByText("tag:okou, tag:build")).toBeInTheDocument();
  expect(created.body).toStrictEqual({
    id: expect.any(String),
    name: "New network",
    scope: "personal",
    tags: ["tag:okou", "tag:build"],
    credentials: { clientId: "client-4410", clientSecret: SECRET },
  });
  expect(secret).toHaveValue("");
  expect(document.body).not.toHaveTextContent(SECRET);
});

test("Realtime impact refresh invalidates an old acknowledgement without discarding deletion", async () => {
  const shared = network(2, "Team tailnet", { scope: "organization" });
  mockRemoteInventory(context, { tailscale: [shared] });
  const preview = { current: impact(2, "a") };
  context.mocks.api(tailscaleContract.impactPreview, ({ respond }) => {
    return respond(200, preview.current);
  });
  const user = userEvent.setup({ delay: null });
  await openPrivateNetworks();
  await openNetwork("Team tailnet");
  click(getConnectorAction("button", "Delete Tailscale"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete Tailscale",
  });
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Affected: 1 member and 2 hosts.",
  );
  await user.click(acknowledgement(dialog));
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Delete Tailscale", dialog),
    ).toBeEnabled();
  });

  // A member binds another host; the server announces the change.
  preview.current = impact(3, "b");
  context.mocks.ably.trigger("tailscale:changed", { orgId: "org_default" });

  await waitFor(() => {
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Affected: 1 member and 3 hosts.",
    );
  });
  expect(acknowledgement(dialog)).toHaveAttribute("aria-checked", "false");
  expect(
    getConnectorAction("button", "Delete Tailscale", dialog),
  ).toBeDisabled();
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).getByText("Team tailnet")).toBeInTheDocument();
});

test("An unconfirmed network creation keeps the credential draft frozen without exposing provider details", async () => {
  const inventory = mockRemoteInventory(context);
  recordCreates(inventory, "failed");
  await openPrivateNetworks();
  await startTailscaleDraft();
  const secret = await fillDraft("New network");

  click(getConnectorAction("button", "Save network"));

  await expect(screen.findByText("Save failed.")).resolves.toBeInTheDocument();
  expect(secret).toHaveValue(SECRET);
  expect(secret).toBeDisabled();
  expect(getConnectorAction("button", "Save network")).toBeDisabled();
  expect(document.body).not.toHaveTextContent(PROVIDER_DETAIL);
});

test("Changing organizations unmounts the draft and clears secrets", async () => {
  mockRemoteInventory(context);
  await openPrivateNetworks();
  await startTailscaleDraft();
  const secret = await fillDraft("New network");
  const clerk = context.mocks.clerk();

  clerk.organization({
    activeOrg: { id: "org_second", name: "Second workspace" },
    memberships: [{ id: "org_default" }, { id: "org_second" }],
  });
  clerk.stateChanged();

  await waitFor(() => {
    expect(secret).not.toBeInTheDocument();
  });
  expect(secret).toHaveValue("");
  expect(screen.queryByLabelText("Client Secret")).not.toBeInTheDocument();
});

test("An impact conflict rejects an outdated network restriction without exposing provider details", async () => {
  const shared = network(2, "Team tailnet", { scope: "organization" });
  mockRemoteInventory(context, { tailscale: [shared] });
  const preview = impact(2, "c");
  context.mocks.api(tailscaleContract.impactPreview, ({ respond }) => {
    return respond(200, preview);
  });
  const converted: {
    body?: { expectedRevision: number; impactSnapshot: string };
  } = {};
  context.mocks.api(
    tailscaleContract.convertToPersonal,
    ({ body, respond }) => {
      converted.body = body;
      return respond(409, {
        error: { code: "TAILSCALE_IMPACT_CHANGED", message: PROVIDER_DETAIL },
      });
    },
  );
  const user = userEvent.setup({ delay: null });
  await openPrivateNetworks();
  await openNetwork("Team tailnet");
  click(getConnectorAction("button", "Edit settings"));
  await expect(
    screen.findByRole("heading", { name: "Edit Tailscale" }),
  ).resolves.toBeInTheDocument();
  const onlyMe = scopeRadio("Only me");
  await user.click(onlyMe);
  click(getConnectorAction("button", "Save network"));
  const confirmation = await screen.findByRole("dialog", {
    name: "Make this network available only to you?",
  });
  await expect(
    within(confirmation).findByRole("alert"),
  ).resolves.toHaveTextContent(
    "Affected: 1 member and 2 hosts. Their hosts will stay saved but cannot connect until their owners rebind them.",
  );
  await user.click(acknowledgement(confirmation));
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Make personal", confirmation),
    ).toBeEnabled();
  });

  click(getConnectorAction("button", "Make personal", confirmation));

  await expect(
    within(confirmation).findByText(
      "The network or its linked connections changed. Your draft is kept. Reopen the network and review the latest settings before changing who can use it.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    getConnectorAction("button", "Make personal", confirmation),
  ).toBeDisabled();
  // The edit form behind the confirmation keeps the restriction draft.
  expect(onlyMe).toHaveAttribute("aria-checked", "true");
  expect(document.body).not.toHaveTextContent(PROVIDER_DETAIL);
  expect(converted.body).toStrictEqual({
    expectedRevision: 1,
    impactSnapshot: preview.impactSnapshot,
  });
});
