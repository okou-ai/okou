import {
  cloudflareAccessContract,
  type CloudflareAccessImpactPreview,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { CLOUDFLARE_ACCESS_ERROR_CODES } from "@okouai/api-contracts/contracts/cloudflare-access-errors";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  queryConnectorAction,
} from "./connector-page-test-helpers.ts";
import {
  mockRemoteInventory,
  REMOTE_TIMESTAMP,
  remoteId,
} from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const SECRET = "cf-access-secret-5521";
const PROVIDER_DETAIL = "zero trust policy 88e1 rejected service token";

function teamGateway(): ScopedCloudflareAccessConfig {
  return {
    id: remoteId("c", 2),
    name: "Team gateway",
    scope: "organization",
    revision: 1,
    generation: 1,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}

function impact(): CloudflareAccessImpactPreview {
  return {
    expectedRevision: 1,
    ownHostCount: 0,
    otherHostCount: 1,
    affectedOwners: [{ userId: "user_morgan", displayName: "Morgan Lee" }],
    impactSnapshot: "d".repeat(64),
  };
}

function choiceButton(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Expected the "${text}" choice`);
  }
  return button;
}

function onlyMe(): HTMLElement {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => {
      return candidate.textContent?.trim().startsWith("Only me");
    },
  );
  const radio = owner && queryAllByRoleFast("radio", owner)[0];
  if (!radio) {
    throw new Error("Expected the Only me scope");
  }
  return radio;
}

async function openPrivateNetworks(): Promise<void> {
  await setupPage({ context, path: "/connectors?scope=private-network" });
  await waitFor(() => {
    expect(getConnectorAction("button", "Add network")).toBeEnabled();
  });
}

async function startAccessDraft(): Promise<HTMLElement> {
  click(getConnectorAction("button", "Add network"));
  await waitFor(() => {
    expect(
      choiceButton("Cloudflare AccessAccess devices with Cloudflare Access"),
    ).toBeEnabled();
  });
  click(choiceButton("Cloudflare AccessAccess devices with Cloudflare Access"));
  const guide = await screen.findByRole("dialog", {
    name: "Create a Service Token",
  });
  click(getConnectorAction("button", "Enter existing credentials", guide));
  await expect(
    screen.findByRole("heading", { name: "Add a Cloudflare Access network" }),
  ).resolves.toBeInTheDocument();
  await fill(screen.getByLabelText("Network name"), "Office apps");
  await fill(screen.getByLabelText("Client ID"), "client-7781.access");
  const secret = screen.getByLabelText("Client Secret");
  await fill(secret, SECRET);
  return secret;
}

async function openTeamGateway(): Promise<void> {
  await openPrivateNetworks();
  click(getConnectorAction("link", "Manage Team gateway"));
  await expect(
    screen.findByRole("heading", { name: "Team gateway", level: 2 }),
  ).resolves.toBeInTheDocument();
}

async function editTeamGateway(): Promise<void> {
  await openTeamGateway();
  click(getConnectorAction("button", "Edit settings"));
  await expect(
    screen.findByRole("heading", { name: "Edit Cloudflare Access" }),
  ).resolves.toBeInTheDocument();
}

async function requestPersonalScope(): Promise<HTMLElement> {
  const user = userEvent.setup({ delay: null });
  await user.click(onlyMe());
  click(getConnectorAction("button", "Save network"));
  return await screen.findByRole("dialog", {
    name: "Make this network available only to you?",
  });
}

test("Switching organizations navigates away from an open shared Access editor", async () => {
  mockRemoteInventory(context, { cloudflare: [teamGateway()] });
  await editTeamGateway();
  const name = screen.getByLabelText("Network name");
  const clerk = context.mocks.clerk();

  clerk.organization({
    activeOrg: { id: "org_second", name: "Second workspace" },
    memberships: [{ id: "org_default" }, { id: "org_second" }],
  });
  clerk.stateChanged();

  await waitFor(() => {
    expect(location.pathname).toBe("/");
  });
  expect(name).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Edit Cloudflare Access" }),
  ).not.toBeInTheDocument();
});

test("An unconfirmed Access creation preserves its frozen credentials", async () => {
  mockRemoteInventory(context);
  context.mocks.api(cloudflareAccessContract.create, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: PROVIDER_DETAIL },
    });
  });
  await openPrivateNetworks();
  const secret = await startAccessDraft();

  click(getConnectorAction("button", "Save network"));

  await expect(screen.findByText("Save failed.")).resolves.toBeInTheDocument();
  expect(secret).toHaveValue(SECRET);
  expect(secret).toBeDisabled();
  expect(getConnectorAction("button", "Save network")).toBeDisabled();
  expect(document.body).not.toHaveTextContent(PROVIDER_DETAIL);
});

test("Changing the owner clears Access secrets", async () => {
  mockRemoteInventory(context);
  await openPrivateNetworks();
  const secret = await startAccessDraft();
  const clerk = context.mocks.clerk();

  clerk.user(
    { id: "user_successor", fullName: "Successor User" },
    { token: "successor-token", id: "sess_successor" },
  );
  clerk.stateChanged();

  await waitFor(() => {
    expect(secret).not.toBeInTheDocument();
  });
  expect(location.pathname).toBe("/connectors");
  expect(secret).toHaveValue("");
  expect(screen.queryByLabelText("Client Secret")).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(SECRET);
});

test("Access load failure does not expose provider details", async () => {
  mockRemoteInventory(context);
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: PROVIDER_DETAIL },
    });
  });

  await setupPage({ context, path: "/connectors?scope=private-network" });

  await expect(
    screen.findByText("Could not load Cloudflare Access."),
  ).resolves.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(PROVIDER_DETAIL);
});

test("Deletion preview permission loss blocks shared deletion", async () => {
  mockRemoteInventory(context, { cloudflare: [teamGateway()] });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(403, {
      error: {
        code: CLOUDFLARE_ACCESS_ERROR_CODES.FORBIDDEN,
        message: PROVIDER_DETAIL,
      },
    });
  });
  await openTeamGateway();

  click(getConnectorAction("button", "Delete Cloudflare Access"));

  const dialog = await screen.findByRole("dialog", {
    name: "Delete Cloudflare Access",
  });
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "This Cloudflare Access is no longer available. Select another one or create one.",
  );
  expect(
    queryConnectorAction("button", "Delete Cloudflare Access", dialog),
  ).toBeNull();
  expect(document.body).not.toHaveTextContent(PROVIDER_DETAIL);
});

test("A restriction rejected with CLOUDFLARE_ACCESS_IN_USE preserves its draft and protects provider details", async () => {
  mockRemoteInventory(context, { cloudflare: [teamGateway()] });
  const preview = impact();
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(200, preview);
  });
  const conversion: {
    body?: { expectedRevision: number; impactSnapshot: string };
  } = {};
  context.mocks.api(
    cloudflareAccessContract.convertToPersonal,
    ({ body, respond }) => {
      conversion.body = body;
      return respond(409, {
        error: {
          code: CLOUDFLARE_ACCESS_ERROR_CODES.IN_USE,
          message: PROVIDER_DETAIL,
        },
      });
    },
  );
  const user = userEvent.setup({ delay: null });
  await editTeamGateway();
  const name = screen.getByLabelText("Network name");
  const confirmation = await requestPersonalScope();
  await expect(
    within(confirmation).findByRole("alert"),
  ).resolves.toHaveTextContent("Affected: 1 member and 1 host.");
  await user.click(
    within(confirmation).getByRole("checkbox", { name: /^I understand/ }),
  );
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Make personal", confirmation),
    ).toBeEnabled();
  });

  click(getConnectorAction("button", "Make personal", confirmation));

  await expect(
    within(confirmation).findByText(
      "This Cloudflare Access is still in use. Unbind or rebind its dependent hosts and custom connectors first.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    getConnectorAction("button", "Make personal", confirmation),
  ).toBeDisabled();
  expect(name).toHaveValue("Team gateway");
  expect(document.body).not.toHaveTextContent(PROVIDER_DETAIL);
  expect(conversion.body).toStrictEqual({
    expectedRevision: 1,
    impactSnapshot: preview.impactSnapshot,
  });
});

test("Restriction preview permission loss blocks the scope change", async () => {
  mockRemoteInventory(context, { cloudflare: [teamGateway()] });
  context.mocks.api(cloudflareAccessContract.impactPreview, ({ respond }) => {
    return respond(403, {
      error: {
        code: CLOUDFLARE_ACCESS_ERROR_CODES.FORBIDDEN,
        message: PROVIDER_DETAIL,
      },
    });
  });
  await editTeamGateway();

  const confirmation = await requestPersonalScope();

  await expect(
    within(confirmation).findByRole("alert"),
  ).resolves.toHaveTextContent(
    "This network is unavailable or you no longer have the required administrator permission.",
  );
  expect(
    getConnectorAction("button", "Make personal", confirmation),
  ).toBeDisabled();
});
