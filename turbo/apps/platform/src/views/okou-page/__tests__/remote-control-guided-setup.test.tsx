import {
  type SshConnectionResponse,
  sshConnectionsContract,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  type SshCredentialResponse,
  sshCredentialsContract,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import {
  type VncConnectionResponse,
  vncConnectionsContract,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  type VncCredentialResponse,
  vncCredentialsContract,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  tailscaleContract,
  type TailscaleConfig,
} from "@okouai/api-contracts/contracts/tailscale";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import {
  click,
  fill,
  setupPage,
  startPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  emitMockedClerkEvent,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import {
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  mockConnectors,
  mockPublicConnectorStatus,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const timestamp = "2026-10-19T00:00:00.000Z";
const network: TailscaleConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Office network",
  scope: "personal",
  tags: ["tag:okou"],
  revision: 1,
  generation: 1,
  sshHosts: [],
  vncHosts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});

const cloudflareNetwork = Object.freeze({
  id: network.id,
  name: network.name,
  scope: network.scope,
  revision: network.revision,
  generation: network.generation,
  sshHosts: network.sshHosts,
  vncHosts: network.vncHosts,
  createdAt: timestamp,
  updatedAt: timestamp,
});

beforeEach(() => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  context.mocks.api(sshConnectionsContract.observations, ({ respond }) => {
    return respond(200, { observations: [] });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  context.mocks.api(vncConnectionsContract.observations, ({ respond }) => {
    return respond(200, { observations: [] });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
});
async function page(
  path = "/connectors?scope=remote-control",
  enabled = true,
  role?: "admin" | "member",
  capabilities: { vnc?: boolean; tailscale?: boolean } = {},
  userId = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
) {
  if (role) {
    context.mocks.data.org({
      id: "org_network_scope",
      name: "Engineering",
      role,
    });
  }
  await setupPage({
    context,
    path,
    auth: {
      user: { id: userId, fullName: "Network Owner" },
      ...(role
        ? {
            organization: {
              activeOrg: { id: "org_network_scope", name: "Engineering" },
              memberships: [{ id: "org_network_scope" }],
            },
          }
        : {}),
    },
    featureSwitches: {
      [FeatureSwitchKey.RemoteControlGuidedSetup]: enabled,
      [FeatureSwitchKey.VncAccess]: capabilities.vnc ?? true,
      [FeatureSwitchKey.TailscaleAccess]: capabilities.tailscale ?? true,
    },
  });
}
async function directForm() {
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Use existing connection details"));
  await screen.findByRole("heading", {
    name: "Use existing connection details",
  });
  click(screen.getByText("Direct connection"));
  await screen.findByLabelText("Device address");
  return await screen.findByLabelText("SSH username");
}
test.each([
  ["ssh", false],
  ["vnc", false],
  ["ssh", true],
  ["vnc", true],
] as const)(
  "The new deep link %s keeps the existing experience when guided is off and legacy=%s",
  async (protocol, legacyEnabled) => {
    await page(
      `/connectors?scope=remote-control&setup=${protocol}`,
      false,
      undefined,
      { vnc: legacyEnabled, tailscale: legacyEnabled },
    );
    await waitFor(() => {
      expect(getAction("button", "Add host")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: "Set up a connection" }),
    ).toBeNull();
    expect(queryAction("button", "Add connection")).toBeNull();
  },
);
test.each([
  ["user_3EWY21Oe3f15kfs3yYmbGgDb3NV", "Add connection"],
  ["user_3G9pYGWE2oaAQAUfb8wIwcLxwiy", "Add your first device"],
])(
  "The empty remote directory lets %s start setup using %s",
  async (userId, action) => {
    await page("/connectors?scope=remote-control", true, undefined, {}, userId);
    await screen.findByRole("heading", { name: "No devices added yet" });
    expect(
      screen.getByText("Start with SSH or VNC and follow the setup steps."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Let Okou work on a computer or server you choose."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Saving a connection does not authorize its use in chat.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Personal connections" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Set up a connection" }),
    ).toBeNull();
    expect(queryAllByRoleFast("tab")).toHaveLength(0);
    expect(queryAction("button", "Add credential")).toBeNull();
    click(getAction("button", action));
    await screen.findByRole("heading", { name: "Set up a connection" });
    expect(screen.getByText("Run commands on the device.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Control the device’s screen with a mouse and keyboard.",
      ),
    ).toBeInTheDocument();
  },
);
test.each(["staff-colleague", "external-user"])(
  "A stored UI override cannot expose guided setup to %s",
  async (userId) => {
    await page(
      "/connectors?scope=remote-control&setup=vnc",
      true,
      "member",
      { vnc: true, tailscale: true },
      userId,
    );
    await waitFor(() => {
      expect(getAction("button", "Add host")).toBeInTheDocument();
    });
    expect(queryAction("button", "Add connection")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Set up a connection" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Personal connections" }),
    ).toBeNull();
  },
);
test("Another account cannot open the network list or count dialog through a stored override", async () => {
  mockSavedConnections();
  await page(
    `/connectors?scope=private-network&networkConnections=tailscale:${network.id}`,
    true,
    "member",
    {},
    "other-account",
  );
  await screen.findByRole("heading", { name: "Cloudflare Access" });
  expect(
    screen.queryByRole("region", { name: "Personal networks" }),
  ).toBeNull();
  expect(
    screen.queryByRole("dialog", { name: "Connections using this network" }),
  ).toBeNull();
});
test("Switching accounts immediately removes the previous account's remote UI", async () => {
  await page();
  await screen.findByRole("heading", { name: "No devices added yet" });
  act(() => {
    mockUser(
      { id: "another-account", fullName: "Another account" },
      { id: "another-session", token: "test-token" },
    );
    emitMockedClerkEvent();
  });
  await waitFor(() => {
    expect(getAction("button", "Add host")).toBeInTheDocument();
  });
  expect(
    screen.queryByRole("heading", { name: "No devices added yet" }),
  ).toBeNull();
  expect(queryAction("button", "Add connection")).toBeNull();
});
test("A delayed feature response cannot enable remote UI for the next account", async () => {
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    featureSwitchesContract.get,
    async ({ respond, withSignal }) => {
      requested.resolve();
      await withSignal(release.promise);
      return respond(200, {
        switches: { [FeatureSwitchKey.RemoteControlGuidedSetup]: true },
        effectiveSwitches: {
          [FeatureSwitchKey.RemoteControlGuidedSetup]: true,
        },
      });
    },
  );
  const loading = await startPage({
    context,
    path: "/connectors?scope=remote-control&setup=ssh",
    auth: {
      user: { id: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV", fullName: "Bingjie" },
    },
  });
  await requested.promise;
  act(() => {
    mockUser(
      { id: "another-account", fullName: "Another account" },
      { id: "another-session", token: "test-token" },
    );
    emitMockedClerkEvent();
  });
  release.resolve();
  await loading.ready;
  await waitFor(() => {
    expect(getAction("button", "Add host")).toBeInTheDocument();
  });
  expect(queryAction("button", "Add connection")).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Set up a connection" }),
  ).toBeNull();
});
test("The UI switch does not expose disabled VNC or Tailscale setup", async () => {
  await page("/connectors?scope=remote-control&setup=vnc", true, undefined, {
    vnc: false,
    tailscale: false,
  });
  await screen.findByRole("heading", { name: "No devices added yet" });
  expect(
    screen.getByText("Start with SSH and follow the setup steps."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Start with SSH or VNC and follow the setup steps."),
  ).toBeNull();
  expect(screen.queryByLabelText("Login method")).toBeNull();
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", {
    name: "Use existing connection details",
  });
  expect(screen.getByText("Run commands on the device.")).toBeInTheDocument();
  expect(
    screen.queryByText(
      "Control the device’s screen with a mouse and keyboard.",
    ),
  ).toBeNull();
  expect(queryAction("button", "Start setup")).toBeNull();
  click(getAction("button", "Use existing connection details"));
  await screen.findByText("Direct connection");
  expect(
    screen.queryByText("For devices already connected to Tailscale."),
  ).toBeNull();
  expect(queryAction("button", "Set up your device step by step")).toBeNull();
  click(screen.getByText("Direct connection"));
  await screen.findByLabelText("SSH username");
});
test.each([false, true])(
  "With Tailscale SSH disabled, reusable Tailscale networks follow the existing VNC gate (%s)",
  async (vnc) => {
    context.mocks.api(tailscaleContract.list, ({ respond }) => {
      return respond(200, { configs: [network] });
    });
    await page("/connectors?scope=private-network", true, undefined, {
      vnc,
      tailscale: false,
    });
    if (vnc) {
      const card = await screen.findByText(network.name);
      click(card);
      await screen.findByRole("heading", { name: network.name });
      click(getAction("button", "Back to private networks"));
      await screen.findByText(network.name);
    } else {
      await screen.findByRole("heading", {
        name: "Personal networks",
      });
    }
    expect(screen.queryAllByText(network.name)).toHaveLength(vnc ? 1 : 0);
    click(getAction("button", "Add network"));
    await screen.findByRole("heading", { name: "Add a private network" });
    expect(
      screen.getByText("Cloudflare Access", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.queryAllByText("Tailscale", { exact: true })).toHaveLength(
      vnc ? 1 : 0,
    );
  },
);
test("Private network links to connection management without starting device setup", async () => {
  await page("/connectors?scope=private-network&setup=ssh");
  click(
    await waitFor(() => {
      return getAction("link", "Manage device connections");
    }),
  );
  await screen.findByRole("heading", { name: "No devices added yet" });
  expect(
    screen.queryByRole("heading", { name: "Set up a connection" }),
  ).toBeNull();
});
test.each(["tailscale", "cloudflare"] as const)(
  "Opening a %s network card navigates to its details and back in the app",
  async (provider) => {
    context.mocks.api(tailscaleContract.list, ({ respond }) => {
      return respond(200, {
        configs: provider === "tailscale" ? [network] : [],
      });
    });
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, {
        configs: provider === "cloudflare" ? [cloudflareNetwork] : [],
      });
    });
    await page("/connectors?scope=private-network");
    click(await screen.findByText(network.name));
    await screen.findByRole("heading", { name: network.name });
    expect(getAction("button", "Edit settings")).toBeInTheDocument();
    click(getAction("button", "Back to private networks"));
    expect(
      (await screen.findByText(network.name)).closest("a"),
    ).toHaveAttribute(
      "href",
      expect.stringContaining(`remoteResource=${provider}%3A${network.id}`),
    );
  },
);
test.each(["ssh", "vnc"] as const)(
  "%s offers distinct setup paths when its existing access switch is enabled",
  async (protocol) => {
    await page(`/connectors?scope=remote-control&setup=${protocol}`);
    await screen.findByRole("heading", { name: "Set up a connection" });
    expect(queryAction("button", "View saved connections")).toBeNull();
    click(getAction("button", "Start setup"));
    await screen.findByRole("heading", {
      name:
        protocol === "ssh"
          ? "Install Tailscale"
          : "Enable screen sharing on the computer you want to connect",
    });
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Set up a connection" });
    click(getAction("button", "Use existing connection details"));
    await screen.findByRole("heading", {
      name:
        protocol === "ssh"
          ? "Use existing connection details"
          : "Choose a VNC login method",
    });
    expect(
      screen.queryByRole("heading", { name: "Device operating system" }),
    ).toBeNull();
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Set up a connection" });
  },
);
async function setupFromNetwork(
  provider: "tailscale" | "cloudflare",
  capabilities: { vnc?: boolean; tailscale?: boolean } = {},
) {
  const otherNetwork = {
    id: "a0000000-0000-4000-8000-000000000002",
    name: "Another network",
  };
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, {
      configs:
        provider === "tailscale"
          ? [{ ...network, ...otherNetwork }, network]
          : [],
    });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, {
      configs:
        provider === "cloudflare"
          ? [{ ...cloudflareNetwork, ...otherNetwork }, cloudflareNetwork]
          : [],
    });
  });
  await page(
    `/connectors?scope=private-network&remoteResource=${provider}:${network.id}`,
    true,
    undefined,
    capabilities,
  );
  await screen.findByRole("heading", { name: network.name });
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Set up a connection" });
}
test.each(["tailscale", "cloudflare"] as const)(
  "SSH setup from %s preserves the network through protocol changes, guided steps, and cancellation",
  async (provider) => {
    await setupFromNetwork(provider);
    expect(
      screen.getByText("Using network: Office network"),
    ).toBeInTheDocument();
    click(
      screen.getByText(
        "Control the device’s screen with a mouse and keyboard.",
      ),
    );
    click(screen.getByText("Run commands on the device."));
    click(getAction("button", "Continue"));
    const addressLabel =
      provider === "tailscale" ? "Device address" : "Connection address";
    const address =
      provider === "tailscale" ? "100.64.0.20" : "device.example.com";
    await fill(await screen.findByLabelText(addressLabel), address);
    expect(
      screen.getByText(provider === "tailscale" ? "1 / 3" : "1 / 2"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Access permissions", { exact: true }),
    ).toBeNull();
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Set up a connection" });
    click(getAction("button", "Continue"));
    await expect(screen.findByLabelText(addressLabel)).resolves.toHaveValue(
      address,
    );
    click(getAction("button", "Continue"));
    if (provider === "tailscale") {
      await screen.findByText("2 / 3");
      click(getAction("button", "Enabled, continue"));
    }
    const username = await screen.findByLabelText("SSH username");
    expect(screen.getByLabelText("Device address")).toHaveValue(address);
    expect(
      screen.getByRole("combobox", {
        name: provider === "tailscale" ? "Saved network" : "Cloudflare Access",
      }),
    ).toHaveTextContent(network.name);
    expect(
      screen.getByText(provider === "tailscale" ? "3 / 3" : "2 / 2"),
    ).toBeInTheDocument();
    await fill(username, "draft-user");
    await fill(screen.getByLabelText(/Connection name/u), "Network device");
    click(getAction("button", "Back"));
    if (provider === "tailscale") {
      await screen.findByText("2 / 3");
      click(getAction("button", "Enabled, continue"));
    } else {
      await screen.findByText("1 / 2");
      click(getAction("button", "Continue"));
    }
    await waitFor(() => {
      expect(username).toBeVisible();
    });
    expect(username).toHaveValue("draft-user");
    expect(screen.getByLabelText(/Connection name/u)).toHaveValue(
      "Network device",
    );
    click(getAction("button", "Private network"));
    await screen.findByRole("heading", { name: network.name });
    expect(getAction("button", "Edit settings")).toBeInTheDocument();
  },
);
test.each(["tailscale", "cloudflare"] as const)(
  "Existing SSH details from %s skip network setup and return to the source network",
  async (provider) => {
    await setupFromNetwork(provider);
    click(getAction("button", "Use existing connection details"));
    const username = await screen.findByLabelText("SSH username");
    expect(
      screen.getByRole("combobox", {
        name: provider === "tailscale" ? "Saved network" : "Cloudflare Access",
      }),
    ).toHaveTextContent(network.name);
    await fill(username, "existing-user");
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Set up a connection" });
    click(getAction("button", "Use existing connection details"));
    await waitFor(() => {
      expect(username).toBeVisible();
    });
    expect(username).toHaveValue("existing-user");
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Set up a connection" });
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: network.name });
  },
);
test("SSH keeps address edits and the selected network when revisiting preparation", async () => {
  await setupFromNetwork("tailscale");
  click(getAction("button", "Continue"));
  await fill(await screen.findByLabelText("Device address"), "100.64.0.20");
  click(getAction("button", "Continue"));
  click(await screen.findByText("Enabled, continue"));
  const username = await screen.findByLabelText("SSH username");
  await fill(username, "draft-user");
  await fill(screen.getByLabelText("Device address"), "100.64.0.21");
  click(screen.getByRole("combobox", { name: "Saved network" }));
  click(await screen.findByRole("option", { name: "Another network" }));
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Enable SSH on the computer you want to connect",
  });
  expect(
    screen.getByRole("combobox", { name: "Saved network" }),
  ).toHaveTextContent("Another network");
  click(getAction("button", "Back"));
  await expect(
    screen.findByRole("textbox", { name: "Device address" }),
  ).resolves.toHaveValue("100.64.0.21");
  await fill(
    screen.getByRole("textbox", { name: "Device address" }),
    "100.64.0.22",
  );
  click(getAction("button", "Continue"));
  const networkPicker = await screen.findByRole("combobox", {
    name: "Saved network",
  });
  click(networkPicker);
  click(await screen.findByRole("option", { name: "Office network" }));
  click(getAction("button", "Enabled, continue"));
  await waitFor(() => {
    expect(username).toBeVisible();
  });
  expect(username).toHaveValue("draft-user");
  expect(screen.getByLabelText("Device address")).toHaveValue("100.64.0.22");
  expect(
    screen.getByRole("combobox", { name: "Saved network" }),
  ).toHaveTextContent("Office network");
});
test.each([
  ["tailscale", "guided"],
  ["tailscale", "existing"],
  ["cloudflare", "guided"],
  ["cloudflare", "existing"],
] as const)(
  "VNC from %s keeps its native network during %s setup and protective profile changes",
  async (provider, mode) => {
    await setupFromNetwork(provider);
    click(
      screen.getByText(
        "Control the device’s screen with a mouse and keyboard.",
      ),
    );
    click(
      getAction(
        "button",
        mode === "guided" ? "Continue" : "Use existing connection details",
      ),
    );
    if (mode === "guided") {
      await screen.findByRole("heading", {
        name: "Enable screen sharing on the computer you want to connect",
      });
      click(getAction("button", "Enabled, continue"));
    }
    const group = await screen.findByLabelText("Service type");
    click(group);
    click(await screen.findByRole("option", { name: "Apple screen sharing" }));
    click(getAction("button", "Continue"));
    await screen.findByRole("heading", { name: "Connect a device" });
    expect(screen.getByLabelText("Connection method")).toHaveTextContent(
      provider === "tailscale" ? "Tailscale" : "Cloudflare Access",
    );
    expect(
      screen.getByRole("combobox", { name: "Saved network" }),
    ).toHaveTextContent(network.name);
    expect(queryAction("button", "Add SSH connection")).toBeNull();
    await fill(screen.getByLabelText("Device address"), "device.example.com");
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Choose a VNC login method" });
    click(group);
    click(await screen.findByRole("option", { name: "Certificate-based VNC" }));
    click(getAction("button", "Continue"));
    await screen.findByRole("heading", { name: "Connect a device" });
    expect(
      screen.getByRole("combobox", { name: "Saved network" }),
    ).toHaveTextContent(network.name);
    expect(screen.getByLabelText("Device address")).toHaveValue(
      "device.example.com",
    );
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Choose a VNC login method" });
    click(getAction("button", "Back"));
    if (mode === "guided") {
      await screen.findByRole("heading", {
        name: "Enable screen sharing on the computer you want to connect",
      });
      click(getAction("button", "Back"));
    }
    await screen.findByRole("heading", { name: "Set up a connection" });
    click(getAction("button", "Use existing connection details"));
    await screen.findByRole("heading", { name: "Choose a VNC login method" });
    click(getAction("button", "Continue"));
    await screen.findByRole("heading", { name: "Connect a device" });
    expect(screen.getByLabelText("Device address")).toHaveValue(
      "device.example.com",
    );
    expect(
      screen.getByRole("combobox", { name: "Saved network" }),
    ).toHaveTextContent(network.name);
    click(getAction("button", "Private network"));
    await screen.findByRole("heading", { name: network.name });
  },
);
test("Network setup respects disabled VNC and clears the source when leaving for the remote directory", async () => {
  await setupFromNetwork("cloudflare", { vnc: false, tailscale: false });
  expect(
    screen.queryByText(
      "Control the device’s screen with a mouse and keyboard.",
    ),
  ).toBeNull();
  click(getAction("button", "Continue"));
  await screen.findByLabelText("Connection address");
  const directory = queryAction("button", "Connectors");
  if (directory) {
    click(directory);
  }
  click(await screen.findByTestId("connectors-scope-private-network"));
  await screen.findByRole("heading", { name: "Private networks" });
  click(screen.getByTestId("connectors-scope-remote-control"));
  await screen.findByRole("heading", { name: "No devices added yet" });
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Add remote connection" });
  expect(screen.queryByText("Using network: Office network")).toBeNull();
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "No devices added yet" });
});
test("A Tailscale network available only to VNC starts a VNC connection without offering SSH", async () => {
  await setupFromNetwork("tailscale", { vnc: true, tailscale: false });
  expect(screen.queryByText("Run commands on the device.")).toBeNull();
  click(getAction("button", "Use existing connection details"));
  await screen.findByRole("heading", { name: "Choose a VNC login method" });
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a device" });
  expect(screen.getByLabelText("Connection method")).toHaveTextContent(
    "Tailscale",
  );
  expect(
    screen.getByRole("combobox", { name: "Saved network" }),
  ).toHaveTextContent(network.name);
});
test("First-time setup from existing settings opens installation without cycling through the entry page", async () => {
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Use existing connection details"));
  await screen.findByRole("heading", {
    name: "Use existing connection details",
  });
  click(getAction("button", "Set up your device step by step"));
  await screen.findByRole("heading", {
    name: "Install Tailscale",
  });
  expect(
    screen.queryByRole("heading", { name: "Set up a connection" }),
  ).toBeNull();
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Start setup"));
  await screen.findByRole("heading", {
    name: "Install Tailscale",
  });
});
test("Existing Tailscale settings open the saved network and device login form, preserving the draft on return", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Use existing connection details"));
  await screen.findByRole("heading", {
    name: "Use existing connection details",
  });
  click(screen.getByText("For devices already connected to Tailscale."));
  const username = await screen.findByLabelText("SSH username");
  expect(
    screen.queryByRole("heading", {
      name: "Install Tailscale",
    }),
  ).toBeNull();
  await expect(
    screen.findByRole("combobox", { name: "Saved network" }),
  ).resolves.toHaveTextContent("Office network");
  await fill(username, "draft-user");
  await fill(
    screen.getByLabelText(/Connection name/u),
    "Existing network draft",
  );
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Use existing connection details",
  });
  click(screen.getByText("For devices already connected to Tailscale."));
  await expect(screen.findByLabelText("SSH username")).resolves.toHaveValue(
    "draft-user",
  );
  expect(screen.getByLabelText(/Connection name/u)).toHaveValue(
    "Existing network draft",
  );
});

