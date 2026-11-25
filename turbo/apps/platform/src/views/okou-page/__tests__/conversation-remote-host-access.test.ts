import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import {
  chatRemoteAccessContract,
  type ThreadRemoteHostAccess,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { vncHost, remoteId } from "./connectors-remote-control-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
const context = testContext();
const sshId = remoteId("b", 1);
const thread = "a3000000-0000-4000-8000-000000000010";
async function remote(
  options: {
    newChat?: boolean;
    sshDefault?: boolean;
    vncDefault?: boolean;
    override?: boolean;
    directoryTunnel?: boolean;
    beforeSave?: () => Promise<void>;
    refresh?: () => Promise<"ok" | "failed">;
  } = {},
) {
  const vnc = vncHost(
    1,
    "MacinCloud",
    options.directoryTunnel
      ? {
          transport: { type: "direct" as const },
          security: {
            type: "qemu_x509_gssapi" as const,
            trust: { mode: "system" as const },
            service: {
              realm: "LOCAL.TEST",
              components: ["vnc", "desktop.local.test"],
            },
            kdc: {
              host: "directory.local.test",
              port: 88,
              transport: { type: "ssh" as const, connectionId: sshId },
              ticketLifetimeSeconds: 1200,
              renewableLifetimeSeconds: 7200,
            },
          },
        }
      : { transport: { type: "ssh" as const, connectionId: sshId } },
  );
  const ssh = {
    connectionId: sshId,
    displayName: options.directoryTunnel ? "Directory tunnel" : "MacinCloud",
    defaultEnabled: options.sshDefault ?? false,
  };
  const desktop = {
    connectionId: vnc.id,
    displayName: "MacinCloud",
    defaultEnabled: options.vncDefault ?? true,
  };
  const choices = new Map<string, boolean>();
  if (options.override !== undefined) {
    choices.set(sshId, options.override);
  }
  function effective(row: typeof ssh): ThreadRemoteHostAccess {
    const value = choices.get(row.connectionId);
    return {
      ...row,
      overrideEnabled: value ?? null,
      enabled: value ?? row.defaultEnabled,
      source: value === undefined ? "default" : "override",
    };
  }
  mockChatLifecycle(context, { threadId: thread });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserEnabledByDefault: false,
      cloudBrowserAvailable: false,
      sshHosts: [ssh],
      vncHosts: [desktop],
    });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [vnc] });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    async ({ respond }) => {
      if (
        choices.size &&
        options.refresh &&
        (await options.refresh()) === "failed"
      ) {
        return respond(503, {
          error: {
            code: "UNAVAILABLE",
            message: "Chat permissions are temporarily unavailable",
          },
        });
      }
      return respond(200, { ssh: [effective(ssh)], vnc: [effective(desktop)] });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.setThreadOverride,
    async ({ params, body, respond }) => {
      await options.beforeSave?.();
      choices.set(params.connectionId, body.enabled);
      return respond(200, effective(params.protocol === "ssh" ? ssh : desktop));
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.clearThreadOverride,
    ({ params, respond }) => {
      choices.delete(params.connectionId);
      return respond(200, effective(params.protocol === "ssh" ? ssh : desktop));
    },
  );
  await setupPage({
    context,
    path: options.newChat ? "/?compose=1" : "/chats/" + thread,
  });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", /Remote access/));
  return screen.findByRole("dialog", { name: "Remote access" });
}
async function setChoice(
  protocol: "SSH" | "VNC",
  value: "Off" | "On" | "Default",
) {
  const select = await screen.findByRole("combobox", {
    name: protocol + " MacinCloud",
  });
  click(select);
  const option = await screen.findByRole("option", {
    name: value === "Default" ? /^Default/ : value,
  });
  click(option);
  return select;
}
const on = "SSH enabled: MacinCloud";
const requires = "Requires SSH: MacinCloud";
const enable = "Enable SSH: MacinCloud";
test("chat-composer-vnc-dependencies-011 The saved chat's dependency feedback follows both changes of its SSH access", async () => {
  const dialog = await remote();
  await within(dialog).findByText(enable);
  await setChoice("SSH", "On");
  await within(dialog).findByText(on);
  expect(within(dialog).queryByText(enable)).toBeNull();
  await setChoice("SSH", "Off");
  await expect(within(dialog).findByText(enable)).resolves.toBeVisible();
  expect(within(dialog).queryByText(on)).toBeNull();
});
test("chat-composer-vnc-dependencies-012 Turning VNC off changes its SSH warning into an informational dependency", async () => {
  const dialog = await remote();
  await within(dialog).findByText(enable);
  await setChoice("VNC", "Off");
  await expect(within(dialog).findByText(requires)).resolves.toBeVisible();
  expect(within(dialog).queryByText(enable)).toBeNull();
});
test.each([
  ["chat-composer-vnc-dependencies-013", true, false, enable, on],
  ["chat-composer-vnc-dependencies-014", false, true, on, enable],
] as const)(
  "%s Inheriting the saved SSH default replaces its override and updates the VNC dependency",
  async (_id, sshDefault, override, before, after) => {
    const dialog = await remote({ sshDefault, override });
    await within(dialog).findByText(before);
    await setChoice("SSH", "Default");
    await expect(within(dialog).findByText(after)).resolves.toBeVisible();
    expect(within(dialog).queryByText(before)).toBeNull();
  },
);
test("chat-composer-vnc-dependencies-015 A new chat distinguishes a disabled VNC dependency, an unmet one, and restored SSH", async () => {
  const dialog = await remote({
    newChat: true,
    sshDefault: true,
    vncDefault: false,
  });
  await within(dialog).findByText(on);
  await setChoice("SSH", "Off");
  await within(dialog).findByText(requires);
  await setChoice("VNC", "On");
  await within(dialog).findByText(enable);
  await setChoice("SSH", "Default");
  await expect(within(dialog).findByText(on)).resolves.toBeVisible();
  expect(within(dialog).queryByText(enable)).toBeNull();
});
test("chat-composer-vnc-dependencies-001 A keyboard SSH choice keeps its focus and both host rows in their initial order", async () => {
  const dialog = await remote({ newChat: true });
  const fields = within(dialog).getAllByRole("combobox");
  const labels = fields.map((el) => {
    return el.getAttribute("aria-label");
  });
  expect(labels).toStrictEqual(
    expect.arrayContaining(["SSH MacinCloud", "VNC MacinCloud"]),
  );
  const ssh = within(dialog).getByRole("combobox", { name: "SSH MacinCloud" });
  ssh.focus();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Enter}");
  const option = await screen.findByRole("option", { name: "On" });
  await user.keyboard("{Home}{ArrowDown}");
  expect(option).toHaveFocus();
  await user.keyboard("{Enter}");
  await within(dialog).findByText(on);
  expect(ssh).toHaveFocus();
  expect(
    within(dialog)
      .getAllByRole("combobox")
      .map((el) => {
        return el.getAttribute("aria-label");
      }),
  ).toStrictEqual(labels);
});

