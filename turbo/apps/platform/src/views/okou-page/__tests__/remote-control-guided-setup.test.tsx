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
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
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
import { createDeferredPromise } from "../../../signals/utils.ts";
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
    },
  });
}
async function directForm() {
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(screen.getByText("Run commands on the device."));
  return await screen.findByLabelText("SSH username");
}
async function selectConnectionNetwork(
  provider: "Tailscale" | "Cloudflare Access" | "Tailscale SSH",
  name = network.name,
) {
  click(await screen.findByRole("combobox", { name: "Connection method" }));
  click(await screen.findByRole("option", { name: `${name} · ${provider}` }));
}
test.each(["ssh", "vnc"] as const)(
  "The new deep link %s keeps the existing experience when guided is off",
  async (protocol) => {
    await page(`/connectors?scope=remote-control&setup=${protocol}`, false);
    await waitFor(() => {
      expect(getAction("button", "Add host")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: "Add remote connection" }),
    ).toBeNull();
    expect(queryAction("button", "Add connection")).toBeNull();
  },
);
test.each([
  "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
  "user_3G9pYGWE2oaAQAUfb8wIwcLxwiy",
])(
  "The empty remote directory lets %s start setup with only its empty-state action",
  async (userId) => {
    await page("/connectors?scope=remote-control", true, undefined, userId);
    await screen.findByRole("heading", { name: "No devices added yet" });
    expect(
      screen.getByText("Let Okou work on a computer or server you choose."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Add remote connection" }),
    ).toBeNull();
    expect(queryAllByRoleFast("tab")).toHaveLength(0);
    expect(queryAction("button", "Add credential")).toBeNull();
    expect(
      queryAllByRoleFast("button").filter((button) => {
        return button.textContent?.trim() === "Add connection";
      }),
    ).toHaveLength(1);
    click(getAction("button", "Add connection"));
    await screen.findByRole("heading", { name: "Add remote connection" });
    expect(screen.getByText("Computer use").closest("a")).toHaveAttribute(
      "href",
      "/connectors?scope=remote-control&setup=computer-use&computerUseStep=install",
    );
    expect(screen.getByText("Run commands on the device.")).toBeVisible();
    expect(
      screen.getByText(
        "Control the device’s screen with a mouse and keyboard.",
      ),
    ).toBeInTheDocument();
  },
);
test.each([
  ["ssh", false],
  ["vnc", false],
  ["ssh", true],
  ["vnc", true],
] as const)(
  "The remote directory waits for %s before showing an add action with saved connections=%s",
  async (protocol, populated) => {
    const release = context.mocks.deferred<void>();
    if (protocol === "ssh") {
      context.mocks.api(
        sshConnectionsContract.list,
        async ({ respond, withSignal }) => {
          await withSignal(release.promise);
          return respond(200, { connections: populated ? [sshHost] : [] });
        },
      );
    } else {
      context.mocks.api(
        vncConnectionsContract.list,
        async ({ respond, withSignal }) => {
          await withSignal(release.promise);
          return respond(200, { connections: populated ? [vncHost] : [] });
        },
      );
    }
    await page("/connectors?scope=connected");
    click(screen.getByTestId("connectors-scope-remote-control"));
    await screen.findByText("Loading…");
    expect(queryAction("button", "Add connection")).toBeNull();
    expect(screen.queryByText("No devices added yet")).toBeNull();
    release.resolve();
    if (populated) {
      await screen.findByRole("listitem", {
        name: protocol === "ssh" ? sshHost.displayName : vncHost.displayName,
      });
    } else {
      await screen.findByRole("heading", { name: "No devices added yet" });
    }
    expect(getAction("button", "Add connection")).toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").filter((button) => {
        return button.textContent?.trim() === "Add connection";
      }),
    ).toHaveLength(1);
    expect(screen.queryByText("Loading…")).toBeNull();
  },
);

test("Computer use opens its download guide from the parallel connection choices", async () => {
  await page("/connectors?scope=remote-control&setup=add");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(screen.getByText("Computer use"));
  const dialog = await screen.findByRole("dialog", {
    name: "Install and sign in",
  });
  expect(dialog).toHaveTextContent("Install and sign in");
  expect(new URLSearchParams(window.location.search).get("setup")).toBe(
    "computer-use",
  );
  const download = await waitFor(() => {
    return getAction("link", "Download for macOS", dialog);
  });
  expect(download).toHaveAttribute(
    "href",
    expect.stringContaining("/api/desktop/updates/stable/darwin/arm64/dmg"),
  );
  click(getAction("button", "Continue", dialog));
  await screen.findByRole("heading", { name: "Allow access and stay online" });
  expect(within(dialog).getByRole("presentation")).toHaveAttribute(
    "src",
    expect.stringContaining("computer-use-permissions-online-"),
  );
  expect(
    new URLSearchParams(window.location.search).get("computerUseStep"),
  ).toBe("permissions");
  click(getAction("button", "Continue", dialog));
  await screen.findByRole("heading", { name: "Enable it in chat" });
  expect(
    new URLSearchParams(window.location.search).get("computerUseStep"),
  ).toBe("chat");
  act(() => {
    return window.history.back();
  });
  await screen.findByRole("heading", { name: "Allow access and stay online" });
  click(getAction("button", "Previous", dialog));
  await screen.findByRole("heading", { name: "Install and sign in" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(new URLSearchParams(window.location.search).get("setup")).toBe("add");
  click(screen.getByText("Run commands on the device."));
  await expect(
    screen.findByLabelText("SSH username"),
  ).resolves.toBeInTheDocument();
});

test("A Computer use URL restores the installation guide", async () => {
  await page(
    "/connectors?scope=remote-control&setup=computer-use&computerUseStep=install",
    true,
    undefined,
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Install and sign in",
  });
  expect(
    within(dialog).getByText(/Requires an Apple silicon Mac/),
  ).toBeInTheDocument();
  expect(within(dialog).getByRole("presentation")).toHaveAttribute(
    "src",
    expect.stringContaining("computer-use-install-sign-in-"),
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(screen.getByText("Computer use").closest("a")).toHaveAttribute(
    "href",
    "/connectors?scope=remote-control&setup=computer-use&computerUseStep=install",
  );
  expect(screen.getByText("Run commands on the device.")).toBeInTheDocument();
});

test.each([
  ["permissions", "Allow access and stay online"],
  ["chat", "Enable it in chat"],
])("A Computer use URL restores the %s step", async (step, title) => {
  await page(
    `/connectors?scope=remote-control&setup=computer-use&computerUseStep=${step}`,
  );
  const dialog = await screen.findByRole("dialog", { name: title });
  const illustration = within(dialog).getByRole("figure");
  expect(illustration).toBeInTheDocument();
});

test("The Computer use chat guide renders a vector rather than a bitmap", async () => {
  await page(
    "/connectors?scope=remote-control&setup=computer-use&computerUseStep=chat",
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Enable it in chat",
  });
  const illustration = within(dialog).getByRole("img");
  expect(illustration.tagName).toBe("svg");
  expect(within(illustration).getByText("Your computer")).toBeInTheDocument();
  expect(within(illustration).getByText("This Mac")).toBeInTheDocument();
});

test.each([
  ["profile", "Choose a VNC login method"],
  ["connection", "Connect a device"],
  ["login", "Enter device login information"],
  ["trust", "Review and save"],
])("A VNC URL restores the %s step", async (step, title) => {
  await page(
    `/connectors?scope=remote-control&setup=vnc&step=${step}&vncProfile=x509_vnc&vncRoute=direct`,
  );
  await screen.findByRole("heading", { name: title });
  expect(new URLSearchParams(window.location.search).get("step")).toBe(step);
});

test("VNC steps follow browser history", async () => {
  await page("/connectors?scope=remote-control&setup=vnc&step=profile");
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a device" });
  expect(new URLSearchParams(window.location.search).get("step")).toBe(
    "connection",
  );
  act(() => {
    return window.history.back();
  });
  await screen.findByRole("heading", { name: "Choose a VNC login method" });
});

test("An SSH URL restores the connection form", async () => {
  await page("/connectors?scope=remote-control&setup=ssh&step=login");
  await screen.findByLabelText("SSH username");
  await fill(screen.getByLabelText("Password"), "not-for-the-url");
  expect(window.location.search).toBe(
    "?scope=remote-control&setup=ssh&step=login",
  );
});

test.each(["ssh", "vnc"])(
  "A saved %s URL restores the persisted connection rather than an empty success screen",
  async (protocol) => {
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [sshHost] });
    });
    context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [vncHost] });
    });
    const connection = protocol === "ssh" ? sshHost : vncHost;
    await page(
      `/connectors?scope=remote-control&setup=${protocol}&step=saved&savedConnection=${connection.id}`,
    );
    await screen.findByRole("heading", { name: "Connection added" });
    expect(screen.getByText(connection.displayName)).toBeInTheDocument();
    expect(getAction("link", "View connection")).toHaveAttribute(
      "href",
      `/connectors?scope=remote-control&remoteResource=${protocol}%3A${connection.id}`,
    );
  },
);

test("An unavailable saved connection cannot show a success screen", async () => {
  await page(
    "/connectors?scope=remote-control&setup=ssh&step=saved&savedConnection=missing",
  );
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "This configuration is unavailable or you no longer have access.",
  );
  expect(
    screen.queryByRole("heading", { name: "Connection added" }),
  ).toBeNull();
});

test("A saved computer-setup link can return from network creation", async () => {
  await page("/connectors?scope=remote-control&setup=computer");
  await screen.findByRole("heading", {
    name: "Step 1 · Prepare the connection",
  });
  expect(
    screen.getByText("Set up Tailscale so Okou can connect to your computer."),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Device address")).toBeNull();
  expect(queryAction("button", "Continue with this network")).toBeNull();
  click(getAction("button", "Set up Tailscale"));
  const guide = await screen.findByRole("dialog");
  expect(
    within(guide).getByRole("heading", { name: "Download Tailscale" }),
  ).toBeInTheDocument();
  expect(queryAction("button", "Back", guide)).toBeNull();
  expect(queryAction("button", "Previous", guide)).toBeNull();
  expect(getAction("link", "Download Tailscale", guide)).toHaveAttribute(
    "href",
    "https://tailscale.com/download",
  );
  expect(screen.queryByText("Cloudflare Access", { exact: true })).toBeNull();
  await userEvent.keyboard("{Escape}");
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Step 1 · Prepare the connection",
  });
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Add remote connection" });
});

test.each([{ configs: [] }, { configs: [network] }])(
  "Computer setup waits for saved networks before showing setup actions: %j",
  async ({ configs }) => {
    const release = context.mocks.deferred<void>();
    context.mocks.api(
      tailscaleContract.list,
      async ({ respond, withSignal }) => {
        await withSignal(release.promise);
        return respond(200, { configs });
      },
    );
    await page("/connectors?scope=remote-control&setup=computer");
    await screen.findByText("Loading…");
    expect(queryAction("button", "Set up Tailscale")).toBeNull();
    expect(queryAction("button", "Continue with this network")).toBeNull();
    release.resolve();
    await waitFor(() => {
      expect(getAction("button", "Set up Tailscale")).toBeInTheDocument();
    });
    expect(screen.queryAllByLabelText("Saved network")).toHaveLength(
      configs.length,
    );
    expect(
      queryAllByRoleFast("button").filter((button) => {
        return button.textContent?.trim() === "Continue with this network";
      }),
    ).toHaveLength(configs.length);
  },
);

test("Connecting my computer returns after creating a Tailscale network and uses the chosen network", async () => {
  let savedTs: TailscaleConfig[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: savedTs });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [cloudflareNetwork] });
  });
  context.mocks.api(tailscaleContract.create, ({ body, respond }) => {
    const created = { ...network, id: body.id, name: body.name };
    savedTs = [created];
    return respond(201, created);
  });
  await page("/connectors?scope=remote-control&setup=computer");
  await screen.findByRole("heading", {
    name: "Step 1 · Prepare the connection",
  });
  expect(screen.queryByLabelText("Saved network")).toBeNull();
  click(getAction("button", "Set up Tailscale"));
  await screen.findByRole("dialog");
  click(getAction("button", "Enter existing credentials"));
  const name = await screen.findByLabelText("Network name");
  await fill(name, "Home network");
  await fill(screen.getByLabelText("Client ID"), "test-only-id");
  await fill(screen.getByLabelText("Client Secret"), "test-only-secret");
  click(getAction("button", "Save network"));
  await screen.findByRole("heading", {
    name: "Step 1 · Prepare the connection",
  });
  const selector = await screen.findByLabelText("Saved network");
  const continueButton = await waitFor(() => {
    return getAction("button", "Continue with this network");
  });
  expect(continueButton).toBeDisabled();
  click(selector);
  click(await screen.findByRole("option", { name: "Home network" }));
  expect(
    screen.queryByRole("option", { name: cloudflareNetwork.name }),
  ).toBeNull();
  click(getAction("button", "Continue with this network"));
  await screen.findByRole("heading", {
    name: "What should Okou do on your computer?",
  });
  expect(queryAction("button", "Private networks")).toBeNull();
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Step 1 · Prepare the connection",
  });
  expect(screen.getByLabelText("Saved network")).toHaveTextContent(
    "Home network",
  );
  click(getAction("button", "Continue with this network"));
  await screen.findByRole("heading", {
    name: "What should Okou do on your computer?",
  });
  click(screen.getByText("Run commands on the device."));
  await screen.findByText("Network: Home network · Tailscale");
  expect(screen.queryByLabelText("Connection method")).toBeNull();
  click(screen.getByText("More settings", { selector: "summary" }));
  expect(screen.queryByLabelText("Connection method")).toBeNull();
  expect(screen.getByLabelText("Device address")).toHaveValue("");
});
test("A refreshed computer network setup returns to the computer guide, not the provider picker", async () => {
  await page("/connectors?scope=private-network&setup=computer");
  await screen.findByRole("heading", {
    name: "Step 1 · Prepare the connection",
  });
  expect(screen.queryByText("Cloudflare Access", { exact: true })).toBeNull();
  expect(getAction("button", "Set up Tailscale")).toBeInTheDocument();
});

async function computerForm(protocol: "ssh" | "vnc") {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(503, { error: { message: "Cloudflare unavailable" } });
  });
  await page("/connectors?scope=remote-control&setup=computer");
  click(await screen.findByLabelText("Saved network"));
  click(await screen.findByRole("option", { name: network.name }));
  click(getAction("button", "Continue with this network"));
  click(
    await screen.findByText(
      protocol === "ssh" ? "Run commands (SSH)" : "Control the screen (VNC)",
    ),
  );
}