async function openCloudflareSetup() {
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Use existing connection details"));
  await screen.findByRole("heading", {
    name: "Use existing connection details",
  });
  click(screen.getByText("Cloudflare Access", { exact: true }));
  await fill(
    await screen.findByLabelText("Connection address"),
    "device.example.com",
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Set up Cloudflare access",
  });
}

test("Adding a Service Token preserves the draft on Back and continues to computer login with the new network", async () => {
  const configs = [{ ...cloudflareNetwork }];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    const created = { ...cloudflareNetwork, id: body.id, name: body.name };
    configs.push(created);
    return respond(201, created);
  });
  await openCloudflareSetup();
  await screen.findByRole("combobox", { name: "Saved network" });
  click(getAction("button", "Add Service Token"));
  const name = await screen.findByLabelText("Network name");
  await fill(name, "New office network");
  await fill(screen.getByLabelText("Client ID"), "test-client-id");
  await fill(screen.getByLabelText("Client Secret"), "test-client-secret");
  click(getAction("button", "Back"));
  await screen.findByRole("combobox", { name: "Saved network" });
  expect(configs).toHaveLength(1);
  click(getAction("button", "Add Service Token"));
  await waitFor(() => {
    expect(screen.getByLabelText("Network name")).toBeVisible();
  });
  expect(name).toHaveValue("New office network");
  expect(screen.getByLabelText("Client Secret")).toHaveValue(
    "test-client-secret",
  );
  click(getAction("button", "Save and continue"));
  const username = await screen.findByLabelText("SSH username");
  expect(configs).toHaveLength(2);
  expect(screen.getByLabelText("Device address")).toHaveValue(
    "device.example.com",
  );
  expect(
    screen.getByRole("combobox", { name: "Cloudflare Access" }),
  ).toHaveTextContent("New office network");
  await fill(username, "draft-user");
  await fill(screen.getByLabelText(/Connection name/u), "My computer");
  click(getAction("button", "Back"));
  await screen.findByRole("combobox", { name: "Saved network" });
  click(getAction("button", "Add Service Token"));
  await fill(
    await screen.findByLabelText("Network name"),
    "Replacement network",
  );
  await fill(screen.getByLabelText("Client ID"), "test-replacement-id");
  await fill(screen.getByLabelText("Client Secret"), "test-replacement-secret");
  click(getAction("button", "Save and continue"));
  await waitFor(() => {
    expect(screen.getByLabelText("SSH username")).toBeVisible();
  });
  expect(username).toHaveValue("draft-user");
  expect(screen.getByLabelText(/Connection name/u)).toHaveValue("My computer");
  expect(
    screen.getByRole("combobox", { name: "Cloudflare Access" }),
  ).toHaveTextContent("Replacement network");
  expect(configs).toHaveLength(3);
});

