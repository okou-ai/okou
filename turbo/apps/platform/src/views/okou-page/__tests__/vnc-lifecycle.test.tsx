import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import {
  vncCredentialsContract,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const owner = Object.freeze<{ id: string; fullName: string }>({
  id: "vnc-original-owner",
  fullName: "Original Owner",
});
const credential = Object.freeze<VncCredentialResponse>({
  id: "d0000000-0000-4000-8000-000000000001",
  name: "Other owner's login",
  authMethod: "vnc_password",
  revision: 1,
  hosts: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

async function openCredential(name: string) {
  click(getAction("button", "Add credential"));
  const dialog = await screen.findByRole("dialog", { name: "Add credential" });
  await fill(within(dialog).getByLabelText("Credential name"), name);
  await fill(within(dialog).getByLabelText("VNC password"), " pwd ");
  return dialog;
}

function mockEmptySettings() {
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
}

async function credentialPage() {
  await setupPage({
    context,
    path: "/connectors/vnc",
    auth: {
      user: owner,
      session: { id: "vnc-session-original", token: "original-token" },
      organization: {
        activeOrg: { id: "org_vnc_lifecycle", name: "VNC lifecycle" },
        memberships: [{ id: "org_vnc_lifecycle" }],
      },
    },
    featureSwitches: { [FeatureSwitchKey.VncAccess]: true },
  });
  await screen.findByText("Add a VNC host to get started.");
  click(getAction("radio", "Credentials"));
  await screen.findByText("No saved VNC credentials.");
}

function replaceSession() {
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.user(owner, {
      id: "vnc-session-replacement",
      token: "replacement-token",
    });
    clerk.stateChanged();
  });
}

test("A same-owner session replacement preserves the password and focus and saves with the current session", async () => {
  mockEmptySettings();
  const requests: unknown[] = [];
  context.mocks.api(
    vncCredentialsContract.create,
    ({ body, request, respond }) => {
      requests.push({
        body,
        authorization: request.headers.get("authorization"),
      });
      return respond(201, { ...credential, id: body.id, name: body.name });
    },
  );
  await credentialPage();
  const dialog = await openCredential("Original session login");
  const secret = within(dialog).getByLabelText("VNC password");
  await userEvent.click(secret);
  replaceSession();
  const current = await screen.findByRole("dialog", { name: "Add credential" });
  expect(within(current).getByLabelText("Credential name")).toHaveValue(
    "Original session login",
  );
  expect(within(current).getByLabelText("VNC password")).toHaveValue(" pwd ");
  expect(within(current).getByLabelText("VNC password")).toHaveFocus();
  click(getAction("button", "Save", current));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    {
      body: {
        id: expect.any(String),
        name: "Original session login",
        authentication: { method: "vnc_password", password: " pwd " },
      },
      authorization: "Bearer replacement-token",
    },
  ]);
  expect(secret).toHaveValue("");
});

test("A same-owner session replacement preserves an uncertain draft for an explicit same-UUID retry", async () => {
  mockEmptySettings();
  const requests: { body: unknown; authorization: string | null }[] = [];
  let acknowledge = false;
  context.mocks.api(
    vncCredentialsContract.create,
    ({ body, request, respond }) => {
      requests.push({
        body,
        authorization: request.headers.get("authorization"),
      });
      return acknowledge
        ? respond(204)
        : respond(500, {
            error: { code: "INTERNAL_ERROR", message: "Save failed" },
          });
    },
  );
  await credentialPage();
  const dialog = await openCredential("Original session login");
  click(getAction("button", "Save", dialog));
  await within(dialog).findByText(/The save result is unknown/u);
  replaceSession();
  const current = await screen.findByRole("dialog", { name: "Add credential" });
  expect(within(current).getByLabelText("Credential name")).toHaveValue(
    "Original session login",
  );
  expect(within(current).getByLabelText("VNC password")).toHaveValue(" pwd ");
  expect(within(current).getByLabelText("VNC password")).toBeDisabled();
  expect(getAction("button", "Retry", current)).toBeEnabled();
  acknowledge = true;
  click(getAction("button", "Retry", current));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  const body = {
    id: expect.any(String),
    name: "Original session login",
    authentication: { method: "vnc_password", password: " pwd " },
  };
  expect(requests).toStrictEqual([
    { body, authorization: "Bearer original-token" },
    { body, authorization: "Bearer replacement-token" },
  ]);
  expect(requests[1]?.body).toStrictEqual(requests[0]?.body);
});

test("Returning to an owner never revives an abandoned uncertain credential draft", async () => {
  let activeOwner = owner.id;
  let initialId: string | undefined;
  let laterId: string | undefined;
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, {
      credentials: activeOwner === owner.id ? [] : [credential],
    });
  });
  context.mocks.api(vncCredentialsContract.create, ({ body, respond }) => {
    if (body.name === "Abandoned login") {
      initialId = body.id;
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Save failed" },
      });
    }
    laterId = body.id;
    return respond(201, { ...credential, id: body.id, name: body.name });
  });
  await setupPage({
    context,
    path: "/connectors/vnc",
    auth: {
      user: owner,
      organization: {
        activeOrg: { id: "org_vnc_lifecycle", name: "VNC lifecycle" },
        memberships: [{ id: "org_vnc_lifecycle" }],
      },
    },
    featureSwitches: { [FeatureSwitchKey.VncAccess]: true },
  });
  await screen.findByText("Add a VNC host to get started.");
  click(getAction("radio", "Credentials"));
  await screen.findByText("No saved VNC credentials.");
  const dialog = await openCredential("Abandoned login");
  const secret = within(dialog).getByLabelText("VNC password");
  click(getAction("button", "Save", dialog));
  await screen.findByText(/The save result is unknown/u);
  expect(getAction("button", "Retry", dialog)).toBeEnabled();

  const clerk = context.mocks.clerk();
  act(() => {
    activeOwner = "vnc-other-owner";
    clerk.user(
      { id: activeOwner, fullName: "Other Owner" },
      { token: "other-token" },
    );
    clerk.stateChanged();
  });
  await screen.findByText(credential.name);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(secret).toHaveValue("");

  act(() => {
    activeOwner = owner.id;
    clerk.user(owner, { token: "original-token" });
    clerk.stateChanged();
  });
  await screen.findByText("No saved VNC credentials.");
  expect(screen.queryByRole("dialog")).toBeNull();
  const fresh = await openCredential("Fresh login");
  expect(within(fresh).queryByText(/The save result is unknown/u)).toBeNull();
  click(getAction("button", "Save", fresh));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(initialId).toBeDefined();
  expect(laterId).toBeDefined();
  expect(laterId).not.toBe(initialId);
});