test("Computer SSH saves the chosen network without exposing route selection or depending on Cloudflare", async () => {
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(204);
  });
  await computerForm("ssh");
  await fill(await screen.findByLabelText("SSH username"), "operator");
  await fill(screen.getByLabelText("Device address"), "100.64.0.24");
  await fill(
    screen.getByLabelText("Password", { exact: true }),
    "test-password",
  );
  expect(screen.queryByLabelText("Connection method")).toBeNull();
  click(screen.getByText("More settings", { selector: "summary" }));
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(requests).toStrictEqual([
    expect.objectContaining({
      displayName: "100.64.0.24",
      host: "100.64.0.24",
      port: 22,
      transport: { type: "tailscale", configId: network.id },
    }),
  ]);
});

test.each(["", "My Mac"])(
  "Computer screen sharing saves the selected network and optional name %j",
  async (name) => {
    const requests: unknown[] = [];
    context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
      requests.push(body);
      return respond(204);
    });
    await computerForm("vnc");
    const service = await screen.findByLabelText("Screen-sharing service");
    expect(getAction("button", "Continue")).toBeDisabled();
    click(service);
    click(await screen.findByRole("option", { name: "Apple screen sharing" }));
    expect(screen.getByLabelText("Login method")).not.toBeVisible();
    click(getAction("button", "Continue"));
    await fill(await screen.findByLabelText("Device address"), "100.64.0.24");
    expect(
      screen.getByText(`Network: ${network.name} · Tailscale`),
    ).toBeVisible();
    expect(screen.queryByLabelText("Connection method")).toBeNull();
    expect(screen.queryByLabelText("Saved network")).toBeNull();
    click(getAction("button", "Back"));
    expect(screen.getByLabelText("Screen-sharing service")).toHaveTextContent(
      "Apple screen sharing",
    );
    click(getAction("button", "Continue"));
    expect(screen.getByLabelText("Device address")).toHaveValue("100.64.0.24");
    click(getAction("button", "Continue"));
    await fill(
      await screen.findByLabelText("Username", { exact: true }),
      "operator",
    );
    await fill(
      screen.getByLabelText("Password", { exact: true }),
      "test-password",
    );
    click(screen.getByText("Connection name (optional)"));
    expect(screen.getByLabelText("Connection name")).not.toBeRequired();
    await fill(screen.getByLabelText("Connection name"), name);
    click(getAction("button", "Continue"));
    await screen.findByRole("heading", { name: "Review and save" });
    expect(
      screen.queryByText(/If certificates or keys are required/u),
    ).toBeNull();
    expect(screen.queryByLabelText("Server certificate trust")).toBeNull();
    expect(requests).toHaveLength(0);
    click(getAction("button", "Save"));
    await screen.findByRole("heading", { name: "Connection added" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      displayName: name || "100.64.0.24",
      host: "100.64.0.24",
      port: 5900,
      transport: { type: "tailscale", configId: network.id },
      security: { type: "apple_dh" },
    });
  },
);

test("Other computer screen-sharing services retain explicit authentication and certificate settings", async () => {
  await computerForm("vnc");
  click(await screen.findByLabelText("Screen-sharing service"));
  click(await screen.findByRole("option", { name: "Other VNC software" }));
  expect(screen.getByLabelText("Service type")).toBeVisible();
  click(screen.getByLabelText("Login method"));
  click(
    await screen.findByRole("option", {
      name: "Encrypted without a VNC password (X509None)",
    }),
  );
  click(getAction("button", "Continue"));
  await fill(await screen.findByLabelText("Device address"), "100.64.0.24");
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Review and save" });
  expect(screen.getByLabelText("Server certificate trust")).toBeVisible();
});

test.each(["staff-colleague", "external-user"])(
  "Guided setup is enabled by default for %s",
  async (userId) => {
    await setupPage({
      context,
      path: "/connectors?scope=remote-control&setup=vnc",
      auth: {
        user: { id: userId, fullName: "Network Owner" },
        organization: {
          activeOrg: { id: "external-org", name: "External" },
          memberships: [{ id: "external-org" }],
        },
      },
    });
    await expect(
      screen.findByRole("heading", { name: "Add remote connection" }),
    ).resolves.toBeInTheDocument();
    expect(queryAction("button", "Add host")).toBeNull();
  },
);
test("An opted-in account can open its network list and count dialog", async () => {
  mockSavedConnections();
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  await page(
    `/connectors?scope=private-network&networkConnections=tailscale:${network.id}`,
    true,
    "member",
    "other-account",
  );
  await expect(
    screen.findByRole("dialog", {
      name: "Connections using this network",
    }),
  ).resolves.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect(
    screen.findByRole("region", { name: "Personal networks" }),
  ).resolves.toBeInTheDocument();
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
    screen.queryByRole("heading", { name: "Add remote connection" }),
  ).toBeNull();
});
test("Saved Tailscale networks can be managed", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  await page("/connectors?scope=private-network", true, undefined);
  await screen.findByText(network.name);
  click(getAction("link", `Manage ${network.name}`));
  await screen.findByRole("heading", { name: network.name });
  click(getAction("button", "Back to private networks"));
  await screen.findByText(network.name);
  click(getAction("button", "Add network"));
  await screen.findByRole("heading", { name: "Add a private network" });
  expect(
    screen.getByText("Cloudflare Access", { exact: true }),
  ).toBeInTheDocument();
  expect(screen.getByText("Tailscale", { exact: true })).toBeInTheDocument();
});
test("Private network links to connection management without starting device setup", async () => {
  await page("/connectors?scope=private-network&setup=ssh");
  click(
    await waitFor(() => {
      return getAction("link", "Manage device connections");
    }),
  );
  await screen.findByRole("heading", { name: "No devices added yet" });
  expect(
    screen.queryByRole("heading", { name: "Add remote connection" }),
  ).toBeNull();
});
test.each(["tailscale", "cloudflare"] as const)(
  "A %s network title is read-only and its Manage action opens details",
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
    const title = await screen.findByText(network.name);
    expect(title.closest("a, button")).toBeNull();
    click(title);
    expect(screen.queryByRole("heading", { name: network.name })).toBeNull();
    click(getAction("link", `Manage ${network.name}`));
    await screen.findByRole("heading", { name: network.name });
    expect(getAction("button", "Edit settings")).toBeInTheDocument();
    expect(queryAction("button", "Add connection")).toBeNull();
    expect(
      screen.getByText("Who can use this", { selector: "dt" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Only me", { selector: "dd" })).toBeInTheDocument();
    click(getAction("button", "Back to private networks"));
    expect((await screen.findByText(network.name)).closest("a")).toBeNull();
    expect(getAction("link", `Manage ${network.name}`)).toHaveAttribute(
      "href",
      expect.stringContaining(`remoteResource=${provider}%3A${network.id}`),
    );
  },
);
test.each(["ssh", "vnc"] as const)(
  "%s entry only offers protocol selection and opens the navigated configuration page",
  async (protocol) => {
    await page(`/connectors?scope=remote-control&setup=${protocol}`);
    await screen.findByRole("heading", { name: "Add remote connection" });
    expect(screen.queryByLabelText("Connection method")).toBeNull();
    expect(queryAction("button", "Back")).toBeNull();
    expect(queryAction("button", "Add a private network")).toBeNull();
    expect(screen.queryByText("Install Tailscale")).toBeNull();
    click(
      screen.getByText(
        protocol === "ssh"
          ? "Run commands on the device."
          : "Control the device’s screen with a mouse and keyboard.",
      ),
    );
    await screen.findByRole("heading", {
      name:
        protocol === "ssh"
          ? "Connect a computer or server"
          : "Choose a VNC login method",
    });
    expect(getAction("button", "Remote control")).toBeInTheDocument();
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Add remote connection" });
  },
);
async function setupWithSavedNetworks(provider: "tailscale" | "cloudflare") {
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
  await page("/connectors?scope=remote-control&setup=ssh", true);
  await screen.findByRole("heading", { name: "Add remote connection" });
}

async function selectVncNetwork(provider: "tailscale" | "cloudflare") {
  click(await screen.findByLabelText("Connection method"));
  click(
    await screen.findByRole("option", {
      name: provider === "tailscale" ? "Tailscale" : "Cloudflare Access",
    }),
  );
  click(await screen.findByRole("combobox", { name: "Saved network" }));
  click(await screen.findByRole("option", { name: network.name }));
}

test.each(["tailscale", "cloudflare"] as const)(
  "Manual SSH retains its selected %s network and clears login drafts when restarted",
  async (provider) => {
    await setupWithSavedNetworks(provider);
    click(
      screen.getByText(
        "Control the device’s screen with a mouse and keyboard.",
      ),
    );
    await screen.findByLabelText("Service type");
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Add remote connection" });
    click(screen.getByText("Run commands on the device."));
    await fill(await screen.findByLabelText("SSH username"), "draft-user");
    await fill(screen.getByLabelText("Device address"), "device.example.com");
    await selectConnectionNetwork(
      provider === "tailscale" ? "Tailscale" : "Cloudflare Access",
    );
    await expect(
      screen.findByLabelText("Connection method"),
    ).resolves.toHaveTextContent(network.name);
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Add remote connection" });
    click(screen.getByText("Run commands on the device."));
    await expect(screen.findByLabelText("SSH username")).resolves.toHaveValue(
      "",
    );
    expect(screen.getByLabelText("Device address")).toHaveValue("");
    expect(screen.getByLabelText("Connection method")).toHaveTextContent(
      network.name,
    );
    click(getAction("button", "Remote control"));
    await screen.findByRole("heading", { name: "No devices added yet" });
  },
);
test.each(["tailscale", "cloudflare"] as const)(
  "Manual VNC keeps its selected %s network during protective profile changes",
  async (provider) => {
    await setupWithSavedNetworks(provider);
    click(
      screen.getByText(
        "Control the device’s screen with a mouse and keyboard.",
      ),
    );
    const group = await screen.findByLabelText("Service type");
    click(group);
    click(await screen.findByRole("option", { name: "Apple screen sharing" }));
    click(getAction("button", "Continue"));
    await screen.findByRole("heading", { name: "Connect a device" });
    await selectVncNetwork(provider);
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
    expect(group).toHaveTextContent("Certificate-based VNC");
    click(getAction("button", "Continue"));
    await screen.findByRole("heading", { name: "Connect a device" });
    expect(
      screen.getByRole("combobox", { name: "Saved network" }),
    ).toHaveTextContent(network.name);
    expect(screen.getByLabelText("Device address")).toHaveValue(
      "device.example.com",
    );
    click(getAction("button", "Remote control"));
    await screen.findByRole("heading", { name: "No devices added yet" });
  },
);
test("Manual setup clears the chosen network when leaving for the remote directory", async () => {
  await setupWithSavedNetworks("cloudflare");
  click(screen.getByText("Run commands on the device."));
  await screen.findByLabelText("Connection method");
  await selectConnectionNetwork("Cloudflare Access");
  const directory = queryAction("button", "Connectors");
  if (directory) {
    click(directory);
  }
  click(await screen.findByTestId("connectors-scope-private-network"));
  await screen.findByRole("region", { name: "Private networks" });
  click(screen.getByTestId("connectors-scope-remote-control"));
  await screen.findByRole("heading", { name: "No devices added yet" });
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Add remote connection" });
  expect(queryAction("button", "Back")).toBeNull();
});
test("Manual VNC can select a saved Tailscale network", async () => {
  await setupWithSavedNetworks("tailscale");
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  await screen.findByRole("heading", { name: "Choose a VNC login method" });
  click(await screen.findByLabelText("Service type"));
  click(await screen.findByRole("option", { name: "Apple screen sharing" }));
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a device" });
  await selectVncNetwork("tailscale");
  expect(screen.getByLabelText("Connection method")).toHaveTextContent(
    "Tailscale",
  );
  expect(
    screen.getByRole("combobox", { name: "Saved network" }),
  ).toHaveTextContent(network.name);
});
test.each(["Tailscale", "Cloudflare Access"] as const)(
  "Remote control selects an existing %s network without provisioning",
  async (provider) => {
    context.mocks.api(tailscaleContract.list, ({ respond }) => {
      return respond(200, { configs: [network] });
    });
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, { configs: [cloudflareNetwork] });
    });
    await page("/connectors?scope=remote-control&setup=ssh");
    await screen.findByRole("heading", { name: "Add remote connection" });
    click(screen.getByText("Run commands on the device."));
    await screen.findByLabelText("SSH username");
    expect(screen.getByLabelText("Connection method")).toHaveTextContent(
      "Direct connection",
    );
    await selectConnectionNetwork(provider);
    await screen.findByLabelText("SSH username");
    expect(
      screen.getByRole("combobox", {
        name: "Connection method",
      }),
    ).toHaveTextContent(network.name);
    expect(screen.queryByLabelText("Client Secret")).toBeNull();
    expect(queryAction("button", "Add Service Token")).toBeNull();
  },
);
test("Manual SSH chooses a saved Tailscale SSH route and saves without SSH credentials", async () => {
  const homeNetwork = {
    ...network,
    id: "a0000000-0000-4000-8000-000000000002",
    name: "Home network",
  };
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network, homeNetwork] });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [cloudflareNetwork] });
  });
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(201, {
      id: body.id,
      displayName: body.displayName,
      host: body.host,
      username: "ubuntu",
      port: 22,
      transport: { type: "tailscale_ssh", configId: homeNetwork.id },
      generation: 1,
      learnedHostKey: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
  await directForm();
  await fill(screen.getByLabelText("Device address"), "100.64.0.25");
  await fill(screen.getByLabelText("SSH username"), "ssh-user");
  await fill(screen.getByLabelText("Password"), "ssh-password");
  click(screen.getByLabelText("Connection method"));
  const tailscaleGroup = await screen.findByRole("group", {
    name: "Tailscale",
  });
  expect(
    within(tailscaleGroup).getByRole("option", {
      name: "Office network · Tailscale",
    }),
  ).toHaveTextContent(/^Office network$/);
  expect(
    screen.getByRole("group", {
      name: "Cloudflare Access",
    }),
  ).toBeInTheDocument();
  const tailscaleSshGroup = screen.getByRole("group", {
    name: "Tailscale SSH",
  });
  click(
    within(tailscaleSshGroup).getByRole("option", {
      name: "Office network · Tailscale SSH",
    }),
  );
  await fill(await screen.findByLabelText("System username"), "ubuntu");
  expect(screen.getByLabelText("Connection method")).toHaveTextContent(
    "Office network · Tailscale SSH",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Password")).not.toBeVisible();
  expect(screen.getByLabelText("Password")).toBeDisabled();
  await selectConnectionNetwork("Cloudflare Access");
  expect(screen.getByLabelText("SSH username")).toHaveValue("ssh-user");
  expect(screen.getByLabelText("Password")).toHaveValue("ssh-password");
  await selectConnectionNetwork("Tailscale SSH", homeNetwork.name);
  expect(screen.getByLabelText("System username")).toHaveValue("ubuntu");
  expect(screen.getByLabelText("Device address")).toHaveValue("100.64.0.25");
  click(screen.getByText("More settings"));
  expect(screen.getByLabelText("Port")).toBeDisabled();
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: expect.any(String),
      host: "100.64.0.25",
      port: 22,
      username: "ubuntu",
      transport: { type: "tailscale_ssh", configId: homeNetwork.id },
    },
  ]);
});

