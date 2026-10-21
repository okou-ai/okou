import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
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
  OTHER_AGENT_ID,
  SCOUT_AGENT_ID,
  SCOUT_THREAD_ID,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

const GITHUB_SLUG = "github" as ConnectorSlug;
const SLACK_SLUG = "slack" as ConnectorSlug;

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
    screen.findByLabelText("Remove GitHub"),
  ).resolves.toBeInTheDocument();
});

test("Refresh both independent resource domains every time the menu opens", async () => {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });
  let connectorLabel = "First GitHub";
  let computerLabel = "First computer";
  context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      builtinConnectors: [
        {
          slug: GITHUB_SLUG,
          label: connectorLabel,
          icon: {
            url: "https://icons.example.test/github.svg",
            invertInDarkMode: false,
          },
          hasPermissions: false,
        },
      ],
      customConnectors: [],
    });
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
  await screen.findByLabelText("Remove First GitHub");
  await screen.findByText("First computer");
  click(trigger);
  await waitFor(() => {
    return expect(screen.queryByText("First computer")).not.toBeInTheDocument();
  });
  connectorLabel = "Renamed GitHub";
  computerLabel = "Renamed computer";
  click(trigger);
  await expect(
    screen.findByLabelText("Remove Renamed GitHub"),
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
  await expect(screen.findByLabelText("Remove GitHub")).resolves.toBeVisible();
  await expect(screen.findByRole("alert")).resolves.toBeVisible();
});

test("Closing a pending menu releases its snapshot before reopening", async () => {
  installComposerConnectorFixture({
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });
  const started = context.mocks.deferred<AbortSignal>();
  const release = context.mocks.deferred<void>();
  let pending = true;
  context.mocks.api(
    connectedConnectorsContract.list,
    async ({ request, respond }) => {
      const stale = pending;
      if (stale) {
        started.resolve(request.signal);
        await release.promise;
      }
      return respond(200, {
        builtinConnectors: [
          {
            slug: GITHUB_SLUG,
            label: stale ? "Stale GitHub" : "Fresh GitHub",
            icon: {
              url: "https://icons.example.test/github.svg",
              invertInDarkMode: false,
            },
            hasPermissions: false,
          },
        ],
        customConnectors: [],
      });
    },
  );
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  await screen.findByRole("dialog", { name: "Connectors" });
  const requestSignal = await started.promise;
  click(trigger);
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
    expect(requestSignal.aborted).toBeTruthy();
  });
  pending = false;
  click(trigger);
  await expect(
    screen.findByLabelText("Remove Fresh GitHub"),
  ).resolves.toBeVisible();
  release.resolve(undefined);
  expect(screen.queryByLabelText("Remove Stale GitHub")).toBeNull();
});

test("Render remote resources while connected connectors are unavailable", async () => {
  installComposerConnectorFixture();
  context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
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
    "Couldn't load connectors.",
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

test("Do not show the previous Agent's connectors while the next Agent loads", async () => {
  const otherAuthorization = context.mocks.deferred<void>();
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" }),
      builtinConnector({ slug: SLACK_SLUG, label: "Slack" }),
    ],
    builtinAuthorizations: {
      [SCOUT_AGENT_ID]: [GITHUB_SLUG],
      [OTHER_AGENT_ID]: [SLACK_SLUG],
    },
    authorizationGates: { [OTHER_AGENT_ID]: otherAuthorization.promise },
  });
  context.mocks.data.userPreferences({
    pinnedAgentIds: [SCOUT_AGENT_ID, OTHER_AGENT_ID],
  });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  await screen.findByLabelText("Remove GitHub");
  click(trigger);
  await waitFor(() => {
    expect(screen.queryByLabelText("Remove GitHub")).toBeNull();
  });

  click(await findFastControl("link", "Other Agent"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${OTHER_AGENT_ID}/chat`);
  });
  click(await findFastControl("button", "Connectors"));
  await screen.findByRole("dialog", { name: "Connectors" });
  expect(screen.queryByLabelText("Remove GitHub")).toBeNull();
  expect(screen.queryByRole("list", { name: "Connectors" })).toBeNull();

  otherAuthorization.resolve(undefined);
  await expect(
    screen.findByLabelText("Remove Slack"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Add GitHub")).toBeInTheDocument();
});

test("Show an error when an authorization change cannot be saved", async () => {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });
  context.mocks.api(userBuiltinConnectorsContract.update, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_ERROR",
        message: "Authorization could not be saved",
      },
    });
  });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  click(await findFastControl("button", "Connectors"));
  click(await screen.findByLabelText("Remove GitHub"));
  await expect(
    screen.findByText("Authorization could not be saved"),
  ).resolves.toBeVisible();
});
