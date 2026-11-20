import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const OWNER_SESSION_ID = "sess_owner";
const OWNER_TOKEN = "owner-token";
const PASSWORD = "sesame42";

function owner() {
  return { id: "user_owner", fullName: "Owner User" };
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

async function openVncCredentials(): Promise<void> {
  await setupPage({
    context,
    path: "/connectors?scope=remote-control&remoteView=credentials",
    auth: {
      user: owner(),
      session: { token: OWNER_TOKEN, id: OWNER_SESSION_ID },
    },
  });
  await waitFor(() => {
    expect(protocolTab("VNC")).toBeInTheDocument();
  });
  click(protocolTab("VNC"));
  await waitFor(() => {
    expect(getConnectorAction("button", "Add credential")).toBeEnabled();
  });
}

async function draftCredential(): Promise<{
  readonly dialog: HTMLElement;
  readonly name: HTMLElement;
  readonly password: HTMLElement;
}> {
  click(getConnectorAction("button", "Add credential"));
  const dialog = await screen.findByRole("dialog", { name: "Add credential" });
  const name = within(dialog).getByLabelText("Credential name");
  const password = within(dialog).getByLabelText("VNC password");
  await fill(name, "Lab desktop");
  await fill(password, PASSWORD);
  expect(password).toHaveValue(PASSWORD);
  return { dialog, name, password };
}

async function expectFreshForm(): Promise<HTMLElement> {
  click(getConnectorAction("button", "Add credential"));
  const dialog = await screen.findByRole("dialog", { name: "Add credential" });
  expect(screen.getAllByRole("dialog")).toStrictEqual([dialog]);
  expect(within(dialog).getByLabelText("Credential name")).toHaveValue("");
  expect(within(dialog).getByLabelText("VNC password")).toHaveValue("");
  return dialog;
}

test("A same-owner session replacement closes the form and cannot revive its password", async () => {
  mockRemoteInventory(context);
  await openVncCredentials();
  const draft = await draftCredential();
  const clerk = context.mocks.clerk();

  clerk.user(owner(), { token: "replacement-token", id: "sess_replacement" });
  clerk.stateChanged();

  await waitFor(() => {
    expect(draft.dialog).not.toBeInTheDocument();
  });
  expect(draft.password).toHaveValue("");

  clerk.user(owner(), { token: OWNER_TOKEN, id: OWNER_SESSION_ID });
  clerk.stateChanged();

  await expectFreshForm();
  expect(draft.name).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(PASSWORD);
});

test("Returning to an owner never revives an abandoned uncertain credential draft", async () => {
  const inventory = mockRemoteInventory(context);
  const attempt = { failedId: "", savedId: "" };
  context.mocks.api(vncCredentialsContract.create, ({ body, respond }) => {
    if (!attempt.failedId) {
      attempt.failedId = body.id;
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Internal error" },
      });
    }
    attempt.savedId = body.id;
    const created = {
      id: body.id,
      name: body.name,
      authMethod: "vnc_password" as const,
      revision: 1,
      createdAt: REMOTE_TIMESTAMP,
      updatedAt: REMOTE_TIMESTAMP,
      hosts: [],
    };
    inventory.vncCredentials = [created];
    return respond(201, created);
  });
  await openVncCredentials();
  const draft = await draftCredential();
  click(getConnectorAction("button", "Save", draft.dialog));
  await expect(
    within(draft.dialog).findByRole("alert"),
  ).resolves.toHaveTextContent("Save failed.");
  expect(getConnectorAction("button", "Save", draft.dialog)).toBeDisabled();
  const clerk = context.mocks.clerk();

  clerk.user(
    { id: "user_other", fullName: "Other User" },
    { token: "other-token", id: "sess_other" },
  );
  clerk.stateChanged();

  await waitFor(() => {
    expect(draft.dialog).not.toBeInTheDocument();
  });
  expect(draft.password).toHaveValue("");

  clerk.user(owner(), { token: OWNER_TOKEN, id: OWNER_SESSION_ID });
  clerk.stateChanged();

  const fresh = await expectFreshForm();
  expect(within(fresh).queryByRole("alert")).not.toBeInTheDocument();
  await fill(within(fresh).getByLabelText("Credential name"), "Lab desktop");
  await fill(within(fresh).getByLabelText("VNC password"), "secret99");

  click(getConnectorAction("button", "Save", fresh));

  await expect(
    screen.findByRole("heading", { name: "Lab desktop", level: 2 }),
  ).resolves.toBeInTheDocument();
  expect(fresh).not.toBeInTheDocument();
  expect(attempt.savedId).not.toBe(attempt.failedId);
});