test.each(["Tailscale", "Cloudflare Access"] as const)(
  "An uncertain %s network save retains the locked draft",
  async (provider) => {
    if (provider === "Tailscale") {
      context.mocks.api(tailscaleContract.create, ({ respond }) => {
        return respond(500, {
          error: {
            code: "INTERNAL_ERROR",
            message: "Response unavailable",
          },
        });
      });
    } else {
      context.mocks.api(cloudflareAccessContract.create, ({ respond }) => {
        return respond(500, {
          error: {
            code: "INTERNAL_ERROR",
            message: "Response unavailable",
          },
        });
      });
    }
    const name = await openNetworkForm(provider);
    await fill(name, "Recovered network");
    await fill(screen.getByLabelText("Client ID"), "test-client");
    await fill(screen.getByLabelText("Client Secret"), "test-secret");
    click(getAction("button", "Save network"));
    await screen.findByText("Save failed.");
    expect(name).toHaveValue("Recovered network");
    expect(name).toBeDisabled();
  },
);
test.each(["tailscale", "cloudflare"] as const)(
  "%s settings allow optional credential replacement without fetching saved secrets",
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
        return getAction("button", "Edit settings");
      }),
    );
    await screen.findByRole("heading", {
      name:
        provider === "tailscale" ? "Edit Tailscale" : "Edit Cloudflare Access",
    });
    const replaceLabel =
      provider === "tailscale"
        ? "Replace OAuth credentials"
        : "Replace Service Token";
    const replace = screen.getByRole("checkbox", { name: replaceLabel });
    expect(replace).not.toBeChecked();
    expect(screen.queryByLabelText("Client Secret")).toBeNull();
    await userEvent.click(replace);
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
    click(getAction("button", "Edit settings"));
    const replaceAgain = await screen.findByRole("checkbox", {
      name: replaceLabel,
    });
    expect(replaceAgain).not.toBeChecked();
    expect(screen.queryByLabelText("Client Secret")).toBeNull();
    await userEvent.click(replaceAgain);
    const reopened = await screen.findByLabelText("Client Secret");
    expect(reopened).toHaveValue("");
    expect(reopened).toHaveAttribute("type", "password");
  },
);
test.each([
  ["tailscale", false],
  ["tailscale", true],
  ["cloudflare", false],
  ["cloudflare", true],
] as const)(
  "%s settings save with optional credential replacement=%s",
  async (provider, replace) => {
    const contract =
      provider === "tailscale" ? tailscaleContract : cloudflareAccessContract;
    let saved = provider === "tailscale" ? network : cloudflareNetwork;
    context.mocks.api(contract.list, ({ respond }) => {
      return respond(200, { configs: [saved] });
    });
    context.mocks.api(contract.update, ({ body, respond }) => {
      expect(body).toStrictEqual({
        expectedRevision: 1,
        name: "Updated office network",
        ...(provider === "tailscale" ? { tags: network.tags } : {}),
        ...(replace
          ? {
              credentials: {
                clientId: "test-client",
                clientSecret: "test-secret",
              },
            }
          : {}),
      });
      saved = {
        ...saved,
        name: body.name ?? saved.name,
        revision: 2,
        generation: replace ? 2 : 1,
      };
      return respond(200, saved);
    });
    await page(
      `/connectors?scope=private-network&remoteResource=${provider}:${network.id}`,
    );
    await screen.findByRole("heading", { name: network.name });
    click(getAction("button", "Edit settings"));
    const name = await screen.findByLabelText("Network name");
    await fill(name, "Updated office network");
    if (replace) {
      await userEvent.click(
        screen.getByRole("checkbox", {
          name:
            provider === "tailscale"
              ? "Replace OAuth credentials"
              : "Replace Service Token",
        }),
      );
      await fill(await screen.findByLabelText("Client ID"), "test-client");
      await fill(screen.getByLabelText("Client Secret"), "test-secret");
    }
    click(getAction("button", "Save network"));
    await screen.findByRole("heading", { name: "Updated office network" });
    expect(getAction("button", "Edit settings")).toBeInTheDocument();
  },
);

test("Direct SSH accepts an optional name, retains input through username help and saves through the contract", async () => {
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
  click(screen.getByText("Connection name (optional)"));
  const name = screen.getByLabelText(/Connection name/u);
  expect(name).toHaveValue("");
  expect(name).not.toBeRequired();
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
  click(getAction("button", "Add connection"));
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
test("An unnamed SSH connection uses the current device address after correcting a rejected save", async () => {
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return requests.length === 1
      ? respond(400, {
          error: { code: "SSH_INVALID_HOST", message: "Invalid host" },
        })
      : respond(204);
  });
  const username = await directForm();
  const address = screen.getByLabelText("Device address");
  await fill(address, "first.example.com");
  await fill(username, "operator");
  await fill(screen.getByLabelText("Password"), "test-only-password");
  click(getAction("button", "Add connection"));
  await screen.findByRole("alert");
  await fill(address, "corrected.example.com");
  click(screen.getByText("Connection name (optional)"));
  expect(screen.getByLabelText("Connection name")).toHaveValue("");
  expect(screen.getByLabelText("Connection name")).toHaveAttribute(
    "placeholder",
    "corrected.example.com",
  );
  click(screen.getByText("Connection name (optional)"));
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(screen.getByText("corrected.example.com")).toBeInTheDocument();
  expect(requests).toStrictEqual(
    ["first.example.com", "corrected.example.com"].map((host) => {
      return expect.objectContaining({
        displayName: host,
        host,
        credential: {
          create: {
            name: host,
            username: "operator",
            authentication: {
              method: "password",
              password: "test-only-password",
            },
          },
        },
      });
    }),
  );
});

test("Empty private networks show disabled options and guidance only inside the network menu", async () => {
  const release = context.mocks.deferred<void>();
  context.mocks.api(tailscaleContract.list, async ({ respond, withSignal }) => {
    await withSignal(release.promise);
    return respond(200, { configs: [] });
  });
  await directForm();
  await screen.findByText("Loading…");
  const selector = screen.getByLabelText("Connection method");
  expect(selector).toHaveTextContent("Direct connection");
  expect(screen.queryByText(/Add a network in “Private networks”/u)).toBeNull();
  click(selector);
  await screen.findByRole("option", { name: "Direct connection" });
  expect(screen.queryByRole("option", { name: "Private networks" })).toBeNull();

  release.resolve();
  await expect(
    screen.findByRole("option", { name: "Private networks" }),
  ).resolves.toHaveAttribute("aria-disabled", "true");
  expect(
    screen.getByText(/Add a network in “Private networks”/u),
  ).toBeVisible();
  click(screen.getByRole("option", { name: "Direct connection" }));
  await waitFor(() => {
    expect(
      screen.queryByText(/Add a network in “Private networks”/u),
    ).toBeNull();
  });
  expect(selector).toHaveTextContent("Direct connection");
  expect(screen.getByLabelText("Device address")).toBeEnabled();
});

test("Saved network loading failures leave direct access available", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(503, { error: { message: "Network unavailable" } });
  });
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(screen.getByText("Run commands on the device."));
  await screen.findByLabelText("SSH username");
  await screen.findByText(
    "Unable to load this step. Your entries are saved in the form.",
  );
  expect(screen.getByLabelText("Connection method")).toHaveTextContent(
    "Direct connection",
  );
  expect(screen.getByLabelText("Device address")).toBeEnabled();
  click(screen.getByLabelText("Connection method"));
  await screen.findByRole("option", { name: "Direct connection" });
  expect(screen.queryByRole("option", { name: "Private networks" })).toBeNull();
  expect(screen.queryByText(/Add a network in “Private networks”/u)).toBeNull();
  await userEvent.keyboard("{Escape}");
});
test("The remote selector lists all saved networks without auto-selecting a single provider", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, {
      configs: [
        network,
        {
          ...network,
          id: "a0000000-0000-4000-8000-000000000002",
          name: "Home network",
        },
      ],
    });
  });
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [cloudflareNetwork] });
  });
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(screen.getByText("Run commands on the device."));
  await screen.findByLabelText("SSH username");
  expect(screen.getByLabelText("Connection method")).toHaveTextContent(
    "Direct connection",
  );
  click(screen.getByLabelText("Connection method"));
  const home = await screen.findByRole("option", {
    name: "Home network · Tailscale",
  });
  expect(screen.queryByRole("option", { name: "Private networks" })).toBeNull();
  expect(screen.queryByText(/Add a network in “Private networks”/u)).toBeNull();
  click(home);
  await screen.findByLabelText("SSH username");
  expect(screen.getByLabelText("Connection method")).toHaveTextContent(
    "Home network",
  );
});
test("VNC keeps empty SSH selection disabled and preserves the draft between steps", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
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
  await expect(screen.findByLabelText("SSH host")).resolves.toBeDisabled();
  expect(screen.getByLabelText("SSH host")).toHaveTextContent(
    "No SSH connections available",
  );
  expect(screen.getByLabelText("SSH host")).toHaveAccessibleDescription(
    "Add an SSH connection in “Remote control”, then select it here.",
  );
  expect(queryAction("button", "Continue")).toBeNull();
  expect(screen.getByLabelText("Device address")).not.toBeVisible();
  expect(
    screen.getByText("More settings", { selector: "summary" }),
  ).not.toBeVisible();
  expect(
    screen.queryByText(/SSH protects the Runner-to-SSH-server hop/u),
  ).toBeNull();
  expect(
    screen.getByText(/This method requires an SSH connection/u),
  ).not.toBeVisible();
  click(screen.getByLabelText("Connection method"));
  click(await screen.findByRole("option", { name: "Tailscale" }));
  click(await screen.findByLabelText("Saved network"));
  click(await screen.findByRole("option", { name: /Office network/u }));
  await waitFor(() => {
    expect(screen.getByLabelText("Device address")).toBeVisible();
  });
  click(screen.getByText("More settings", { selector: "summary" }));
  const port = screen.getByLabelText("Port");
  await fill(port, "5901");
  expect(queryAction("button", "Add SSH connection")).toBeNull();
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Choose a VNC login method",
  });
  expect(group).toHaveTextContent("Apple screen sharing");
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a device" });
  expect(screen.getByLabelText("Port")).toHaveValue(5901);
});
test("VNC with no saved network hides dependent fields and preserves the address when switching back", async () => {
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  await screen.findByLabelText("Login method");
  click(getAction("button", "Continue"));
  const address = await screen.findByLabelText("Device address");
  await fill(address, "screen.example.com");
  click(screen.getByLabelText("Connection method"));
  click(await screen.findByRole("option", { name: "Cloudflare Access" }));
  await expect(screen.findByLabelText("Saved network")).resolves.toBeDisabled();
  expect(screen.getByLabelText("Saved network")).toHaveTextContent(
    "No Cloudflare Access networks available",
  );
  expect(screen.getByLabelText("Saved network")).toHaveAccessibleDescription(
    "Add a Cloudflare Access network in “Private networks”, then select it here.",
  );
  expect(queryAction("button", "Add a private network")).toBeNull();
  expect(queryAction("button", "Continue")).toBeNull();
  expect(address).not.toBeVisible();
  expect(
    screen.getByText("More settings", { selector: "summary" }),
  ).not.toBeVisible();
  expect(screen.queryByRole("checkbox", { name: "Origin TLS" })).toBeNull();
  click(screen.getByLabelText("Connection method"));
  click(await screen.findByRole("option", { name: "Tailscale" }));
  await expect(
    screen.findByLabelText("Saved network"),
  ).resolves.toHaveTextContent("No Tailscale networks available");
  expect(screen.getByLabelText("Saved network")).toBeDisabled();
  expect(queryAction("button", "Continue")).toBeNull();
  expect(address).not.toBeVisible();
  click(screen.getByLabelText("Connection method"));
  click(await screen.findByRole("option", { name: "Direct connection" }));
  expect(screen.queryByLabelText("Saved network")).toBeNull();
  await waitFor(() => {
    expect(address).toBeVisible();
    expect(getAction("button", "Continue")).toBeEnabled();
  });
  expect(address).toHaveValue("screen.example.com");
});

