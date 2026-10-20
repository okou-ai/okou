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
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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
  legacyEnabled = !enabled,
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
    ...(role
      ? {
          auth: {
            user: { id: "network-owner", fullName: "Network Owner" },
            organization: {
              activeOrg: { id: "org_network_scope", name: "Engineering" },
              memberships: [{ id: "org_network_scope" }],
            },
          },
        }
      : {}),
    featureSwitches: {
      [FeatureSwitchKey.RemoteControlGuidedSetup]: enabled,
      [FeatureSwitchKey.VncAccess]: legacyEnabled,
      [FeatureSwitchKey.TailscaleAccess]: legacyEnabled,
    },
  });
}
async function directForm() {
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(
    getAction("button", "Already have connection details? Enter them directly"),
  );
  await screen.findByRole("heading", {
    name: "Use existing connection settings",
  });
  click(screen.getByText("Direct connection"));
  await screen.findByLabelText("Computer address");
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
      legacyEnabled,
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
test("The guided switch alone exposes both SSH and VNC from connection management", async () => {
  await page();
  await screen.findByRole("heading", { name: "No devices added yet" });
  expect(
    screen.queryByRole("heading", { name: "Set up a connection" }),
  ).toBeNull();
  expect(queryAllByRoleFast("tab")).toHaveLength(0);
  expect(queryAction("button", "Add credential")).toBeNull();
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Set up a connection" });
  expect(screen.getByText("Operate through commands.")).toBeInTheDocument();
  expect(
    screen.getByText("Operate through the screen, mouse and keyboard."),
  ).toBeInTheDocument();
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
test.each([
  ["ssh", false],
  ["vnc", false],
  ["ssh", true],
  ["vnc", true],
] as const)(
  "%s offers distinct setup paths with legacy switches=%s",
  async (protocol, legacyEnabled) => {
    await page(
      `/connectors?scope=remote-control&setup=${protocol}`,
      true,
      undefined,
      legacyEnabled,
    );
    await screen.findByRole("heading", { name: "Set up a connection" });
    expect(queryAction("button", "View saved connections")).toBeNull();
    click(getAction("button", "Start setup"));
    await screen.findByRole("heading", {
      name:
        protocol === "ssh"
          ? "Install Tailscale on the target computer"
          : "Target operating system",
    });
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Set up a connection" });
    click(
      getAction(
        "button",
        "Already have connection details? Enter them directly",
      ),
    );
    await screen.findByRole("heading", {
      name:
        protocol === "ssh"
          ? "Use existing connection settings"
          : "Which login settings does the VNC service use?",
    });
    expect(
      screen.queryByRole("heading", { name: "Target operating system" }),
    ).toBeNull();
    click(getAction("button", "Back"));
    await screen.findByRole("heading", { name: "Set up a connection" });
  },
);
test("First-time setup from existing settings opens installation without cycling through the entry page", async () => {
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(
    getAction("button", "Already have connection details? Enter them directly"),
  );
  await screen.findByRole("heading", {
    name: "Use existing connection settings",
  });
  click(getAction("button", "First time? Set up your computer step by step"));
  await screen.findByRole("heading", {
    name: "Install Tailscale on the target computer",
  });
  expect(
    screen.queryByRole("heading", { name: "Set up a connection" }),
  ).toBeNull();
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Start setup"));
  await screen.findByRole("heading", {
    name: "Install Tailscale on the target computer",
  });
});
test("Existing Tailscale settings open the saved network and device login form, preserving the draft on return", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
  });
  await page("/connectors?scope=remote-control&setup=ssh");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(
    getAction("button", "Already have connection details? Enter them directly"),
  );
  await screen.findByRole("heading", {
    name: "Use existing connection settings",
  });
  click(
    screen.getByText(
      "The device is already on Tailscale. Use its network settings.",
    ),
  );
  const username = await screen.findByLabelText("SSH username");
  expect(
    screen.queryByRole("heading", {
      name: "Install Tailscale on the target computer",
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
    name: "Use existing connection settings",
  });
  click(
    screen.getByText(
      "The device is already on Tailscale. Use its network settings.",
    ),
  );
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
  click(
    getAction("button", "Already have connection details? Enter them directly"),
  );
  await screen.findByRole("heading", {
    name: "Use existing connection settings",
  });
  click(screen.getByText("Cloudflare Access", { exact: true }));
  await fill(
    await screen.findByLabelText("Connection address"),
    "device.example.com",
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Allow access through Cloudflare",
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
  expect(screen.getByLabelText("Computer address")).toHaveValue(
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
  await fill(screen.getByLabelText("Computer address"), "server.example.com");
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
  expect(getAction("button", "Save and check")).toBeDisabled();
  click(getAction("button", "Save only"));
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
  expect(screen.getByText(/Saved, but not checked yet/u)).toBeInTheDocument();
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
    name: "Install Tailscale on the target computer",
  });
  click(getAction("button", "I have installed it"));
  await screen.findByLabelText("Computer address");
  await fill(screen.getByLabelText("Computer address"), "100.64.0.20");
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Create an Okou tag in Tailscale",
  });
  expect(
    screen.getByText("Access controls → Definitions → Tags → Create tag"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Show detailed instructions")).toBeNull();
  click(getAction("button", "Tag created, continue"));
  await screen.findByRole("heading", {
    name: "Allow Okou to reach this computer",
  });
  expect(screen.queryByLabelText("Port")).toBeNull();
  click(screen.getByText("Show grant to add"));
  expect(screen.getByText(/"tcp:\*"/u)).toBeInTheDocument();
  expect(
    screen.getByText(/broader rules already in your policy remain effective/u),
  ).toBeInTheDocument();
  click(getAction("button", "Rule saved, continue"));
  await screen.findByRole("heading", {
    name: "Create and enter connection credentials",
  });
  await screen.findByLabelText("Client Secret");
  expect(screen.getByLabelText("Client Secret")).toHaveAttribute(
    "type",
    "password",
  );
  expect(getAction("button", "Save and continue")).toBeInTheDocument();
  click(getAction("button", "Get Client ID and Client Secret"));
  await screen.findByRole("dialog", { name: "Tailscale connection setup" });
  for (let index = 0; index < 3; index++) {
    click(getAction("button", "Next"));
  }
  expect(
    screen.getByText(/Click Save and continue after copying/u),
  ).toBeInTheDocument();
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
  click(screen.getByText("Show grant to add"));
  expect(JSON.parse(screen.getByText(/"tcp:\*"/u).textContent!)).toStrictEqual({
    src: ["tag:office-review", "tag:remote-review"],
    dst: ["100.64.0.20"],
    ip: ["tcp:*"],
  });
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Create an Okou tag in Tailscale",
  });
  expect(screen.getByText("office-review")).toBeVisible();
  expect(screen.getByText("remote-review")).toBeVisible();
  click(getAction("button", "Tag created, continue"));
  click(getAction("button", "Rule saved, continue"));
  await screen.findByRole("heading", {
    name: "Create and enter connection credentials",
  });
  expect(screen.getByLabelText("Network name")).toHaveValue(
    "Custom tag network",
  );
  expect(screen.getByLabelText("Client Secret")).toHaveValue(
    "test-only-client-secret",
  );
  click(getAction("button", "Get Client ID and Client Secret"));
  click(getAction("button", "Next"));
  click(getAction("button", "Next"));
  expect(
    screen.getByText(
      /tag:office-review, tag:remote-review from the current Okou form/u,
    ),
  ).toBeVisible();
  click(screen.getByText("Tag missing?"));
  expect(screen.getByText(/Definitions → Tags → Create tag/u)).toBeVisible();
  click(getAction("button", "Return to form"));
  click(getAction("button", "Save and continue"));
  await screen.findByRole("heading", {
    name: "Enable SSH on the target computer",
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
  click(getAction("button", "Set up a new network"));
  expect(picker).not.toHaveTextContent("Office network");
  click(getAction("button", "I have installed it"));
  await fill(await screen.findByLabelText("Computer address"), "100.64.0.20");
  click(getAction("button", "Continue"));
  const tagName = await screen.findByText("existing-office");
  expect(tagName).toBeVisible();
});
test("VNC groups actual service methods and retains the connection step while adding SSH", async () => {
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Start setup"));
  await screen.findByRole("heading", { name: "Target operating system" });
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enable screen access on the target computer",
  });
  click(getAction("button", "The service is ready"));
  const group = await screen.findByLabelText("Service type");
  click(group);
  click(await screen.findByRole("option", { name: "Apple screen sharing" }));
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Connect to the target computer",
  });
  click(screen.getByText("More settings", { selector: "summary" }));
  const port = screen.getByLabelText("Port");
  await fill(port, "5901");
  click(getAction("button", "Add the required SSH connection"));
  const ssh = await screen.findByRole("dialog", { name: "Add host" });
  click(getAction("button", "Cancel", ssh));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(port).toHaveValue(5901);
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Which login settings does the VNC service use?",
  });
  expect(group).toHaveTextContent("Apple screen sharing");
  click(group);
  click(
    await screen.findByRole("option", { name: "Certificate-protected VNC" }),
  );
  expect(group).toHaveTextContent("Certificate-protected VNC");
});
test("VNC with no saved network shows an actionable empty state and preserves the address through help", async () => {
  await page("/connectors?scope=remote-control&setup=vnc");
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("button", "Start setup"));
  await screen.findByRole("heading", { name: "Target operating system" });
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enable screen access on the target computer",
  });
  click(getAction("button", "The service is ready"));
  await screen.findByLabelText("Login method");
  click(getAction("button", "Continue"));
  const address = await screen.findByLabelText("Device address");
  await fill(address, "screen.example.com");
  click(screen.getByLabelText("Connection method"));
  click(await screen.findByRole("option", { name: "Cloudflare Access" }));
  await screen.findByText(/No Cloudflare Access network saved yet/u);
  expect(screen.queryByRole("combobox", { name: "Saved network" })).toBeNull();
  expect(getAction("button", "Add a private network")).toBeEnabled();
  expect(getAction("button", "Continue")).toBeDisabled();
  click(getAction("button", "Where can I find the address?"));
  await screen.findByText(/open Zero Trust → Access controls → Applications/u);
  await userEvent.keyboard("{Escape}");
  expect(address).toHaveValue("screen.example.com");
  click(getAction("button", "Add a private network"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a network provider",
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
  await fill(screen.getByLabelText("Computer address"), "invalid.example.com");
  await fill(username, "operator");
  expect(screen.queryByLabelText("Credential name")).toBeNull();
  await fill(screen.getByLabelText("Password"), "test-only-password");
  const name = screen.getByLabelText(/Connection name/u);
  await fill(name, "Office computer");
  click(getAction("button", "Save only"));
  await screen.findByRole("alert");
  expect(name).toHaveValue("Office computer");
  expect(
    screen.queryByRole("heading", { name: "Connection added" }),
  ).toBeNull();
  expect(getAction("button", "Save only")).toBeEnabled();
});

