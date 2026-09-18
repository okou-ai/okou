import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import {
  vncCredentialsContract,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
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
