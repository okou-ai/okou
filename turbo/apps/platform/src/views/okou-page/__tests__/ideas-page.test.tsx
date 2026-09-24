import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
  type PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000030";
const IDEAS_PATH = `/agents/${AGENT_ID}/ideas`;

const REVENUECAT_PROMPT =
  "Set up a daily RevenueCat digest that tracks new subscriptions, renewals, and cancellations in Google Sheets and alerts on Slack for churn spikes";

function agentFixture(): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId: AGENT_ID,
    ownerId: "test-user-123",
    description: "Helps turn ideas into work",
    displayName: "Research Agent",
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "public",
  };
}

function catalogItem(
  slug: ConnectorSlug,
  label: string,
): PublicConnectorCatalogStatusItem {
  return {
    slug,
    label,
    description: `${label} test connector`,
    icon: {
      url: `https://icons.example.test/${slug}.svg`,
      invertInDarkMode: slug === "github",
    },
    category: "test",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        description: "Sign in to grant access.",
        grantKind: "auth-code",
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: true,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
  };
}

function catalogResponse(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): PublicConnectorCatalogStatusResponse {
  return { connectors: [...connectors] };
}

function configureAgent(): void {
  context.mocks.data.agents([agentFixture()]);
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
}

function mockCatalog(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, catalogResponse(connectors));
  });
}

async function findComposer(name = "Message"): Promise<HTMLElement> {
  return await screen.findByRole("textbox", { name });
}

test("The ideas catalog still offers connector-free use cases", async () => {
  configureAgent();
  mockCatalog([]);

  await setupPage({ context, path: IDEAS_PATH });
  await screen.findByText("Browser screenshots");

  expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

  await fill(await screen.findByLabelText("Search use cases"), "Daily standup");

  await expect(
    screen.findByText("No use cases match your search."),
  ).resolves.toBeVisible();
});

test("Connector-dependent ideas fail closed when availability cannot be verified", async () => {
  configureAgent();
  const failCatalog = context.mocks.deferred<void>();
  const failureReturned = context.mocks.deferred<void>();
  context.mocks.api(connectorCatalogContract.status, async ({ respond }) => {
    await failCatalog.promise;
    failureReturned.resolve(undefined);
    return respond(503, {
      error: {
        code: "CONNECTOR_CATALOG_UNAVAILABLE",
        message: "Connector catalog unavailable",
      },
    });
  });

  await setupPage({ context, path: IDEAS_PATH });
  await screen.findByText("Daily standup report");

  failCatalog.resolve(undefined);
  await failureReturned.promise;

  await waitFor(() => {
    expect(screen.getByText("Browser screenshots")).toBeVisible();
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();
  });
});

test("A use case is hidden when any required connector is unavailable", async () => {
  configureAgent();
  mockCatalog([catalogItem("github", "GitHub"), catalogItem("slack", "Slack")]);

  await setupPage({ context, path: IDEAS_PATH });
  await screen.findByText("GitHub progress weekly");

  expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();
});

test("Search for a use case and start it with the agent", async () => {
  configureAgent();
  mockCatalog([
    catalogItem("github", "GitHub"),
    catalogItem("sentry", "Sentry"),
    catalogItem("axiom", "Axiom"),
    catalogItem("plausible", "Plausible"),
    catalogItem("slack", "Slack"),
    catalogItem("revenuecat", "RevenueCat"),
    catalogItem("google-sheets", "Google Sheets"),
  ]);

  await setupPage({ context, path: IDEAS_PATH });
  const search = await screen.findByLabelText("Search use cases");

  await fill(search, "RevenueCat");

  const idea = await screen.findByText("RevenueCat subscription digest");
  expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();

  click(idea);

  const composer = await findComposer();
  expect(composer.textContent).toBe(REVENUECAT_PROMPT);
});