test("VNC displays saved Cloudflare connection details", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [cloudflareNetwork] });
  });
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  click(await screen.findByLabelText("Service type"));
  click(await screen.findByRole("option", { name: "Apple screen sharing" }));
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a device" });
  click(screen.getByLabelText("Connection method"));
  click(await screen.findByRole("option", { name: "Cloudflare Access" }));
  const selector = await screen.findByLabelText("Saved network");
  click(selector);
  click(await screen.findByRole("option", { name: /Office network/u }));
  await waitFor(() => {
    expect(screen.getByLabelText("Origin TLS server name")).toBeVisible();
  });
  expect(screen.getByRole("checkbox", { name: "Origin TLS" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Origin TLS" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  const address = screen.getByLabelText("Device address");
  await fill(address, "screen.example.com");
  click(getAction("button", "Where can I find the device address?"));
  await screen.findByText(/open Zero Trust → Access controls → Applications/u);
  expect(
    within(screen.getByRole("dialog")).getAllByRole("listitem"),
  ).toHaveLength(3);
  await userEvent.keyboard("{Escape}");
  expect(address).toHaveValue("screen.example.com");
  click(getAction("button", "Continue"));
  expect(
    screen.getByRole("heading", { name: "Connect a device" }),
  ).toBeInTheDocument();
  await fill(
    screen.getByLabelText("Origin TLS server name"),
    "screen.internal",
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
});

test("VNC can select an existing SSH host without empty-state guidance", async () => {
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [sshHost] });
  });
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  await screen.findByLabelText("Login method");
  click(getAction("button", "Continue"));
  const address = await screen.findByLabelText("Device address");
  await fill(address, "screen.example.com");
  click(screen.getByLabelText("Connection method"));
  click(await screen.findByRole("option", { name: "Through saved SSH host" }));
  const selector = await screen.findByLabelText("SSH host");
  expect(selector).toBeEnabled();
  click(selector);
  click(
    await screen.findByRole("option", {
      name: `${sshHost.displayName} · ${sshHost.host}:${sshHost.port}`,
    }),
  );
  expect(selector).toHaveTextContent(sshHost.displayName);
  expect(
    screen.queryByText(/Add an SSH connection in “Remote control”/u),
  ).toBeNull();
  expect(queryAction("button", "Add SSH connection")).toBeNull();
  expect(getAction("button", "Continue")).toBeEnabled();
});
test.each([
  ["tailscale", "ssh"],
  ["tailscale", "vnc"],
  ["cloudflare", "ssh"],
  ["cloudflare", "vnc"],
] as const)(
  "%s network deletion explains its %s dependency beside the disabled action",
  async (provider, protocol) => {
    const contract =
      provider === "tailscale" ? tailscaleContract : cloudflareAccessContract;
    const host = {
      id: "b0000000-0000-4000-8000-000000000001",
      displayName: "Office computer",
    };
    context.mocks.api(contract.list, ({ respond }) => {
      return respond(200, {
        configs: [
          {
            ...(provider === "tailscale" ? network : cloudflareNetwork),
            sshHosts: protocol === "ssh" ? [host] : [],
            vncHosts: protocol === "vnc" ? [{ ...host, roles: ["rfb"] }] : [],
          },
        ],
      });
    });
    await page(
      `/connectors?scope=private-network&remoteResource=${provider}:${network.id}`,
    );
    await screen.findByText("Office computer");
    const deleteLabel =
      provider === "tailscale"
        ? "Delete Tailscale"
        : "Delete Cloudflare Access";
    expect(getAction("button", deleteLabel)).toBeDisabled();
    const explanation =
      "Your SSH or VNC hosts still use this network. Rebind or delete those hosts first.";
    expect(screen.queryByText(explanation)).toBeNull();

    const info = getAction("button", "Why can't I delete this network?");
    await userEvent.click(info);
    const popover = await screen.findByRole("dialog", { name: deleteLabel });
    expect(within(popover).getByText(explanation)).toBeInTheDocument();
    expect(getAction("button", deleteLabel)).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(info).toHaveFocus();
  },
);

test.each(["tailscale", "cloudflare"] as const)(
  "An unused %s network keeps deletion available without dependency info",
  async (provider) => {
    const contract =
      provider === "tailscale" ? tailscaleContract : cloudflareAccessContract;
    context.mocks.api(contract.list, ({ respond }) => {
      return respond(200, {
        configs: [provider === "tailscale" ? network : cloudflareNetwork],
      });
    });
    await page(
      `/connectors?scope=private-network&remoteResource=${provider}:${network.id}`,
    );
    await screen.findByRole("heading", { name: network.name });
    expect(
      getAction(
        "button",
        provider === "tailscale"
          ? "Delete Tailscale"
          : "Delete Cloudflare Access",
      ),
    ).toBeEnabled();
    expect(
      queryAction("button", "Why can't I delete this network?"),
    ).toBeNull();
  },
);
test("Changing category abandons setup and returns to management", async () => {
  const username = await directForm();
  await fill(username, "operator");
  const directory = queryAction("button", "Connectors");
  if (directory) {
    click(directory);
  }
  click(await screen.findByTestId("connectors-scope-private-network"));
  await screen.findByRole("region", { name: "Private networks" });
  click(screen.getByTestId("connectors-scope-remote-control"));
  await screen.findByRole("heading", { name: "No devices added yet" });
  expect(screen.queryByLabelText("SSH username")).toBeNull();
});

test("SSH login methods are explicit keyboard choices that show only the matching secret fields", async () => {
  const username = await directForm();
  await fill(username, "operator");
  const methods = screen.getByRole("radiogroup", { name: "Login method" });
  const password = getAction("radio", "Account password", methods);
  const key = getAction("radio", "SSH key", methods);
  expect(password).toHaveAttribute("aria-checked", "true");
  expect(key).toHaveAttribute("aria-checked", "false");
  expect(screen.getByLabelText("Password")).toBeRequired();
  expect(screen.queryByLabelText("Private key")).toBeNull();

  await userEvent.click(password);
  await userEvent.keyboard("{ArrowRight}");
  expect(key).toHaveAttribute("aria-checked", "true");
  expect(key).toHaveFocus();
  expect(screen.getByLabelText("Private key")).toBeRequired();
  expect(screen.getByLabelText("Private key")).toHaveAccessibleDescription(
    "Paste or import the complete SSH private key, not the .pub public-key file.",
  );
  expect(screen.getByLabelText("Choose private key file")).toBeEnabled();
  expect(screen.getByLabelText("Passphrase (optional)")).not.toBeRequired();
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(username).toHaveValue("operator");

  await userEvent.keyboard("{ArrowLeft}");
  expect(password).toHaveAttribute("aria-checked", "true");
  expect(password).toHaveFocus();
  expect(screen.getByLabelText("Password")).toBeRequired();
  expect(screen.queryByLabelText("Private key")).toBeNull();
  expect(screen.queryByLabelText("Passphrase (optional)")).toBeNull();
  expect(username).toHaveValue("operator");
});

test("SSH private-key help explains key locations and what to do without a key", async () => {
  await directForm();
  click(getAction("radio", "SSH key"));
  const help = getAction("button", "Where can I find the SSH private key?");
  await userEvent.click(help);
  const popover = await screen.findByRole("dialog");
  expect(within(popover).getAllByRole("listitem")).toHaveLength(3);
  expect(within(popover).getByText(/%USERPROFILE%/u)).toBeInTheDocument();
  expect(within(popover).getByText(/\.pem/u)).toBeInTheDocument();
  expect(within(popover).getByText(/target account/u)).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(help).toHaveFocus();
  });
  expect(screen.getByLabelText("Private key")).toHaveValue("");
});

test("Selecting SSH key login submits the private key rather than the previous password", async () => {
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
    return respond(204);
  });
  const username = await directForm();
  await fill(screen.getByLabelText("Device address"), "ssh.example.com");
  await fill(username, "operator");
  await fill(screen.getByLabelText("Password"), "unused-password");
  click(getAction("radio", "SSH key"));
  await fill(screen.getByLabelText("Private key"), " test-private-key\n");
  await fill(screen.getByLabelText("Passphrase (optional)"), "test-passphrase");
  click(screen.getByText("Connection name (optional)"));
  await fill(screen.getByLabelText(/Connection name/u), "Key login device");
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Connection added" });
  expect(requests).toStrictEqual([
    {
      id: expect.any(String),
      displayName: "Key login device",
      host: "ssh.example.com",
      port: 22,
      transport: { type: "direct" },
      credential: {
        create: {
          name: "Key login device",
          username: "operator",
          authentication: {
            method: "private_key",
            privateKey: " test-private-key\n",
            passphrase: "test-passphrase",
          },
        },
      },
    },
  ]);
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
  click(screen.getByText("Connection name (optional)"));
  const name = screen.getByLabelText(/Connection name/u);
  await fill(name, "Office computer");
  click(getAction("button", "Add connection"));
  await screen.findByRole("alert");
  expect(name).toHaveValue("Office computer");
  expect(
    screen.queryByRole("heading", { name: "Connection added" }),
  ).toBeNull();
  expect(getAction("button", "Add connection")).toBeEnabled();
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
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
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
async function openVncReview() {
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  click(await screen.findByLabelText("Login method"));
  click(
    await screen.findByRole("option", {
      name: "Encrypted without a VNC password (X509None)",
    }),
  );
  click(getAction("button", "Continue"));
  await fill(
    await screen.findByLabelText("Device address"),
    "screen.example.com",
  );
  click(getAction("button", "Continue"));
  await fill(await screen.findByLabelText(/Connection name/u), "Office screen");
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Review and save" });
}

test.each(["edit", "select"] as const)(
  "VNC clears a rejected save when users %s and validates again on retry",
  async (action) => {
    context.mocks.api(vncConnectionsContract.create, ({ respond }) => {
      return respond(400, {
        error: { code: "VNC_INVALID_HOST", message: "Invalid host" },
      });
    });
    await openVncReview();
    click(getAction("button", "Save"));
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Enter a valid hostname or IP address",
    );

    if (action === "edit") {
      await fill(
        screen.getByLabelText("VNC certificate name"),
        "screen.example.com",
      );
    } else {
      click(screen.getByLabelText("Server certificate trust"));
      click(
        await screen.findByRole("option", {
          name: "Custom certificate authorities",
        }),
      );
    }
    expect(screen.queryByRole("alert")).toBeNull();
    if (action === "select") {
      click(screen.getByLabelText("Server certificate trust"));
      click(
        await screen.findByRole("option", {
          name: "System certificate authorities",
        }),
      );
    }
    click(getAction("button", "Save"));
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Enter a valid hostname or IP address",
    );
    expect(
      screen.queryByRole("heading", { name: "Connection added" }),
    ).toBeNull();
  },
);

test("VNC clears a rejected save between steps without losing the draft or skipping validation", async () => {
  context.mocks.api(vncConnectionsContract.create, ({ respond }) => {
    return respond(400, {
      error: { code: "VNC_INVALID_HOST", message: "Invalid host" },
    });
  });
  await openVncReview();
  click(getAction("button", "Save"));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Enter a valid hostname or IP address",
  );
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText(/Connection name/u)).toHaveValue(
    "Office screen",
  );
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Connect a device" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Device address")).toHaveValue(
    "screen.example.com",
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  expect(screen.queryByRole("alert")).toBeNull();
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Review and save" });
  expect(screen.queryByRole("alert")).toBeNull();
  click(getAction("button", "Save"));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Enter a valid hostname or IP address",
  );
  expect(
    screen.queryByRole("heading", { name: "Connection added" }),
  ).toBeNull();
});

test("VNC does not show a late save rejection on earlier setup steps", async () => {
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(vncConnectionsContract.create, async ({ respond }) => {
    await response.promise;
    return respond(400, {
      error: { code: "VNC_INVALID_HOST", message: "Invalid host" },
    });
  });
  await openVncReview();
  click(getAction("button", "Save"));
  await waitFor(() => {
    expect(getAction("button", "Saving…")).toBeDisabled();
  });
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  response.resolve();
  await waitFor(() => {
    expect(getAction("button", "Continue")).toBeEnabled();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Connect a device" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Device address")).toHaveValue(
    "screen.example.com",
  );
});

