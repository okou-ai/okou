import {
  cloudflareAccessContract,
  type CloudflareAccessImpactPreview,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();

function gateway(
  index: number,
  name: string,
  scope: ScopedCloudflareAccessConfig["scope"],
): ScopedCloudflareAccessConfig {
  return {
    id: remoteId("c", index),
    name,
    scope,
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}

function impact(
  otherHostCount: number,
  ownerName: string,
  mark: string,
): CloudflareAccessImpactPreview {
  return {
    expectedRevision: 1,
    ownHostCount: 0,
    otherHostCount,
    affectedOwners: [{ userId: "user_morgan", displayName: ownerName }],
    impactSnapshot: mark.repeat(64),
  };
}

async function openNetwork(name: string): Promise<void> {
  await setupPage({ context, path: "/connectors?scope=private-network" });
  await waitFor(() => {
    expect(getConnectorAction("link", `Manage ${name}`)).toBeInTheDocument();
  });
  click(getConnectorAction("link", `Manage ${name}`));
  await expect(
    screen.findByRole("heading", { name, level: 2 }),
  ).resolves.toBeInTheDocument();
}

/** Opens the shared deletion dialog and confirms the reviewed impact. */
async function acknowledgeSharedDeletion(preview: {
  current: CloudflareAccessImpactPreview;
}): Promise<HTMLElement> {
  mockRemoteInventory(context, {
    cloudflare: [gateway(2, "Team gateway", "organization")],
  });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(200, preview.current);
  });
  await openNetwork("Team gateway");
  click(getConnectorAction("button", "Delete Cloudflare Access"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Affected: 1 member and 2 hosts.",
  );
  await userEvent.setup({ delay: null }).click(acknowledgement(dialog));
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Delete Cloudflare Access", dialog),
    ).toBeEnabled();
  });
  return dialog;
}

function acknowledgement(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("checkbox", { name: /^I understand/ });
}

test("An unchanged save returns to details without updating the configuration", async () => {
  mockRemoteInventory(context, {
    cloudflare: [gateway(1, "Protected applications", "personal")],
  });
  context.mocks.api(cloudflareAccessContract.update, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Update unavailable" },
    });
  });
  await openNetwork("Protected applications");
  click(getConnectorAction("button", "Edit settings"));
  await fill(
    await screen.findByLabelText("Network name"),
    "  Protected applications  ",
  );

  click(getConnectorAction("button", "Save network"));

  await waitFor(() => {
    expect(getConnectorAction("button", "Edit settings")).toBeEnabled();
  });
  expect(
    screen.getByRole("heading", { name: "Protected applications", level: 2 }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Network name")).not.toBeInTheDocument();
});

test("Shared deletion refreshes changed impact on cloudflare-access:changed and requires fresh confirmation", async () => {
  const preview = { current: impact(2, "Morgan Lee", "a") };
  const dialog = await acknowledgeSharedDeletion(preview);

  // Another member binds a host; the server announces the Access change.
  preview.current = impact(3, "Morgan Lee", "b");
  context.mocks.ably.trigger("cloudflare-access:changed", {
    orgId: "org_default",
  });

  await waitFor(() => {
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Affected: 1 member and 3 hosts.",
    );
  });
  expect(acknowledgement(dialog)).toHaveAttribute("aria-checked", "false");
  expect(
    getConnectorAction("button", "Delete Cloudflare Access", dialog),
  ).toBeDisabled();
});

test("Shared deletion keeps confirmation when a refreshed impact snapshot is unchanged", async () => {
  const preview = { current: impact(2, "Morgan Lee", "a") };
  const dialog = await acknowledgeSharedDeletion(preview);
  expect(within(dialog).getByText("Morgan Lee")).toBeInTheDocument();

  // The member renames their profile; the impact itself is unchanged.
  preview.current = impact(2, "Morgan Rivera", "a");
  context.mocks.ably.trigger("cloudflare-access:changed", {
    orgId: "org_default",
  });

  await expect(
    within(dialog).findByText("Morgan Rivera"),
  ).resolves.toBeInTheDocument();
  expect(acknowledgement(dialog)).toHaveAttribute("aria-checked", "true");
  expect(
    getConnectorAction("button", "Delete Cloudflare Access", dialog),
  ).toBeEnabled();
});
