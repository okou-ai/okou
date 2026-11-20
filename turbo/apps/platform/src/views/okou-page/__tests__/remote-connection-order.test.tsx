import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createComposerConnectorHelpers,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  sshHost,
} from "./connectors-remote-control-test-helpers.ts";

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
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

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
