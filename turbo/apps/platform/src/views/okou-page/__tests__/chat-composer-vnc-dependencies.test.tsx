import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import {
  chatRemoteAccessContract,
  type ThreadRemoteHostAccess,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  vncConnectionsContract,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  SCOUT_AGENT_ID,
  SCOUT_THREAD_ID,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

const SSH_ID = "b0000000-0000-4000-8000-000000000031";
const OTHER_SSH_ID = "b0000000-0000-4000-8000-000000000032";
const KDC_SSH_ID = "b0000000-0000-4000-8000-000000000033";
const VNC_ID = "b0000000-0000-4000-8000-000000000034";
const SSH_WARNING = "Enable SSH: MacinCloud";
const KDC_WARNING = "Enable SSH: Directory tunnel";
const SSH_NOTE = "Requires SSH: MacinCloud";
const SSH_ENABLED_NOTE = "SSH enabled: MacinCloud";

function installDependencyFixture({
  newChat = false,
  sshDefaultEnabled = false,
  sshOverrideEnabled,
  vncDefaultEnabled = true,
  transportSshId = SSH_ID,
  kdcSshId,
  configurationReady,
  failAccessAfterVncEnabled = false,
  failConfigurationOnce = false,
  saveReady,
  refreshReady,
  failSave = false,
}: {
  newChat?: boolean;
  sshDefaultEnabled?: boolean;
  sshOverrideEnabled?: boolean;
  vncDefaultEnabled?: boolean;
  transportSshId?: string | null;
  kdcSshId?: string;
  configurationReady?: Promise<void>;
  failAccessAfterVncEnabled?: boolean;
  failConfigurationOnce?: boolean;
  saveReady?: Promise<void>;
  refreshReady?: Promise<void>;
  failSave?: boolean;
} = {}) {
  installComposerConnectorFixture(newChat ? {} : { threadId: SCOUT_THREAD_ID });
  const settings = [
    {
      connectionId: SSH_ID,
      displayName: "MacinCloud",
      defaultEnabled: sshDefaultEnabled,
    },
    {
      connectionId: OTHER_SSH_ID,
      displayName: "Other tunnel",
      defaultEnabled: false,
    },
    {
      connectionId: KDC_SSH_ID,
      displayName: "Directory tunnel",
      defaultEnabled: false,
    },
    {
      connectionId: VNC_ID,
      displayName: "MacinCloud",
      defaultEnabled: vncDefaultEnabled,
    },
  ];
  const overrides = new Map<string, boolean>();
  if (sshOverrideEnabled !== undefined) {
    overrides.set(SSH_ID, sshOverrideEnabled);
  }
  const access = (connectionId: string): ThreadRemoteHostAccess => {
    const setting = settings.find((item) => {
      return item.connectionId === connectionId;
    });
    if (!setting) {
      throw new Error(`Unexpected remote host ${connectionId}`);
    }
    const overrideEnabled = overrides.get(connectionId) ?? null;
    return {
      ...setting,
      overrideEnabled,
      enabled: overrideEnabled ?? setting.defaultEnabled,
      source: overrideEnabled === null ? "default" : "override",
    };
  };
  const sshIds = [SSH_ID, OTHER_SSH_ID, KDC_SSH_ID];
  let failAccessRead = false;
  let saved = false;
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: settings.filter((item) => {
        return item.connectionId !== VNC_ID;
      }),
      vncHosts: settings.filter((item) => {
        return item.connectionId === VNC_ID;
      }),
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    async ({ respond }) => {
      if (saved) {
        await refreshReady;
      }
      if (failAccessRead) {
        return respond(500, {
          error: {
            code: "INTERNAL_ERROR",
            message: "Remote access unavailable",
          },
        });
      }
      return respond(200, { ssh: sshIds.map(access), vnc: [access(VNC_ID)] });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.setThreadOverride,
    async ({ params, body, respond }) => {
      await saveReady;
      if (failSave) {
        return respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Save failed" },
        });
      }
      overrides.set(params.connectionId, body.enabled);
      saved = true;
      if (
        failAccessAfterVncEnabled &&
        params.protocol === "vnc" &&
        body.enabled
      ) {
        failAccessRead = true;
      }
      return respond(200, access(params.connectionId));
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.clearThreadOverride,
    ({ params, respond }) => {
      overrides.delete(params.connectionId);
      return respond(200, access(params.connectionId));
    },
  );
  const connection: VncConnectionResponse = {
    id: VNC_ID,
    displayName: "MacinCloud",
    host: "desktop.example.com",
    port: 5900,
    credentialId: "b0000000-0000-4000-8000-000000000035",
    credentialName: "Desktop login",
    generation: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(transportSshId
      ? { transport: { type: "ssh" as const, connectionId: transportSshId } }
      : {}),
    ...(kdcSshId
      ? { kerberosAuthentication: "qemu_kerberos_password" as const }
      : {}),
    security: kdcSshId
      ? {
          type: "qemu_x509_gssapi",
          trust: { mode: "system" },
          service: {
            realm: "EXAMPLE.COM",
            components: ["vnc", "desktop.example.com"],
          },
          kdc: {
            host: "127.0.0.1",
            port: 88,
            transport: { type: "ssh", connectionId: kdcSshId },
            ticketLifetimeSeconds: 1200,
            renewableLifetimeSeconds: 7200,
          },
        }
      : { type: "x509_vnc", trust: { mode: "system" } },
  };
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 1 });
  });
  context.mocks.api(vncConnectionsContract.list, async ({ respond }) => {
    await configurationReady;
    if (failConfigurationOnce) {
      failConfigurationOnce = false;
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Configuration unavailable" },
      });
    }
    return respond(200, { connections: [connection] });
  });
}

