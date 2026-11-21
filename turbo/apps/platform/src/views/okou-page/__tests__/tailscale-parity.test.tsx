import {
  tailscaleContract,
  type TailscaleConfig,
  type UpdateTailscaleRequest,
} from "@okouai/api-contracts/contracts/tailscale";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  type RemoteInventory,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const NOT_USED = "Not used by any of your hosts";

function homeTailnet(
  overrides: Partial<TailscaleConfig> = {},
): TailscaleConfig {
  return {
    id: remoteId("a", 1),
    name: "Home tailnet",
    scope: "personal",
    tags: ["tag:okou", "tag:build"],
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
    ...overrides,
  };
}

async function openHomeTailnet(): Promise<void> {
  await setupPage({
    context,
    path: `/connectors?scope=private-network&remoteResource=tailscale:${remoteId("a", 1)}`,
  });
  await waitFor(() => {
    expect(getConnectorAction("button", "Edit settings")).toBeEnabled();
  });
}

async function editHomeTailnet(): Promise<void> {
  click(getConnectorAction("button", "Edit settings"));
  await expect(
    screen.findByRole("heading", { name: "Edit Tailscale" }),
  ).resolves.toBeInTheDocument();
}

function announceSshChange(
  inventory: RemoteInventory,
  sshHosts: TailscaleConfig["sshHosts"],
): void {
  inventory.tailscale = [homeTailnet({ sshHosts })];
  context.mocks.ably.trigger("ssh:changed", { orgId: "org_default" });
}

test("A common SSH notice refreshes network usage and restores deletion after unbinding", async () => {
  const inventory = mockRemoteInventory(context, {
    tailscale: [homeTailnet()],
  });
  await openHomeTailnet();
  expect(screen.getByText(NOT_USED)).toBeInTheDocument();
  expect(getConnectorAction("button", "Delete Tailscale")).toBeEnabled();

  announceSshChange(inventory, [
    { id: remoteId("b", 1), displayName: "Private server" },
  ]);

  await expect(
    screen.findByText("Private server"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(NOT_USED)).not.toBeInTheDocument();
  expect(getConnectorAction("button", "Delete Tailscale")).toBeDisabled();

  announceSshChange(inventory, []);

  await expect(screen.findByText(NOT_USED)).resolves.toBeInTheDocument();
  expect(screen.queryByText("Private server")).not.toBeInTheDocument();
  expect(getConnectorAction("button", "Delete Tailscale")).toBeEnabled();
});

test("Saving unchanged normalized metadata returns to details even when writes are unavailable", async () => {
  mockRemoteInventory(context, { tailscale: [homeTailnet()] });
  context.mocks.api(tailscaleContract.update, ({ respond }) => {
    return respond(500, {
      error: { code: "TAILSCALE_UNAVAILABLE", message: "Writes unavailable" },
    });
  });
  await openHomeTailnet();
  await editHomeTailnet();
  await fill(screen.getByLabelText("Network name"), "  Home tailnet  ");
  await fill(screen.getByLabelText("Allowed tags"), "tag:okou tag:build");

  click(getConnectorAction("button", "Save network"));

  await waitFor(() => {
    expect(getConnectorAction("button", "Edit settings")).toBeEnabled();
  });
  expect(
    screen.getByRole("heading", { name: "Home tailnet", level: 2 }),
  ).toBeInTheDocument();
  expect(screen.getByText("tag:okou, tag:build")).toBeInTheDocument();
});

test("An intentional tag-order edit is saved against the current revision", async () => {
  const inventory = mockRemoteInventory(context, {
    tailscale: [homeTailnet()],
  });
  const saved: { body?: UpdateTailscaleRequest } = {};
  context.mocks.api(tailscaleContract.update, ({ body, respond }) => {
    saved.body = body;
    const updated = homeTailnet({
      tags: body.tags ?? [],
      revision: 2,
    });
    inventory.tailscale = [updated];
    return respond(200, updated);
  });
  await openHomeTailnet();
  await editHomeTailnet();
  await fill(screen.getByLabelText("Allowed tags"), "tag:build tag:okou");

  click(getConnectorAction("button", "Save network"));

  await expect(
    screen.findByText("tag:build, tag:okou"),
  ).resolves.toBeInTheDocument();
  expect(saved.body).toStrictEqual({
    expectedRevision: 1,
    name: "Home tailnet",
    tags: ["tag:build", "tag:okou"],
  });
});