test("An uncertain Service Token save retries the same network and only then continues to login", async () => {
  const configs: (typeof cloudflareNetwork)[] = [];
  const submittedIds: string[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    submittedIds.push(body.id);
    if (submittedIds.length === 1) {
      configs.push({ ...cloudflareNetwork, id: body.id, name: body.name });
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Response unavailable" },
      });
    }
    return respond(204);
  });
  await openCloudflareSetup();
  click(getAction("button", "Add Service Token"));
  await fill(await screen.findByLabelText("Network name"), "Recovered network");
  await fill(screen.getByLabelText("Client ID"), "test-client-id");
  await fill(screen.getByLabelText("Client Secret"), "test-client-secret");
  click(getAction("button", "Save and continue"));
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("SSH username")).toBeNull();
  expect(screen.getByLabelText("Network name")).toHaveValue(
    "Recovered network",
  );
  click(getAction("button", "Retry"));
  await screen.findByLabelText("SSH username");
  expect(submittedIds).toHaveLength(2);
  expect(submittedIds[0]).toBe(submittedIds[1]);
  expect(configs).toHaveLength(1);
  expect(
    screen.getByRole("combobox", { name: "Cloudflare Access" }),
  ).toHaveTextContent("Recovered network");
});
test.each(["tailscale", "cloudflare"] as const)(
  "%s credential update opens blank replacement fields without fetching saved secrets",
  async (provider) => {
    context.mocks.api(tailscaleContract.list, ({ respond }) => {
      return respond(200, { configs: [network] });
    });
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, { configs: [cloudflareNetwork] });
    });
    await page(
      `/connectors?scope=private-network&remoteResource=${provider}:${network.id}`,
    );
    click(
      await waitFor(() => {
        return getAction("button", "Update credentials");
      }),
    );
    await screen.findByRole("heading", {
      name:
        provider === "tailscale" ? "Edit Tailscale" : "Edit Cloudflare Access",
    });
    const secret = await screen.findByLabelText("Client Secret");
    expect(secret).toHaveValue("");
    expect(secret).toBeRequired();
    expect(secret).toHaveAttribute("type", "password");
    const field = secret.parentElement!;
    await fill(secret, "test-only-replacement");
    click(getAction("button", "Show entered value", field));
    expect(secret).toHaveValue("test-only-replacement");
    expect(secret).toHaveAttribute("type", "text");
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: network.name });
    click(getAction("button", "Update credentials"));
    const reopened = await screen.findByLabelText("Client Secret");
    expect(reopened).toHaveValue("");
    expect(reopened).toHaveAttribute("type", "password");
  },
);
test("Direct SSH requires a name, retains input through username help and saves through the contract", async () => {
  const requests: unknown[] = [];
  let savedId = "";
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    savedId = body.id;
    return respond(201, {
      id: body.id,
      displayName: body.displayName,
      host: body.host,
      port: body.port,
      username: "operator",
      credentialId: "d0000000-0000-4000-8000-000000000001",
      credentialName: "Office login",
      generation: 1,
      learnedHostKey: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
  const username = await directForm();
  const name = screen.getByLabelText(/Connection name/u);
  expect(name).toHaveValue("");
  expect(name).toBeRequired();
  await fill(screen.getByLabelText("Device address"), "server.example.com");
  await fill(username, "operator");
  expect(screen.queryByLabelText("Credential name")).toBeNull();
  await fill(screen.getByLabelText("Password"), "test-only-password");
  click(getAction("button", "Show entered value"));
  expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
  expect(screen.getByLabelText("Password")).toHaveValue("test-only-password");
  click(getAction("button", "Hide entered value"));
  expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  await fill(name, "Office computer");
  click(getAction("button", "Where can I find my username?"));
  await screen.findByText("whoami");
  expect(username).toHaveValue("operator");
  expect(name).toHaveValue("Office computer");
  await userEvent.keyboard("{Escape}");
  expect(
    Array.from(name.closest("form")!.querySelectorAll(":invalid")).map(
      (field) => {
        return field.getAttribute("name");
      },
    ),
  ).toStrictEqual([]);
  expect(queryAction("button", "Save and check")).toBeNull();
  click(getAction("button", "Save"));
  await waitFor(() => {
    return expect(requests).toHaveLength(1);
  });
  await screen.findByRole("heading", { name: "Connection added" });
  expect(requests).toStrictEqual([
    expect.objectContaining({
      displayName: "Office computer",
      host: "server.example.com",
      port: 22,
    }),
  ]);
  expect(
    screen.getByText("You can view or edit connection details in Settings."),
  ).toBeInTheDocument();
  expect(queryAction("link", "Open chat")).toBeNull();
  expect(getAction("link", "View connection").getAttribute("href")).toContain(
    `remoteResource=ssh%3A${savedId}`,
  );
});
test("Tailscale setup keeps custom tags consistent across instructions, credentials and the saved network", async () => {
  let savedNetworks: TailscaleConfig[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: savedNetworks });
  });
  context.mocks.api(tailscaleContract.create, ({ body, respond }) => {
    expect(body.tags).toStrictEqual(["tag:office-review", "tag:remote-review"]);
    const created = {
      ...network,
      id: body.id,
      name: body.name,
      tags: body.tags,
    };
    savedNetworks = [created];
    return respond(201, created);
  });
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Start setup"));
  await screen.findByRole("heading", {
    name: "Install Tailscale",
  });
  click(getAction("button", "Installed, continue"));
  await screen.findByLabelText("Device address");
  await fill(screen.getByLabelText("Device address"), "100.64.0.20");
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Create an Okou tag",
  });
  expect(
    screen.getByText("Access controls → Definitions → Tags → Create tag"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Show detailed instructions")).toBeNull();
  click(getAction("button", "Created, continue"));
  await screen.findByRole("heading", {
    name: "Allow Okou to reach this computer",
  });
  expect(screen.queryByLabelText("Port")).toBeNull();
  click(screen.getByText("View rule code"));
  expect(screen.getByText(/"tcp:22"/u)).toBeInTheDocument();
  expect(
    screen.getByText(/broader permissions already granted still apply/u),
  ).toBeInTheDocument();
  click(getAction("button", "Saved, continue"));
  await screen.findByRole("heading", {
    name: "Create connection credentials",
  });
  await screen.findByLabelText("Client Secret");
  expect(screen.getByLabelText("Client Secret")).toHaveAttribute(
    "type",
    "password",
  );
  expect(getAction("button", "Save and continue")).toBeInTheDocument();
  click(getAction("button", "How do I get connection credentials?"));
  await screen.findByRole("dialog", { name: "Tailscale connection setup" });
  for (let index = 0; index < 2; index++) {
    click(getAction("button", "Continue"));
  }
  expect(screen.getByText(/click “Save and continue”/u)).toBeInTheDocument();
  click(getAction("button", "Return to form"));
  await fill(screen.getByLabelText("Network name"), "Custom tag network");
  await fill(screen.getByLabelText("Client ID"), "test-only-client-id");
  await fill(screen.getByLabelText("Client Secret"), "test-only-client-secret");
  click(screen.getByText("Allowed tags", { selector: "summary" }));
  await fill(
    screen.getByLabelText("Allowed tags"),
    "tag:office-review, tag:remote-review",
  );
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Allow Okou to reach this computer",
  });
  expect(
    screen.getByText("tag:office-review, tag:remote-review"),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Access controls → Policies → General access rules → Add rule",
    ),
  ).toBeVisible();
  click(screen.getByText("View rule code"));
  expect(JSON.parse(screen.getByText(/"tcp:22"/u).textContent!)).toStrictEqual({
    src: ["tag:office-review", "tag:remote-review"],
    dst: ["100.64.0.20"],
    ip: ["tcp:22"],
  });
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Create an Okou tag",
  });
  expect(screen.getByText("office-review")).toBeVisible();
  expect(screen.getByText("remote-review")).toBeVisible();
  click(getAction("button", "Created, continue"));
  click(getAction("button", "Saved, continue"));
  await screen.findByRole("heading", {
    name: "Create connection credentials",
  });
  expect(screen.getByLabelText("Network name")).toHaveValue(
    "Custom tag network",
  );
  expect(screen.getByLabelText("Client Secret")).toHaveValue(
    "test-only-client-secret",
  );
  click(getAction("button", "How do I get connection credentials?"));
  click(getAction("button", "Continue"));
  expect(
    within(screen.getByRole("dialog")).getByText(
      "tag:office-review, tag:remote-review",
    ),
  ).toBeVisible();
  click(screen.getByText("Can’t find the tag?"));
  expect(
    screen.getByText(/Definitions → Tags and click Create tag/u),
  ).toBeVisible();
  await userEvent.keyboard("{Escape}");
  click(getAction("button", "Save and continue"));
  await screen.findByRole("heading", {
    name: "Enable SSH on the computer you want to connect",
  });
  expect(savedNetworks).toHaveLength(1);
});
test("A single saved network is explicitly selected and can be changed", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, {
      configs: [{ ...network, tags: ["tag:existing-office"] }],
    });
  });
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Start setup"));
  const picker = await screen.findByLabelText("Saved network");
  await waitFor(() => {
    expect(picker).toHaveTextContent("Office network");
  });
  expect(screen.queryByText("1 / 7")).not.toBeInTheDocument();
  click(getAction("button", "Set up a new network"));
  expect(picker).not.toHaveTextContent("Office network");
  click(getAction("button", "Installed, continue"));
  await fill(await screen.findByLabelText("Device address"), "100.64.0.20");
  click(getAction("button", "Continue"));
  const tagName = await screen.findByText("existing-office");
  expect(tagName).toBeVisible();
});
test("VNC groups actual service methods and retains the connection step while adding SSH", async () => {
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Start setup"));
  await screen.findByRole("heading", {
    name: "Enable screen sharing on the computer you want to connect",
  });
  click(getAction("button", "Enabled, continue"));
  const group = await screen.findByLabelText("Service type");
  click(group);
  click(await screen.findByRole("option", { name: "Apple screen sharing" }));
  expect(screen.getByLabelText("Login method")).toHaveTextContent("Apple DH");
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Connect a device",
  });
  expect(
    screen.getByRole("combobox", { name: "Connection method" }),
  ).toBeEnabled();
  click(screen.getByText("More settings", { selector: "summary" }));
  const port = screen.getByLabelText("Port");
  await fill(port, "5901");
  click(getAction("button", "Add SSH connection"));
  const ssh = await screen.findByRole("dialog", { name: "Add host" });
  click(getAction("button", "Cancel", ssh));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(port).toHaveValue(5901);
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Choose a VNC login method",
  });
  expect(group).toHaveTextContent("Apple screen sharing");
  click(group);
  click(await screen.findByRole("option", { name: "Certificate-based VNC" }));
  expect(group).toHaveTextContent("Certificate-based VNC");
});
test.each([
  [
    "Mac",
    "On the Mac you want to connect, open System Settings → General → Sharing.",
  ],
  [
    "Windows",
    "On the Windows computer you want to connect, install or open a supported VNC server.",
  ],
  [
    "Linux",
    "On the Linux computer you want to connect, install or open a VNC server for the desktop session.",
  ],
])(
  "VNC preparation shows %s instructions in place and retains the choice on return",
  async (os, instruction) => {
    await setupFromNetwork("tailscale");
    click(
      screen.getByText(
        "Control the device’s screen with a mouse and keyboard.",
      ),
    );
    click(getAction("button", "Continue"));
    await screen.findByRole("heading", {
      name: "Enable screen sharing on the computer you want to connect",
    });
    expect(
      screen.queryByRole("heading", { name: "Device operating system" }),
    ).toBeNull();
    click(
      getAction(
        "radio",
        os,
        screen.getByRole("radiogroup", { name: "Device operating system" }),
      ),
    );
    expect(screen.getByText(instruction)).toBeVisible();
    click(getAction("button", "Enabled, continue"));
    await screen.findByRole("heading", { name: "Choose a VNC login method" });
    click(getAction("button", "Back"));
    await screen.findByRole("heading", {
      name: "Enable screen sharing on the computer you want to connect",
    });
    expect(screen.getByText(instruction)).toBeVisible();
    expect(getAction("radio", os)).toHaveAttribute("aria-checked", "true");
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Set up a connection" });
    click(getAction("button", "Continue"));
    await screen.findByRole("heading", {
      name: "Enable screen sharing on the computer you want to connect",
    });
    expect(screen.getByText(instruction)).toBeVisible();
  },
);
test("VNC with no saved network shows an actionable empty state and preserves the address through help", async () => {
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Start setup"));
  await screen.findByRole("heading", {
    name: "Enable screen sharing on the computer you want to connect",
  });
  click(getAction("button", "Enabled, continue"));
  await screen.findByLabelText("Login method");
  click(getAction("button", "Continue"));
  const address = await screen.findByLabelText("Device address");
  await fill(address, "screen.example.com");
  click(screen.getByLabelText("Connection method"));
  click(await screen.findByRole("option", { name: "Cloudflare Access" }));
  await screen.findByText(/No Cloudflare Access network added yet/u);
  expect(screen.queryByRole("combobox", { name: "Saved network" })).toBeNull();
  expect(getAction("button", "Add a private network")).toBeEnabled();
  expect(getAction("button", "Continue")).toBeDisabled();
  click(getAction("button", "Where can I find the device address?"));
  await screen.findByText(/open Zero Trust → Access controls → Applications/u);
  await userEvent.keyboard("{Escape}");
  expect(address).toHaveValue("screen.example.com");
  click(getAction("button", "Add a private network"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a network type",
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(picker).not.toBeInTheDocument();
  });
  expect(address).toHaveValue("screen.example.com");
  expect(getAction("button", "Continue")).toBeDisabled();
});
test("Private network dependencies block deletion of a referenced network", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, {
      configs: [
        {
          ...network,
          sshHosts: [
            {
              id: "b0000000-0000-4000-8000-000000000001",
              displayName: "Office computer",
            },
          ],
        },
      ],
    });
  });
  await page(
    `/connectors?scope=private-network&remoteResource=tailscale:${network.id}`,
  );
  await screen.findByText("Office computer");
  expect(getAction("button", "Delete Tailscale")).toBeDisabled();
});
test("Changing category abandons setup and returns to management", async () => {
  const username = await directForm();
  await fill(username, "operator");
  const directory = queryAction("button", "Connectors");
  if (directory) {
    click(directory);
  }
  click(await screen.findByTestId("connectors-scope-private-network"));
  await screen.findByRole("heading", { name: "Private networks" });
  click(screen.getByTestId("connectors-scope-remote-control"));
  await screen.findByRole("heading", { name: "Remote connections" });
  expect(screen.queryByLabelText("SSH username")).toBeNull();
});