test.each(["rsa", "kerberos"] as const)(
  "VNC shows %s import errors only on their owning setup step",
  async (kind) => {
    context.mocks.api(vncConnectionsContract.inspectRsaKey, ({ respond }) => {
      return respond(400, {
        error: { code: "VNC_INVALID_INPUT", message: "Invalid public key" },
      });
    });
    await page("/connectors?scope=remote-control&setup=vnc");
    await screen.findByRole("heading", { name: "Add remote connection" });
    click(
      screen.getByText(
        "Control the device’s screen with a mouse and keyboard.",
      ),
    );
    click(await screen.findByLabelText("Service type"));
    click(
      await screen.findByRole("option", {
        name: kind === "rsa" ? "RSA-AES" : "QEMU or enterprise authentication",
      }),
    );
    if (kind === "kerberos") {
      click(screen.getByLabelText("Login method"));
      click(
        await screen.findByRole("option", {
          name: "Kerberos · service ticket",
        }),
      );
    }
    click(getAction("button", "Continue"));
    await fill(
      await screen.findByLabelText("Device address"),
      "screen.example.com",
    );
    if (kind === "kerberos") {
      const connection = screen
        .getByLabelText("Device address")
        .closest<HTMLElement>("[data-remote-vnc-step]")!;
      await fill(
        within(connection).getByLabelText("VNC service realm"),
        "EXAMPLE.COM",
      );
      await fill(
        within(connection).getByLabelText("VNC service instance"),
        "screen.example.com",
      );
    }
    click(getAction("button", "Continue"));
    await screen.findByRole("heading", {
      name: "Enter device login information",
    });
    if (kind === "kerberos") {
      await userEvent.upload(
        screen.getByLabelText("Service ticket file (.ccache)"),
        new File([], "empty.ccache"),
      );
    } else {
      await fill(
        screen.getByLabelText("Password", { exact: true }),
        "test-password",
      );
      await fill(screen.getByLabelText(/Connection name/u), "Office screen");
      click(getAction("button", "Continue"));
      await screen.findByRole("heading", { name: "Review and save" });
      await fill(
        screen.getByLabelText(
          "Independently trusted RSA public PEM (optional)",
        ),
        "invalid public key",
      );
      click(getAction("button", "Import trusted public key"));
    }
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Check the VNC configuration and try again.",
    );
    click(getAction("button", "Back"));
    await screen.findByRole("heading", {
      name:
        kind === "rsa" ? "Enter device login information" : "Connect a device",
    });
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

test.each([500, 409] as const)(
  "VNC keeps %s failure notices on the save step while preserving the locked draft",
  async (status) => {
    context.mocks.api(vncConnectionsContract.create, ({ respond }) => {
      return status === 500
        ? respond(500, {
            error: { code: "INTERNAL_ERROR", message: "Save interrupted" },
          })
        : respond(409, {
            error: { code: "VNC_RESOURCE_ID_CONFLICT", message: "Conflict" },
          });
    });
    await openVncReview();
    click(getAction("button", "Save"));
    const message =
      status === 500 ? "Save failed." : "This resource could not be created.";
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      message,
    );
    click(getAction("button", "Back"));
    await screen.findByRole("heading", {
      name: "Enter device login information",
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText(/Connection name/u)).toBeDisabled();
    click(getAction("button", "Continue"));
    await screen.findByRole("heading", { name: "Review and save" });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(getAction("button", "Save")).toBeDisabled();
  },
);

test("Mac VNC review shows its network, address, and account method before saving", async () => {
  await setupWithSavedNetworks("tailscale");
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  click(await screen.findByLabelText("Service type"));
  click(await screen.findByRole("option", { name: "Apple screen sharing" }));
  expect(screen.getByLabelText("Login method")).toHaveTextContent("Apple DH");
  click(getAction("button", "Continue"));
  await selectVncNetwork("tailscale");
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
  expect(getAction("button", "Save")).toBeEnabled();
});

test("Returning to the remote entry clears the previous SSH draft", async () => {
  const username = await directForm();
  await fill(username, "old-user");
  await fill(screen.getByLabelText("Device address"), "old-device.example.com");
  await fill(
    screen.getByLabelText("Password", { exact: true }),
    "test-password",
  );
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(screen.getByText("Run commands on the device."));
  await expect(screen.findByLabelText("SSH username")).resolves.toHaveValue("");
  expect(screen.getByLabelText("Device address")).toHaveValue("");
  expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("");
});
test("Restarting VNC setup clears the previous draft but Back within setup preserves it", async () => {
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  await screen.findByRole("heading", { name: "Choose a VNC login method" });
  click(getAction("button", "Continue"));
  await fill(
    await screen.findByLabelText("Device address"),
    "old-device.example.com",
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  await fill(
    screen.getByLabelText("VNC password", { exact: true }),
    "old-password",
  );
  await fill(screen.getByLabelText(/Connection name/u), "Old connection");
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Connect a device" });
  expect(screen.getByLabelText("Device address")).toHaveValue(
    "old-device.example.com",
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  expect(screen.getByLabelText("VNC password", { exact: true })).toHaveValue(
    "old-password",
  );
  expect(screen.getByLabelText(/Connection name/u)).toHaveValue(
    "Old connection",
  );
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Connect a device" });
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Choose a VNC login method" });
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  await screen.findByRole("heading", { name: "Choose a VNC login method" });
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a device" });
  expect(screen.getByLabelText("Device address")).toHaveValue("");
  await fill(screen.getByLabelText("Device address"), "new-device.example.com");
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  expect(screen.getByLabelText("VNC password", { exact: true })).toHaveValue(
    "",
  );
  expect(screen.getByLabelText(/Connection name/u)).toHaveValue("");
});

test("Switching protocols starts the matching editor instead of retaining the previous protocol form", async () => {
  const username = await directForm();
  await fill(username, "operator");
  click(getAction("button", "Back"));

  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  await screen.findByRole("heading", {
    name: "Choose a VNC login method",
  });
  expect(screen.queryByLabelText("SSH username")).toBeNull();
});

test("Leaving setup cancels pending credential loading", async () => {
  const gate = context.mocks.deferred<void>();
  context.mocks.api(sshCredentialsContract.list, async ({ respond }) => {
    await gate.promise;
    return respond(200, { credentials: [] });
  });
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(screen.getByText("Run commands on the device."));
  await screen.findByLabelText("SSH username");
  click(getAction("button", "Connectors"));
  click(await screen.findByTestId("connectors-scope-private-network"));
  await screen.findByRole("region", { name: "Private networks" });
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(screen.getByTestId("connectors-scope-remote-control"));
  await screen.findByRole("heading", { name: "No devices added yet" });
  expect(screen.queryByLabelText("SSH username")).toBeNull();
});

test.each(["Office retry", ""])(
  "An unknown save outcome locks the connection draft named %j",
  async (connectionLabel) => {
    context.mocks.api(sshConnectionsContract.create, ({ respond }) => {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Save outcome unknown",
        },
      });
    });
    const username = await directForm();
    await fill(screen.getByLabelText("Device address"), "retry.example.com");
    await fill(username, "operator");
    expect(screen.queryByLabelText("Credential name")).toBeNull();
    await fill(screen.getByLabelText("Password"), "test-only-password");
    click(screen.getByText("Connection name (optional)"));
    const name = screen.getByLabelText(/Connection name/u);
    await fill(name, connectionLabel);
    click(getAction("button", "Add connection"));
    await screen.findByText("Save failed.");
    expect(name).toBeDisabled();
    expect(getAction("radio", "Account password")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(getAction("radio", "SSH key")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
);

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

test.each(["directory", "details"] as const)(
  "Guided SSH %s refreshes a connection changed in another window",
  async (view) => {
    mockSavedConnections();
    let displayName = sshHost.displayName;
    context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [{ ...sshHost, displayName }] });
    });
    await page(
      `/connectors?scope=remote-control${
        view === "details" ? `&remoteResource=ssh:${sshHost.id}` : ""
      }`,
      true,
      "member",
    );
    await expect(screen.findByText(displayName)).resolves.toBeInTheDocument();

    displayName = "Renamed in another window";
    context.mocks.ably.trigger("ssh:changed", { orgId: "org_network_scope" });

    await expect(screen.findByText(displayName)).resolves.toBeInTheDocument();
  },
);

function mockNetworkUsageChangedInAnotherWindow() {
  let linked = false;
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, {
      configs: [
        {
          ...cloudflareNetwork,
          sshHosts: linked
            ? [{ id: sshHost.id, displayName: sshHost.displayName }]
            : [],
        },
      ],
    });
  });
  return () => {
    linked = true;
    context.mocks.ably.trigger("ssh:changed", { orgId: "org_network_scope" });
  };
}

test("An SSH deletion stays pending while its details refresh", async () => {
  mockSavedConnections();
  const refreshRequested = context.mocks.deferred<void>();
  const refreshRelease = context.mocks.deferred<void>();
  const deleteRequested = context.mocks.deferred<void>();
  const deleteRelease = context.mocks.deferred<void>();
  let refreshing = false;
  let deleted = false;
  context.mocks.api(
    sshConnectionsContract.list,
    async ({ respond, withSignal }) => {
      if (refreshing) {
        refreshRequested.resolve();
        await withSignal(refreshRelease.promise);
      }
      return respond(200, { connections: deleted ? [] : [sshHost] });
    },
  );
  context.mocks.api(
    sshConnectionsContract.delete,
    async ({ respond, withSignal }) => {
      deleteRequested.resolve();
      await withSignal(deleteRelease.promise);
      deleted = true;
      return respond(204);
    },
  );
  await page(
    `/connectors?scope=remote-control&remoteResource=ssh:${sshHost.id}`,
    true,
    "member",
  );
  await screen.findByRole("heading", { name: sshHost.displayName });
  click(getAction("button", "Delete connection"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete connection",
  });
  click(getAction("button", "Delete connection", dialog));
  await deleteRequested.promise;

  refreshing = true;
  await act(async () => {
    context.mocks.ably.trigger("ssh:changed", { orgId: "org_network_scope" });
    await refreshRequested.promise;
  });
  expect(dialog).toBeVisible();
  expect(getAction("button", "Cancel", dialog)).toBeDisabled();

  refreshing = false;
  refreshRelease.resolve();
  deleteRelease.resolve();
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Delete connection" }),
    ).not.toBeInTheDocument();
  });
  await screen.findByText(
    "This configuration is unavailable or you no longer have access.",
  );
});

test.each(["tailscale", "cloudflare"] as const)(
  "The %s deletion dialog survives a pending and failed detail refresh",
  async (provider) => {
    const requested = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    let refreshing = false;
    const config = provider === "tailscale" ? network : cloudflareNetwork;
    const contract =
      provider === "tailscale" ? tailscaleContract : cloudflareAccessContract;
    const title =
      provider === "tailscale"
        ? "Delete Tailscale"
        : "Delete Cloudflare Access";
    context.mocks.api(contract.list, async ({ respond, withSignal }) => {
      if (refreshing) {
        requested.resolve();
        await withSignal(release.promise);
        return respond(503, { error: { message: "Network unavailable" } });
      }
      return respond(200, { configs: [config] });
    });
    await page(
      `/connectors?scope=private-network&remoteResource=${provider}:${config.id}`,
      true,
      "member",
    );
    await screen.findByRole("heading", { name: config.name });
    click(getAction("button", title));
    const dialog = await screen.findByRole("dialog", { name: title });

    refreshing = true;
    await act(async () => {
      context.mocks.ably.trigger("ssh:changed", { orgId: "org_network_scope" });
      await requested.promise;
    });
    expect(dialog).toBeVisible();
    expect(
      screen.getByRole("heading", { name: config.name, hidden: true }),
    ).toBeInTheDocument();

    release.resolve();
    await screen.findByText(
      `Could not load ${provider === "tailscale" ? "Tailscale" : "Cloudflare Access"}.`,
    );
    expect(dialog).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: config.name, hidden: true }),
    ).not.toBeInTheDocument();
    click(getAction("button", "Cancel", dialog));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: title }),
      ).not.toBeInTheDocument();
    });
  },
);

test.each(["ssh", "vnc"] as const)(
  "The guided %s edit entry displays pending credentials and a failed load",
  async (protocol) => {
    mockSavedConnections();
    const release = context.mocks.deferred<void>();
    if (protocol === "ssh") {
      context.mocks.api(
        sshCredentialsContract.list,
        async ({ respond, withSignal }) => {
          await withSignal(release.promise);
          return respond(503, {
            error: { message: "Credentials unavailable" },
          });
        },
      );
    } else {
      context.mocks.api(
        vncCredentialsContract.list,
        async ({ respond, withSignal }) => {
          await withSignal(release.promise);
          return respond(503, {
            error: { message: "Credentials unavailable" },
          });
        },
      );
    }
    const host = protocol === "ssh" ? sshHost : vncHost;
    await page(
      `/connectors?scope=remote-control&remoteResource=${protocol}:${host.id}`,
    );
    await screen.findByRole("heading", { name: host.displayName });
    const edit = getAction("button", "Edit connection");
    click(edit);
    await waitFor(() => {
      expect(edit).toBeDisabled();
      expect(edit).toHaveAttribute("aria-busy", "true");
    });
    release.resolve();
    await screen.findByText(
      protocol === "ssh"
        ? "Could not load SSH settings."
        : "Could not load VNC configuration.",
    );
  },
);

test.each(["ssh", "vnc"] as const)(
  "The guided %s credentials list stays visible while a saved rename reloads",
  async (protocol) => {
    mockSavedConnections();
    const requested = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    let renamed = false;
    const name = protocol === "ssh" ? sshLogin.name : vncLogin.name;
    if (protocol === "ssh") {
      context.mocks.api(
        sshCredentialsContract.list,
        async ({ respond, withSignal }) => {
          if (renamed) {
            requested.resolve();
            await withSignal(release.promise);
          }
          return respond(200, {
            credentials: [
              { ...sshLogin, name: renamed ? "Updated login" : name },
            ],
          });
        },
      );
      context.mocks.api(sshCredentialsContract.update, ({ respond }) => {
        renamed = true;
        return respond(200, {
          ...sshLogin,
          name: "Updated login",
          revision: 4,
        });
      });
    } else {
      context.mocks.api(
        vncCredentialsContract.list,
        async ({ respond, withSignal }) => {
          if (renamed) {
            requested.resolve();
            await withSignal(release.promise);
          }
          return respond(200, {
            credentials: [
              { ...vncLogin, name: renamed ? "Updated login" : name },
            ],
          });
        },
      );
      context.mocks.api(vncCredentialsContract.update, ({ respond }) => {
        renamed = true;
        return respond(200, {
          ...vncLogin,
          name: "Updated login",
          revision: 5,
        });
      });
    }
    await page(
      `/connectors?scope=remote-control&remoteView=credentials&type=${protocol}`,
    );
    await screen.findByRole("heading", { name });
    click(getAction("button", "Edit credential"));
    const dialog = await screen.findByRole("dialog", {
      name: "Edit credential",
    });
    await fill(
      within(dialog).getByLabelText("Credential name"),
      "Updated login",
    );
    await act(async () => {
      click(getAction("button", "Save", dialog));
      await requested.promise;
    });
    expect(
      screen.getByRole("heading", { name, hidden: true }),
    ).toBeInTheDocument();
    release.resolve();
    await screen.findByRole("heading", { name: "Updated login" });
  },
);

test("Guided private network directory refreshes SSH usage changed in another window", async () => {
  const changeUsage = mockNetworkUsageChangedInAnotherWindow();
  await page("/connectors?scope=private-network", true, "member");
  await screen.findByText(cloudflareNetwork.name);
  expect(
    getAction("button", "Office network · Your 0 connections"),
  ).toBeInTheDocument();

  changeUsage();

  await waitFor(() => {
    expect(
      getAction("button", "Office network · Your 1 connection"),
    ).toBeInTheDocument();
  });
});

test.each(["Tailscale", "Cloudflare Access"] as const)(
  "The %s network list and connections dialog stay visible during a background refresh",
  async (provider) => {
    const requested = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    let refreshing = false;
    const config = provider === "Tailscale" ? network : cloudflareNetwork;
    const contract =
      provider === "Tailscale" ? tailscaleContract : cloudflareAccessContract;
    context.mocks.api(contract.list, async ({ respond, withSignal }) => {
      if (refreshing) {
        requested.resolve();
        await withSignal(release.promise);
      }
      return respond(200, {
        configs: [
          {
            ...config,
            sshHosts: [
              {
                id: sshHost.id,
                displayName: refreshing
                  ? "Updated server"
                  : sshHost.displayName,
              },
            ],
          },
        ],
      });
    });
    await page("/connectors?scope=private-network", true, "member");
    await screen.findByText(network.name);
    click(getAction("button", "Office network · Your 1 connection"));
    const dialog = await screen.findByRole("dialog", {
      name: "Connections using this network",
    });
    await within(dialog).findByText(sshHost.displayName);

    refreshing = true;
    context.mocks.ably.trigger("ssh:changed", { orgId: "org_network_scope" });
    await requested.promise;

    expect(dialog).toBeVisible();
    expect(within(dialog).getByText(sshHost.displayName)).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("region", { name: "Personal networks", hidden: true }),
      ).getByText(network.name),
    ).toBeInTheDocument();

    release.resolve();
    await within(dialog).findByText("Updated server");
  },
);

test.each(["Tailscale", "Cloudflare Access"] as const)(
  "A failed %s network refresh removes stale data",
  async (provider) => {
    let failed = false;
    const config = provider === "Tailscale" ? network : cloudflareNetwork;
    const contract =
      provider === "Tailscale" ? tailscaleContract : cloudflareAccessContract;
    context.mocks.api(contract.list, ({ respond }) => {
      return failed
        ? respond(503, { error: { message: "Network unavailable" } })
        : respond(200, { configs: [config] });
    });
    await page("/connectors?scope=private-network", true, "member");
    await screen.findByText(network.name);

    failed = true;
    context.mocks.ably.trigger("ssh:changed", { orgId: "org_network_scope" });
    await screen.findByText(`Could not load ${provider}.`);
    expect(screen.queryByText(network.name)).not.toBeInTheDocument();
  },
);

