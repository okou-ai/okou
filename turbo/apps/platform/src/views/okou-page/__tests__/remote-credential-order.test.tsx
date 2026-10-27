import {
  sshCredentialsContract,
  type SshCredentialResponse,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import {
  vncCredentialsContract,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  mockConnectors,
  mockPublicConnectorStatus,
} from "./connector-page-test-helpers.ts";
import {
  mockHostInventories,
  orderedNames,
  resourceId,
  sshHosts,
  timestamp,
  vncHosts,
} from "./remote-resource-order-test-helpers.ts";

const context = testContext();
const credentialNames = Object.freeze(["login-11", "login-2", "Android login"]);

function mockCredentials(): void {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  mockHostInventories(context);
  const references = [[0, 2], [1], [3, 4]];
  const ssh: SshCredentialResponse[] = credentialNames.map((name, index) => {
    return {
      id: resourceId("d", index),
      name,
      username: `operator-${index}`,
      authMethod: "password",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      hosts: references[index]!.map((hostIndex) => {
        const host = sshHosts[hostIndex]!;
        return { id: host.id, displayName: host.displayName };
      }),
    };
  });
  const vnc: VncCredentialResponse[] = ssh.map((credential, index) => {
    return {
      id: resourceId("f", index),
      name: credential.name,
      authMethod: "vnc_password",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      hosts: references[index]!.map((hostIndex) => {
        const host = vncHosts[hostIndex]!;
        return { id: host.id, displayName: host.displayName };
      }),
    };
  });
  context.mocks.api(sshCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: ssh });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: vnc });
  });
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: sshHosts.map((host, index) => {
        const credential =
          ssh[
            references.findIndex((indexes) => {
              return indexes.includes(index);
            })
          ]!;
        return {
          ...host,
          username: credential.username,
          credentialId: credential.id,
          credentialName: credential.name,
        };
      }),
    });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: vncHosts.map((host, index) => {
        const credential =
          vnc[
            references.findIndex((indexes) => {
              return indexes.includes(index);
            })
          ]!;
        return {
          ...host,
          credentialId: credential.id,
          credentialName: credential.name,
        };
      }),
    });
  });
}

test.each(["ssh", "vnc"] as const)(
  "%s credentials and their associated hosts use natural order",
  async (protocol) => {
    mockCredentials();
    await setupPage({
      context,
      path: `/connectors?scope=remote-control&remoteView=credentials&type=${protocol}`,
      featureSwitches: { [FeatureSwitchKey.RemoteControlGuidedSetup]: true },
    });
    await screen.findByRole("heading", { name: "Android login" });
    expect(
      screen.getAllByRole("article").map((card) => {
        return within(card).getByRole("heading", { level: 2 }).textContent;
      }),
    ).toStrictEqual(["Android login", "login-2", "login-11"]);
    const card = screen
      .getByRole("heading", { name: "login-11" })
      .closest("article");
    expect(card).not.toBeNull();
    expect(
      within(card!)
        .getAllByRole("listitem")
        .map((item) => {
          return item.textContent;
        }),
    ).toStrictEqual(
      protocol === "ssh"
        ? ["android", "dev-11"]
        : ["desktop-android", "desktop-dev-11"],
    );
  },
);

test.each(["ssh", "vnc"] as const)(
  "%s saved login choices sort their displayed host labels",
  async (protocol) => {
    mockCredentials();
    await setupPage({
      context,
      path: `/connectors?scope=remote-control&setup=${protocol}`,
      featureSwitches: { [FeatureSwitchKey.RemoteControlGuidedSetup]: true },
    });
    await screen.findByRole("heading", { name: "Add remote connection" });
    if (protocol === "ssh") {
      click(screen.getByText("Run commands on the device."));
      await screen.findByLabelText("SSH username");
    } else {
      click(
        screen.getByText(
          "Control the device’s screen with a mouse and keyboard.",
        ),
      );
      await screen.findByLabelText("Login method");
      click(getConnectorAction("button", "Continue"));
      await fill(
        await screen.findByLabelText("Device address"),
        "screen.example.com",
      );
      click(getConnectorAction("button", "Continue"));
      await screen.findByRole("heading", {
        name: "Enter device login information",
      });
    }
    click(getConnectorAction("button", "Choose saved login details"));
    const picker = await screen.findByRole("dialog", {
      name: "Choose saved login details",
    });
    const labels =
      protocol === "ssh"
        ? ["android, dev-11", "DEV-1, dev-1", "dev-2"]
        : [
            "desktop-android, desktop-dev-11",
            "desktop-DEV-1, desktop-dev-1",
            "desktop-dev-2",
          ];
    expect(
      within(picker)
        .getAllByText(
          /^(android, dev-11|DEV-1, dev-1|dev-2|desktop-android, desktop-dev-11|desktop-DEV-1, desktop-dev-1|desktop-dev-2)$/u,
        )
        .map((item) => {
          return item.textContent;
        }),
    ).toStrictEqual(labels);
    click(within(picker).getByText(labels[0]!));
    const selectedLogin = await screen.findByText(labels[0]!);
    const selectedDescription =
      protocol === "ssh" ? "operator-0 · Password" : "VNC password";
    expect(
      within(selectedLogin.parentElement!).getByText(selectedDescription),
    ).toBeInTheDocument();
  },
);

test("VNC jump-host choices use the same natural host order", async () => {
  mockCredentials();
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&type=vnc",
    featureSwitches: { [FeatureSwitchKey.RemoteControlGuidedSetup]: false },
  });
  await screen.findByRole("heading", { name: vncHosts[0]!.displayName });
  click(getConnectorAction("button", "Add host"));
  const dialog = await screen.findByRole("dialog", { name: "Add host" });
  click(within(dialog).getByRole("combobox", { name: "Connection route" }));
  click(await screen.findByRole("option", { name: "Through saved SSH host" }));
  click(await within(dialog).findByRole("combobox", { name: "SSH host" }));
  const list = await screen.findByRole("listbox");
  expect(
    within(list)
      .getAllByRole("option")
      .map((option) => {
        return option.textContent?.split(" · ")[0];
      }),
  ).toStrictEqual(orderedNames);
  click(within(list).getByText("dev-2 · ssh-2.example.com:22"));
  expect(
    within(dialog).getByRole("combobox", { name: "SSH host" }),
  ).toHaveTextContent("dev-2");
});
