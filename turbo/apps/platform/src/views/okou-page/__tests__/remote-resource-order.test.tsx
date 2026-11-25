import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createComposerConnectorHelpers } from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  sshHost,
} from "./connectors-remote-control-test-helpers.ts";
import type { SshCredentialResponse } from "@okouai/api-contracts/contracts/ssh-credentials";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import type { TailscaleConfig } from "@okouai/api-contracts/contracts/tailscale";

const context = testContext();

const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

// Saved in an order that differs from the natural name order.
function savedNames(): string[] {
  return ["dev-11", "android", "dev-2", "DEV-1", "dev-1"];
}

function listedHostNames(names: readonly string[]): string[] {
  return queryAllByRoleFast("listitem")
    .map((item) => {
      return item.getAttribute("aria-label") ?? "";
    })
    .filter((name) => {
      return names.includes(name);
    });
}

test("Remote host names follow the active Chinese locale", async () => {
  const names = ["上海-11", "广州-2", "北京"];
  const hosts = names.map((name, index) => {
    return sshHost(index + 1, name);
  });
  mockRemoteInventory(context, { ssh: hosts });
  context.mocks.api(
    chatRemoteAccessContract.listHostDefaults,
    ({ respond }) => {
      return respond(200, {
        ssh: hosts.map((host) => {
          return {
            connectionId: host.id,
            displayName: host.displayName,
            defaultEnabled: true,
          };
        }),
        vnc: [],
      });
    },
  );

  await setupPage({
    context,
    path: "/connectors?scope=remote-control",
    locale: "zh-Hans",
  });

  await expect(
    screen.findByRole("listitem", { name: "北京" }),
  ).resolves.toBeInTheDocument();
  expect(listedHostNames(names)).toStrictEqual(["北京", "广州-2", "上海-11"]);
});

test("A chat keeps remote choices in natural name order across access states with existing thread false", async () => {
  installComposerConnectorFixture();
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: savedNames().map((name, index) => {
        return {
          id: `computer-${index + 1}`,
          hostName: `${name}.local`,
          displayName: name,
          lastSeenAt: REMOTE_TIMESTAMP,
          status: "online" as const,
        };
      }),
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: savedNames().map((name, index) => {
        return {
          connectionId: remoteId("b", index + 1),
          displayName: name,
          defaultEnabled: name === "dev-11",
        };
      }),
      vncHosts: savedNames().map((name, index) => {
        return {
          connectionId: remoteId("e", index + 1),
          displayName: `desktop-${name}`,
          defaultEnabled: false,
        };
      }),
    });
  });
  await setupPage({ context, path: "/" });

  click(await findFastControl("button", "Connectors"));

  const natural = ["android", "DEV-1", "dev-1", "dev-2", "dev-11"];
  const popover = await screen.findByRole("dialog", { name: "Connectors" });
  await expect(
    within(popover).findByRole("switch", { name: "dev-11" }),
  ).resolves.toBeInTheDocument();
  expect(
    within(popover)
      .getAllByRole("switch")
      .map((control) => {
        return control.closest("label")?.textContent?.trim();
      })
      .filter((name) => {
        return name !== undefined && natural.includes(name);
      }),
  ).toStrictEqual(natural);

  click(await findFastControl("button", /^Remote access/));

  const dialog = await screen.findByRole("dialog", { name: "Remote access" });
  const connections = within(dialog).getByRole("list", { name: "Connections" });
  expect(
    within(connections)
      .getAllByRole("combobox")
      .map((choice) => {
        return choice.getAttribute("aria-label");
      }),
  ).toStrictEqual([
    ...natural.map((name) => {
      return `SSH ${name}`;
    }),
    ...natural.map((name) => {
      return `VNC desktop-${name}`;
    }),
  ]);
  expect(
    within(dialog).getByRole("combobox", { name: "SSH dev-11" }),
  ).toHaveTextContent("Default (On)");
  expect(
    within(dialog).getByRole("combobox", { name: "SSH dev-2" }),
  ).toHaveTextContent("Default (Off)");
});

function sshLogin(
  index: number,
  name: string,
  hostNames: readonly string[],
): SshCredentialResponse {
  return {
    id: remoteId("d", index),
    name,
    username: `operator-${index}`,
    authMethod: "password",
    revision: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    // Host IDs run opposite to the natural name order.
    hosts: hostNames.map((displayName, position) => {
      return {
        id: remoteId("b", index * 10 + hostNames.length - position),
        displayName,
      };
    }),
  };
}

function setupChoice(title: string): HTMLElement {
  const choice = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim().startsWith(title);
  });
  if (!choice) {
    throw new Error(`Expected the ${title} setup choice`);
  }
  return choice;
}