async function openRemoteAccess(newChat = false) {
  await setupPage({
    context,
    path: newChat
      ? `/agents/${SCOUT_AGENT_ID}/chat`
      : `/chats/${SCOUT_THREAD_ID}`,
  });
  click(await findFastControl("button", "Connectors"));
  click(await screen.findByText("Remote access"));
  const menu = await screen.findByRole("dialog", { name: "Remote access" });
  await within(menu).findByRole("combobox", { name: "VNC MacinCloud" });
  return menu;
}

async function chooseHost(name: string, option: string) {
  click(screen.getByRole("combobox", { name }));
  click(await screen.findByRole("option", { name: option }));
}

test.each([
  {
    protocol: "SSH",
    name: "SSH MacinCloud",
    option: "On",
    keys: "{ArrowDown}{Enter}",
    dependency: SSH_ENABLED_NOTE,
  },
  {
    protocol: "VNC",
    name: "VNC MacinCloud",
    option: "Off",
    keys: "{End}{Enter}",
    dependency: SSH_NOTE,
  },
])(
  "New-chat $protocol choices preserve row order, keyboard focus and VNC dependency feedback",
  async ({ name, option, keys, dependency }) => {
    installDependencyFixture({ newChat: true });
    const menu = await openRemoteAccess(true);
    await within(menu).findByText(SSH_WARNING);
    const originalOrder = within(menu)
      .getAllByRole("combobox")
      .map((control) => {
        return control.getAttribute("aria-label");
      });
    const user = userEvent.setup({ delay: null });
    within(menu).getByRole("combobox", { name }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: option });
    await user.keyboard(keys);
    await within(menu).findByText(dependency);
    await waitFor(() => {
      const control = within(menu).getByRole("combobox", { name });
      expect(control).toHaveTextContent(option);
      expect(control).toHaveFocus();
    });
    expect(
      within(menu)
        .getAllByRole("combobox")
        .map((control) => {
          return control.getAttribute("aria-label");
        }),
    ).toStrictEqual(originalOrder);
  },
);

