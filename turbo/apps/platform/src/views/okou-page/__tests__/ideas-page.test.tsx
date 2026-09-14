import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
  type PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { reloadConnectors$ } from "../../../signals/external/connectors.ts";

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

function categoryButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!button) {
    throw new Error(`${name} category button not found`);
  }
  return button;
}

async function findComposer(name = "Message"): Promise<HTMLElement> {
  return await screen.findByRole("textbox", { name });
}

function installCatalogRefresh(initial: PublicConnectorCatalogStatusResponse): {
  readonly startRefresh: () => void;
  readonly refreshResponse: ReturnType<
    typeof context.mocks.deferred<PublicConnectorCatalogStatusResponse>
  >;
  readonly refreshStarted: Promise<void>;
} {
  const refreshStarted = context.mocks.deferred<void>();
  const refreshResponse =
    context.mocks.deferred<PublicConnectorCatalogStatusResponse>();
  let catalogRequest = 0;

  context.mocks.api(connectorCatalogContract.status, async ({ respond }) => {
    catalogRequest += 1;
    if (catalogRequest === 1) {
      return respond(200, initial);
    }
    refreshStarted.resolve(undefined);
    return respond(200, await refreshResponse.promise);
  });

  return {
    startRefresh: () => {
      context.store.set(reloadConnectors$);
    },
    refreshResponse,
    refreshStarted: refreshStarted.promise,
  };
}

test("A migration idea uses the Okou product identity", async () => {
  configureAgent();
  mockCatalog([
    catalogItem("zapier", "Zapier"),
    catalogItem("slack", "Slack"),
    catalogItem("notion", "Notion"),
  ]);

  await setupPage({
    context,
    host: "app.okou.ai",
    path: IDEAS_PATH,
    featureSwitches: { [FeatureSwitchKey.ZapierConnector]: true },
  });
  const idea = await screen.findByText("Zapier → Okou migration");

  click(idea);

  const composer = await findComposer();
  expect(composer.textContent).toBe(
    "Help me migrate my Zapier workflows to Okou. I have zaps for: new Slack message → Notion, Gmail → Google Sheets, and GitHub PR → Slack",
  );
});

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

test("Ideas fall back to All when the selected category becomes unavailable", async () => {
  configureAgent();
  const refresh = installCatalogRefresh(
    catalogResponse([
      catalogItem("github", "GitHub"),
      catalogItem("sentry", "Sentry"),
      catalogItem("axiom", "Axiom"),
      catalogItem("plausible", "Plausible"),
      catalogItem("slack", "Slack"),
    ]),
  );

  await setupPage({ context, path: IDEAS_PATH });
  await screen.findByText("Daily standup report");
  const engineering = await waitFor(() => {
    return categoryButton("Engineering");
  });
  click(engineering);
  await waitFor(() => {
    expect(screen.getByText("Daily standup report")).toBeVisible();
    expect(screen.queryByText("Browser screenshots")).not.toBeInTheDocument();
  });

  refresh.startRefresh();
  await refresh.refreshStarted;
  refresh.refreshResponse.resolve(catalogResponse([]));

  await screen.findByText("Browser screenshots");
  expect(
    queryAllByRoleFast("button").find((candidate) => {
      return candidate.textContent?.trim() === "Engineering";
    }),
  ).toBeUndefined();
  expect(categoryButton("All")).toBeVisible();
});

test("A use case is hidden when any required connector is unavailable", async () => {
  configureAgent();
  mockCatalog([catalogItem("github", "GitHub"), catalogItem("slack", "Slack")]);

  await setupPage({ context, path: IDEAS_PATH });
  await screen.findByText("GitHub progress weekly");

  expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();
});

test("Ideas remain stable while connector availability reloads", async () => {
  configureAgent();
  const refresh = installCatalogRefresh(
    catalogResponse([catalogItem("github", "GitHub")]),
  );

  await setupPage({ context, path: IDEAS_PATH });
  await screen.findByText("GitHub progress weekly");

  refresh.startRefresh();
  await refresh.refreshStarted;

  expect(screen.getByText("GitHub progress weekly")).toBeVisible();
  expect(
    screen.queryByText("RevenueCat subscription digest"),
  ).not.toBeInTheDocument();

  refresh.refreshResponse.resolve(
    catalogResponse([
      catalogItem("github", "GitHub"),
      catalogItem("revenuecat", "RevenueCat"),
      catalogItem("google-sheets", "Google Sheets"),
      catalogItem("slack", "Slack"),
    ]),
  );

  await expect(
    screen.findByText("RevenueCat subscription digest"),
  ).resolves.toBeVisible();
});

test("Pending connector availability is not mistaken for no connectors", async () => {
  configureAgent();
  const catalog =
    context.mocks.deferred<PublicConnectorCatalogStatusResponse>();
  context.mocks.api(connectorCatalogContract.status, async ({ respond }) => {
    return respond(200, await catalog.promise);
  });

  await setupPage({ context, path: IDEAS_PATH });
  await screen.findByRole("heading", { name: "Ideas & Use Cases" });

  expect(screen.getByText("Daily standup report")).toBeVisible();

  catalog.resolve(catalogResponse([]));

  await waitFor(() => {
    expect(screen.getByText("Browser screenshots")).toBeVisible();
    expect(screen.queryByText("Daily standup report")).not.toBeInTheDocument();
  });
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