test.each(["account", "workspace"] as const)(
  "Switching %s immediately removes the previous owner's network data",
  async (owner) => {
    const release = context.mocks.deferred<void>();
    let changed = false;
    context.mocks.api(
      tailscaleContract.list,
      async ({ respond, withSignal }) => {
        if (changed) {
          await withSignal(release.promise);
        }
        return respond(200, {
          configs: [
            { ...network, name: changed ? "New Tailscale" : "Old Tailscale" },
          ],
        });
      },
    );
    context.mocks.api(
      cloudflareAccessContract.list,
      async ({ respond, withSignal }) => {
        if (changed) {
          await withSignal(release.promise);
        }
        return respond(200, {
          configs: [
            {
              ...cloudflareNetwork,
              name: changed ? "New Cloudflare" : "Old Cloudflare",
            },
          ],
        });
      },
    );
    await page("/connectors?scope=private-network", true, "member");
    await screen.findByText("Old Tailscale");
    await screen.findByText("Old Cloudflare");

    changed = true;
    const clerk = context.mocks.clerk();
    act(() => {
      if (owner === "account") {
        clerk.user(
          { id: "other-network-owner", fullName: "Other Owner" },
          {
            id: "other-network-session",
            token: "other-token",
          },
        );
      } else {
        clerk.organization({
          activeOrg: { id: "org_other_networks", name: "Other Workspace" },
          memberships: [{ id: "org_other_networks" }],
        });
      }
      clerk.stateChanged();
    });
    await waitFor(() => {
      expect(screen.queryByText("Old Tailscale")).not.toBeInTheDocument();
      expect(screen.queryByText("Old Cloudflare")).not.toBeInTheDocument();
    });

    release.resolve();
  },
);

test("Guided private network details refresh SSH usage changed in another window", async () => {
  const changeUsage = mockNetworkUsageChangedInAnotherWindow();
  await page(
    `/connectors?scope=private-network&remoteResource=cloudflare:${cloudflareNetwork.id}`,
    true,
    "member",
  );
  await screen.findByText(cloudflareNetwork.name);
  expect(getAction("button", "Delete Cloudflare Access")).toBeEnabled();

  changeUsage();

  await expect(
    screen.findByText(sshHost.displayName),
  ).resolves.toBeInTheDocument();
  expect(getAction("button", "Delete Cloudflare Access")).toBeDisabled();
});

test("Credentials have a separate page without adding controls to the connection list", async () => {
  mockSavedConnections();
  await page();
  await screen.findByRole("listitem", { name: sshHost.displayName });
  const manage = getAction("link", "Manage credentials");
  expect(manage).toHaveAttribute(
    "href",
    "/connectors?scope=remote-control&remoteView=credentials",
  );
  click(manage);
  await screen.findByRole("heading", { name: "Credentials", level: 1 });
  await screen.findByRole("heading", { name: sshLogin.name });
  expect(screen.getByText("Username:").nextElementSibling).toHaveTextContent(
    sshLogin.username,
  );
  expect(
    screen.getByText("Login method:").nextElementSibling,
  ).toHaveTextContent("Password");
  expect(screen.getByText("Backup computer")).toBeInTheDocument();
  expect(getAction("button", "Delete credential")).toBeDisabled();
  const deleteHelp =
    "This credential is still in use. Choose another credential for these connections before deleting it.";
  expect(screen.queryByText(deleteHelp)).not.toBeInTheDocument();
  click(getAction("button", "Why is deletion unavailable?"));
  await screen.findByText(deleteHelp);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByText(deleteHelp)).not.toBeInTheDocument();
  });
  click(getAction("radio", "VNC"));
  await screen.findByRole("heading", { name: vncLogin.name });
  expect(screen.getByText("Backup screen")).toBeInTheDocument();
  expect(getAction("button", "Delete credential")).toBeDisabled();
  click(getAction("button", "Back to remote connections"));
  await screen.findByRole("listitem", { name: sshHost.displayName });
  expect(getAction("link", "Manage credentials")).toBeInTheDocument();
});

test.each(["ssh", "vnc"] as const)(
  "Editing %s credentials keeps secrets hidden until replacement is selected",
  async (protocol) => {
    mockSavedConnections();
    const appleLogin: VncCredentialResponse = {
      ...vncLogin,
      authMethod: "apple_dh_username_password",
      username: "demo",
    };
    context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
      return respond(200, { credentials: [appleLogin] });
    });
    await page(
      `/connectors?scope=remote-control&remoteView=credentials&type=${protocol}`,
    );
    await screen.findByRole("heading", {
      name: protocol === "ssh" ? sshLogin.name : vncLogin.name,
    });
    expect(screen.getByText("Username:").nextElementSibling).toHaveTextContent(
      protocol === "ssh" ? sshLogin.username : "demo",
    );
    expect(
      screen.getByText("Login method:").nextElementSibling,
    ).toHaveTextContent(
      protocol === "ssh" ? "Password" : "Apple DH username and password",
    );
    click(getAction("button", "Edit credential"));
    const dialog = await screen.findByRole("dialog", {
      name: "Edit credential",
    });
    const replace = within(dialog).getByRole("checkbox", {
      name: "Change login details",
    });
    expect(within(dialog).queryByText("Login method:")).not.toBeInTheDocument();
    expect(replace).not.toBeChecked();
    expect(within(dialog).queryByLabelText("Password")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(
        protocol === "ssh" ? "Backup computer" : "Backup screen",
      ),
    ).toBeVisible();
    await userEvent.click(replace);
    const secret = within(dialog).getByLabelText("Password");
    expect(secret).toHaveValue("");
    expect(secret).toBeRequired();
    expect(secret).toHaveAttribute("type", "password");
    await fill(secret, "test-only-replacement");
    await userEvent.click(replace);
    expect(within(dialog).queryByLabelText("Password")).not.toBeInTheDocument();
    await userEvent.click(replace);
    expect(within(dialog).getByLabelText("Password")).toHaveValue("");
    click(getAction("button", "Cancel", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  },
);

test.each(["ssh", "vnc"] as const)(
  "The standalone %s credentials page supports adding, renaming, and deleting an unused credential",
  async (protocol) => {
    let sshRows: SshCredentialResponse[] = [];
    let vncRows: VncCredentialResponse[] = [];
    context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
      return respond(200, { credentials: sshRows });
    });
    context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
      return respond(200, { credentials: vncRows });
    });
    context.mocks.api(sshCredentialsContract.create, ({ body, respond }) => {
      const saved = { ...sshLogin, id: body.id, name: body.name, hosts: [] };
      sshRows = [saved];
      return respond(201, saved);
    });
    context.mocks.api(vncCredentialsContract.create, ({ body, respond }) => {
      const saved = { ...vncLogin, id: body.id, name: body.name, hosts: [] };
      vncRows = [saved];
      return respond(201, saved);
    });
    context.mocks.api(sshCredentialsContract.update, ({ body, respond }) => {
      const saved = { ...sshRows[0]!, name: body.name!, revision: 4 };
      sshRows = [saved];
      return respond(200, saved);
    });
    context.mocks.api(vncCredentialsContract.update, ({ body, respond }) => {
      const saved = { ...vncRows[0]!, name: body.name!, revision: 5 };
      vncRows = [saved];
      return respond(200, saved);
    });
    context.mocks.api(sshCredentialsContract.delete, ({ respond }) => {
      sshRows = [];
      return respond(204);
    });
    context.mocks.api(vncCredentialsContract.delete, ({ respond }) => {
      vncRows = [];
      return respond(204);
    });
    await page(
      `/connectors?scope=remote-control&remoteView=credentials&type=${protocol}`,
    );
    await screen.findByText("0 credentials configured");
    click(getAction("button", "Add credential"));
    const create = await screen.findByRole("dialog", {
      name: "Add credential",
    });
    await fill(
      within(create).getByLabelText("Credential name"),
      "Reusable login",
    );
    if (protocol === "ssh") {
      await fill(within(create).getByLabelText("SSH username"), "operator");
      click(getAction("radio", "Password", create));
    }
    await fill(
      within(create).getByLabelText(
        protocol === "ssh" ? "Password" : "VNC password",
      ),
      "test-pwd",
    );
    click(getAction("button", "Save", create));
    await screen.findByRole("heading", { name: "Reusable login" });
    click(getAction("button", "Edit credential"));
    const edit = await screen.findByRole("dialog", { name: "Edit credential" });
    await fill(within(edit).getByLabelText("Credential name"), "Renamed login");
    click(getAction("button", "Save", edit));
    await screen.findByRole("heading", { name: "Renamed login" });
    click(getAction("button", "Delete credential"));
    const remove = await screen.findByRole("dialog", {
      name: "Delete credential",
    });
    expect(getAction("button", "Delete credential", remove)).toBeEnabled();
    click(getAction("button", "Delete credential", remove));
    await screen.findByText("0 credentials configured");
    expect(getAction("button", "Add credential")).toBeEnabled();
  },
);

test("The legacy credentials view remains available with the guided switch off", async () => {
  await page(
    "/connectors?scope=remote-control&remoteView=credentials&type=ssh",
    false,
  );
  await screen.findByText(
    "No SSH hosts configured. Add a host, then enable it by default or in individual chats.",
  );
  click(getAction("radio", "Credentials"));
  await screen.findByText("0 credentials configured");
  click(getAction("button", "Add credential"));
  const dialog = await screen.findByRole("dialog", { name: "Add credential" });
  expect(within(dialog).getByLabelText("SSH username")).toBeInTheDocument();
});

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

test("VNC details separate login information from chat permissions without repeating the route", async () => {
  mockSavedConnections();
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: [
        {
          ...vncHost,
          credentialId: vncLogin.id,
          credentialName: vncLogin.name,
          security: { type: "apple_dh" },
          transport: { type: "tailscale", configId: network.id },
        },
      ],
    });
  });
  let enabled = false;
  const updates: unknown[] = [];
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, {
        ssh: [],
        vnc: [
          {
            connectionId: vncHost.id,
            displayName: vncHost.displayName,
            defaultEnabled: enabled,
          },
        ],
      });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.updateHostDefault,
    ({ params, body, respond }) => {
      updates.push({
        protocol: params.protocol,
        connectionId: params.connectionId,
        enabled: body.enabled,
      });
      enabled = body.enabled;
      return respond(200, {
        connectionId: vncHost.id,
        displayName: vncHost.displayName,
        defaultEnabled: enabled,
      });
    },
  );
  await page(
    `/connectors?scope=remote-control&remoteResource=vnc:${vncHost.id}`,
  );
  await screen.findByRole("heading", { name: vncHost.displayName });
  click(
    screen.getByText("Server identity and chat permissions", {
      selector: "summary",
    }),
  );
  const card = screen.getByRole("article");
  expect(within(card).getAllByText(network.name)).toHaveLength(1);
  expect(
    within(card).getAllByText(`${vncHost.host}:${vncHost.port}`),
  ).toHaveLength(1);
  expect(within(card).queryByText(/^RFB destination:/u)).toBeNull();
  expect(
    within(card).getByText("Login information", { selector: "dt" }),
  ).toBeInTheDocument();
  expect(within(card).getByText(vncLogin.name)).toBeInTheDocument();
  expect(
    within(card).getByText("Login method", { selector: "dt" }),
  ).toBeInTheDocument();
  expect(within(card).getByText("Mac VNC (Apple DH)")).toBeInTheDocument();
  expect(
    within(card).getByText("Authentication method", { selector: "dt" }),
  ).toBeInTheDocument();
  const toggle = within(card).getByRole("switch", {
    name: "Enabled by default for chats",
  });
  await waitFor(() => {
    expect(toggle).toBeEnabled();
  });
  expect(toggle).not.toBeChecked();
  expect(updates).toStrictEqual([]);
  click(toggle);
  await waitFor(() => {
    expect(
      screen.getByRole("switch", { name: "Enabled by default for chats" }),
    ).toBeChecked();
  });
  expect(updates).toStrictEqual([
    { protocol: "vnc", connectionId: vncHost.id, enabled: true },
  ]);
});

test.each<{
  security: Exclude<VncConnectionResponse["security"], { type: "x509_none" }>;
  rsaAesAuthentication?: "rsa_aes_password";
  label: string;
  value: string;
}>([
  {
    security: {
      type: "x509_vnc",
      serverName: "screen.internal.example.com",
      trust: { mode: "system" },
    },
    label: "TLS certificate identity",
    value: "screen.internal.example.com",
  },
  {
    security: { type: "rsa_aes_ra2", serverKeySha256: "ab".repeat(32) },
    rsaAesAuthentication: "rsa_aes_password",
    label: "Server RSA wire-key SHA256",
    value: "ab".repeat(32),
  },
])(
  "VNC details retain the complete $label",
  async ({ security, rsaAesAuthentication, label, value }) => {
    mockSavedConnections();
    context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
      return respond(200, {
        connections: [
          {
            ...vncHost,
            credentialId: vncLogin.id,
            credentialName: vncLogin.name,
            security,
            rsaAesAuthentication,
          },
        ],
      });
    });
    await page(
      `/connectors?scope=remote-control&remoteResource=vnc:${vncHost.id}`,
    );
    await screen.findByRole("heading", { name: vncHost.displayName });
    click(
      screen.getByText("Server identity and chat permissions", {
        selector: "summary",
      }),
    );
    expect(screen.getByText(label, { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText(value)).toBeInTheDocument();
  },
);

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