test("chat-composer-vnc-dependencies-003 SSH keeps keyboard focus across a held save and the separate access refresh", async () => {
  const save = context.mocks.deferred<void>();
  const refresh = context.mocks.deferred<"ok" | "failed">();
  const read = context.mocks.deferred<void>();
  const dialog = await remote({
    sshDefault: true,
    beforeSave: () => {
      return save.promise;
    },
    refresh() {
      if (!read.settled()) {
        read.resolve();
      }
      return refresh.promise;
    },
  });
  const field = within(dialog).getByRole("combobox", {
    name: "SSH MacinCloud",
  });
  field.focus();
  const user = userEvent.setup({ delay: null });
  try {
    await user.keyboard("{Enter}");
    const choice = await screen.findByRole("option", { name: "On" });
    await user.keyboard("{Home}{ArrowDown}");
    expect(choice).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(field).toHaveAttribute("aria-busy", "true");
    });
    expect(field).toHaveAttribute("aria-readonly", "true");
    expect(field).toHaveFocus();
    save.resolve();
    await read.promise;
    expect(field).toHaveFocus();
    refresh.resolve("ok");
    await waitFor(() => {
      expect(field).toHaveTextContent(/^On$/);
      expect(field).not.toHaveAttribute("aria-busy", "true");
    });
    expect(field).toHaveFocus();
  } finally {
    if (!save.settled()) {
      save.resolve();
    }
    if (!refresh.settled()) {
      refresh.resolve("ok");
    }
  }
});
test("chat-composer-vnc-dependencies-021 A failed VNC access refresh shows the failure and withholds the SSH enable warning", async () => {
  const refresh = context.mocks.deferred<"ok" | "failed">();
  const read = context.mocks.deferred<void>();
  const dialog = await remote({
    vncDefault: false,
    refresh() {
      if (!read.settled()) {
        read.resolve();
      }
      return refresh.promise;
    },
  });
  try {
    await within(dialog).findByText(requires);
    await setChoice("VNC", "On");
    await read.promise;
    refresh.resolve("failed");
    await expect(
      within(dialog).findByText("Couldn't load remote access."),
    ).resolves.toBeVisible();
    expect(within(dialog).queryByText(enable)).toBeNull();
  } finally {
    if (!refresh.settled()) {
      refresh.resolve("ok");
    }
  }
});

test("chat-composer-vnc-dependencies-017 A direct VNC connection reports only its directory tunnel dependency", async () => {
  const dialog = await remote({ directoryTunnel: true });
  const warning = "Enable SSH: Directory tunnel";
  await within(dialog).findByText(warning);
  expect(within(dialog).queryByText("Enable SSH: MacinCloud")).toBeNull();
  const ssh = within(dialog).getByRole("combobox", {
    name: "SSH Directory tunnel",
  });
  click(ssh);
  click(await screen.findByRole("option", { name: "On" }));
  await expect(
    within(dialog).findByText("SSH enabled: Directory tunnel"),
  ).resolves.toBeVisible();
  expect(within(dialog).queryByText(warning)).toBeNull();
});