test("A rejected SSH save retains the entered name and does not show a success state", async () => {
  context.mocks.api(sshConnectionsContract.create, ({ respond }) => {
    return respond(400, {
      error: { code: "SSH_INVALID_HOST", message: "Invalid host" },
    });
  });
  const username = await directForm();
  await fill(screen.getByLabelText("Device address"), "invalid.example.com");
  await fill(username, "operator");
  expect(screen.queryByLabelText("Credential name")).toBeNull();
  await fill(screen.getByLabelText("Password"), "test-only-password");
  const name = screen.getByLabelText(/Connection name/u);
  await fill(name, "Office computer");
  click(getAction("button", "Save"));
  await screen.findByRole("alert");
  expect(name).toHaveValue("Office computer");
  expect(
    screen.queryByRole("heading", { name: "Connection added" }),
  ).toBeNull();
  expect(getAction("button", "Save")).toBeEnabled();
});

test("VNC saves only after reviewing the connection and server identity", async () => {
  const requests: unknown[] = [];
  let savedId = "";
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    savedId = body.id;
    return respond(201, {
      id: body.id,
      displayName: body.displayName,
      host: body.host,
      port: body.port,
      generation: 1,
      credential: { type: "none" },
      security: { type: "x509_none", trust: { mode: "system" } },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Start setup"));
  await screen.findByRole("heading", {
    name: "Enable screen sharing on the computer you want to connect",
  });
  click(getAction("button", "Enabled, continue"));
  click(await screen.findByLabelText("Login method"));
  click(
    await screen.findByRole("option", {
      name: "Encrypted without a VNC password (X509None)",
    }),
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Connect a device",
  });
  await fill(screen.getByLabelText("Device address"), "screen.example.com");
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  const name = screen.getByLabelText(/Connection name/u);
  expect(name).toBeRequired();
  expect(name).toHaveValue("");
  await fill(name, "Office screen");
  expect(requests).toHaveLength(0);
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Review and save",
  });
  expect(screen.getByLabelText("Server certificate trust")).toHaveTextContent(
    "System certificate authorities",
  );
  click(getAction("button", "Save"));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(getAction("link", "View connection").getAttribute("href")).toContain(
    `remoteResource=vnc%3A${savedId}`,
  );
  expect(requests).toStrictEqual([
    expect.objectContaining({
      displayName: "Office screen",
      host: "screen.example.com",
      port: 5900,
      security: { type: "x509_none", trust: { mode: "system" } },
    }),
  ]);
});
test("Mac VNC review shows its network, address, and account method before saving", async () => {
  await setupFromNetwork("tailscale");
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  click(getAction("button", "Use existing connection details"));
  click(await screen.findByLabelText("Service type"));
  click(await screen.findByRole("option", { name: "Apple screen sharing" }));
  expect(screen.getByLabelText("Login method")).toHaveTextContent("Apple DH");
  click(getAction("button", "Continue"));
  await fill(await screen.findByLabelText("Device address"), "100.64.0.24");
  click(getAction("button", "Continue"));
  await fill(
    await screen.findByLabelText("Username", { exact: true }),
    "operator",
  );
  await fill(
    screen.getByLabelText("Password", { exact: true }),
    "test-password",
  );
  await fill(screen.getByLabelText(/Connection name/u), "Office Mac");
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Review and save" });
  expect(screen.getByText("100.64.0.24", { selector: "dd" })).toBeVisible();
  expect(
    screen.getByText("Tailscale · Office network", { selector: "dd" }),
  ).toBeVisible();
  expect(
    screen.getByText("Apple DH username and password", { selector: "dd" }),
  ).toBeVisible();
  expect(
    screen.getByText("Saving a connection does not authorize its use in chat."),
  ).toBeVisible();
  expect(getAction("button", "Save")).toBeEnabled();
});

