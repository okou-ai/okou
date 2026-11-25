import {
  emitMockedClerkEvent,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, vi } from "vitest";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { mockRemoteInventory } from "./connectors-remote-control-test-helpers.ts";
const context = testContext();
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
