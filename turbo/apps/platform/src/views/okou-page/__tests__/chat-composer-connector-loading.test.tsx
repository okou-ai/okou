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
  SCOUT_THREAD_ID,
  SECOND_SCOUT_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  context,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const GITHUB_SLUG = "github" as ConnectorSlug;
const SLACK_SLUG = "slack" as ConnectorSlug;
const GMAIL_SLUG = "gmail" as ConnectorSlug;

function connectorIcon(trigger: HTMLElement, slug: ConnectorSlug) {
  return trigger.querySelector(
    `img[src="https://icons.example.test/${slug}.svg"]`,
  );
}

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
  const trigger = await findFastControl("button", "Connectors");
  await waitFor(() => {
    expect(connectorIcon(trigger, GITHUB_SLUG)).toBeInTheDocument();
  });
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

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  const trigger = await findFastControl("button", "Connectors");
  await waitFor(() => {
    expect(connectorIcon(trigger, GITHUB_SLUG)).toBeInTheDocument();
  });
});

test("Show connected connector icons without opening the menu", async () => {
  const authorization = context.mocks.deferred<void>();
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" }),
      builtinConnector({ slug: SLACK_SLUG, label: "Slack" }),
      builtinConnector({ slug: GMAIL_SLUG, label: "Gmail", connected: false }),
    ],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG, GMAIL_SLUG] },
    authorizationGates: { [SCOUT_AGENT_ID]: authorization.promise },
  });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  const trigger = await findFastControl("button", "Connectors");
  expect(trigger).toBeEmptyDOMElement();

  authorization.resolve(undefined);
  await waitFor(() => {
    expect(connectorIcon(trigger, GITHUB_SLUG)).toBeInTheDocument();
  });
  expect(connectorIcon(trigger, SLACK_SLUG)).toBeNull();
  expect(connectorIcon(trigger, GMAIL_SLUG)).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
});

test("Keep connector icons across chats with the same agent", async () => {
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" }),
      builtinConnector({ slug: SLACK_SLUG, label: "Slack" }),
    ],
    builtinAuthorizations: {
      [SCOUT_AGENT_ID]: [GITHUB_SLUG],
      [OTHER_AGENT_ID]: [SLACK_SLUG],
    },
    threads: [
      {
        id: SCOUT_THREAD_ID,
        title: "First Scout chat",
        agentId: SCOUT_AGENT_ID,
      },
      {
        id: SECOND_SCOUT_THREAD_ID,
        title: "Second Scout chat",
        agentId: SCOUT_AGENT_ID,
      },
    ],
    threadId: SCOUT_THREAD_ID,
  });
  await setupPage({ context, path: `/chats/${SCOUT_THREAD_ID}` });
  const trigger = await findFastControl("button", "Connectors");
  await waitFor(() => {
    expect(connectorIcon(trigger, GITHUB_SLUG)).toBeInTheDocument();
  });

  click(await findFastControl("link", "Second Scout chat"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${SECOND_SCOUT_THREAD_ID}`);
  });
  expect(
    connectorIcon(await findFastControl("button", "Connectors"), GITHUB_SLUG),
  ).toBeInTheDocument();
});

test("Keep connector icons until the next agent resolves", async () => {
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
  await waitFor(() => {
    expect(connectorIcon(trigger, GITHUB_SLUG)).toBeInTheDocument();
  });
  click(await findFastControl("link", "Other Agent"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${OTHER_AGENT_ID}/chat`);
  });
  const otherTrigger = await findFastControl("button", "Connectors");
  expect(connectorIcon(otherTrigger, GITHUB_SLUG)).toBeInTheDocument();
  otherAuthorization.resolve(undefined);
  await waitFor(() => {
    expect(connectorIcon(otherTrigger, SLACK_SLUG)).toBeInTheDocument();
  });
  expect(connectorIcon(otherTrigger, GITHUB_SLUG)).toBeNull();
});

test("Allow authorization retry after a rejected save", async () => {
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
  await waitFor(() => {
    expect(screen.getByLabelText("Remove GitHub")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  context.mocks.api(userBuiltinConnectorsContract.update, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: [] });
  });
  context.mocks.api(connectorOverviewContract.agent, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: [], customConnectorIds: [] });
  });
  click(screen.getByLabelText("Remove GitHub"));
  await expect(screen.findByLabelText("Add GitHub")).resolves.toBeVisible();
});