test("Switching protocols starts the matching editor instead of retaining the previous protocol form", async () => {
  const username = await directForm();
  await fill(username, "operator");
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Use existing connection details",
  });
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("radio", "VNC"));
  click(getAction("button", "Start setup"));
  await screen.findByRole("heading", {
    name: "Enable screen sharing on the computer you want to connect",
  });
  click(getAction("button", "Enabled, continue"));
  await screen.findByRole("heading", {
    name: "Choose a VNC login method",
  });
  expect(screen.queryByLabelText("SSH username")).toBeNull();
});

test("Leaving setup cancels an editor that is still loading credentials", async () => {
  const gate = context.mocks.deferred<void>();
  context.mocks.api(sshCredentialsContract.list, async ({ respond }) => {
    await gate.promise;
    return respond(200, { credentials: [] });
  });
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Use existing connection details"));
  await screen.findByRole("heading", {
    name: "Use existing connection details",
  });
  click(screen.getByText("Direct connection"));
  const directory = queryAction("button", "Connectors");
  if (directory) {
    click(directory);
  }
  click(await screen.findByTestId("connectors-scope-private-network"));
  await screen.findByRole("heading", { name: "Private networks" });
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(screen.getByTestId("connectors-scope-remote-control"));
  await screen.findByRole("heading", { name: "Remote connections" });
  expect(screen.queryByLabelText("SSH username")).toBeNull();
});

test("An idempotent retry keeps the connection name from the locked draft", async () => {
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return requests.length === 1
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Save outcome unknown",
          },
        })
      : respond(204);
  });
  const username = await directForm();
  await fill(screen.getByLabelText("Device address"), "retry.example.com");
  await fill(username, "operator");
  expect(screen.queryByLabelText("Credential name")).toBeNull();
  await fill(screen.getByLabelText("Password"), "test-only-password");
  const name = screen.getByLabelText(/Connection name/u);
  await fill(name, "Office retry");
  click(getAction("button", "Save"));
  await screen.findByText("Save failed.");
  expect(name).toBeDisabled();
  click(getAction("button", "Retry"));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(screen.getByText("Office retry")).toBeInTheDocument();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toStrictEqual(requests[0]);
});

const sshHost: SshConnectionResponse = Object.freeze({
  id: "b0000000-0000-4000-8000-000000000001",
  displayName: "Office computer",
  host: "ssh.example.com",
  port: 22,
  username: "operator",
  credentialId: "d0000000-0000-4000-8000-000000000001",
  credentialName: "Old internal name",
  generation: 1,
  learnedHostKey: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const sshLogin: SshCredentialResponse = Object.freeze({
  id: "d0000000-0000-4000-8000-000000000001",
  name: "Old internal name",
  username: "operator",
  authMethod: "password",
  revision: 3,
  hosts: [
    { id: sshHost.id, displayName: sshHost.displayName },
    {
      id: "b0000000-0000-4000-8000-000000000002",
      displayName: "Backup computer",
    },
  ],
  createdAt: timestamp,
  updatedAt: timestamp,
});
const vncHost = Object.freeze<VncConnectionResponse>({
  id: "b0000000-0000-4000-8000-000000000003",
  displayName: "Office screen",
  host: "screen.example.com",
  port: 5900,
  credentialId: "d0000000-0000-4000-8000-000000000003",
  credentialName: "Old screen login",
  security: { type: "x509_vnc", trust: { mode: "system" } },
  generation: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const vncLogin: VncCredentialResponse = Object.freeze({
  id: "d0000000-0000-4000-8000-000000000003",
  name: "Old screen login",
  authMethod: "vnc_password",
  revision: 4,
  hosts: [
    { id: vncHost.id, displayName: vncHost.displayName },
    {
      id: "b0000000-0000-4000-8000-000000000004",
      displayName: "Backup screen",
    },
  ],
  createdAt: timestamp,
  updatedAt: timestamp,
});
function mockSavedConnections() {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [sshHost] });
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [sshLogin] });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [vncHost] });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [vncLogin] });
  });
}
async function editConnection(protocol: "ssh" | "vnc") {
  await page(
    `/connectors?scope=remote-control&remoteResource=${protocol}:${protocol === "ssh" ? sshHost.id : vncHost.id}`,
  );
  await screen.findByRole("heading", {
    name: protocol === "ssh" ? sshHost.displayName : vncHost.displayName,
  });
  click(getAction("button", "Edit connection"));
  await screen.findByRole("heading", { name: "Edit connection" });
  return await screen.findByLabelText(
    protocol === "ssh" ? "Password" : "VNC password",
  );
}

