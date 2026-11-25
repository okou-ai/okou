import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  tailscaleContract,
  type TailscaleConfig,
} from "@okouai/api-contracts/contracts/tailscale";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  click,
  setupPage,
  startPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  type RemoteInventory,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const privateNetworks = "/connectors?scope=private-network";
function station(): TailscaleConfig {
  return {
    id: remoteId("c", 81),
    name: "Studio devices",
    scope: "personal",
    tags: ["tag:studio"],
    generation: 1,
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}
function gateway(): ScopedCloudflareAccessConfig {
  return {
    id: remoteId("b", 82),
    name: "Field access",
    scope: "personal",
    generation: 1,
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}
function member() {
  context.mocks.data.org({
    id: "org_default",
    name: "Engineering",
    role: "member",
  });
}
async function visit(options: Partial<RemoteInventory>, query = "") {
  mockRemoteInventory(context, options);
  await setupPage({ context, path: privateNetworks + query });
}
async function closeDialog(d: HTMLElement) {
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(d).not.toBeInTheDocument();
  });
}
test("remote-control-guided-setup-022 Closing a saved network's connection dialog reveals the member's personal networks", async () => {
  member();
  const network = station();
  await visit(
    { tailscale: [network] },
    "&networkConnections=tailscale:" + network.id,
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Connections using this network",
  });
  await closeDialog(dialog);
  expect(
    within(
      await screen.findByRole("region", { name: "Personal networks" }),
    ).getByText(network.name),
  ).toBeVisible();
});
test("remote-control-guided-setup-023 Manage device connections leaves private networks for the empty directory", async () => {
  await visit({}, "&setup=ssh");
  click(await findFastControl("link", "Manage device connections"));
  await screen.findByText("No devices added yet");
  expect(
    screen.queryByRole("heading", { name: "Add remote connection" }),
  ).toBeNull();
});
test("remote-control-guided-setup-025 Only Manage opens personal Cloudflare settings and its enabled deletion action", async () => {
  const network = gateway();
  await visit({ cloudflare: [network] });
  const label = await screen.findByText(network.name);
  expect(label.closest('a,button,[role="button"]')).toBeNull();
  click(label);
  const manage = await findFastControl("link", "Manage " + network.name);
  const target = manage.getAttribute("href");
  expect(
    new URL(target!, location.origin).searchParams.get("remoteResource"),
  ).toBe("cloudflare:" + network.id);
  click(manage);
  await findFastControl("button", "Edit settings");
  await expect(
    findFastControl("button", "Delete Cloudflare Access"),
  ).resolves.toBeEnabled();
  expect(screen.getByText("Only me")).toBeVisible();
  expect(queryFastControl("button", "Add connection")).toBeNull();
  expect(screen.queryByText(/cannot delete|before.*delet/i)).toBeNull();
  click(await findFastControl("button", "Back to private networks"));
  const restored = await screen.findByText(network.name);
  expect(restored.closest('a,button,[role="button"]')).toBeNull();
  await expect(
    findFastControl("link", "Manage " + network.name),
  ).resolves.toHaveAttribute("href", target);
});
test("remote-control-guided-setup-108 A missing Tailscale edit link explains the failure and allows adding a network", async () => {
  await visit({}, "&network=tailscale&networkEdit=" + station().id);
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    /Unable to load/i,
  );
  expect(screen.queryByLabelText("Network name")).toBeNull();
  click(await findFastControl("button", "Back"));
  click(await findFastControl("button", "Add network"));
  await screen.findByRole("heading", { name: "Add a private network" });
});
test("remote-control-guided-setup-109 A member cannot open the organization Tailscale editor", async () => {
  member();
  const network = station();
  network.scope = "organization";
  await visit(
    { tailscale: [network] },
    "&network=tailscale&networkEdit=" + network.id,
  );
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    /Unable to load/i,
  );
  expect(screen.queryByLabelText("Network name")).toBeNull();
});
test("remote-control-guided-setup-114 A member can add another network beside the only personal network", async () => {
  member();
  const network = station();
  await visit({ tailscale: [network] });
  const personal = await screen.findByRole("region", {
    name: "Personal networks",
  });
  expect(within(personal).getByText(network.name)).toBeVisible();
  await expect(findFastControl("button", "Add network")).resolves.toBeEnabled();
  expect(
    screen.queryByRole("region", { name: "Organization networks" }),
  ).toBeNull();
  expect(screen.queryByText("No networks added yet")).toBeNull();
});
test("remote-control-guided-setup-116 The empty network action appears only after the held inventory loads", async () => {
  mockRemoteInventory(context);
  const reply = context.mocks.deferred<void>();
  context.mocks.api(tailscaleContract.list, async ({ respond }) => {
    await reply.promise;
    return respond(200, { configs: [] });
  });
  const page = await startPage({ context, path: privateNetworks });
  try {
    await page.content;
    const directory = await screen.findByRole("region", {
      name: "Private networks",
    });
    const panel = within(directory);
    await panel.findByText("Loading…");
    expect(queryFastControl("button", "Add network", directory)).toBeNull();
    expect(panel.queryByText("No networks added yet")).toBeNull();
    expect(panel.queryByRole("region")).toBeNull();
    reply.resolve();
    await panel.findByText("No networks added yet");
    expect(queryFastControl("button", "Add network", directory)).toBeVisible();
    expect(panel.queryByText("Loading…")).toBeNull();
  } finally {
    if (!reply.settled()) {
      reply.resolve();
    }
    await page.ready;
  }
});
test("remote-control-guided-setup-121 A member inspects only the devices for the chosen network and regains keyboard focus", async () => {
  member();
  const ts = station(),
    cf = gateway();
  cf.scope = "organization";
  ts.vncHosts = [
    { id: remoteId("e", 19), displayName: "Design desktop", roles: ["rfb"] },
  ];
  cf.sshHosts = [{ id: remoteId("a", 20), displayName: "Team shell" }];
  await visit({ tailscale: [ts], cloudflare: [cf] });
  for (const [network, device, other] of [
    [cf.name, "Team shell", "Design desktop"],
    [ts.name, "Design desktop", "Team shell"],
  ] as const) {
    const control = await findFastControl("button", new RegExp(network));
    control.focus();
    click(control);
    const d = await screen.findByRole("dialog", {
      name: "Connections using this network",
    });
    const body = within(d);
    await body.findByText(device);
    expect(body.queryByText(other)).toBeNull();
    expect(queryAllByRoleFast("link", d)).toHaveLength(0);
    await closeDialog(d);
    expect(control).toHaveFocus();
  }
  await expect(
    screen.findByRole("region", { name: "Personal networks" }),
  ).resolves.toBeVisible();
});
test("remote-control-guided-setup-123 Cloudflare details list both linked devices as read-only references", async () => {
  const network = gateway();
  network.sshHosts = [{ id: remoteId("a", 17), displayName: "Warehouse SSH" }];
  network.vncHosts = [
    { id: remoteId("e", 18), displayName: "Warehouse console", roles: ["rfb"] },
  ];
  await visit(
    { cloudflare: [network] },
    "&remoteResource=cloudflare:" + network.id,
  );
  const first = await screen.findByText("Warehouse SSH");
  const list = first.closest("ul");
  expect(list).toBeInTheDocument();
  const refs = within(list!);
  expect(refs.getByText("Warehouse console")).toBeVisible();
  expect(queryAllByRoleFast("button", list!)).toHaveLength(0);
  expect(queryAllByRoleFast("link", list!)).toHaveLength(0);
  expect(screen.queryByText("Add connection")).toBeNull();
});
test("remote-control-guided-setup-131 Engineering members see personal ownership and the organization administrator rule", async () => {
  member();
  await visit({}, "&network=add");
  click(await findFastControl("button", /Tailscale/));
  click(await findFastControl("button", "Enter existing credentials"));
  const personal = await screen.findByRole("radio", { name: /Only me/i });
  expect(personal).toBeChecked();
  expect(
    screen.getByRole("radio", { name: /Organization members/i }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    screen.getByText(
      "Members of Engineering can use this network to connect devices.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Organization administrators create and manage organization networks.",
    ),
  ).toBeVisible();
});
