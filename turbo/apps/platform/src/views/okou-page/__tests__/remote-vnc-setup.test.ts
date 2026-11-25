import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  vncHost,
} from "./connectors-remote-control-test-helpers.ts";
import {
  emitMockedClerkEvent,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import userEvent from "@testing-library/user-event";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { mockNow } from "../../../lib/time.ts";

const context = testContext();

const directory = "/connectors?scope=remote-control",
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

const keyHex =
    "05020000004b0001000f4558414d504c452e494e56414c49440005616c69636500000001000000640200120020535353535353535353535353535353535353535353535353535353535353535300000002",
  ticketHex =
    "0504000000000001000000010000000f4558414d504c452e494e56414c494400000005616c69636500000001000000010000000f4558414d504c452e494e56414c494400000005616c69636500000002000000020000000f4558414d504c452e494e56414c494400000003766e6300000014686f73742e6578616d706c652e696e76616c696400120000002037373737373737373737373737373737373737373737373737373737373737370000006400000064000003e800000000004000000000000000000000000000001b53594e5448455449435f4e4f545f415f5245414c5f5449434b455400000000";
const realm = "EXAMPLE.INVALID",
  server = "host.example.invalid";
const principal = Object.freeze({ realm, components: ["alice"] });
function material(hex: string) {
  return Uint8Array.from(hex.match(/../gu)!, (byte) => {
    return Number.parseInt(byte, 16);
  });
}
function fileFrom(hex: string, filename: string) {
  const bytes = material(hex),
    file = new File([bytes], filename);
  return { bytes, file, encoded: btoa(String.fromCharCode(...bytes)) };
}
type Source = "keytab" | "ticket";
function serverInventory() {
  mockRemoteInventory(context);
  let saved: unknown = null;
  context.mocks.api(vncCredentialsContract.create, ({ body, respond }) => {
    saved = body.authentication;
    return respond(204);
  });
  return () => {
    return saved;
  };
}
async function choose(dialog: HTMLElement, label: string) {
  click(
    within(dialog).getByRole("combobox", { name: "Authentication method" }),
  );
  click(await screen.findByRole("option", { name: label }));
}
async function describePrincipal(dialog: HTMLElement) {
  await fill(await within(dialog).findByLabelText("Initiator realm"), realm);
  await fill(within(dialog).getByLabelText("Initiator components"), "alice");
}
async function dialogFor(type: Source) {
  click(await findFastControl("button", "Add credential"));
  const dialog = await screen.findByRole("dialog", { name: "Add credential" });
  await fill(
    within(dialog).getByLabelText("Credential name"),
    "Design console",
  );
  await choose(
    dialog,
    type === "ticket" ? "Kerberos · service ticket" : "Kerberos · keytab",
  );
  await describePrincipal(dialog);
  if (type === "ticket") {
    await fill(within(dialog).getByLabelText("VNC service realm"), realm);
    await fill(within(dialog).getByLabelText("VNC service instance"), server);
  }
  return dialog;
}
async function begin(type: Source, ownerLabel?: () => string) {
  mockNow(new Date(500_000), context.signal);
  const saved = serverInventory();
  if (ownerLabel) {
    context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
      return respond(200, {
        credentials: [
          {
            id: "eecc1088-5000-4777-8888-000000000003",
            revision: 1,
            name: ownerLabel(),
            authMethod: "vnc_password",
            hosts: [],
            createdAt: "2026-10-02T00:00:00Z",
            updatedAt: "2026-10-02T00:00:00Z",
          },
        ],
      });
    });
  }
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&remoteView=credentials&type=vnc",
  });
  return { dialog: await dialogFor(type), saved };
}
async function upload(dialog: HTMLElement, type: Source, file: File) {
  await userEvent
    .setup({ delay: null })
    .upload(
      within(dialog).getByLabelText(
        type === "ticket"
          ? "Service ticket file (.ccache)"
          : "Keytab file (.keytab)",
      ),
      file,
    );
}
function pending(type: Source, alternate = false) {
  const hex = type === "ticket" ? ticketHex : keyHex;
  const raw = alternate ? hex.replace("53535353", "41424344") : hex;
  const contents = fileFrom(
    raw,
    type === "ticket" ? "studio.ccache" : "studio.keytab",
  );
  const release = context.mocks.deferred<void>(),
    started = context.mocks.deferred<void>();
  vi.spyOn(contents.file, "arrayBuffer").mockImplementation(async () => {
    started.resolve();
    await release.promise;
    return contents.bytes.buffer;
  });
  const canonical =
    type === "ticket" ? raw : raw.replace("00000064020012", "00000000020012");
  return {
    ...contents,
    encoded: btoa(String.fromCharCode(...material(canonical))),
    started: started.promise,
    finish: async () => {
      release.resolve();
      await waitFor(() => {
        return expect(
          contents.bytes.every((byte) => {
            return byte === 0;
          }),
        ).toBeTruthy();
      });
    },
    release: () => {
      if (!release.settled()) {
        release.resolve();
      }
    },
  };
}
async function save(dialog: HTMLElement) {
  click(await findFastControl("button", "Save", dialog));
}
async function accepted(dialog: HTMLElement) {
  await save(dialog);
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
}
async function rejected(dialog: HTMLElement) {
  await save(dialog);
  await expect(within(dialog).findByRole("alert")).resolves.toBeVisible();
}
test("vnc-settings-026 A selected service ticket is saved only on confirmation with the exact service and initiator", async () => {
  const { dialog, saved } = await begin("ticket"),
    file = pending("ticket");
  try {
    expect(within(dialog).queryByLabelText("KDC host")).toBeNull();
    await upload(dialog, "ticket", file.file);
    await file.started;
    await file.finish();
    expect(saved()).toBeNull();
    await accepted(dialog);
    expect(saved()).toMatchObject({
      method: "qemu_kerberos_ticket",
      initiator: principal,
      service: { realm, components: ["vnc", server] },
      ticketCache: file.encoded,
    });
  } finally {
    file.release();
  }
});
test.each([
  [
    "vnc-settings-027",
    "ticket",
    "VNC service instance",
    server,
    "other.example.invalid",
  ],
  ["vnc-settings-029", "keytab", "Initiator realm", realm, "OTHER.INVALID"],
] as const)(
  "%s Returning a %s draft to its original identity requires a freshly selected file",
  async (_id, type, label, original, other) => {
    const { dialog, saved } = await begin(type),
      old = pending(type);
    try {
      await upload(dialog, type, old.file);
      await old.started;
      const field = within(dialog).getByLabelText(label);
      await fill(field, other);
      await fill(field, original);
      await old.finish();
      await rejected(dialog);
      expect(saved()).toBeNull();
      const fresh = pending(type);
      try {
        await upload(dialog, type, fresh.file);
        await fresh.started;
        await fresh.finish();
        await accepted(dialog);
        expect(saved()).toMatchObject({
          initiator: principal,
          [type === "ticket" ? "ticketCache" : "keytab"]: fresh.encoded,
        });
      } finally {
        fresh.release();
      }
    } finally {
      old.release();
    }
  },
);
test("vnc-settings-028 Completing the old keytab read after its replacement still saves the replacement bytes", async () => {
  const { dialog, saved } = await begin("keytab"),
    old = pending("keytab"),
    fresh = pending("keytab", true);
  try {
    await upload(dialog, "keytab", old.file);
    await old.started;
    await upload(dialog, "keytab", fresh.file);
    await fresh.started;
    await fresh.finish();
    await old.finish();
    await accepted(dialog);
    expect(saved()).toMatchObject({ keytab: fresh.encoded });
    expect(fresh.encoded).not.toBe(old.encoded);
  } finally {
    old.release();
    fresh.release();
  }
});
test("vnc-settings-030 Closing the original dialog prevents its delayed file from populating a new keytab import", async () => {
  const { dialog, saved } = await begin("keytab"),
    old = pending("keytab");
  try {
    await upload(dialog, "keytab", old.file);
    await old.started;
    click(await findFastControl("button", "Cancel", dialog));
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
    const next = await dialogFor("keytab");
    await old.finish();
    await rejected(next);
    expect(saved()).toBeNull();
  } finally {
    old.release();
  }
});
test("vnc-settings-031 Replacing an unreadable keytab dismisses its import error and saves the readable material", async () => {
  const { dialog, saved } = await begin("keytab");
  const unreadable = fileFrom(keyHex, "unreadable.keytab");
  vi.spyOn(unreadable.file, "arrayBuffer").mockRejectedValue(
    new Error("File read failed"),
  );
  await upload(dialog, "keytab", unreadable.file);
  await expect(within(dialog).findByRole("alert")).resolves.toBeVisible();
  expect(saved()).toBeNull();
  const fresh = pending("keytab");
  try {
    await upload(dialog, "keytab", fresh.file);
    await fresh.started;
    await fresh.finish();
    await accepted(dialog);
    expect(saved()).toMatchObject({
      initiator: principal,
      keytab: fresh.encoded,
    });
  } finally {
    fresh.release();
  }
});
test("vnc-settings-032 A round trip through Kerberos password discards the pending keytab import even after the file is read", async () => {
  const { dialog, saved } = await begin("keytab"),
    old = pending("keytab");
  try {
    await upload(dialog, "keytab", old.file);
    await old.started;
    await choose(dialog, "Kerberos · password");
    await choose(dialog, "Kerberos · keytab");
    await describePrincipal(dialog);
    await old.finish();
    await rejected(dialog);
    expect(saved()).toBeNull();
  } finally {
    old.release();
  }
});

test("vnc-settings-033 Returning to the original owner creates an empty keytab draft even after their old file finishes", async () => {
  let card = "Original owner card";
  const { dialog, saved } = await begin("keytab", () => {
      return card;
    }),
    old = pending("keytab");
  try {
    await upload(dialog, "keytab", old.file);
    await old.started;
    card = "Second owner card";
    mockUser(
      { id: "local-second-owner", fullName: "Second Owner" },
      { token: "local-second-token" },
    );
    emitMockedClerkEvent();
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
    await screen.findByText("Second owner card");
    card = "Returned owner card";
    mockUser(
      { id: "test-user-123", fullName: "Test User" },
      { token: "test-token" },
    );
    emitMockedClerkEvent();
    await screen.findByText("Returned owner card");
    const next = await dialogFor("keytab");
    await old.finish();
    await rejected(next);
    expect(saved()).toBeNull();
  } finally {
    old.release();
  }
});