test.each(["ssh", "vnc"] as const)(
  "%s editing leaves saved secrets blank and renaming keeps the existing credential",
  async (protocol) => {
    mockSavedConnections();
    const writes: unknown[] = [];
    context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
      writes.push(body);
      return respond(200, {
        ...sshHost,
        displayName: body.displayName ?? sshHost.displayName,
        generation: 2,
      });
    });
    context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
      writes.push(body);
      return respond(200, {
        ...vncHost,
        displayName: body.displayName ?? vncHost.displayName,
        generation: 3,
      });
    });
    const secret = await editConnection(protocol);
    expect(secret).toHaveValue("");
    expect(secret).not.toBeRequired();
    expect(screen.queryByLabelText("Credential name")).toBeNull();
    expect(screen.queryByLabelText("VNC credential name")).toBeNull();
    click(screen.getByText("Connection settings", { selector: "summary" }));
    if (protocol === "vnc") {
      click(screen.getByText("More settings", { selector: "summary" }));
    }
    expect(screen.getByLabelText("Port")).toHaveValue(
      protocol === "ssh" ? 22 : 5900,
    );
    await fill(screen.getByLabelText(/Connection name/u), "Renamed device");
    click(getAction("button", "Save"));
    await screen.findByRole("heading", {
      name: protocol === "ssh" ? sshHost.displayName : vncHost.displayName,
    });
    expect(writes).toStrictEqual([
      expect.objectContaining({
        displayName: "Renamed device",
        credential: { id: protocol === "ssh" ? sshLogin.id : vncLogin.id },
      }),
    ]);
  },
);

test.each(["ssh", "vnc"] as const)(
  "%s shared login requires confirmation; cancelling retains the draft without writing",
  async (protocol) => {
    mockSavedConnections();
    const writes: unknown[] = [];
    const loginWrites: unknown[] = [];
    context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
      writes.push(body);
      return respond(200, { ...sshHost, generation: 2 });
    });
    context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
      writes.push(body);
      return respond(200, { ...vncHost, generation: 3 });
    });
    context.mocks.api(sshCredentialsContract.update, ({ body, respond }) => {
      loginWrites.push(body);
      return respond(200, { ...sshLogin, revision: 4 });
    });
    context.mocks.api(vncCredentialsContract.update, ({ body, respond }) => {
      loginWrites.push(body);
      return respond(200, { ...vncLogin, revision: 5 });
    });
    const secret = await editConnection(protocol);
    await fill(secret, "newpass");
    click(getAction("button", "Save"));
    const confirmation = await screen.findByRole("dialog", {
      name: "Update shared login information?",
    });
    expect(confirmation).toHaveTextContent(
      protocol === "ssh" ? "Backup computer" : "Backup screen",
    );
    expect(confirmation).toHaveTextContent("2 connections");
    expect(writes).toHaveLength(0);
    expect(loginWrites).toHaveLength(0);
    click(getAction("button", "Continue editing", confirmation));
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(secret).toHaveValue("newpass");
    expect(writes).toHaveLength(0);
    click(getAction("button", "Save"));
    const confirmAgain = await screen.findByRole("dialog", {
      name: "Update shared login information?",
    });
    click(getAction("button", "Confirm update", confirmAgain));
    await screen.findByRole("heading", {
      name: protocol === "ssh" ? sshHost.displayName : vncHost.displayName,
    });
    expect(writes).toHaveLength(1);
    expect(loginWrites).toStrictEqual([
      expect.objectContaining({
        expectedRevision: protocol === "ssh" ? 3 : 4,
        authentication: {
          method: protocol === "ssh" ? "password" : "vnc_password",
          password: "newpass",
        },
      }),
    ]);
  },
);

test("VNC reuse offers only login information matching the configured authentication profile", async () => {
  mockSavedConnections();
  await editConnection("vnc");
  click(getAction("button", "Use saved login information"));
  const picker = await screen.findByRole("dialog", {
    name: "Use saved login information",
  });
  expect(picker).toHaveTextContent("Office screen");
  expect(picker).not.toHaveTextContent("Office computer");
  await userEvent.keyboard("{Escape}");
  click(screen.getByText("Connection settings", { selector: "summary" }));
  click(screen.getByLabelText("Login method"));
  click(
    await screen.findByRole("option", {
      name: "Encrypted without a VNC password (X509None)",
    }),
  );
  expect(queryAction("button", "Use saved login information")).toBeNull();
  expect(screen.queryByLabelText("VNC password")).toBeNull();
});

test("A resource deep link cannot expose the new editor when the switch is off", async () => {
  mockSavedConnections();
  await page(
    `/connectors?scope=remote-control&remoteResource=ssh:${sshHost.id}`,
    false,
  );
  await screen.findByRole("heading", { name: sshHost.displayName });
  expect(
    screen.queryByRole("heading", { name: "Connection details" }),
  ).toBeNull();
  expect(queryAction("button", "Add host")).not.toBeNull();
});

test.each(["ssh", "vnc"] as const)(
  "%s revision conflicts retain the login draft and require review of the new shared impact",
  async (protocol) => {
    mockSavedConnections();
    let savedSsh = sshHost;
    let savedVnc = vncHost;
    const revisions: number[] = [];
    const generations: number[] = [];
    const addedHost = {
      id: "b0000000-0000-4000-8000-000000000005",
      displayName: "Another shared computer",
    };
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [savedSsh] });
    });
    context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [savedVnc] });
    });
    context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
      return respond(200, {
        credentials: [
          revisions.length
            ? {
                ...sshLogin,
                revision: 4,
                hosts: [...sshLogin.hosts, addedHost],
              }
            : sshLogin,
        ],
      });
    });
    context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
      return respond(200, {
        credentials: [
          revisions.length
            ? {
                ...vncLogin,
                revision: 5,
                hosts: [...vncLogin.hosts, addedHost],
              }
            : vncLogin,
        ],
      });
    });
    context.mocks.api(sshConnectionsContract.update, ({ body, respond }) => {
      generations.push(body.expectedGeneration);
      savedSsh = { ...savedSsh, generation: savedSsh.generation + 1 };
      return respond(200, savedSsh);
    });
    context.mocks.api(vncConnectionsContract.update, ({ body, respond }) => {
      generations.push(body.expectedGeneration);
      savedVnc = { ...savedVnc, generation: savedVnc.generation + 1 };
      return respond(200, savedVnc);
    });
    context.mocks.api(sshCredentialsContract.update, ({ body, respond }) => {
      revisions.push(body.expectedRevision);
      return revisions.length === 1
        ? respond(409, {
            error: {
              code: "SSH_CREDENTIAL_REVISION_CONFLICT",
              message: "Changed",
            },
          })
        : respond(200, { ...sshLogin, revision: 5 });
    });
    context.mocks.api(vncCredentialsContract.update, ({ body, respond }) => {
      revisions.push(body.expectedRevision);
      return revisions.length === 1
        ? respond(409, {
            error: {
              code: "VNC_CREDENTIAL_REVISION_CONFLICT",
              message: "Changed",
            },
          })
        : respond(200, { ...vncLogin, revision: 6 });
    });
    const secret = await editConnection(protocol);
    await fill(secret, "newpass");
    click(getAction("button", "Save"));
    const impact = await screen.findByRole("dialog", {
      name: "Update shared login information?",
    });
    click(getAction("button", "Confirm update", impact));
    const keep = await waitFor(() => {
      return getAction("button", "Keep my changes with this version");
    });
    expect(secret).toHaveValue("newpass");
    expect(
      screen.getByText(
        "Connection settings are saved. Review the login information update before leaving.",
      ),
    ).toBeInTheDocument();
    click(keep);
    await waitFor(() => {
      return expect(getAction("button", "Save")).toBeEnabled();
    });
    expect(secret).toHaveValue("newpass");
    click(getAction("button", "Save"));
    const latestImpact = await screen.findByRole("dialog", {
      name: "Update shared login information?",
    });
    expect(latestImpact).toHaveTextContent("3 connections");
    expect(latestImpact).toHaveTextContent(addedHost.displayName);
    click(getAction("button", "Confirm update", latestImpact));
    await screen.findByRole("heading", {
      name: protocol === "ssh" ? sshHost.displayName : vncHost.displayName,
    });
    expect(generations).toStrictEqual(protocol === "ssh" ? [1, 2] : [2, 3]);
    expect(revisions).toStrictEqual(protocol === "ssh" ? [3, 4] : [4, 5]);
  },
);

test.each(["ssh", "vnc"] as const)(
  "%s details show saved settings without check controls or chat access",
  async (protocol) => {
    mockSavedConnections();
    const host = protocol === "ssh" ? sshHost : vncHost;
    await page(
      `/connectors?scope=remote-control&remoteResource=${protocol}:${host.id}`,
    );
    await screen.findByRole("heading", { name: host.displayName });
    expect(
      screen.queryByRole("heading", {
        name: "Connection checks are unavailable",
      }),
    ).toBeNull();
    expect(queryAction("button", "Check connection")).toBeNull();
    expect(queryAction("link", "Check in chat")).toBeNull();
    expect(queryAction("link", "Open chat")).toBeNull();
    expect(screen.queryByText("Check status")).toBeNull();
    expect(screen.queryByText("Not checked yet")).toBeNull();
  },
);