test("ssh credentials and their associated hosts use natural order", async () => {
  mockRemoteInventory(context, {
    sshCredentials: [
      sshLogin(1, "login-11", ["dev-11", "android"]),
      sshLogin(2, "Android login", []),
      sshLogin(3, "login-2", ["dev-2"]),
    ],
  });

  await setupPage({
    context,
    path: "/connectors?scope=remote-control&remoteView=credentials",
  });

  await expect(
    screen.findByRole("heading", { name: "login-11", level: 2 }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((heading) => {
      return heading.textContent;
    }),
  ).toStrictEqual(["Android login", "login-2", "login-11"]);
  const card = screen
    .getByRole("heading", { name: "login-11", level: 2 })
    .closest("article");
  if (!card) {
    throw new Error("Expected the login-11 credential card");
  }
  expect(
    queryAllByRoleFast("listitem", card).map((item) => {
      return item.textContent;
    }),
  ).toStrictEqual(["android", "dev-11"]);
});

test("ssh saved login choices sort their displayed host labels", async () => {
  mockRemoteInventory(context, {
    sshCredentials: [
      sshLogin(3, "Single host", ["dev-2"]),
      sshLogin(2, "Mixed case", ["dev-1", "DEV-1"]),
      sshLogin(0, "Shared", ["dev-11", "android"]),
    ],
  });
  await setupPage({ context, path: "/connectors?scope=remote-control" });
  await waitFor(() => {
    expect(getConnectorAction("button", "Add connection")).toBeEnabled();
  });
  click(getConnectorAction("button", "Add connection"));
  await waitFor(() => {
    expect(setupChoice("SSH")).toBeEnabled();
  });
  click(setupChoice("SSH"));
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Choose saved login details"),
    ).toBeEnabled();
  });

  click(getConnectorAction("button", "Choose saved login details"));

  const chooser = await screen.findByRole("dialog", {
    name: "Choose saved login details",
  });
  const labels = [
    ["android, dev-11", "operator-0 · Password"],
    ["DEV-1, dev-1", "operator-2 · Password"],
    ["dev-2", "operator-3 · Password"],
  ];
  expect(
    queryAllByRoleFast("button", chooser)
      .map((choice) => {
        return choice.textContent?.trim();
      })
      .filter((text) => {
        return text !== "";
      }),
  ).toStrictEqual(
    labels.map(([label, description]) => {
      return `${label}${description}`;
    }),
  );

  click(within(chooser).getByText("android, dev-11"));

  await waitFor(() => {
    expect(chooser).not.toBeInTheDocument();
  });
  expect(screen.getByText("android, dev-11")).toBeInTheDocument();
  expect(screen.getByText("operator-0 · Password")).toBeInTheDocument();
});

function naturalNames(): string[] {
  return ["android", "DEV-1", "dev-1", "dev-2", "dev-11"];
}

function tailnet(
  index: number,
  name: string,
  overrides: Partial<TailscaleConfig> = {},
): TailscaleConfig {
  return {
    id: remoteId("a", index),
    name,
    scope: "personal",
    tags: ["tag:okou"],
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
    ...overrides,
  };
}

function managedNetworks(section: HTMLElement): string[] {
  return queryAllByRoleFast("link", section).flatMap((link) => {
    const label = link.getAttribute("aria-label") ?? "";
    return label.startsWith("Manage ") ? [label.slice("Manage ".length)] : [];
  });
}

test("Private networks are sorted within their scope", async () => {
  mockRemoteInventory(context, {
    tailscale: [
      tailnet(1, "Network-11"),
      tailnet(2, "Org-11", { scope: "organization" }),
      tailnet(3, "Network-2"),
      tailnet(4, "Android network"),
      tailnet(5, "Org-2", { scope: "organization" }),
      tailnet(6, "Network-1"),
    ],
  });

  await setupPage({ context, path: "/connectors?scope=private-network" });

  const personal = await screen.findByRole("region", {
    name: "Personal networks",
  });
  expect(managedNetworks(personal)).toStrictEqual([
    "Android network",
    "Network-1",
    "Network-2",
    "Network-11",
  ]);
  expect(
    managedNetworks(
      screen.getByRole("region", { name: "Organization networks" }),
    ),
  ).toStrictEqual(["Org-2", "Org-11"]);
});

test("A tailscale network shows linked hosts in natural order", async () => {
  // Linked hosts arrive in saved order, not natural name order.
  const saved = ["dev-11", "android", "dev-2", "DEV-1", "dev-1"];
  mockRemoteInventory(context, {
    tailscale: [
      tailnet(1, "Home tailnet", {
        sshHosts: saved.map((displayName, index) => {
          return { id: remoteId("b", index + 1), displayName };
        }),
        vncHosts: saved.map((name, index) => {
          return {
            id: remoteId("e", index + 1),
            displayName: `desktop-${name}`,
            roles: ["rfb" as const],
          };
        }),
      }),
    ],
  });
  await setupPage({ context, path: "/connectors?scope=private-network" });
  await waitFor(() => {
    expect(
      getConnectorAction("link", "Manage Home tailnet"),
    ).toBeInTheDocument();
  });

  click(getConnectorAction("link", "Manage Home tailnet"));

  const usage = await screen.findByRole("heading", {
    name: "Connections using this network",
  });
  const section = usage.parentElement;
  if (!section) {
    throw new Error("Expected the network usage section");
  }
  expect(
    queryAllByRoleFast("listitem", section).map((item) => {
      return item.textContent;
    }),
  ).toStrictEqual([
    ...naturalNames(),
    ...naturalNames().map((name) => {
      return `desktop-${name}`;
    }),
  ]);
});
