import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  vncHost,
} from "./connectors-remote-control-test-helpers.ts";
const context = testContext(),
  directory = "/connectors?scope=remote-control",
  subject = "Illustration desk";
async function openDevice() {
  await setupPage({ context, path: directory });
  click(await findFastControl("link", /Illustration desk/u));
  return screen.findByRole("article");
}
test("vnc-settings-047 A saved connection is deleted only after confirming its displayed host, using the current generation", async () => {
  const device = vncHost(71, subject, { generation: 4 });
  const inventory = mockRemoteInventory(context, { vnc: [device] });
  let deletion: unknown = null;
  context.mocks.api(
    vncConnectionsContract.delete,
    ({ params, body, respond }) => {
      deletion = { connectionId: params.connectionId, ...body };
      if (params.connectionId !== device.id || body.expectedGeneration !== 4) {
        return respond(409, {
          error: {
            code: "VNC_GENERATION_CONFLICT",
            message: "Refresh required",
          },
        });
      }
      inventory.vnc = [];
      return respond(204);
    },
  );
  const card = await openDevice();
  click(await findFastControl("button", "Delete connection", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete connection",
  });
  expect(dialog).toHaveTextContent(subject);
  expect(deletion).toBeNull();
  expect(inventory.vnc).toStrictEqual([device]);
  click(await findFastControl("button", "Delete connection", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  await waitFor(() => {
    return expect(document.body).not.toHaveTextContent(subject);
  });
  expect(deletion).toStrictEqual({
    connectionId: device.id,
    expectedGeneration: 4,
  });
  expect(inventory.vnc).toStrictEqual([]);
});
test("vnc-settings-021 The direct connection step rejects private device addresses and enables Continue for a public IPv4-mapped address", async () => {
  mockRemoteInventory(context);
  await setupPage({ context, path: directory + "&setup=vnc&step=connection" });
  const host = await screen.findByRole("textbox", { name: /Device address/u });
  const next = await findFastControl("button", "Continue");
  for (const value of [
    "127.0.0.1.",
    "0:0:0:0:0:0:0:1",
    "::1.",
    "::ffff:127.0.0.1",
    "::ffff:192.168.1.2",
    "fc00::1",
    "febf::1",
  ]) {
    await fill(host, value);
    await expect(
      screen.findByText(
        /Private IP addresses require a supported private-network route/u,
      ),
    ).resolves.toBeVisible();
    expect(next).toBeDisabled();
  }
  await fill(host, "::ffff:8.8.8.8");
  await waitFor(() => {
    return expect(
      screen.queryByText(
        /Private IP addresses require a supported private-network route/u,
      ),
    ).toBeNull();
  });
  expect(next).toBeEnabled();
});
const oldKey =
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1XE3pYfFC29c6BMYX9AT\nn5Aqh2J85Vr83cg/9gNbS/fShovUkC13Ye5f5vvzz0cwGYEs0A8/ThRRQW4Cs6xC\nj6UbPQE2bsZYm0HeBhycUbTtkxCohCN3H1+gofj54pdDBgLthD4lCdWzafrC42mV\nZtH4Ia0WGjneohfIuQZ0oSaPRBaK9WcYVesPEyO71kaoUUWQbQ0Fbdq9g4ocWwGC\nkyWopXeUPwh6roJoDaWHW4/11TETVJ7FF5yx1UXitg2r6zpITtOrQ+SeonQHb72e\nYAzUO5dOcSGqrMHj7PIBwKMZXuYWHtXaPp7dZMtVgWvrebM+2RaNLDlun1i0RimU\nQwIDAQAB\n-----END PUBLIC KEY-----",
  newKey =
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmXGLjrZ+6s7LuTEWD+49\nDlUI55+9onNStnOrkgcl6Ijut2z9yFupNkBzfbcqBjTRyPKa3QzlevHBaDF/mkXM\nZJ2Q6V5EU+xZIdEvFaQS6j4lERsgw3RvAFf/Rr0XXDI/Xfk8h6xdPa5K107BhjjW\n35z2zxxShTIGXVO1cHBEXOdKeT46eBvDUeKGNC07UGLQeqVu47IY0sxa2eEflj6S\n2yLwz/rK+nGJjGKYrrTPwaIhrf72rcn4GG2Z6mUbgCYaTdxBH8kbszkGnOUJMkmd\neD95DzQUAJuoQNV2zUJqB720DbIbUFSNJJr+NKmlcE+Ea/Iq1JqKKCbxqroaZt3x\nfQIDAQAB\n-----END PUBLIC KEY-----";
const resultPin = "cd".repeat(32);
async function rsaEditor() {
  await setupPage({
    context,
    path: directory + "&setup=vnc&step=trust&vncProfile=rsa_aes_ra2",
  });
  return {
    pin: await screen.findByLabelText(/Server RSA wire-key SHA256/u),
    key: await screen.findByLabelText(/Independently trusted RSA public PEM/u),
    convert: await findFastControl("button", "Import trusted public key"),
  };
}
test("vnc-settings-063 Importing independently obtained RSA material shows its wire pin and size and leaves the new connection unsaved", async () => {
  const inventory = mockRemoteInventory(context);
  let received: unknown;
  context.mocks.api(
    vncConnectionsContract.inspectRsaKey,
    ({ body, respond }) => {
      received = body;
      return respond(200, { serverKeySha256: resultPin, modulusBits: 2048 });
    },
  );
  const { pin, key, convert } = await rsaEditor();
  await fill(key, oldKey);
  click(convert);
  await expect(
    screen.findByText("Imported public-key size: 2048 bits"),
  ).resolves.toBeVisible();
  expect(pin).toHaveValue(resultPin);
  expect(received).toStrictEqual({ publicKeyPem: oldKey });
  await expect(
    screen.findByText(/Conversion does not establish identity or save/u),
  ).resolves.toBeVisible();
  expect(pin).toBeVisible();
  expect(inventory.vnc).toStrictEqual([]);
});
test("vnc-settings-064 A late RSA import reports the changed PEM without replacing its current key or trusted pin", async () => {
  mockRemoteInventory(context);
  const started = context.mocks.deferred<string>(),
    hold = context.mocks.deferred<void>();
  context.mocks.api(
    vncConnectionsContract.inspectRsaKey,
    async ({ body, respond }) => {
      started.resolve(body.publicKeyPem);
      await hold.promise;
      return respond(200, { serverKeySha256: resultPin, modulusBits: 2048 });
    },
  );
  try {
    const { pin, key, convert } = await rsaEditor();
    await fill(pin, "ab".repeat(32));
    await fill(key, oldKey);
    click(convert);
    await expect(started.promise).resolves.toBe(oldKey);
    await fill(key, newKey);
    expect(screen.queryByRole("alert")).toBeNull();
    hold.resolve();
    await expect(screen.findByRole("alert")).resolves.toBeVisible();
    expect(pin).toHaveValue("ab".repeat(32));
    expect(key).toHaveValue(newKey);
    expect(screen.queryByText(/Imported public-key size/u)).toBeNull();
  } finally {
    if (!hold.settled()) {
      hold.resolve();
    }
  }
});
