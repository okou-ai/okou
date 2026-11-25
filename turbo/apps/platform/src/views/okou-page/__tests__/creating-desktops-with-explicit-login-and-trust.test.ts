import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  REMOTE_TIMESTAMP,
  vncHost,
  sshHost,
} from "./connectors-remote-control-test-helpers.ts";
const context = testContext(),
  base = "/connectors?scope=remote-control",
  setup = base + "&setup=vnc&step=profile";
async function press(name: string | RegExp, box?: HTMLElement) {
  click(await findFastControl("button", name, box));
}
async function pick(name: string | RegExp, choice: string | RegExp) {
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: choice }));
}
function field(name: string | RegExp) {
  return screen.getByLabelText(name, { selector: "input,textarea" });
}
async function address(value: string) {
  await screen.findByText("Connect a device");
  await fill(field("Device address"), value);
}
function saveBoundary() {
  const sent = context.mocks.deferred<unknown>();
  context.mocks.api(vncConnectionsContract.create, ({ body, respond }) => {
    sent.resolve(body);
    return respond(
      201,
      vncHost(19, body.displayName, { id: body.id, host: body.host }),
    );
  });
  return sent;
}
test("vnc-settings-013 Both saved identity and setup explain the unauthenticated profile before creating a direct credentialless desktop", async () => {
  const known = {
    id: remoteId("e", 13),
    displayName: "Open lab desktop",
    host: "lab.example.com",
    port: 5900,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    credential: { type: "none" as const },
    security: {
      type: "x509_none" as const,
      trust: { mode: "system" as const },
    },
  };
  mockRemoteInventory(context, { vnc: [known] });
  const sent = saveBoundary();
  await setupPage({ context, path: base + "&remoteResource=vnc:" + known.id });
  click(
    await screen.findByText("Server identity and chat permissions", {
      selector: "summary",
    }),
  );
  await expect(
    screen.findByText(/does not authenticate you to the VNC server/),
  ).resolves.toBeVisible();
  await press("Back to remote connections");
  await press("Add connection");
  await press(/^VNC/);
  await pick("Login method", /without a VNC password \(X509None\)/);
  const explanation = await screen.findByText(
    /Anyone else who can reach that server/,
  );
  const accordion = explanation.closest("details");
  if (accordion && !accordion.open) {
    click(accordion.querySelector("summary")!);
  }
  expect(explanation).toBeVisible();
  await press("Continue");
  await address("open.example.com");
  await press("Continue");
  await fill(field(/^Connection name/), "Public display");
  await press("Continue");
  await screen.findByText("Review and save");
  await press("Save");
  await expect(sent.promise).resolves.toMatchObject({
    host: "open.example.com",
    credential: { type: "none" },
    security: { type: "x509_none" },
    transport: { type: "direct" },
  });
  await screen.findByText("Connection added");
});
test("vnc-settings-016 Reselecting a saved SSH gateway preserves the final device endpoint and independent RFB certificate name", async () => {
  const gateway = sshHost(16, "Display gateway");
  const login = {
    id: remoteId("f", 16),
    name: "Screen access",
    authMethod: "vnc_password" as const,
    revision: 1,
    hosts: [],
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
  };
  mockRemoteInventory(context, { ssh: [gateway], vncCredentials: [login] });
  const sent = saveBoundary();
  await setupPage({ context, path: setup });
  await press("Continue");
  await screen.findByText("Connect a device");
  await pick("Connection method", /SSH/);
  await pick(/SSH host/, /Display gateway/);
  await fill(field("Device address"), "first.example.com");
  await pick("Connection method", /Direct/);
  await fill(field("Device address"), "second.example.com");
  await pick("Connection method", /SSH/);
  await pick(/SSH host/, /Display gateway/);
  expect(field("Device address")).toHaveValue("second.example.com");
  await press("Continue");
  await press("Choose saved login details");
  const dialog = await screen.findByRole("dialog");
  click(await within(dialog).findByText("Screen access"));
  await fill(field(/^Connection name/), "Desktop via gateway");
  await press("Continue");
  await fill(field("VNC certificate name"), "desktop.internal.example.com");
  await press("Save");
  await expect(sent.promise).resolves.toMatchObject({
    host: "second.example.com",
    port: 5900,
    transport: { type: "ssh", connectionId: gateway.id },
    credential: { id: login.id },
    security: { serverName: "desktop.internal.example.com", type: "x509_vnc" },
  });
  await screen.findByText("Connection added");
});
test("vnc-settings-024 The QEMU SCRAM desktop preserves password whitespace and saves the selected custom CA", async () => {
  const pem =
    "-----BEGIN CERTIFICATE-----\nMIIBlzCCAT2gAwIBAgIUW4TzBICxpktCC/lHaqoMSGEcFIcwCgYIKoZIzj0EAwIw\nITEfMB0GA1UEAwwWQmF0Y2ggODAgbG9jYWwgdGVzdCBDQTAeFw0yNjExMjIyMTIx\nMjBaFw0zNjExMTkyMTIxMjBaMCExHzAdBgNVBAMMFkJhdGNoIDgwIGxvY2FsIHRl\nc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATUktiO6NDvb8/gabt5NTh/\nF2lk9fnLJazZMdyIDrV76PpTrmkxs1zyuNFR0OEqjmkoVw1r/f3Fh1P1NWdxFDfC\no1MwUTAdBgNVHQ4EFgQUpM50hCZY8R21hKELhgNtmmKvW2swHwYDVR0jBBgwFoAU\npM50hCZY8R21hKELhgNtmmKvW2swDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD\nAgNIADBFAiEAizZ2Zdx4yeNcX8hYLpn0JafFOBFcGFdXcou8YkibU9wCIGYUf5ip\nTfOCrEpnMkJQ7Xfy3ORd1A/7F9ZiOUXTKp9G\n-----END CERTIFICATE-----";
  const password = "  exact-scram-secret  ";
  mockRemoteInventory(context);
  const sent = saveBoundary();
  await setupPage({ context, path: setup });
  await pick("Service type", /QEMU/);
  await pick("Login method", /QEMU SCRAM-SHA-256/);
  await press("Continue");
  await address("qemu.example.com");
  await press("Continue");
  await fill(field("Username"), "operator");
  const secret = field("Password");
  await fill(secret, password);
  await fill(field(/^Connection name/), "QEMU station");
  await press("Continue");
  await pick(/Server certificate trust/, /Custom/);
  await fill(field(/CA certificates/), pem);
  await press("Save");
  await expect(sent.promise).resolves.toMatchObject({
    credential: {
      create: {
        authentication: {
          method: "qemu_scram_sha256",
          username: "operator",
          password,
        },
      },
    },
    security: {
      type: "qemu_x509_sasl",
      trust: { mode: "custom_ca", caBundle: pem },
    },
  });
  await screen.findByText("Connection added");
  expect(screen.queryByDisplayValue(password)).toBeNull();
  expect(secret).toHaveValue("");
  expect(document.body.textContent).not.toContain(password);
});