test.each([
  {
    protocol: "SSH",
    defaultEnabled: true,
    option: "On",
    keys: "{ArrowDown}{Enter}",
  },
  {
    protocol: "SSH",
    defaultEnabled: false,
    option: "On",
    keys: "{ArrowDown}{Enter}",
  },
  {
    protocol: "VNC",
    defaultEnabled: true,
    option: "On",
    keys: "{ArrowDown}{Enter}",
  },
  {
    protocol: "VNC",
    defaultEnabled: true,
    option: "Off",
    keys: "{End}{Enter}",
  },
])(
  "Saved-chat $protocol keeps keyboard focus through a slow $option save from default $defaultEnabled",
  async ({ protocol, defaultEnabled, option, keys }) => {
    const save = context.mocks.deferred<void>();
    const refresh = context.mocks.deferred<void>();
    installDependencyFixture({
      sshDefaultEnabled: protocol === "SSH" ? defaultEnabled : false,
      vncDefaultEnabled: protocol === "VNC" ? defaultEnabled : true,
      saveReady: save.promise,
      refreshReady: refresh.promise,
    });
    const menu = await openRemoteAccess();
    const name = `${protocol} MacinCloud`;
    const control = within(menu).getByRole("combobox", { name });
    const user = userEvent.setup({ delay: null });
    control.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: option });
    await user.keyboard(keys);
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(control).toHaveFocus();
    });
    expect(control).toHaveAttribute("aria-readonly", "true");
    expect(control).toHaveAttribute("aria-busy", "true");
    await user.keyboard("{Enter}{End}{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();

    save.resolve();
    expect(control).toHaveAttribute("aria-busy", "true");
    expect(control).toHaveFocus();
    refresh.resolve();
    await waitFor(() => {
      const savedControl = within(menu).getByRole("combobox", { name });
      expect(savedControl.textContent?.trim()).toBe(option);
      expect(savedControl).toHaveFocus();
    });
  },
);

test.each([false, true])(
  "A completed save preserves the user's new keyboard destination (failure: %s)",
  async (failSave) => {
    const save = context.mocks.deferred<void>();
    installDependencyFixture({
      sshDefaultEnabled: true,
      saveReady: save.promise,
      failSave,
    });
    const menu = await openRemoteAccess();
    const control = within(menu).getByRole("combobox", {
      name: "SSH MacinCloud",
    });
    const user = userEvent.setup({ delay: null });
    control.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "On" });
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => {
      expect(control).toHaveFocus();
    });
    await user.keyboard("{Tab}");
    const destination = within(menu).getByRole("combobox", {
      name: "SSH Other tunnel",
    });
    expect(destination).toHaveFocus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
    save.resolve();
    await waitFor(() => {
      expect(control).not.toHaveAttribute("aria-busy", "true");
      expect(control).toHaveTextContent(failSave ? "Default (On)" : /^On$/);
    });
    expect(destination).toHaveFocus();
    if (failSave) {
      await within(menu).findByText(
        "Couldn't confirm whether your change was saved. Reload permissions before making another change.",
      );
      click(await findFastControl("button", "Reload", menu));
    }
    await waitFor(() => {
      expect(destination).not.toHaveAttribute("aria-readonly", "true");
    });
    await chooseHost("SSH Other tunnel", "On");
    await waitFor(() => {
      expect(destination).not.toHaveAttribute("aria-busy", "true");
      expect(destination).toHaveTextContent(
        failSave ? "Default (Off)" : /^On$/,
      );
    });
  },
);

test("Dismissing Remote access during a save retains the connector trigger focus", async () => {
  const save = context.mocks.deferred<void>();
  const refresh = context.mocks.deferred<void>();
  installDependencyFixture({
    sshDefaultEnabled: true,
    saveReady: save.promise,
    refreshReady: refresh.promise,
  });
  const menu = await openRemoteAccess();
  const control = within(menu).getByRole("combobox", {
    name: "SSH MacinCloud",
  });
  await chooseHost("SSH MacinCloud", "On");
  await waitFor(() => {
    expect(control).toHaveFocus();
  });
  click(await findFastControl("button", "Close", menu));
  const trigger = await findFastControl("button", "Connectors");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Remote access" })).toBeNull();
  });
  save.resolve();
  refresh.resolve();
  click(trigger);
  const entry = await screen.findByText("Remote access");
  click(entry);
  const reopened = await screen.findByRole("combobox", {
    name: "SSH MacinCloud",
  });
  await waitFor(() => {
    expect(reopened).toHaveTextContent(/^On$/);
  });
  click(
    await findFastControl(
      "button",
      "Close",
      screen.getByRole("dialog", { name: "Remote access" }),
    ),
  );
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
});

