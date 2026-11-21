import type { SshCredentialResponse } from "@okouai/api-contracts/contracts/ssh-credentials";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();

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
