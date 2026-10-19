import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  tailscaleContract,
  type TailscaleConfig,
} from "@okouai/api-contracts/contracts/tailscale";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
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
async function page(path = "/connectors?scope=remote-control", enabled = true) {
  await setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.RemoteControlGuidedSetup]: enabled,
      [FeatureSwitchKey.VncAccess]: true,
      [FeatureSwitchKey.TailscaleAccess]: true,
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
test("The new deep link keeps the existing experience when the switch is off", async () => {
  await page("/connectors?scope=remote-control&setup=ssh", false);
  await waitFor(() => {
    expect(getAction("button", "Add host")).toBeInTheDocument();
  });
  expect(
    screen.queryByRole("heading", { name: "Set up a connection" }),
  ).toBeNull();
  expect(queryAction("button", "Add connection")).toBeNull();
});
test("Remote control opens management before setup, with a separate login tab", async () => {
  await page();
  await screen.findByRole("heading", { name: "No devices added yet" });
  expect(
    screen.queryByRole("heading", { name: "Set up a connection" }),
  ).toBeNull();
  click(getAction("tab", "Login information"));
  await screen.findByText(
    "No SSH credentials yet. Add a private key or password to reuse across hosts.",
  );
  click(getAction("button", "Add connection"));
  await screen.findByRole("heading", { name: "Set up a connection" });
  expect(screen.getByText("Operate through commands.")).toBeInTheDocument();
  expect(
    screen.getByText("Operate through the screen, mouse and keyboard."),
  ).toBeInTheDocument();
});
test("Direct SSH requires a name, retains input through username help and saves through the contract", async () => {
  const requests: unknown[] = [];
  context.mocks.api(sshConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
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
  await fill(screen.getByLabelText("Credential name"), "Office login");
  await fill(screen.getByLabelText("Password"), "test-only-password");
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
  expect(screen.getByText(/Saved, but not checked yet/u)).toBeInTheDocument();
  expect(getAction("link", "Open chat").getAttribute("href")).toContain(
    "prompt=",
  );
});
test("Tailscale setup adds a narrow grant with the selected port and leaves the target untagged", async () => {
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
    screen.getByText(/Do not tag your personal target computer/u),
  ).toBeInTheDocument();
  click(getAction("button", "Tag created, continue"));
  await screen.findByRole("heading", {
    name: "Allow Okou to reach this computer",
  });
  click(screen.getByText("Use a custom port"));
  await fill(screen.getByLabelText("Port"), "2222");
  click(screen.getByText("Show grant to add"));
  expect(screen.getByText(/"tcp:2222"/u)).toBeInTheDocument();
  expect(
    screen.getByText(/does not restrict any broader rules/u),
  ).toBeInTheDocument();
  click(getAction("button", "Rule saved, continue"));
  await screen.findByRole("heading", {
    name: "Create and enter network credentials",
  });
  await screen.findByLabelText("OAuth client secret");
  expect(screen.getByLabelText("OAuth client secret")).toHaveAttribute(
    "type",
    "password",
  );
});
test("A single saved network is explicitly selected and can be changed", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [network] });
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
  const group = await screen.findByLabelText(
    "How does the VNC service authenticate?",
  );
  click(group);
  click(await screen.findByRole("option", { name: "Apple screen sharing" }));
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Connect to the target computer",
  });
  const port = screen.getByLabelText("RFB destination port");
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
  await page("/connectors?scope=private-network");
  click(
    await screen.findByText("Office network", { selector: "summary strong" }),
  );
  await screen.findByText("Office computer");
  expect(getAction("button", "Delete Tailscale")).toBeDisabled();
});
test("Changing category abandons setup and returns to management", async () => {
  const username = await directForm();
  await fill(username, "operator");
  click(screen.getByTestId("connectors-scope-private-network"));
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
  await fill(screen.getByLabelText("Credential name"), "Office login");
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

test("VNC saves only after the separate login and server-identity steps", async () => {
  const requests: unknown[] = [];
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    requests.push(body);
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
  click(await screen.findByLabelText("Security profile"));
  click(
    await screen.findByRole("option", {
      name: "Encrypted without a VNC password (X509None)",
    }),
  );
  click(getAction("button", "Continue"));
  await screen.findByRole("heading", {
    name: "Connect to the target computer",
  });
  await fill(
    screen.getByLabelText("RFB destination host"),
    "screen.example.com",
  );
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
  click(getAction("button", "Save"));
  await screen.findByRole("heading", { name: "Connection added" });
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
  click(screen.getByText("VNC", { selector: "strong" }));
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
  click(screen.getByTestId("connectors-scope-private-network"));
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
  await fill(screen.getByLabelText("Credential name"), "Office login");
  await fill(screen.getByLabelText("Password"), "test-only-password");
  const name = screen.getByLabelText(/Connection name/u);
  await fill(name, "Office retry");
  click(getAction("button", "Save"));
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