test("VNC editing groups login details and keeps field guidance available without repeated sections", async () => {
  mockSavedConnections();
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: [
        {
          ...vncHost,
          credentialId: vncLogin.id,
          credentialName: vncLogin.name,
          security: { type: "apple_dh" },
          transport: { type: "tailscale", configId: network.id },
        },
      ],
    });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, {
      credentials: [
        {
          ...vncLogin,
          authMethod: "apple_dh_username_password",
          username: "operator",
        },
      ],
    });
  });
  await page(
    `/connectors?scope=remote-control&remoteResource=vnc:${vncHost.id}`,
  );
  await screen.findByRole("heading", { name: vncHost.displayName });
  click(getAction("button", "Edit connection"));
  await screen.findByRole("heading", { name: "Edit connection" });
  const username = await screen.findByLabelText("Username");
  const password = screen.getByLabelText("Password");
  expect(
    screen.getAllByRole("heading", { name: "Login information" }),
  ).toHaveLength(1);
  expect(username).toHaveValue("operator");
  expect(password).toHaveValue("");
  expect(password).not.toBeRequired();
  expect(
    screen.queryByText(
      /Leave fields blank to keep the saved login information/u,
    ),
  ).toBeNull();

  const loginHelp = getAction("button", "Login information");
  await userEvent.click(loginHelp);
  await expect(
    screen.findByText(
      /Leave fields blank to keep the saved login information/u,
    ),
  ).resolves.toBeVisible();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(loginHelp).toHaveFocus();
  });

  const usernameHelp = getAction("button", "Where can I find my username?");
  await userEvent.click(usernameHelp);
  const helpDialog = await screen.findByRole("dialog");
  expect(within(helpDialog).getByText("whoami")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(usernameHelp).toHaveFocus();
  });

  await fill(password, "draftpass");
  const settings = screen.getByText("Connection settings", {
    selector: "summary",
  });
  click(settings);
  expect(screen.getByLabelText("Service type")).toBeVisible();
  expect(screen.getByLabelText("Login method")).toBeVisible();
  await userEvent.click(getAction("button", "Protocol and security details"));
  await expect(screen.findByRole("dialog")).resolves.toHaveTextContent(
    /certificate/iu,
  );
  await userEvent.keyboard("{Escape}");
  click(settings);
  expect(password).toHaveValue("draftpass");
});

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

test("SSH login reuse is optional, shows the selected account, and can return to manual entry", async () => {
  mockSavedConnections();
  await directForm();
  await fill(screen.getByLabelText("Device address"), "new-device.example.com");
  await fill(screen.getByLabelText("SSH username"), "new-operator");
  await fill(screen.getByLabelText("Password"), "draft-password");
  click(getAction("button", "Choose saved login details"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose saved login details",
  });
  expect(picker).toHaveTextContent(
    "Choose login details from an existing connection. Make sure they also work for this device.",
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.getByLabelText("SSH username")).toHaveValue("new-operator");
  expect(screen.getByLabelText("Password")).toHaveValue("draft-password");
  click(getAction("button", "Choose saved login details"));
  const reopened = await screen.findByRole("dialog", {
    name: "Choose saved login details",
  });
  click(within(reopened).getByText("Backup computer, Office computer"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(
    screen.getByText("Backup computer, Office computer"),
  ).toBeInTheDocument();
  expect(screen.getByText("operator · Password")).toBeInTheDocument();
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(queryAction("radio", "SSH key")).toBeNull();
  click(getAction("button", "Enter details manually"));
  await expect(screen.findByLabelText("SSH username")).resolves.toHaveValue("");
  expect(screen.getByLabelText("Password")).toHaveValue("");
  expect(screen.getByLabelText("Device address")).toHaveValue(
    "new-device.example.com",
  );
});

test("VNC can reuse a saved password and switch back to manual entry", async () => {
  mockSavedConnections();
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Add remote connection" });
  click(
    screen.getByText("Control the device’s screen with a mouse and keyboard."),
  );
  await screen.findByLabelText("Login method");
  click(getAction("button", "Continue"));
  await fill(
    await screen.findByLabelText("Device address"),
    "screen.example.com",
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enter device login information",
  });
  click(getAction("button", "Choose saved login details"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose saved login details",
  });
  click(within(picker).getByText("Backup screen, Office screen"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.getByText("Backup screen, Office screen")).toBeInTheDocument();
  expect(screen.queryByLabelText("VNC password")).toBeNull();
  click(getAction("button", "Enter details manually"));
  await expect(screen.findByLabelText("VNC password")).resolves.toHaveValue("");
});

test("VNC reuse offers only login information matching the configured authentication profile", async () => {
  mockSavedConnections();
  await editConnection("vnc");
  click(getAction("button", "Choose saved login details"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose saved login details",
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
  expect(queryAction("button", "Choose saved login details")).toBeNull();
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
  "%s revision conflicts preserve the login draft and partial save result",
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
    expect(secret).toHaveValue("newpass");
    await screen.findByText(
      "Connection settings are saved. Review the login information update before leaving.",
    );
    expect(getAction("button", "Save")).toBeDisabled();
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
        ? "Download Tailscale"
        : "Create a Service Token",
  });
  click(getAction("button", "Enter existing credentials"));
  return await screen.findByRole("textbox", { name: "Network name" });
}
test.each([
  ["tailscale", 1, "Download Tailscale"],
  ["tailscale", 2, "Create an OAuth credential"],
  ["tailscale", 3, "Set permissions and tags"],
  ["tailscale", 4, "Generate and copy the credential"],
  ["cloudflare", 1, "Create a Service Token"],
  ["cloudflare", 2, "Allow access to the target application"],
  ["cloudflare", 3, "Enter connection credentials"],
] as const)(
  "Private network URL restores %s guide step %s",
  async (provider, step, title) => {
    await page(
      `/connectors?scope=private-network&network=${provider}&networkGuide=${provider}&networkStep=${step}`,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading")).toHaveTextContent(title);
    expect(
      within(dialog).getByText(`${step} / ${provider === "tailscale" ? 4 : 3}`),
    ).toBeInTheDocument();
  },
);

test.each(["tailscale", "cloudflare"] as const)(
  "Private network URL restores the %s editor without returning credentials",
  async (provider) => {
    context.mocks.api(tailscaleContract.list, ({ respond }) => {
      return respond(200, { configs: [network] });
    });
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, { configs: [cloudflareNetwork] });
    });
    await page(
      `/connectors?scope=private-network&network=${provider}&networkEdit=${network.id}`,
    );
    await expect(
      screen.findByRole("textbox", { name: "Network name" }),
    ).resolves.toHaveValue(network.name);
    expect(screen.queryByLabelText("Client Secret")).toBeNull();
  },
);

test("Private network history restores the provider picker and guide step", async () => {
  await page("/connectors?scope=private-network&network=add");
  click(await screen.findByText("Cloudflare Access", { exact: true }));
  await screen.findByRole("dialog", { name: "Create a Service Token" });
  click(getAction("button", "Continue"));
  expect(new URLSearchParams(window.location.search).get("networkStep")).toBe(
    "2",
  );
  act(() => {
    window.history.back();
  });
  await screen.findByRole("dialog", { name: "Create a Service Token" });
  expect(new URLSearchParams(window.location.search).get("networkStep")).toBe(
    "1",
  );
});

test("A missing private network URL stays unavailable and can return to creation", async () => {
  await page(
    `/connectors?scope=private-network&network=tailscale&networkEdit=${network.id}`,
  );
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Unable to load",
  );
  expect(screen.queryByRole("textbox", { name: "Network name" })).toBeNull();
  click(getAction("button", "Back"));
  await waitFor(() => {
    expect(getAction("button", "Add network")).toBeInTheDocument();
  });
  click(getAction("button", "Add network"));
  await screen.findByRole("heading", { name: "Add a private network" });
});

test.each(["tailscale", "cloudflare"] as const)(
  "A member cannot open an organization %s editor through a URL",
  async (provider) => {
    context.mocks.api(tailscaleContract.list, ({ respond }) => {
      return respond(200, {
        configs: [{ ...network, scope: "organization" }],
      });
    });
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, {
        configs: [{ ...cloudflareNetwork, scope: "organization" }],
      });
    });
    await page(
      `/connectors?scope=private-network&network=${provider}&networkEdit=${network.id}`,
      true,
      "member",
    );
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to load",
    );
    expect(screen.queryByRole("textbox", { name: "Network name" })).toBeNull();
  },
);

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
  const guide = await screen.findByRole("dialog", {
    name: "Create a Service Token",
  });
  expect(queryAllByRoleFast("link", guide)).toHaveLength(1);
  expect(getAction("link", "Open Cloudflare dashboard", guide)).toHaveAttribute(
    "target",
    "_blank",
  );
  expect(getAction("link", "Open Cloudflare dashboard", guide)).toHaveAttribute(
    "href",
    "https://dash.cloudflare.com/",
  );
  expect(
    within(guide).getByText(
      "Zero Trust › Access controls › Service credentials › Service Tokens",
    ),
  ).toBeVisible();
  const instructions = within(guide).getByRole("list");
  const items = within(instructions).getAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(items[0]).toHaveTextContent("Click Create Service Token.");
  expect(items[1]).toHaveTextContent(
    "Enter Okou for Name and choose a Service Token Duration.",
  );
  expect(items[2]).toHaveTextContent(
    "Click Generate token and keep the result page open to copy the credentials.",
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
  await screen.findByRole("dialog", { name: "Download Tailscale" });
  click(getAction("button", "Installed, continue"));
  expect(screen.getByText("2 / 4")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Create an OAuth credential" }),
  ).toBeInTheDocument();
  click(getAction("button", "Previous"));
  expect(screen.getByText("1 / 4")).toBeInTheDocument();
  expect(queryAction("button", "Previous")).toBeNull();
  click(getAction("button", "Installed, continue"));
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
  expect(screen.getByText("3 / 4")).toBeInTheDocument();
  click(getAction("button", "Continue"));
  expect(screen.getByText("4 / 4")).toBeInTheDocument();
  const instructions = within(screen.getByRole("dialog")).getByRole("list");
  expect(within(instructions).getAllByRole("listitem")).toHaveLength(3);
  expect(
    getAction("button", "Close", screen.getByRole("dialog")),
  ).toBeInTheDocument();
  expect(screen.getByText(/click “Save network”/u)).toBeInTheDocument();
  click(getAction("button", "Return to form"));
  expect(getAction("button", "Save network")).toBeInTheDocument();
  click(getAction("button", "How do I get connection credentials?"));
  await screen.findByRole("dialog", { name: "Download Tailscale" });
  click(getAction("button", "Installed, continue"));
  click(getAction("button", "Continue"));
  expect(screen.getByText("tag:office, tag:review")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(name).toHaveValue("Tailnet draft");
  expect(secret).toHaveValue("test-only-draft-secret");
});

test("Private network starts with a provider selector and each guide can be closed without a redundant back action", async () => {
  await page("/connectors?scope=private-network");
  await screen.findByRole("heading", { name: "No networks added yet" });
  expect(
    screen.queryByRole("heading", { name: "Private networks" }),
  ).toBeNull();
  for (const name of ["Personal networks", "Organization networks"]) {
    expect(screen.queryByRole("region", { name })).toBeNull();
  }
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
          ? "Download Tailscale"
          : "Create a Service Token",
    });
    expect(
      screen.getByText(provider === "Tailscale" ? "1 / 4" : "1 / 3"),
    ).toBeInTheDocument();
    expect(
      getAction("button", "Enter existing credentials"),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "No networks added yet" });
    click(getAction("button", "Add network"));
    await screen.findByRole("heading", { name: "Add a private network" });
  }
  expect(
    screen.queryByRole("heading", {
      name: "Install Tailscale",
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Add remote connection" }),
  ).toBeNull();
  context.mocks.api(cloudflareAccessContract.create, ({ respond }) => {
    return respond(204);
  });
  click(screen.getByText("Cloudflare Access", { exact: true }));
  await screen.findByRole("dialog", { name: "Create a Service Token" });
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
  await screen.findByRole("heading", { name: "No networks added yet" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Network name" })).toBeNull();
});

test.each([
  ["Tailscale", "personal"],
  ["Tailscale", "organization"],
  ["Cloudflare Access", "personal"],
  ["Cloudflare Access", "organization"],
] as const)(
  "Private network directory only shows the populated group for %s %s networks",
  async (provider, scope) => {
    context.mocks.api(tailscaleContract.list, ({ respond }) => {
      return respond(200, {
        configs: provider === "Tailscale" ? [{ ...network, scope }] : [],
      });
    });
    context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
      return respond(200, {
        configs:
          provider === "Cloudflare Access"
            ? [{ ...cloudflareNetwork, scope }]
            : [],
      });
    });
    await page("/connectors?scope=private-network", true, "member");
    const populated = await screen.findByRole("region", {
      name:
        scope === "personal" ? "Personal networks" : "Organization networks",
    });
    expect(within(populated).getByText(network.name)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).toBeNull();
    });
    expect(
      screen.queryByRole("region", {
        name:
          scope === "personal" ? "Organization networks" : "Personal networks",
      }),
    ).toBeNull();
    expect(screen.queryByText("No networks added yet")).toBeNull();
    expect(getAction("button", "Add network")).toBeInTheDocument();
  },
);

test.each(["Tailscale", "Cloudflare Access"] as const)(
  "Private network directory waits for %s before showing the empty state",
  async (provider) => {
    const release = context.mocks.deferred<void>();
    const contract =
      provider === "Tailscale" ? tailscaleContract : cloudflareAccessContract;
    context.mocks.api(contract.list, async ({ respond, withSignal }) => {
      await withSignal(release.promise);
      return respond(200, { configs: [] });
    });
    await page("/connectors?scope=private-network");
    await screen.findByText("Loading…");
    expect(queryAction("button", "Add network")).toBeNull();
    expect(screen.queryByText("No networks added yet")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Personal networks" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Organization networks" }),
    ).toBeNull();
    release.resolve();
    await screen.findByRole("heading", { name: "No networks added yet" });
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(getAction("button", "Add network")).toBeInTheDocument();
  },
);

test.each(["Tailscale", "Cloudflare Access"] as const)(
  "Private network directory shows a %s error instead of an empty state",
  async (provider) => {
    const contract =
      provider === "Tailscale" ? tailscaleContract : cloudflareAccessContract;
    context.mocks.api(contract.list, ({ respond }) => {
      return respond(503, { error: { message: "Network unavailable" } });
    });
    await page("/connectors?scope=private-network");
    await screen.findByText(`Could not load ${provider}.`);
    expect(screen.queryByText("No networks added yet")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Personal networks" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Organization networks" }),
    ).toBeNull();
  },
);

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
  expect(within(organization).getByText(shared.name).closest("a")).toBeNull();
  expect(
    getAction("link", `View ${shared.name}`, organization),
  ).toHaveAttribute(
    "href",
    expect.stringContaining(`remoteResource=cloudflare%3A${shared.id}`),
  );
});