test("VNC saves only after the separate login and server-identity steps", async () => {
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
  await screen.findByRole("heading", { name: "Target operating system" });
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enable screen access on the target computer",
  });
  click(getAction("button", "The service is ready"));
  click(await screen.findByLabelText("Login method"));
  click(
    await screen.findByRole("option", {
      name: "Encrypted without a VNC password (X509None)",
    }),
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Connect to the target computer",
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
    name: "Verify the identity of the target computer",
  });
  expect(screen.getByLabelText("Server certificate trust")).toHaveTextContent(
    "System certificate authorities",
  );
  click(getAction("button", "Save only"));
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

test("Switching protocols starts the matching editor instead of retaining the previous protocol form", async () => {
  const username = await directForm();
  await fill(username, "operator");
  click(getAction("button", "Back"));
  await screen.findByRole("heading", {
    name: "Use existing connection settings",
  });
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "Set up a connection" });
  click(getAction("radio", "VNC"));
  click(getAction("button", "Start setup"));
  await screen.findByRole("heading", { name: "Target operating system" });
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Enable screen access on the target computer",
  });
  click(getAction("button", "The service is ready"));
  await screen.findByRole("heading", {
    name: "Which login settings does the VNC service use?",
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
  click(
    getAction("button", "Already have connection details? Enter them directly"),
  );
  await screen.findByRole("heading", {
    name: "Use existing connection settings",
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
  await fill(screen.getByLabelText("Computer address"), "retry.example.com");
  await fill(username, "operator");
  expect(screen.queryByLabelText("Credential name")).toBeNull();
  await fill(screen.getByLabelText("Password"), "test-only-password");
  const name = screen.getByLabelText(/Connection name/u);
  await fill(name, "Office retry");
  click(getAction("button", "Save only"));
  await screen.findByText(
    /We couldn't confirm whether your changes were saved/u,
  );
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
    click(getAction("button", "Save only"));
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
    click(getAction("button", "Save only"));
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
    click(getAction("button", "Save only"));
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
    click(getAction("button", "Save only"));
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
        "Connection settings were saved. Review the login information update before leaving.",
      ),
    ).toBeInTheDocument();
    click(keep);
    await waitFor(() => {
      return expect(getAction("button", "Save only")).toBeEnabled();
    });
    expect(secret).toHaveValue("newpass");
    click(getAction("button", "Save only"));
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
  "%s details never grant chat access or suggest a check ran while the settings service is unavailable",
  async (protocol) => {
    mockSavedConnections();
    const host = protocol === "ssh" ? sshHost : vncHost;
    await page(
      `/connectors?scope=remote-control&remoteResource=${protocol}:${host.id}`,
    );
    await screen.findByRole("heading", { name: host.displayName });
    expect(
      screen.getByRole("heading", {
        name: "Connection checks are unavailable",
      }),
    ).toBeInTheDocument();
    expect(getAction("button", "Check connection")).toBeDisabled();
    expect(queryAction("link", "Check in chat")).toBeNull();
    expect(queryAction("link", "Open chat")).toBeNull();
    expect(screen.getByText("Not checked yet")).toBeInTheDocument();
  },
);

async function openNetworkForm(provider: "Tailscale" | "Cloudflare Access") {
  await page("/connectors?scope=private-network");
  await waitFor(() => {
    expect(getAction("button", "Add private network")).toBeInTheDocument();
  });
  click(getAction("button", "Add private network"));
  await screen.findByRole("heading", { name: "Add a private network" });
  click(screen.getByText(provider, { exact: true }));
  await screen.findByRole("dialog", {
    name:
      provider === "Tailscale"
        ? "Tailscale connection setup"
        : "Cloudflare connection setup",
  });
  click(getAction("button", "Already have credentials? Enter them directly"));
  return await screen.findByRole("textbox", { name: "Network name" });
}
test("Cloudflare four-step guide preserves the draft and resumes after returning", async () => {
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
  click(getAction("button", "Get Client ID and Client Secret"));
  await screen.findByRole("dialog", { name: "Cloudflare connection setup" });
  expect(getAction("link", "Open Cloudflare dashboard")).toHaveAttribute(
    "target",
    "_blank",
  );
  click(getAction("button", "Next"));
  expect(screen.getByText("2 / 4")).toBeInTheDocument();
  click(getAction("button", "Return to form"));
  expect(name).toHaveValue("Cloudflare draft");
  expect(secret).toHaveValue("test-only-draft-secret");
  click(getAction("button", "Hide entered value"));
  expect(secret).toHaveAttribute("type", "password");
  click(getAction("button", "Get Client ID and Client Secret"));
  expect(screen.getByText("2 / 4")).toBeInTheDocument();
  click(getAction("button", "Previous"));
  expect(screen.getByText("1 / 4")).toBeInTheDocument();
  click(getAction("button", "Next"));
  click(getAction("button", "Next"));
  expect(screen.getByText(/Action: Service Auth/u)).toBeInTheDocument();
  expect(screen.getByText(/Keep all existing rules/u)).toBeInTheDocument();
  click(getAction("button", "Next"));
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
  const name = await openNetworkForm("Tailscale");
  await fill(name, "Tailnet draft");
  click(screen.getByText("Allowed tags", { selector: "summary" }));
  await fill(screen.getByLabelText("Allowed tags"), "tag:office, tag:review");
  const secret = screen.getByLabelText("Client Secret");
  await fill(secret, "test-only-draft-secret");
  click(getAction("button", "Get Client ID and Client Secret"));
  await screen.findByRole("dialog", { name: "Tailscale connection setup" });
  click(getAction("button", "Next"));
  click(getAction("button", "Next"));
  expect(
    screen.getByText(/tag:office, tag:review from the current Okou form/u),
  ).toBeInTheDocument();
  click(screen.getByText("Tag missing?"));
  expect(
    screen.getByText(/Definitions → Tags → Create tag/u),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Enter office, review as Tag name/u),
  ).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(name).toHaveValue("Tailnet draft");
  expect(secret).toHaveValue("test-only-draft-secret");
  click(getAction("button", "Get Client ID and Client Secret"));
  expect(screen.getByText("3 / 4")).toBeInTheDocument();
  click(getAction("button", "Next"));
  expect(
    screen.getByText(/Click Save network after copying/u),
  ).toBeInTheDocument();
  click(getAction("button", "Return to form"));
  expect(getAction("button", "Save network")).toBeInTheDocument();
  click(getAction("button", "Get Client ID and Client Secret"));
  click(getAction("button", "Return to selection"));
  await screen.findByRole("heading", { name: "Add a private network" });
  click(screen.getByText("Tailscale", { exact: true }));
  await screen.findByRole("dialog", { name: "Tailscale connection setup" });
  click(getAction("button", "Next"));
  click(getAction("button", "Next"));
  expect(
    screen.getByText(/tag:office, tag:review from the current Okou form/u),
  ).toBeInTheDocument();
  click(getAction("button", "Return to form"));
  expect(name).toHaveValue("Tailnet draft");
  expect(secret).toHaveValue("test-only-draft-secret");
});