test("An unrelated SSH host does not satisfy an enabled VNC host's dependency", async () => {
  installDependencyFixture();
  const menu = await openRemoteAccess();
  const warning = await within(menu).findByText(SSH_WARNING);
  expect(warning.closest('[role="status"]')).toBeInTheDocument();

  await chooseHost("SSH Other tunnel", "On");
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "SSH Other tunnel" }),
    ).toHaveTextContent("On");
    expect(within(menu).getByText(SSH_WARNING)).toBeInTheDocument();
  });
});

test("An enabled VNC host follows its exact SSH dependency", async () => {
  installDependencyFixture();
  const menu = await openRemoteAccess();
  await within(menu).findByText(SSH_WARNING);
  await chooseHost("SSH MacinCloud", "On");
  await expect(
    within(menu).findByText(SSH_ENABLED_NOTE),
  ).resolves.toBeInTheDocument();
  expect(within(menu).queryByText(SSH_WARNING)).toBeNull();

  await chooseHost("SSH MacinCloud", "Off");
  await expect(
    within(menu).findByText(SSH_WARNING),
  ).resolves.toBeInTheDocument();
});

test("A disabled VNC host shows its SSH dependency without a warning", async () => {
  installDependencyFixture();
  const menu = await openRemoteAccess();
  await within(menu).findByText(SSH_WARNING);
  await chooseHost("VNC MacinCloud", "Off");
  await expect(within(menu).findByText(SSH_NOTE)).resolves.toBeInTheDocument();
  expect(within(menu).queryByText(SSH_WARNING)).toBeNull();
});

test.each([
  { defaultEnabled: true, overrideEnabled: false, warningExpected: true },
  { defaultEnabled: false, overrideEnabled: true, warningExpected: false },
])(
  "VNC dependency feedback follows the chat override over default $defaultEnabled",
  async ({ defaultEnabled, overrideEnabled, warningExpected }) => {
    installDependencyFixture({
      sshDefaultEnabled: defaultEnabled,
      sshOverrideEnabled: overrideEnabled,
    });
    const menu = await openRemoteAccess();
    await expect(
      within(menu).findByText(warningExpected ? SSH_WARNING : SSH_ENABLED_NOTE),
    ).resolves.toBeInTheDocument();
    expect(within(menu).queryAllByText(SSH_WARNING)).toHaveLength(
      Number(warningExpected),
    );
    await chooseHost(
      "SSH MacinCloud",
      defaultEnabled ? "Default (On)" : "Default (Off)",
    );
    await expect(
      within(menu).findByText(warningExpected ? SSH_ENABLED_NOTE : SSH_WARNING),
    ).resolves.toBeInTheDocument();
  },
);

test("A new chat updates VNC warnings from unsent host choices", async () => {
  installDependencyFixture({
    newChat: true,
    vncDefaultEnabled: false,
    sshDefaultEnabled: true,
  });
  const menu = await openRemoteAccess(true);
  await expect(
    within(menu).findByText(SSH_ENABLED_NOTE),
  ).resolves.toBeInTheDocument();
  await chooseHost("SSH MacinCloud", "Off");
  await expect(within(menu).findByText(SSH_NOTE)).resolves.toBeInTheDocument();
  expect(within(menu).queryByText(SSH_ENABLED_NOTE)).toBeNull();
  await chooseHost("VNC MacinCloud", "On");
  await expect(
    within(menu).findByText(SSH_WARNING),
  ).resolves.toBeInTheDocument();
  await chooseHost("SSH MacinCloud", "Default (On)");
  await expect(
    within(menu).findByText(SSH_ENABLED_NOTE),
  ).resolves.toBeInTheDocument();
  expect(within(menu).queryByText(SSH_WARNING)).toBeNull();
});