test("Network counts display only that network's connection names without navigation links", async () => {
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
  await userEvent.click(count);
  const sharedDialog = await screen.findByRole("dialog", {
    name: "Connections using this network",
  });
  const sharedList = within(sharedDialog).getByRole("list", {
    name: "Connections using this network",
  });
  expect(
    within(sharedList)
      .getAllByRole("listitem")
      .map((item) => {
        return item.textContent;
      }),
  ).toStrictEqual([sshHost.displayName]);
  expect(queryAllByRoleFast("link", sharedList)).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(count).toHaveFocus();
  click(
    await waitFor(() => {
      return getAction("button", "Office network · Your 1 connection");
    }),
  );
  const personalDialog = await screen.findByRole("dialog", {
    name: "Connections using this network",
  });
  const personalList = within(personalDialog).getByRole("list", {
    name: "Connections using this network",
  });
  expect(
    within(personalList)
      .getAllByRole("listitem")
      .map((item) => {
        return item.textContent;
      }),
  ).toStrictEqual([vncHost.displayName]);
  expect(queryAllByRoleFast("link", personalList)).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(
    screen.getByRole("region", { name: "Personal networks" }),
  ).toBeInTheDocument();
});

test.each(["tailscale", "cloudflare"] as const)(
  "%s network details display linked connection names as a read-only list",
  async (provider) => {
    const contract =
      provider === "tailscale" ? tailscaleContract : cloudflareAccessContract;
    context.mocks.api(contract.list, ({ respond }) => {
      return respond(200, {
        configs: [
          {
            ...(provider === "tailscale" ? network : cloudflareNetwork),
            sshHosts: [{ id: sshHost.id, displayName: sshHost.displayName }],
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
    await page(
      `/connectors?scope=private-network&remoteResource=${provider}:${network.id}`,
    );
    await screen.findByRole("heading", { name: network.name });
    const connections = screen.getByRole("list", {
      name: "Connections using this network",
    });
    expect(
      within(connections)
        .getAllByRole("listitem")
        .map((item) => {
          return item.textContent;
        }),
    ).toStrictEqual([sshHost.displayName, vncHost.displayName]);
    expect(queryAllByRoleFast("link", connections)).toHaveLength(0);
    expect(queryAllByRoleFast("button", connections)).toHaveLength(0);
    expect(queryAction("button", "Add connection")).toBeNull();
  },
);

test("SSH and VNC share one ungrouped connection list regardless of network scope", async () => {
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
  const connections = await screen.findByRole("list", {
    name: "Remote connections",
  });
  expect(
    screen.queryByRole("heading", { name: "No devices added yet" }),
  ).toBeNull();
  expect(getAction("button", "Add connection")).toBeInTheDocument();
  expect(
    within(connections).getByText(sshHost.displayName),
  ).toBeInTheDocument();
  expect(
    within(connections).getByText(vncHost.displayName),
  ).toBeInTheDocument();
  expect(within(connections).getAllByText("Manage")).toHaveLength(2);
  expect(
    screen.queryByRole("heading", { name: "Remote connections" }),
  ).toBeNull();
  expect(screen.queryByText("Only you have access")).toBeNull();
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Add remote connection" });
});

test.each(["ssh", "vnc"] as const)(
  "The remote directory updates the %s chat default independently and shares it with details",
  async (protocol) => {
    mockSavedConnections();
    const enabled = { ssh: true, vnc: false };
    const connection = protocol === "ssh" ? sshHost : vncHost;
    const nextEnabled = !enabled[protocol];
    context.mocks.api(
      chatRemoteAccessContract.listHostDefaults,
      ({ respond }) => {
        return respond(200, {
          ssh: [
            {
              connectionId: sshHost.id,
              displayName: sshHost.displayName,
              defaultEnabled: enabled.ssh,
            },
          ],
          vnc: [
            {
              connectionId: vncHost.id,
              displayName: vncHost.displayName,
              defaultEnabled: enabled.vnc,
            },
          ],
        });
      },
    );
    context.mocks.api(
      chatRemoteAccessContract.updateHostDefault,
      ({ params, body, respond }) => {
        const host = params.protocol === "ssh" ? sshHost : vncHost;
        if (params.connectionId !== host.id) {
          return respond(404, {
            error: { code: "NOT_FOUND", message: "Host not found" },
          });
        }
        enabled[params.protocol] = body.enabled;
        return respond(200, {
          connectionId: host.id,
          displayName: host.displayName,
          defaultEnabled: body.enabled,
        });
      },
    );
    await page();
    const row = await screen.findByRole("listitem", {
      name: connection.displayName,
    });
    const toggle = within(row).getByRole("switch", {
      name: "Enabled by default for chats",
    });
    await waitFor(() => {
      expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(toggle).toHaveAttribute("aria-checked", String(!nextEnabled));
    click(toggle);
    await waitFor(() => {
      const updatedRow = screen.getByRole("listitem", {
        name: connection.displayName,
      });
      expect(within(updatedRow).getByRole("switch")).toHaveAttribute(
        "aria-checked",
        String(nextEnabled),
      );
    });
    expect(
      within(
        screen.getByRole("listitem", { name: sshHost.displayName }),
      ).getByRole("switch"),
    ).toHaveAttribute(
      "aria-checked",
      String(protocol === "ssh" ? nextEnabled : true),
    );
    expect(
      within(
        screen.getByRole("listitem", { name: vncHost.displayName }),
      ).getByRole("switch"),
    ).toHaveAttribute(
      "aria-checked",
      String(protocol === "vnc" ? nextEnabled : false),
    );
    click(
      getAction(
        "link",
        "Manage",
        screen.getByRole("listitem", { name: connection.displayName }),
      ),
    );
    await screen.findByRole("heading", { name: connection.displayName });
    click(
      screen.getByText("Server identity and chat permissions", {
        selector: "summary",
      }),
    );
    expect(
      screen.getByRole("switch", { name: "Enabled by default for chats" }),
    ).toHaveAttribute("aria-checked", String(nextEnabled));
  },
);

test.each(["ssh", "vnc"] as const)(
  "The remote directory keeps its rows and checked values while saving the %s chat default",
  async (protocol) => {
    mockSavedConnections();
    const enabled = { ssh: true, vnc: true };
    const defaultsRequested = context.mocks.deferred<void>();
    const defaultsReady = context.mocks.deferred<void>();
    const connectionsRequested = context.mocks.deferred<void>();
    const connectionsReady = context.mocks.deferred<void>();
    let updated = false;
    context.mocks.api(
      sshConnectionsContract.list,
      async ({ respond, withSignal }) => {
        if (updated) {
          connectionsRequested.resolve();
          await withSignal(connectionsReady.promise);
        }
        return respond(200, { connections: [sshHost] });
      },
    );
    context.mocks.api(
      chatRemoteAccessContract.listHostDefaults,
      async ({ respond, withSignal }) => {
        if (updated) {
          defaultsRequested.resolve();
          await withSignal(defaultsReady.promise);
        }
        return respond(200, {
          ssh: [
            {
              connectionId: sshHost.id,
              displayName: sshHost.displayName,
              defaultEnabled: enabled.ssh,
            },
          ],
          vnc: [
            {
              connectionId: vncHost.id,
              displayName: vncHost.displayName,
              defaultEnabled: enabled.vnc,
            },
          ],
        });
      },
    );
    context.mocks.api(
      chatRemoteAccessContract.updateHostDefault,
      ({ params, body, respond }) => {
        const host = params.protocol === "ssh" ? sshHost : vncHost;
        enabled[params.protocol] = body.enabled;
        updated = true;
        return respond(200, {
          connectionId: host.id,
          displayName: host.displayName,
          defaultEnabled: body.enabled,
        });
      },
    );
    await page("/connectors?scope=remote-control", true, "member");
    const sshRow = await screen.findByRole("listitem", {
      name: sshHost.displayName,
    });
    const vncRow = await screen.findByRole("listitem", {
      name: vncHost.displayName,
    });
    const sshToggle = within(sshRow).getByRole("switch");
    const vncToggle = within(vncRow).getByRole("switch");
    await waitFor(() => {
      expect(sshToggle).toBeChecked();
      expect(vncToggle).toBeChecked();
    });
    const toggle = protocol === "ssh" ? sshToggle : vncToggle;
    await userEvent.click(toggle);
    await defaultsRequested.promise;
    await connectionsRequested.promise;
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-disabled", "true");
    });
    expect(sshRow).toBeVisible();
    expect(vncRow).toBeVisible();
    expect(sshToggle).toBeChecked();
    expect(vncToggle).toBeChecked();
    expect(protocol === "ssh" ? vncToggle : sshToggle).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(toggle).toHaveFocus();

    connectionsReady.resolve();
    defaultsReady.resolve();
    await waitFor(() => {
      expect(toggle).not.toBeChecked();
      expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(screen.getByRole("listitem", { name: sshHost.displayName })).toBe(
      sshRow,
    );
    expect(screen.getByRole("listitem", { name: vncHost.displayName })).toBe(
      vncRow,
    );
    expect(protocol === "ssh" ? vncToggle : sshToggle).toBeChecked();
    expect(toggle).toHaveFocus();
  },
);

test("The remote directory keeps connections visible when chat defaults fail", async () => {
  mockSavedConnections();
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Private default error" },
      });
    },
  );
  await page();
  const row = await screen.findByRole("listitem", {
    name: sshHost.displayName,
  });
  await expect(within(row).findByRole("alert")).resolves.toHaveTextContent(
    "Couldn't load remote access.",
  );
  expect(within(row).queryByRole("switch")).toBeNull();
  expect(getAction("link", "Manage", row)).toBeInTheDocument();
  expect(
    screen.getByRole("listitem", { name: vncHost.displayName }),
  ).toBeInTheDocument();
});

test("The remote directory cannot change a host with unavailable chat defaults", async () => {
  mockSavedConnections();
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, {
        ssh: [
          {
            connectionId: sshHost.id,
            displayName: sshHost.displayName,
            defaultEnabled: true,
          },
        ],
        vnc: [],
      });
    },
  );
  await page();
  await waitFor(() => {
    expect(
      within(
        screen.getByRole("listitem", { name: sshHost.displayName }),
      ).getByRole("switch"),
    ).toBeChecked();
  });
  const row = screen.getByRole("listitem", { name: vncHost.displayName });
  expect(within(row).getByRole("switch")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(getAction("link", "Manage", row)).toBeInTheDocument();
});

test("Organization network details show a concise audience without management actions for members", async () => {
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
    screen.getByText("Who can use this", { selector: "dt" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Engineering · Organization members", { selector: "dd" }),
  ).toBeInTheDocument();
  expect(queryAction("button", "Edit settings")).toBeNull();
  expect(queryAction("button", "Delete Cloudflare Access")).toBeNull();
  expect(queryAction("button", "Add connection")).toBeNull();
});

test.each(["Tailscale", "Cloudflare Access"] as const)(
  "%s creation defaults to personal and explains the unavailable organization option for members",
  async (provider) => {
    await page("/connectors?scope=private-network", true, "member");
    await screen.findByRole("heading", {
      name: "No networks added yet",
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

test.each(["tailscale", "cloudflare"] as const)(
  "Sharing %s saves directly with the edited name and preserves connection references",
  async (provider) => {
    const contract =
      provider === "tailscale" ? tailscaleContract : cloudflareAccessContract;
    let saved = {
      ...(provider === "tailscale" ? network : cloudflareNetwork),
      sshHosts: [
        {
          id: "c0000000-0000-4000-8000-000000000001",
          displayName: "Owner computer",
        },
      ],
    };
    const conversion = createDeferredPromise<void>(context.signal);
    context.mocks.api(contract.list, ({ respond }) => {
      return respond(200, { configs: [saved] });
    });
    context.mocks.api(
      contract.convertToOrganization,
      async ({ body, respond }) => {
        expect(body).toStrictEqual({ expectedRevision: 1 });
        await conversion.promise;
        saved = { ...saved, scope: "organization", revision: 2 };
        return respond(200, saved);
      },
    );
    context.mocks.api(contract.update, ({ body, respond }) => {
      expect(body.expectedRevision).toBe(2);
      saved = { ...saved, name: body.name ?? saved.name, revision: 3 };
      return respond(200, saved);
    });
    await page(
      `/connectors?scope=private-network&remoteResource=${provider}:${network.id}`,
      true,
      "admin",
    );
    await screen.findByRole("heading", { name: network.name });
    click(getAction("button", "Edit settings"));
    const name = await screen.findByLabelText("Network name");
    await fill(name, "Shared office draft");
    click(screen.getByText("Organization members", { exact: true }));
    expect(
      screen.getByLabelText(/Organization members/u, { selector: "input" }),
    ).toBeChecked();
    expect(saved.scope).toBe("personal");
    expect(saved.name).toBe(network.name);
    click(getAction("button", "Save network"));
    await waitFor(() => {
      expect(getAction("button", "Saving...")).toBeDisabled();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    conversion.resolve();
    await screen.findByRole("heading", { name: "Shared office draft" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saved.scope).toBe("organization");
    expect(saved.sshHosts).toStrictEqual([
      {
        id: "c0000000-0000-4000-8000-000000000001",
        displayName: "Owner computer",
      },
    ]);
  },
);

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
  await screen.findByText("Only me", { selector: "dd" });
  expect(getAction("button", "Edit settings")).toBeInTheDocument();
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

test.each(
  (["tailscale", "cloudflare"] as const).flatMap((provider) => {
    return ([409, 403, 500] as const).map((status) => {
      return { provider, status };
    });
  }),
)(
  "$provider sharing failure ($status) keeps the edit draft and shows an inline error",
  async ({ provider, status }) => {
    const contract =
      provider === "tailscale" ? tailscaleContract : cloudflareAccessContract;
    context.mocks.api(contract.list, ({ respond }) => {
      return respond(200, {
        configs: [provider === "tailscale" ? network : cloudflareNetwork],
      });
    });
    context.mocks.api(contract.convertToOrganization, ({ respond }) => {
      return respond(status, {
        error: { code: "NETWORK_UNAVAILABLE", message: "Cannot share" },
      });
    });
    await page(
      `/connectors?scope=private-network&remoteResource=${provider}:${network.id}`,
      true,
      "admin",
    );
    await screen.findByRole("heading", { name: network.name });
    click(getAction("button", "Edit settings"));
    const name = await screen.findByLabelText("Network name");
    await fill(name, "Retained after sharing failure");
    click(screen.getByText("Organization members", { exact: true }));
    click(getAction("button", "Save network"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      status === 409
        ? "The network or its linked connections changed. Your draft is kept."
        : status === 403
          ? "This network is unavailable or you no longer have the required administrator permission."
          : "We could not confirm the change.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getAction("button", "Save network")).toBeDisabled();
    expect(name).toHaveValue("Retained after sharing failure");
  },
);

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
