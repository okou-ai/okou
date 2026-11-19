import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { nowDate } from "../../../lib/time.ts";
import {
  builtinConnector,
  chatConnectorOverviewFixture,
  connectorAccount,
  SCOUT_AGENT_ID,
  SCOUT_THREAD_ID,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

const GITHUB_SLUG = "github" as ConnectorSlug;

function githubOverview(label: string) {
  const target = { kind: "builtin", connectorSlug: GITHUB_SLUG } as const;
  return chatConnectorOverviewFixture({
    target,
    label,
    accounts: [
      connectorAccount({
        id: "f0000000-0000-4000-a000-000000000002",
        target,
        displayName: "Work GitHub",
        isDefault: true,
      }),
    ],
  });
}

test("Read connected inventory without fetching the connector directory or old authorization endpoints", async () => {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });
  context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
    return respond(503, {
      error: { code: "PROVIDER_UNAVAILABLE", message: "Directory unavailable" },
    });
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Directory unavailable" },
    });
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  click(await findFastControl("button", "Connectors"));
  await expect(
    findFastControl("button", /^GitHub/u),
  ).resolves.toBeInTheDocument();
});

test("Refresh the remote menu and Chat account inventory independently", async () => {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });
  let connectorLabel = "First GitHub";
  let computerLabel = "First computer";
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [githubOverview(connectorLabel)]);
  });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [
        {
          id: "f0000000-0000-4000-a000-000000000001",
          hostName: "desktop",
          displayName: computerLabel,
          status: "online",
          lastSeenAt: nowDate().toISOString(),
        },
      ],
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: [],
      vncHosts: [],
    });
  });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  const trigger = await findFastControl("button", "Connectors");
  expect(screen.queryByText("First computer")).not.toBeInTheDocument();
  click(trigger);
  await findFastControl("button", /^First GitHub/u);
  await screen.findByText("First computer");
  click(trigger);
  await waitFor(() => {
    return expect(screen.queryByText("First computer")).not.toBeInTheDocument();
  });
  connectorLabel = "Renamed GitHub";
  context.mocks.ably.trigger("connector:changed");
  computerLabel = "Renamed computer";
  click(trigger);
  await expect(
    findFastControl("button", /^Renamed GitHub/u),
  ).resolves.toBeVisible();
  await expect(screen.findByText("Renamed computer")).resolves.toBeVisible();
  expect(screen.queryByText("First computer")).not.toBeInTheDocument();
});

test("Render connected connectors while remote resources are unavailable", async () => {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Remote resources unavailable" },
    });
  });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  click(await findFastControl("button", "Connectors"));
  await expect(findFastControl("button", /^GitHub/u)).resolves.toBeVisible();
  await expect(screen.findByRole("alert")).resolves.toBeVisible();
});

test("Reopening a pending menu shares the Chat page's inventory request", async () => {
  installComposerConnectorFixture();
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let reads = 0;
  context.mocks.api(
    chatConnectorAccessContract.overview,
    async ({ respond, withSignal }) => {
      reads += 1;
      started.resolve();
      await withSignal(release.promise);
      return respond(200, [githubOverview("GitHub")]);
    },
  );
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  await started.promise;
  click(trigger);
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
  });
  click(trigger);
  release.resolve(undefined);
  await expect(findFastControl("button", /^GitHub/u)).resolves.toBeVisible();
  expect(reads).toBe(1);
});

test("Render remote resources while connected connectors are unavailable", async () => {
  installComposerConnectorFixture();
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(503, {
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Connected inventory unavailable",
      },
    });
  });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [
        {
          id: "f0000000-0000-4000-a000-000000000001",
          hostName: "desktop",
          displayName: "Available computer",
          status: "online",
          lastSeenAt: nowDate().toISOString(),
        },
      ],
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: false,
      sshHosts: [],
      vncHosts: [],
    });
  });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  click(await findFastControl("button", "Connectors"));
  await expect(screen.findByText("Available computer")).resolves.toBeVisible();
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Accounts are unavailable for this connector.",
  );
});

test("Reopening an existing chat refreshes its effective host choices", async () => {
  installComposerConnectorFixture({ threadId: SCOUT_THREAD_ID });
  const host = {
    connectionId: "f0000000-0000-4000-a000-000000000001",
    displayName: "SSH host",
    defaultEnabled: true,
  };
  let enabled = true;
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: [host],
      vncHosts: [],
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ respond }) => {
      return respond(200, {
        ssh: [
          { ...host, enabled, overrideEnabled: enabled, source: "override" },
        ],
        vnc: [],
      });
    },
  );
  await setupPage({ context, path: `/chats/${SCOUT_THREAD_ID}` });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  await expect(screen.findByText("1 enabled")).resolves.toBeVisible();
  click(trigger);
  await waitFor(() => {
    expect(screen.queryByText("Remote access")).not.toBeInTheDocument();
  });
  enabled = false;
  click(trigger);
  await expect(screen.findByText("0 enabled")).resolves.toBeVisible();
});
