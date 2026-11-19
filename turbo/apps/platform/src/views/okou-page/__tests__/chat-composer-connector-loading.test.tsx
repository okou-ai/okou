import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { nowDate } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  builtinConnector,
  chatConnectorOverviewFixture,
  connectorAccount,
  SCOUT_AGENT_ID,
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

function remoteResources(computerName: string) {
  return {
    computerUseHosts: [
      {
        id: "f0000000-0000-4000-a000-000000000001",
        hostName: "desktop",
        displayName: computerName,
        status: "online" as const,
        lastSeenAt: nowDate().toISOString(),
      },
    ],
    cloudBrowserAvailable: true,
    cloudBrowserEnabledByDefault: true,
    sshHosts: [],
    vncHosts: [],
  };
}

function installConnectedGitHub() {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
  });
}

test("Refresh the remote menu and Chat account inventory independently", async () => {
  installConnectedGitHub();
  let connectorLabel = "First GitHub";
  let computerLabel = "First computer";
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [githubOverview(connectorLabel)]);
  });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, remoteResources(computerLabel));
  });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  const trigger = await findFastControl("button", "Connectors");

  click(trigger);
  await expect(
    findFastControl("button", /^First GitHub/u),
  ).resolves.toBeVisible();
  await expect(screen.findByText("First computer")).resolves.toBeVisible();

  click(trigger);
  await waitFor(() => {
    expect(screen.queryByText("First computer")).not.toBeInTheDocument();
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
  installConnectedGitHub();
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
    return respond(200, remoteResources("Available computer"));
  });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  click(await findFastControl("button", "Connectors"));

  await expect(screen.findByText("Available computer")).resolves.toBeVisible();
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Accounts are unavailable for this connector.",
  );
});
