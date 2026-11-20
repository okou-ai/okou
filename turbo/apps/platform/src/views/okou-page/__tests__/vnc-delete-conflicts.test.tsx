import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import {
  vncCredentialsContract,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
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
  vncHost,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();

function desktopLogin(revision: number): VncCredentialResponse {
  return {
    id: remoteId("f", 1),
    name: "Desktop login",
    authMethod: "vnc_password",
    revision,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    hosts: [],
  };
}

function protocolTab(name: string): HTMLElement {
  const tab = queryAllByRoleFast("radio").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`Expected the ${name} credentials tab`);
  }
  return tab;
}

async function confirmIn(dialogName: string): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name: dialogName });
  click(getConnectorAction("button", dialogName, dialog));
  return dialog;
}

test("A stale VNC host generation blocks deletion", async () => {
  const desktop = vncHost(1, "Studio desktop", { generation: 4 });
  const inventory = mockRemoteInventory(context, { vnc: [desktop] });
  const deletion: { expectedGeneration?: number } = {};
  context.mocks.api(vncConnectionsContract.delete, ({ body, respond }) => {
    deletion.expectedGeneration = body.expectedGeneration;
    // Another editor already saved generation 5.
    inventory.vnc = [{ ...desktop, generation: 5 }];
    return respond(409, {
      error: {
        code: VNC_ERROR_CODES.GENERATION_CONFLICT,
        message: "VNC connection was modified by another request",
      },
    });
  });
  await setupPage({
    context,
    path: `/connectors?scope=remote-control&remoteResource=vnc:${desktop.id}`,
  });
  await waitFor(() => {
    expect(getConnectorAction("button", "Delete connection")).toBeEnabled();
  });
  click(getConnectorAction("button", "Delete connection"));

  const dialog = await confirmIn("Delete connection");

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "This host changed since you opened it.",
  );
  expect(
    getConnectorAction("button", "Delete connection", dialog),
  ).toBeDisabled();
  expect(deletion.expectedGeneration).toBe(4);
});

test("A VNC credential deletion rejected with VNC_CREDENTIAL_REVISION_CONFLICT remains blocked", async () => {
  const inventory = mockRemoteInventory(context, {
    vncCredentials: [desktopLogin(3)],
  });
  const deletion: { expectedRevision?: number } = {};
  context.mocks.api(vncCredentialsContract.delete, ({ body, respond }) => {
    deletion.expectedRevision = body.expectedRevision;
    inventory.vncCredentials = [desktopLogin(4)];
    return respond(409, {
      error: {
        code: VNC_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT,
        message: "VNC credential was modified by another request",
      },
    });
  });
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&remoteView=credentials",
  });
  await waitFor(() => {
    expect(protocolTab("VNC")).toBeInTheDocument();
  });
  click(protocolTab("VNC"));
  await waitFor(() => {
    expect(getConnectorAction("button", "Delete credential")).toBeEnabled();
  });
  click(getConnectorAction("button", "Delete credential"));

  const dialog = await confirmIn("Delete credential");

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "This credential changed since you opened it.",
  );
  expect(
    getConnectorAction("button", "Delete credential", dialog),
  ).toBeDisabled();
  expect(deletion.expectedRevision).toBe(3);
});