test("Private network starts with one neutral provider selector and both guides can return to it", async () => {
  await page("/connectors?scope=private-network");
  await screen.findByRole("heading", { name: "No private networks yet" });
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.trim() === "Add private network";
    }),
  ).toHaveLength(1);
  click(getAction("button", "Add private network"));
  await screen.findByRole("heading", { name: "Add a private network" });
  expect(
    screen.getByText("Choose a network type to continue setup."),
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
    expect(screen.getByText("1 / 4")).toBeInTheDocument();
    expect(
      getAction("button", "Already have credentials? Enter them directly"),
    ).toBeInTheDocument();
    click(getAction("button", "Return to selection"));
    await screen.findByRole("heading", { name: "Add a private network" });
  }
  expect(
    screen.queryByRole("heading", {
      name: "Install Tailscale on the target computer",
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
  click(getAction("button", "Already have credentials? Enter them directly"));
  const name = await screen.findByRole("textbox", { name: "Network name" });
  const form = name.closest("form");
  if (!form) {
    throw new Error("Missing network form");
  }
  await fill(name, "Saved network");
  await fill(within(form).getByLabelText("Client ID"), "test-client");
  await fill(within(form).getByLabelText("Client Secret"), "test-secret");
  click(getAction("button", "Save network"));
  await screen.findByRole("heading", { name: "No private networks yet" });
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
    within(personal).getByText("Can use · Can manage"),
  ).toBeInTheDocument();
  expect(
    within(organization).getByText(
      "Engineering · Organization members can use these networks",
    ),
  ).toBeInTheDocument();
  await expect(
    within(organization).findByText("Can use · Administrators manage"),
  ).resolves.toBeInTheDocument();
  expect(
    within(organization).getByText(shared.name).closest("a"),
  ).toHaveAttribute(
    "href",
    expect.stringContaining(`remoteResource=cloudflare%3A${shared.id}`),
  );
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
      "You can use this network; organization administrators manage it",
    ),
  ).toBeInTheDocument();
  expect(queryAction("button", "Edit settings")).toBeNull();
  expect(queryAction("button", "Delete Cloudflare Access")).toBeNull();
});

