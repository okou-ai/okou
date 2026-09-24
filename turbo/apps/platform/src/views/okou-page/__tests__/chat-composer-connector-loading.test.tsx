import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  builtinConnector,
  installComposerConnectorFixture,
  OTHER_AGENT_ID,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  context,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const GITHUB_SLUG = "github" as ConnectorSlug;
const SLACK_SLUG = "slack" as ConnectorSlug;
const GMAIL_SLUG = "gmail" as ConnectorSlug;

test("Read composer summaries without fetching the connector directory or old authorization endpoints", async () => {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });
  const reads = { discovery: 0, custom: 0, builtinGrants: 0, customGrants: 0 };
  context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
    reads.discovery += 1;
    return respond(503, {
      error: { code: "PROVIDER_UNAVAILABLE", message: "Directory unavailable" },
    });
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    reads.custom += 1;
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Directory unavailable" },
    });
  });
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    reads.builtinGrants += 1;
    return respond(200, { enabledConnectorSlugs: [] });
  });
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    reads.customGrants += 1;
    return respond(200, { grants: [] });
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  click(await findFastControl("button", "Connectors"));
  await expect(
    screen.findByLabelText("Remove GitHub"),
  ).resolves.toBeInTheDocument();
  expect(reads).toStrictEqual({
    discovery: 0,
    custom: 0,
    builtinGrants: 0,
    customGrants: 0,
  });
});

test("Show connected connectors while an older API is still serving", async () => {
  const github = builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" });
  installComposerConnectorFixture({
    catalog: [github],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });
  context.mocks.api(connectorOverviewContract.overview, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Route unavailable" },
    });
  });
  context.mocks.api(connectorOverviewContract.agent, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Route unavailable" },
    });
  });
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [github] });
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  click(await findFastControl("button", "Connectors"));
  await expect(
    screen.findByLabelText("Remove GitHub"),
  ).resolves.toBeInTheDocument();
});

test("Load the Agent's connector access only when the Connectors menu opens", async () => {
  const catalog = [
    builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" }),
    builtinConnector({ slug: SLACK_SLUG, label: "Slack" }),
    builtinConnector({ slug: GMAIL_SLUG, label: "Gmail", connected: false }),
  ];
  installComposerConnectorFixture({
    catalog,
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG, GMAIL_SLUG] },
  });
  const requests = { overview: 0, agent: 0 };
  context.mocks.api(connectorOverviewContract.overview, ({ respond }) => {
    requests.overview += 1;
    return respond(200, {
      builtinConnectors: catalog
        .filter((connector) => {
          return connector.connected;
        })
        .map((connector) => {
          return {
            slug: connector.slug,
            label: connector.label,
            icon: connector.icon,
            hasPermissions: connector.permissionSummary.hasPermissions,
          };
        }),
      customConnectors: [],
      accountSummaries: [],
      computerUseHosts: [],
      cloudBrowserEnabledByDefault: true,
    });
  });
  context.mocks.api(connectorOverviewContract.agent, ({ params, respond }) => {
    requests.agent += 1;
    return respond(200, {
      enabledConnectorSlugs:
        params.id === SCOUT_AGENT_ID ? [GITHUB_SLUG, GMAIL_SLUG] : [],
      customConnectorIds: [],
    });
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  const trigger = await findFastControl("button", "Connectors");
  // The composer still reads the overview for computer-use hosts at mount.
  await waitFor(() => {
    expect(requests.overview).toBeGreaterThan(0);
  });
  expect(requests.agent).toBe(0);
  expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();

  click(trigger);
  await expect(
    screen.findByLabelText("Remove GitHub"),
  ).resolves.toBeInTheDocument();
  expect(requests.agent).toBeGreaterThan(0);
  expect(screen.getByLabelText("Add Slack")).toBeInTheDocument();
  expect(screen.queryByText("Gmail")).toBeNull();
  // The trigger stays a static mark rather than listing enabled connectors.
  expect(trigger.querySelector("img")).toBeNull();
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