async function openNetworkForm(provider: "Tailscale" | "Cloudflare Access") {
  await page("/connectors?scope=private-network");
  await waitFor(() => {
    expect(getAction("button", "Add network")).toBeInTheDocument();
  });
  click(getAction("button", "Add network"));
  await screen.findByRole("heading", { name: "Add a private network" });
  click(screen.getByText(provider, { exact: true }));
  await screen.findByRole("dialog", {
    name:
      provider === "Tailscale"
        ? "Tailscale connection setup"
        : "Cloudflare connection setup",
  });
  click(getAction("button", "Enter existing credentials"));
  return await screen.findByRole("textbox", { name: "Network name" });
}
test("Cloudflare three-step guide preserves the draft and resumes after returning", async () => {
  const name = await openNetworkForm("Cloudflare Access");
  await fill(name, "Cloudflare draft");
  const secret = screen.getByLabelText("Client Secret");
  await fill(secret, "test-only-draft-secret");
  click(getAction("button", "Show entered value", secret.parentElement!));
  expect(secret).toHaveAttribute("type", "text");
  expect(screen.getByLabelText("Client ID")).toHaveAttribute(
    "type",
    "password",
  );
  click(getAction("button", "How do I get connection credentials?"));
  await screen.findByRole("dialog", { name: "Cloudflare connection setup" });
  expect(getAction("link", "Open Cloudflare dashboard")).toHaveAttribute(
    "target",
    "_blank",
  );
  click(getAction("button", "Continue"));
  expect(screen.getByText("2 / 3")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(name).toHaveValue("Cloudflare draft");
  expect(secret).toHaveValue("test-only-draft-secret");
  click(getAction("button", "Hide entered value"));
  expect(secret).toHaveAttribute("type", "password");
  click(getAction("button", "How do I get connection credentials?"));
  expect(screen.getByText("2 / 3")).toBeInTheDocument();
  click(getAction("button", "Previous"));
  expect(screen.getByText("1 / 3")).toBeInTheDocument();
  click(getAction("button", "Continue"));
  expect(screen.getByText("Service Auth")).toBeInTheDocument();
  expect(
    screen.getByText(/keep existing rules unchanged/u),
  ).toBeInTheDocument();
  click(getAction("button", "Continue"));
  expect(
    screen.getByText("Return to the form and click Save network."),
  ).toBeInTheDocument();
  click(getAction("button", "Return to form"));
  expect(name).toHaveValue("Cloudflare draft");
  expect(getAction("button", "Save network")).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").find((button) => {
      return /copy.*admin/iu.test(button.textContent ?? "");
    }),
  ).toBeUndefined();
});
test("Tailscale guide uses current form tags and keeps secret inputs mounted through close", async () => {
  const user = userEvent.setup();
  const name = await openNetworkForm("Tailscale");
  await fill(name, "Tailnet draft");
  click(screen.getByText("Allowed tags", { selector: "summary" }));
  await fill(screen.getByLabelText("Allowed tags"), "tag:office, tag:review");
  const secret = screen.getByLabelText("Client Secret");
  await fill(secret, "test-only-draft-secret");
  click(getAction("button", "How do I get connection credentials?"));
  await screen.findByRole("dialog", { name: "Tailscale connection setup" });
  click(getAction("button", "Continue"));
  expect(screen.getByText("tag:office, tag:review")).toBeInTheDocument();
  await user.click(getAction("button", "Copy Tags"));
  await expect(navigator.clipboard.readText()).resolves.toBe(
    "tag:office, tag:review",
  );
  await user.click(getAction("button", "Copy Keys → Auth keys"));
  await expect(navigator.clipboard.readText()).resolves.toBe("Write");
  click(screen.getByText("Can’t find the tag?"));
  expect(
    screen.getByText(/Definitions → Tags and click Create tag/u),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Enter office, review in Tag name/u),
  ).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(name).toHaveValue("Tailnet draft");
  expect(secret).toHaveValue("test-only-draft-secret");
  click(getAction("button", "How do I get connection credentials?"));
  expect(screen.getByText("2 / 3")).toBeInTheDocument();
  click(getAction("button", "Continue"));
  expect(screen.getByText(/click “Save network”/u)).toBeInTheDocument();
  click(getAction("button", "Return to form"));
  expect(getAction("button", "Save network")).toBeInTheDocument();
  click(getAction("button", "How do I get connection credentials?"));
  click(getAction("button", "Return to selection"));
  await screen.findByRole("heading", { name: "Add a private network" });
  click(screen.getByText("Tailscale", { exact: true }));
  await screen.findByRole("dialog", { name: "Tailscale connection setup" });
  click(getAction("button", "Continue"));
  expect(screen.getByText("tag:office, tag:review")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(name).toHaveValue("Tailnet draft");
  expect(secret).toHaveValue("test-only-draft-secret");
});

test("Private network starts with one neutral provider selector and both guides can return to it", async () => {
  await page("/connectors?scope=private-network");
  await screen.findByRole("heading", { name: "Personal networks" });
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.trim() === "Add network";
    }),
  ).toHaveLength(1);
  click(getAction("button", "Add network"));
  await screen.findByRole("heading", { name: "Add a private network" });
  expect(
    screen.getByText("Choose the network your device uses."),
  ).toBeInTheDocument();
  for (const provider of ["Tailscale", "Cloudflare Access"]) {
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Network name" })).toBeNull();
    click(screen.getByText(provider, { exact: true }));
    await screen.findByRole("dialog", {
      name:
        provider === "Tailscale"
          ? "Tailscale connection setup"
          : "Cloudflare connection setup",
    });
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(
      getAction("button", "Enter existing credentials"),
    ).toBeInTheDocument();
    click(getAction("button", "Return to selection"));
    await screen.findByRole("heading", { name: "Add a private network" });
  }
  expect(
    screen.queryByRole("heading", {
      name: "Install Tailscale",
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Set up a connection" }),
  ).toBeNull();
  context.mocks.api(cloudflareAccessContract.create, ({ respond }) => {
    return respond(204);
  });
  click(screen.getByText("Cloudflare Access", { exact: true }));
  await screen.findByRole("dialog", { name: "Cloudflare connection setup" });
  click(getAction("button", "Enter existing credentials"));
  const name = await screen.findByRole("textbox", { name: "Network name" });
  const form = name.closest("form");
  if (!form) {
    throw new Error("Missing network form");
  }
  await fill(name, "Saved network");
  await fill(within(form).getByLabelText("Client ID"), "test-client");
  await fill(within(form).getByLabelText("Client Secret"), "test-secret");
  click(getAction("button", "Save network"));
  await screen.findByRole("heading", { name: "Personal networks" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Network name" })).toBeNull();
});

test("Members see personal and organization networks together, with separate management rights", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  const shared = {
    ...cloudflareNetwork,
    id: "b0000000-0000-4000-8000-000000000001",
    name: "Team gateway",
    scope: "organization" as const,
  };
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  await page("/connectors?scope=private-network", true, "member");
  const personal = await screen.findByRole("region", {
    name: "Personal networks",
  });
  const organization = screen.getByRole("region", {
    name: "Organization networks",
  });
  await waitFor(() => {
    expect(
      screen.getByTestId("connectors-scope-private-network"),
    ).toHaveTextContent("Private network2");
  });
  expect(within(personal).getByText(network.name)).toBeInTheDocument();
  expect(
    getAction("link", `Manage ${network.name}`, personal),
  ).toBeInTheDocument();
  expect(
    within(organization).getByText(
      "Available to members; managed by administrators",
    ),
  ).toBeInTheDocument();
  expect(
    getAction("link", `View ${shared.name}`, organization),
  ).toBeInTheDocument();
  expect(within(organization).queryByText("Engineering")).toBeNull();
  expect(
    within(organization).getByText(shared.name).closest("a"),
  ).toHaveAttribute(
    "href",
    expect.stringContaining(`remoteResource=cloudflare%3A${shared.id}`),
  );
});

test("Network counts open only that network's device connections and preserve in-app navigation", async () => {
  mockSavedConnections();
  const shared = {
    ...cloudflareNetwork,
    name: "Shared gateway",
    scope: "organization" as const,
    sshHosts: [{ id: sshHost.id, displayName: sshHost.displayName }],
    vncHosts: [],
  };
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, {
      configs: [
        {
          ...network,
          vncHosts: [
            {
              id: vncHost.id,
              displayName: vncHost.displayName,
              roles: ["rfb"],
            },
          ],
        },
      ],
    });
  });
  await page("/connectors?scope=private-network", true, "member");
  const count = await waitFor(() => {
    return getAction("button", "Shared gateway · Your 1 connection");
  });
  click(count);
  await waitFor(() => {
    const dialog = screen.getByRole("dialog", {
      name: "Connections using this network",
    });
    expect(within(dialog).getByText(sshHost.displayName)).toBeInTheDocument();
    expect(within(dialog).queryByText(vncHost.displayName)).toBeNull();
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(
    await waitFor(() => {
      return getAction("button", "Office network · Your 1 connection");
    }),
  );
  const hostLink = await waitFor(() => {
    const dialog = screen.getByRole("dialog", {
      name: "Connections using this network",
    });
    const host = within(dialog).getByText(vncHost.displayName);
    expect(host).toBeInTheDocument();
    return host;
  });
  click(hostLink);
  await screen.findByRole("heading", { name: vncHost.displayName });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("SSH and VNC stay personal even when their transport uses an organization network", async () => {
  mockSavedConnections();
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, {
      configs: [{ ...cloudflareNetwork, scope: "organization" as const }],
    });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: [
        {
          ...sshHost,
          port: 443,
          transport: {
            type: "cloudflare_access",
            configId: cloudflareNetwork.id,
          },
        },
      ],
    });
  });
  await page("/connectors?scope=remote-control", true, "member");
  const personal = await screen.findByRole("region", {
    name: "Personal connections",
  });
  expect(
    screen.queryByRole("heading", { name: "No devices added yet" }),
  ).toBeNull();
  expect(queryAction("button", "Add your first device")).toBeNull();
  expect(within(personal).getByText(sshHost.displayName)).toBeInTheDocument();
  expect(within(personal).getByText(vncHost.displayName)).toBeInTheDocument();
  expect(within(personal).getAllByText("Manage")).toHaveLength(2);
  expect(
    screen.queryByRole("region", { name: "Organization connections" }),
  ).toBeNull();
});

