import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createComposerConnectorHelpers } from "./chat-composer-connectors-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
  vncHost,
} from "./connectors-remote-control-test-helpers.ts";
import {
  vncCredentialsContract,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";

const context = testContext();

const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

test("Chat VNC setup appears and filters", async () => {
  installComposerConnectorFixture();
  // No SSH or VNC connections are configured yet.
  mockRemoteInventory(context);
  await setupPage({ context, path: "/" });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", "Add connectors"));
  const search = await screen.findByPlaceholderText("Find connectors...");
  const catalog = search.closest<HTMLElement>('[role="dialog"]');
  if (!catalog) {
    throw new Error("Expected the connector catalog dialog");
  }
  await expect(
    findFastControl("link", "Manage SSH hosts", catalog),
  ).resolves.toBeInTheDocument();

  await fill(search, "vnc");

  // Filtering drops the SSH entry while the VNC entry stays.
  await waitFor(() => {
    expect(
      queryFastControl("link", "Manage SSH hosts", catalog),
    ).not.toBeInTheDocument();
  });
  expect(queryFastControl("link", "Manage VNC", catalog)).toHaveAttribute(
    "href",
    "/connectors?scope=remote-control&type=vnc",
  );
});

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