test.each(["Tailscale", "Cloudflare Access"] as const)(
  "%s creation defaults to personal and explains the unavailable organization option for members",
  async (provider) => {
    await page("/connectors?scope=private-network", true, "member");
    await screen.findByRole("heading", { name: "No private networks yet" });
    click(getAction("button", "Add private network"));
    await screen.findByRole("heading", { name: "Add a private network" });
    click(screen.getByText(provider, { exact: true }));
    await screen.findByRole("dialog");
    click(getAction("button", "Already have credentials? Enter them directly"));
    await screen.findByLabelText("Network name");
    const personal = screen.getByLabelText(/Only me/u, { selector: "input" });
    const organization = screen.getByLabelText(/Organization members/u, {
      selector: "input",
    });
    expect(personal).toBeChecked();
    expect(organization).toBeDisabled();
    expect(
      screen.getByText(
        "Members of Engineering can select this network when adding a device.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Organization networks are created and managed by organization administrators.",
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
      "Sharing network settings does not share your device connections.",
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
    name: "Make this network personal?",
  });
  await within(confirmation).findByText("Alex");
  expect(
    getAction("button", "Confirm personal scope", confirmation),
  ).toBeDisabled();
  expect(saved.scope).toBe("organization");
  click(
    within(confirmation).getByText(
      "I understand that affected members must select another network for their saved connections.",
    ),
  );
  click(getAction("button", "Confirm personal scope", confirmation));
  await screen.findByText("You can use and manage this network");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Make this network personal?" }),
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
    /This network or its references changed/u,
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
    click(getAction("button", "Add private network"));
    await screen.findByRole("heading", { name: "Add a private network" });
    click(screen.getByText(provider, { exact: true }));
    await screen.findByRole("dialog");
    click(getAction("button", "Already have credentials? Enter them directly"));
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