test("Organization network details let members use the network without management actions", async () => {
  const shared = {
    ...cloudflareNetwork,
    name: "Team gateway",
    scope: "organization" as const,
  };
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  await page(
    `/connectors?scope=private-network&remoteResource=cloudflare:${shared.id}`,
    true,
    "member",
  );
  await screen.findByRole("heading", { name: shared.name });
  expect(
    screen.getByText(
      "You can use this network. Organization administrators manage it.",
    ),
  ).toBeInTheDocument();
  expect(queryAction("button", "Edit settings")).toBeNull();
  expect(queryAction("button", "Delete Cloudflare Access")).toBeNull();
});

test.each(["Tailscale", "Cloudflare Access"] as const)(
  "%s creation defaults to personal and explains the unavailable organization option for members",
  async (provider) => {
    await page("/connectors?scope=private-network", true, "member");
    await screen.findByRole("heading", {
      name: "Personal networks",
    });
    click(getAction("button", "Add network"));
    await screen.findByRole("heading", { name: "Add a private network" });
    click(screen.getByText(provider, { exact: true }));
    await screen.findByRole("dialog");
    click(getAction("button", "Enter existing credentials"));
    await screen.findByLabelText("Network name");
    const personal = screen.getByLabelText(/Only me/u, { selector: "input" });
    const organization = screen.getByLabelText(/Organization members/u, {
      selector: "input",
    });
    expect(personal).toBeChecked();
    expect(organization).toBeDisabled();
    expect(
      screen.getByText(
        "Members of Engineering can use this network to connect devices.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Organization administrators create and manage organization networks.",
      ),
    ).toBeInTheDocument();
  },
);

test("Sharing Tailscale requires confirmation, keeps the draft on cancel, and preserves connection references", async () => {
  let saved = {
    ...network,
    sshHosts: [
      {
        id: "c0000000-0000-4000-8000-000000000001",
        displayName: "Owner computer",
      },
    ],
  };
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [saved] });
  });
  context.mocks.api(
    tailscaleContract.convertToOrganization,
    ({ body, respond }) => {
      expect(body).toStrictEqual({ expectedRevision: 1 });
      saved = { ...saved, scope: "organization", revision: 2 };
      return respond(200, saved);
    },
  );
  context.mocks.api(tailscaleContract.update, ({ body, respond }) => {
    expect(body.expectedRevision).toBe(2);
    saved = { ...saved, name: body.name ?? saved.name, revision: 3 };
    return respond(200, saved);
  });
  await page(
    `/connectors?scope=private-network&remoteResource=tailscale:${network.id}`,
    true,
    "admin",
  );
  await screen.findByRole("heading", { name: network.name });
  click(getAction("button", "Edit settings"));
  const name = await screen.findByLabelText("Network name");
  await fill(name, "Shared office draft");
  click(screen.getByText("Organization members", { exact: true }));
  click(getAction("button", "Save network"));
  const confirmation = await screen.findByRole("dialog", {
    name: "Allow organization members to use this network?",
  });
  expect(saved.scope).toBe("personal");
  expect(saved.name).toBe(network.name);
  expect(within(confirmation).getByText("Owner computer")).toBeInTheDocument();
  expect(
    within(confirmation).getByText(
      "Sharing network settings does not share device connections.",
    ),
  ).toBeInTheDocument();
  click(getAction("button", "Continue editing", confirmation));
  expect(name).toHaveValue("Shared office draft");
  expect(saved.scope).toBe("personal");
  click(getAction("button", "Save network"));
  const confirmAgain = await screen.findByRole("dialog", {
    name: "Allow organization members to use this network?",
  });
  click(getAction("button", "Confirm sharing", confirmAgain));
  await screen.findByRole("heading", { name: "Shared office draft" });
  expect(saved.scope).toBe("organization");
  expect(saved.sshHosts).toStrictEqual([
    {
      id: "c0000000-0000-4000-8000-000000000001",
      displayName: "Owner computer",
    },
  ]);
});

test("Restricting Cloudflare requires the current impact acknowledgement and retains saved connections", async () => {
  let saved = {
    ...cloudflareNetwork,
    name: "Team gateway",
    scope: "organization" as "personal" | "organization",
    sshHosts: [
      {
        id: "c0000000-0000-4000-8000-000000000001",
        displayName: "Owner computer",
      },
    ],
  };
  const impactSnapshot = "a".repeat(64);
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [saved] });
  });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(200, {
      expectedRevision: 1,
      ownHostCount: 1,
      otherHostCount: 2,
      affectedOwners: [{ userId: "another-member", displayName: "Alex" }],
      impactSnapshot,
    });
  });
  context.mocks.api(
    cloudflareAccessContract.convertToPersonal,
    ({ body, respond }) => {
      expect(body).toStrictEqual({ expectedRevision: 1, impactSnapshot });
      saved = { ...saved, scope: "personal", revision: 2 };
      return respond(200, saved);
    },
  );
  context.mocks.api(cloudflareAccessContract.update, ({ body, respond }) => {
    expect(body.expectedRevision).toBe(2);
    saved = { ...saved, name: body.name ?? saved.name, revision: 3 };
    return respond(200, saved);
  });
  await page(
    `/connectors?scope=private-network&remoteResource=cloudflare:${network.id}`,
    true,
    "admin",
  );
  await screen.findByRole("heading", { name: saved.name });
  click(getAction("button", "Edit settings"));
  await screen.findByLabelText("Network name");
  click(screen.getByText("Only me", { exact: true }));
  click(getAction("button", "Save network"));
  const confirmation = await screen.findByRole("dialog", {
    name: "Make this network available only to you?",
  });
  await within(confirmation).findByText("Alex");
  expect(getAction("button", "Make personal", confirmation)).toBeDisabled();
  expect(saved.scope).toBe("organization");
  click(
    within(confirmation).getByText(
      "I understand that affected members must select another network before using their saved connections again.",
    ),
  );
  click(getAction("button", "Make personal", confirmation));
  await screen.findByText("You can use and manage this network.");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Make this network available only to you?",
      }),
    ).toBeNull();
  });
  expect(saved.scope).toBe("personal");
  expect(saved.sshHosts).toStrictEqual([
    {
      id: "c0000000-0000-4000-8000-000000000001",
      displayName: "Owner computer",
    },
  ]);
});

test("A scope revision conflict keeps the edit draft and prevents another unreviewed submission", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  context.mocks.api(tailscaleContract.convertToOrganization, ({ respond }) => {
    return respond(409, {
      error: { code: "TAILSCALE_REVISION_CONFLICT", message: "Changed" },
    });
  });
  await page(
    `/connectors?scope=private-network&remoteResource=tailscale:${network.id}`,
    true,
    "admin",
  );
  await screen.findByRole("heading", { name: network.name });
  click(getAction("button", "Edit settings"));
  const name = await screen.findByLabelText("Network name");
  await fill(name, "Retained after conflict");
  click(screen.getByText("Organization members", { exact: true }));
  click(getAction("button", "Save network"));
  const confirmation = await screen.findByRole("dialog", {
    name: "Allow organization members to use this network?",
  });
  click(getAction("button", "Confirm sharing", confirmation));
  await within(confirmation).findByText(
    /The network or its linked connections changed/u,
  );
  expect(getAction("button", "Confirm sharing", confirmation)).toBeDisabled();
  click(getAction("button", "Continue editing", confirmation));
  expect(name).toHaveValue("Retained after conflict");
});

test.each(["Tailscale", "Cloudflare Access"] as const)(
  "%s saves its explicitly selected organization scope without changing other networks",
  async (provider) => {
    let savedTs: TailscaleConfig[] = [network];
    let savedCf = [cloudflareNetwork];
    context.mocks.api(tailscaleContract.list, ({ respond }) => {
      return respond(200, { configs: savedTs });
    });
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, { configs: savedCf });
    });
    context.mocks.api(tailscaleContract.create, ({ body, respond }) => {
      expect(body.scope).toBe("organization");
      const created = {
        ...network,
        id: body.id,
        name: body.name,
        scope: "organization" as const,
      };
      savedTs = [...savedTs, created];
      return respond(201, created);
    });
    context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
      expect(body.scope).toBe("organization");
      const created = {
        ...cloudflareNetwork,
        id: body.id,
        name: body.name,
        scope: "organization" as const,
      };
      savedCf = [...savedCf, created];
      return respond(201, created);
    });
    await page("/connectors?scope=private-network", true, "admin");
    await screen.findByRole("region", { name: "Personal networks" });
    click(getAction("button", "Add network"));
    await screen.findByRole("heading", { name: "Add a private network" });
    click(screen.getByText(provider, { exact: true }));
    await screen.findByRole("dialog");
    click(getAction("button", "Enter existing credentials"));
    const name = await screen.findByLabelText("Network name");
    const form = name.closest("form")!;
    await fill(name, "New team network");
    click(screen.getByText("Organization members", { exact: true }));
    await waitFor(() => {
      expect(
        screen.getByLabelText(/Organization members/u, { selector: "input" }),
      ).toBeChecked();
    });
    await fill(within(form).getByLabelText("Client ID"), "test-only-id");
    await fill(
      within(form).getByLabelText("Client Secret"),
      "test-only-secret",
    );
    click(getAction("button", "Save network"));
    const organization = await screen.findByRole("region", {
      name: "Organization networks",
    });
    await within(organization).findByText("New team network");
    const personal = screen.getByRole("region", { name: "Personal networks" });
    expect(within(personal).getAllByText(network.name)).toHaveLength(2);
  },
);