test("VNC reports its transport and KDC SSH dependencies independently", async () => {
  installDependencyFixture({ kdcSshId: KDC_SSH_ID });
  const menu = await openRemoteAccess();
  await expect(
    within(menu).findByText(KDC_WARNING),
  ).resolves.toBeInTheDocument();
  expect(within(menu).getByText(SSH_WARNING)).toBeInTheDocument();
  click(
    await findFastControl("button", "Enable SSH MacinCloud in this chat", menu),
  );
  await expect(
    within(menu).findByText(SSH_ENABLED_NOTE),
  ).resolves.toBeInTheDocument();
  expect(within(menu).getByText(KDC_WARNING)).toBeInTheDocument();
  click(
    await findFastControl(
      "button",
      "Enable SSH Directory tunnel in this chat",
      menu,
    ),
  );
  await expect(
    within(menu).findByText("SSH enabled: Directory tunnel"),
  ).resolves.toBeInTheDocument();
  expect(within(menu).queryByText(KDC_WARNING)).toBeNull();
});

test("Direct VNC transport still explains an SSH-backed KDC dependency", async () => {
  installDependencyFixture({ transportSshId: null, kdcSshId: KDC_SSH_ID });
  const menu = await openRemoteAccess();
  await expect(
    within(menu).findByText(KDC_WARNING),
  ).resolves.toBeInTheDocument();
  expect(within(menu).queryByText(SSH_WARNING)).toBeNull();
  await chooseHost("SSH Directory tunnel", "On");
  await expect(
    within(menu).findByText("SSH enabled: Directory tunnel"),
  ).resolves.toBeInTheDocument();
  expect(within(menu).queryByText(KDC_WARNING)).toBeNull();
});

test("The same SSH host used for VNC and KDC is explained only once", async () => {
  installDependencyFixture({ kdcSshId: SSH_ID });
  const menu = await openRemoteAccess();
  await within(menu).findByText(SSH_WARNING);
  expect(within(menu).getAllByText(SSH_WARNING)).toHaveLength(1);
});

test("A failed VNC configuration read leaves SSH choices available and can be reloaded", async () => {
  installDependencyFixture({ failConfigurationOnce: true });
  await setupPage({ context, path: `/chats/${SCOUT_THREAD_ID}` });
  click(await findFastControl("button", "Connectors"));
  click(await screen.findByText("Remote access"));
  const menu = await screen.findByRole("dialog", { name: "Remote access" });
  await within(menu).findByText("Could not load VNC configuration.");
  const ssh = within(menu).getByRole("combobox", { name: "SSH Other tunnel" });
  await chooseHost("SSH Other tunnel", "On");
  await waitFor(() => {
    expect(ssh).toHaveTextContent("On");
    expect(ssh).not.toHaveAttribute("aria-readonly", "true");
  });
  click(await findFastControl("button", "Reload", menu));
  await within(menu).findByText(SSH_WARNING);
  const control = within(menu).getByRole("combobox", {
    name: "VNC MacinCloud",
  });
  await waitFor(() => {
    expect(control).not.toHaveAttribute("aria-readonly", "true");
  });
});

test("Pending VNC configuration is not interpreted as disabled SSH access", async () => {
  const ready = createDeferredPromise<void>(context.signal);
  installDependencyFixture({ configurationReady: ready.promise });
  const menu = await openRemoteAccess();
  expect(within(menu).queryByText(SSH_WARNING)).toBeNull();
  ready.resolve(undefined);
  await expect(
    within(menu).findByText(SSH_WARNING),
  ).resolves.toBeInTheDocument();
});

test("A failed access refresh reports its error without claiming dependency status", async () => {
  installDependencyFixture({
    vncDefaultEnabled: false,
    failAccessAfterVncEnabled: true,
  });
  const menu = await openRemoteAccess();
  await within(menu).findByText(SSH_NOTE);
  await chooseHost("VNC MacinCloud", "On");
  await expect(
    within(menu).findByText("Couldn't load remote access."),
  ).resolves.toBeInTheDocument();
  expect(within(menu).queryByText(SSH_WARNING)).toBeNull();
});
