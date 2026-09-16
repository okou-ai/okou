import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  marketingAcquisitionContract,
  type ObservedAcquisitionEvent,
} from "@okouai/api-contracts/contracts/marketing-acquisition";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { DEFAULT_AGENT_AVATAR_URL } from "@okouai/core/agent-avatar";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
} from "@okouai/core";
import {
  billingCheckoutContract,
  billingUsagePackCheckoutContract,
  type MemberUsagePack,
} from "@okouai/api-contracts/contracts/billing";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorManualGrantContract,
  connectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  onboardingCompleteContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";

import {
  click,
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname, pushState, search } from "../../../signals/location.ts";
import { ONBOARDING_CHECKOUT_STATE_PARAM } from "../../../signals/onboarding/onboarding-state.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";
import { mockOAuthCompletions } from "../../okou-page/__tests__/connector-page-test-helpers.ts";

const context = testContext();

const DEFAULT_ONBOARDING_AGENT = {
  agentId: "c0000000-0000-4000-a000-000000000001",
  isDefaultAgent: true,
  ownerId: "test-user-123",
  displayName: "Okou",
  description: null,
  sound: null,
  avatarUrl: DEFAULT_AGENT_AVATAR_URL,
  modelProviderId: null,
  selectedModel: null,
  preferPersonalProvider: false,
  visibility: "public",
} satisfies AgentResponse;

const MARKETING_PRESENTATION_PROMPT = [
  "/gen presentation with template `html-ppt-playful-launch`, create a 15-slide launch deck for SproutPop, a playful habit-building app for remote teams introducing a shared 30-day wellness challenge.",
  "Present it to people and culture leaders with cover, agenda, launch story, audience pain points, product vision, feature tour, rollout timeline, activation moments, team, early metrics, testimonials, pricing, and next steps.",
  "Make it saturated, joyful, idea-led, and structured.",
].join(" ");

const MARKETING_PRESENTATION_SHOWCASE =
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8199ef0a-c692-4c20-8267-e91ffe060b4c/playful-launch-presentation.html";

function templateFromUserMessage(document: UserMessageDocument | undefined) {
  const part = document?.parts.find((candidate) => {
    return candidate.type === "template";
  });
  return part?.type === "template" ? part.template : undefined;
}

function templateTypeFromUserMessage(
  document: UserMessageDocument | undefined,
): string | undefined {
  return templateFromUserMessage(document)?.type;
}

function firstItem<Item>(items: readonly Item[]): Item {
  const item = items[0];
  if (!item) {
    throw new Error("Expected onboarding template data");
  }
  return item;
}

const ONBOARDING_START_SEND_TO = "AW-18144854014/GVKdCLbQ9LscEP7_kcxD";
const CHECKOUT_START_SEND_TO = "AW-18144854014/EEovCKmuvbscEP7_kcxD";
const ADSMARCH_ONBOARDING_START_SEND_TO = "AW-18407336975/xkGcCLaRrOccEI_YpslE";
const ADSMARCH_CHECKOUT_START_SEND_TO = "AW-18407336975/hWi8CPWRrOccEI_YpslE";
const ADSMARCH_PAID_IN_ONBOARDING_SEND_TO =
  "AW-18407336975/M7QYCPiRrOccEI_YpslE";

type GtagFn = (...args: unknown[]) => void;

type WindowWithGtag = Window & {
  gtag?: GtagFn;
};

function installGtagMock(): ReturnType<typeof vi.fn<GtagFn>> {
  const windowWithGtag = window as WindowWithGtag;
  const originalGtag = windowWithGtag.gtag;
  const gtag = vi.fn<GtagFn>();

  Object.defineProperty(windowWithGtag, "gtag", {
    configurable: true,
    value: gtag,
    writable: true,
  });
  context.signal.addEventListener("abort", () => {
    if (originalGtag !== undefined) {
      Object.defineProperty(windowWithGtag, "gtag", {
        configurable: true,
        value: originalGtag,
        writable: true,
      });
      return;
    }
    Reflect.deleteProperty(windowWithGtag, "gtag");
  });

  return gtag;
}

function sentConversions(gtag: ReturnType<typeof vi.fn<GtagFn>>): string[] {
  return gtag.mock.calls.flatMap((call) => {
    const [command, eventName, params] = call;
    if (command !== "event" || eventName !== "conversion") {
      return [];
    }
    const sendTo = (params as { readonly send_to?: unknown }).send_to;
    return typeof sendTo === "string" ? [sendTo] : [];
  });
}

function mockOnboardingNeeded(currentContext = context): void {
  currentContext.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

function mockPrefetchedAgents(agents: readonly AgentResponse[]): void {
  // This response arrives in Worker-served HTML, before the browser runs.
  // Page interactions cannot create this server-only initial document state.
  const bootstrap = document.createElement("script");
  bootstrap.type = "application/json";
  bootstrap.dataset.okouApiBootstrap = "";
  bootstrap.dataset.method = agentsMainContract.list.method;
  bootstrap.dataset.path = encodeURIComponent(agentsMainContract.list.path);
  bootstrap.dataset.contentType = "application/json";
  bootstrap.textContent = JSON.stringify(agents);
  document.head.append(bootstrap);
  context.signal.addEventListener("abort", () => {
    bootstrap.remove();
  });
}

function setupCustomWorkflowPage(
  host: "app.okou.ai" | "app.okou.ai",
  onPrompt: (prompt: string) => void,
): Promise<void> {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      if (body.prompt === undefined) {
        throw new Error("Expected the custom workflow prompt");
      }
      onPrompt(body.prompt);
    },
  });
  mockOnboardingNeeded();
  return setupPage({
    context,
    host,
    locale: "en-US",
    path: "/onboarding/workflow-run?choice=workflow&category=engineering&workflow=custom-workflow",
  });
}

function mockCatalogItem({
  slug,
  label,
  icon,
}: {
  readonly slug: PublicConnectorCatalogStatusItem["slug"];
  readonly label: string;
  readonly icon: PublicConnectorCatalogStatusItem["icon"];
}): void {
  const connector: PublicConnectorCatalogStatusItem = {
    slug,
    label,
    description: `Connect ${label} to continue`,
    icon,
    category: "developer-tools",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        description: null,
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
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
  };
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
}

async function openMakePage(): Promise<void> {
  mockOnboardingNeeded();
  await setupPage({ context, path: "/onboarding" });
  await expect(
    screen.findByRole("heading", {
      name: "What do you want to make first",
    }),
  ).resolves.toBeInTheDocument();
}

async function openGithubWorkflowRun(): Promise<void> {
  mockOnboardingNeeded();
  await setupPage({
    context,
    path: "/onboarding/workflow-run?choice=workflow&category=engineering&workflow=auto-merge-github-prs",
  });
  await expect(
    screen.findByRole("heading", {
      name: "Review your workflow draft",
    }),
  ).resolves.toBeInTheDocument();
}

function chooseMakeOption(name: string): void {
  const radio = queryAllByRoleFast("radio").find((candidate) => {
    return candidate.textContent?.includes(name) ?? false;
  });
  if (!radio) {
    throw new Error(`Radio not found for ${name}`);
  }
  click(radio);
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButtonByText(text, container);
  if (!button) {
    throw new Error(`Button not found for ${text}`);
  }
  return button;
}

function queryButtonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((candidate) => {
      return candidate.textContent?.includes(text) ?? false;
    }) ?? null
  );
}

function buttonsByAriaLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
}

function buttonByAriaLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = buttonsByAriaLabel(label, container)[0];
  if (!button) {
    throw new Error(`Button not found for aria-label ${label}`);
  }
  return button;
}

function chooseTemplate(
  title: string,
  kind: "presentation" | "illustration" | "video",
): void {
  click(buttonByAriaLabel(`Select ${title} ${kind} template`));
  click(buttonByText("Continue"));
}

test("Slack is the leading onboarding choice", async () => {
  await openMakePage();

  const slackOption = firstItem(queryAllByRoleFast("radio"));
  expect(slackOption).toHaveTextContent("Chat with Okou in Slack");
  expect(
    screen.getByTestId("onboarding-slack-illustration"),
  ).toBeInTheDocument();
  expect(screen.getByTestId("onboarding-slack-icon")).toHaveAttribute(
    "src",
    expect.stringContaining("slack-198390069136.svg"),
  );

  click(slackOption);

  await waitFor(() => {
    expect(pathname()).toBe(ROUTES.works);
  });
});

async function expectCreativeChoiceOpensTemplateGallery(scenario: {
  readonly description: string;
  readonly option: string;
  readonly tab: string;
}): Promise<HTMLElement> {
  await openMakePage();
  const option = queryAllByRoleFast("radio").find((candidate) => {
    return candidate.textContent?.includes(scenario.option);
  });
  if (!option) {
    throw new Error(`Expected ${scenario.option} choice`);
  }
  expect(option).toHaveTextContent(scenario.description);

  click(option);

  return waitFor(() => {
    const selectedTab = queryAllByRoleFast("tab").find((candidate) => {
      return (
        candidate.textContent === scenario.tab &&
        candidate.getAttribute("aria-selected") === "true"
      );
    });
    if (!selectedTab) {
      throw new Error(`Expected ${scenario.tab} template tab`);
    }
    return selectedTab;
  });
}

test("Presentation creation opens its template gallery", async () => {
  const selectedTab = await expectCreativeChoiceOpensTemplateGallery({
    option: "Generate a presentation",
    description: "Generate slides and speaker",
    tab: "Presentation",
  });
  expect(selectedTab).toHaveAttribute("aria-selected", "true");
  expect(pathname()).toBe("/agents/c0000000-0000-4000-a000-000000000001/chat");
});

test("Image creation opens its template gallery", async () => {
  const selectedTab = await expectCreativeChoiceOpensTemplateGallery({
    option: "Generate images",
    description: "Create high-quality visuals",
    tab: "Illustration",
  });
  expect(selectedTab).toHaveAttribute("aria-selected", "true");
});

test("Video production opens its template gallery", async () => {
  const selectedTab = await expectCreativeChoiceOpensTemplateGallery({
    option: "Video production",
    description: "Turn your ideas into video",
    tab: "Video",
  });
  expect(selectedTab).toHaveAttribute("aria-selected", "true");
});

test("Website creation opens its template gallery", async () => {
  const selectedTab = await expectCreativeChoiceOpensTemplateGallery({
    option: "Build a website",
    description: "Create and publish a shareable page",
    tab: "Website",
  });
  expect(selectedTab).toHaveAttribute("aria-selected", "true");
});

test("A user can identify and switch workspace during onboarding", async () => {
  mockOnboardingNeeded();
  await setupPage({
    context,
    path: "/onboarding",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: {
          id: "org_switcher",
          name: "Acme Workspace",
          slug: "acme",
        },
        memberships: [{ id: "org_switcher" }],
      },
    },
  });

  await expect(
    screen.findByRole("heading", {
      name: "What do you want to make first",
    }),
  ).resolves.toBeInTheDocument();

  // The compact switcher (mobile layout) is wired into the onboarding shell.
  expect(buttonByAriaLabel("Switch workspace")).toBeInTheDocument();

  // The desktop switcher shows the active workspace name in the top-left.
  await waitFor(() => {
    expect(queryButtonByText("Acme Workspace")).not.toBeNull();
  });
});

test("Workflow drafts identify required and optional connectors clearly", async () => {
  mockCatalogItem({
    slug: "google-cloud",
    label: "Catalog Google Cloud",
    icon: {
      url: "https://icons.example.test/onboarding-google-cloud.svg",
      invertInDarkMode: false,
    },
  });
  mockOnboardingNeeded();
  await setupPage({
    context,
    path: "/onboarding/workflow-run?choice=workflow&category=engineering&workflow=post-github-updates-slack",
  });

  await expect(
    screen.findByRole("heading", {
      name: "Audit Google Cloud IAM and services",
    }),
  ).resolves.toBeInTheDocument();
  const requiredLabel = screen.getByText("Catalog Google Cloud");
  const requiredRow = requiredLabel.parentElement?.parentElement;
  if (!requiredRow) {
    throw new Error("Expected Google Cloud connector row");
  }
  expect(within(requiredRow).getByText(/^Required\s+·/u)).toBeVisible();

  const optionalLabel = screen.getByText("github");
  const optionalRow = optionalLabel.parentElement?.parentElement;
  if (!optionalRow) {
    throw new Error("Expected GitHub connector row");
  }
  expect(within(optionalRow).getByText(/^Optional\s+·/u)).toBeVisible();

  click(buttonByAriaLabel("Preview workflow details"));

  const preview = await screen.findByRole("dialog", {
    name: "Audit Google Cloud IAM and services",
  });
  expect(
    within(preview).getByText((content) => {
      return (
        content === "Google Cloud" || content.startsWith("Google Cloud + ")
      );
    }),
  ).toBeVisible();
});

test("Built-in workflows can start without connector setup", async () => {
  mockOnboardingNeeded();
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [] });
  });
  await setupPage({
    context,
    path: "/onboarding/workflow-run?choice=workflow&category=marketing&workflow=track-keyword-ranks-ahrefs",
  });

  await expect(
    screen.findByRole("heading", {
      name: "Audit a website's technical SEO",
    }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryAllByTestId("connector-card-label")).toHaveLength(0);
  expect(queryButtonByText("Connect")).toBeNull();

  click(buttonByAriaLabel("Preview workflow details"));

  const preview = await screen.findByRole("dialog", {
    name: "Audit a website's technical SEO",
  });
  expect(
    within(preview).getByText(/built-in Firecrawl and DataForSEO/u),
  ).toBeVisible();
  expect(
    preview.querySelector('[data-slot="onboarding-diagram-source-node"]'),
  ).toBeNull();
  expect(
    preview.querySelector('[data-slot="onboarding-diagram-source-dot"]'),
  ).toBeNull();
  expect(preview.querySelector('path[d="M170 81H277"]')).toBeNull();
  expect(
    preview.querySelectorAll('[data-slot="onboarding-okou-avatar"]'),
  ).toHaveLength(1);
  expect(
    preview.querySelector<HTMLImageElement>(
      '[data-slot="onboarding-okou-avatar"]',
    ),
  ).toHaveAttribute(
    "src",
    "https://static.okou.io/platform/views/onboarding/assets/okou-avatar-2df72642115f.webp",
  );
});

test.each([
  "Everyone",
  "Engineer",
  "Product",
  "Data",
  "Marketing",
  "Sales",
  "Support",
  "CEO",
  "Operations",
] as const)(
  "The %s onboarding role has six curated workflows and returns to role selection",
  async (role) => {
    await openMakePage();
    chooseMakeOption("Workflow automation");
    await expect(
      screen.findByRole("heading", { name: "What do you work on?" }),
    ).resolves.toBeInTheDocument();
    click(buttonByText(role));
    await expect(
      screen.findByRole("heading", { name: `${role} workflows` }),
    ).resolves.toBeInTheDocument();

    const workflowCards = screen.getAllByRole("article");
    expect(workflowCards).toHaveLength(6);

    click(buttonByText("Back"));
    await expect(
      screen.findByRole("heading", { name: "What do you work on?" }),
    ).resolves.toBeInTheDocument();
  },
);

test("A workflow preview can be selected as the first draft", async () => {
  await openMakePage();
  chooseMakeOption("Workflow automation");

  await expect(
    screen.findByRole("heading", {
      name: "What do you work on?",
    }),
  ).resolves.toBeInTheDocument();
  click(buttonByText("Engineer"));

  await expect(
    screen.findByRole("heading", {
      name: "Engineer workflows",
    }),
  ).resolves.toBeInTheDocument();
  const workflowButton = queryAllByRoleFast("button").find((candidate) => {
    return candidate
      .getAttribute("aria-label")
      ?.startsWith("Auto-merge GitHub PRs");
  });
  expect(workflowButton).toHaveAttribute("aria-pressed", "false");

  const previewButton = buttonsByAriaLabel("Preview workflow details")[0];
  if (!previewButton) {
    throw new Error("Expected workflow preview button");
  }
  click(previewButton);
  const preview = await screen.findByRole("dialog", {
    name: "Auto-merge GitHub PRs",
  });
  expect(within(preview).getByText("How it works")).toBeVisible();
  click(buttonByText("Select this template", preview));

  await expect(
    screen.findByRole("heading", {
      name: "Review your workflow draft",
    }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Auto-merge GitHub PRs" }),
  ).toBeInTheDocument();
  const selectedWorkflow = new URLSearchParams(search());
  expect(pathname()).toBe("/onboarding/workflow-run");
  expect(selectedWorkflow.get("category")).toBe("engineering");
  expect(selectedWorkflow.get("workflow")).toBe("auto-merge-github-prs");
});

test("Workflow drafts can be created before connectors are connected", async () => {
  mockOnboardingNeeded();
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [] });
  });
  await setupPage({
    context,
    path: "/onboarding/workflow-run?choice=workflow&category=engineering&workflow=watch-sentry-after-release",
  });

  await expect(
    screen.findByRole("heading", {
      name: "Review your workflow draft",
    }),
  ).resolves.toBeInTheDocument();
  expect(buttonByText("Create workflow")).not.toBeDisabled();
  expect(screen.queryByText(/to run this workflow/u)).toBeNull();
});

test("Workflow drafts can be created after connectors are connected", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  context.mocks.data.connectors([
    {
      id: "11111111-1111-4111-8111-111111111112",
      slug: "notion",
      authMethod: "oauth",
      externalId: "notion-user-1",
      externalUsername: "notion-user",
      externalEmail: null,
      oauthScopes: ["read", "write"],
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  await setupPage({
    context,
    path: "/onboarding/workflow-run?choice=workflow&category=product&workflow=summarize-user-feedback-notion",
  });

  await expect(
    screen.findByRole("heading", {
      name: "Review your workflow draft",
    }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(buttonByText("Create workflow")).not.toBeDisabled();
  });
  expect(screen.queryByText(/to run this workflow/u)).toBeNull();
});

test("A user can leave the catalog to create a custom workflow", async () => {
  let completedTimezone: string | undefined;
  context.mocks.api(
    onboardingCompleteContract.complete,
    ({ body, respond }) => {
      completedTimezone = body.timezone;
      return respond(200, {
        onboardingComplete: true,
        needsOnboarding: false,
      });
    },
  );
  await openMakePage();
  chooseMakeOption("Workflow automation");

  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
  click(buttonByText("Engineer"));

  await expect(
    screen.findByRole("heading", { name: "Engineer workflows" }),
  ).resolves.toBeInTheDocument();

  click(buttonByText("Talk to Okou and make my own"));

  await waitFor(() => {
    expect(pathname()).not.toMatch(/^\/onboarding/u);
  });
  expect(completedTimezone).toBe(
    new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
});

test("Okou's avatar appears after onboarding provisions the first agent", async () => {
  const initialAgentList = context.mocks.deferred<void>();
  let provisioned = false;
  let completed = false;
  const agent = DEFAULT_ONBOARDING_AGENT;
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    if (!provisioned) {
      initialAgentList.resolve();
      return respond(200, []);
    }
    return respond(200, [agent]);
  });
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  context.mocks.api(onboardingStatusContract.getStatus, async ({ respond }) => {
    // The first status request lazily provisions Okou after the concurrent
    // agents-page request has read the still-empty workspace.
    await initialAgentList.promise;
    provisioned = true;
    return respond(200, {
      needsOnboarding: !completed,
      onboardingComplete: completed,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: agent.agentId,
      defaultAgentMetadata: {
        displayName: agent.displayName,
        avatarUrl: agent.avatarUrl,
      },
    });
  });
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    completed = true;
    return respond(200, {
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });

  await setupPage({ context, path: "/agents" });
  await screen.findByRole("heading", {
    name: "What do you want to make first",
  });
  chooseMakeOption("Workflow automation");
  await screen.findByRole("heading", { name: "What do you work on?" });
  click(buttonByText("Engineer"));
  await screen.findByRole("heading", { name: "Engineer workflows" });
  click(buttonByText("Talk to Okou and make my own"));

  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${agent.agentId}/chat`);
    const profile = queryAllByRoleFast("link").find((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    });
    expect(profile?.querySelector("img")).toBeVisible();
  });
});

test("Exploring after onboarding shows Okou even when the initial HTML prefetched no agents", async () => {
  const agent = DEFAULT_ONBOARDING_AGENT;
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });

  mockPrefetchedAgents([]);

  await openMakePage();
  chooseMakeOption("I will explore on my own");

  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${agent.agentId}/chat`);
    const profile = queryAllByRoleFast("link").find((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    });
    expect(profile?.querySelector("img")).toBeVisible();
  });
});

test("An onboarded user sees Okou's prefetched avatar on the first visit", async () => {
  context.mocks.data.agents([]);
  mockPrefetchedAgents([DEFAULT_ONBOARDING_AGENT]);

  await setupPage({ context, path: "/" });
  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    const profile = queryAllByRoleFast("link").find((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    });
    expect(profile?.querySelector("img")).toBeVisible();
  });
});

test("Okou custom workflow onboarding addresses Okou by default", async () => {
  const runCreated = context.mocks.deferred<string>();
  await setupCustomWorkflowPage("app.okou.ai", runCreated.resolve);

  await expect(
    screen.findByRole("heading", { name: "Describe your workflow" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByPlaceholderText("Describe what you want Okou to build"),
  ).toBeVisible();
  await fill(
    screen.getByLabelText("Describe your workflow"),
    "Build a daily brief",
  );
  click(buttonByText("Continue with Okou"));

  await expect(runCreated.promise).resolves.toBe("@Okou Build a daily brief");
});

test("Custom workflow onboarding addresses Okou by default", async () => {
  const runCreated = context.mocks.deferred<string>();
  await setupCustomWorkflowPage("app.okou.ai", runCreated.resolve);

  await expect(
    screen.findByRole("heading", { name: "Describe your workflow" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByPlaceholderText("Describe what you want Okou to build"),
  ).toBeVisible();
  await fill(
    screen.getByLabelText("Describe your workflow"),
    "Build a daily brief",
  );
  click(buttonByText("Continue with Okou"));

  await expect(runCreated.promise).resolves.toBe("@Okou Build a daily brief");
});

test("Custom workflow onboarding preserves an explicit assistant mention", async () => {
  const runCreated = context.mocks.deferred<string>();
  await setupCustomWorkflowPage("app.okou.ai", runCreated.resolve);

  await expect(
    screen.findByRole("heading", { name: "Describe your workflow" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByPlaceholderText("Describe what you want Okou to build"),
  ).toBeVisible();
  await fill(
    screen.getByLabelText("Describe your workflow"),
    "@Researcher build a daily brief",
  );
  click(buttonByText("Continue with Okou"));

  await expect(runCreated.promise).resolves.toBe(
    "@Researcher build a daily brief",
  );
});

test("Connecting an OAuth account starts its standard authorization", async () => {
  mockOAuthCompletions(context);
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  context.mocks.browser.open(authWindow);
  context.mocks.api(
    connectorOauthStartContract.start,
    ({ params, respond }) => {
      expect(params.connectorSlug).toBe("github");
      return respond(200, {
        authorizationUrl: "https://oauth.test/github/authorize",
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );

  await openGithubWorkflowRun();
  const connectButton = await waitFor(() => {
    return buttonByText("Connect");
  });
  click(connectButton);

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/github/authorize",
    );
  });
  expect(connectButton).toBeDisabled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("An existing account connection is recognized during onboarding", async () => {
  context.mocks.data.connectors([
    {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "github",
      authMethod: "oauth",
      externalId: "github-user-1",
      externalUsername: "octocat",
      externalEmail: null,
      oauthScopes: ["repo", "project", "workflow"],
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);

  await openGithubWorkflowRun();

  const githubLabel = await screen.findByText("GitHub");
  const githubRow = githubLabel.parentElement?.parentElement;
  if (!githubRow) {
    throw new Error("Expected GitHub connector row");
  }
  expect(within(githubRow).getByText("Connected")).toBeInTheDocument();
  expect(queryButtonByText("Connect", githubRow)).toBeNull();
});

test("Ahrefs can be connected for the default agent during onboarding", async () => {
  context.mocks.api(
    connectorManualGrantContract.connect,
    ({ body, params, respond }) => {
      expect(params.connectorSlug).toBe("ahrefs");
      expect(body.authMethod).toBe("api-token");
      expect(body.account).toStrictEqual({ intent: "add" });
      expect(body.authorizeAgent).toBeTruthy();
      expect(body.agentId).toBeUndefined();
      return respond(200, {
        id: "11111111-1111-4111-8111-111111111112",
        slug: "ahrefs",
        authMethod: "api-token",
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    },
  );
  mockOnboardingNeeded();
  await setupPage({
    context,
    path: "/onboarding?prompt=Track%20keyword%20rankings&connector=ahrefs",
  });

  click(
    await waitFor(() => {
      return buttonByText("Connect");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Ahrefs" });
  await fill(
    within(dialog).getByPlaceholderText("your-ahrefs-api-token"),
    "test-ahrefs-token",
  );
  click(buttonByText("Save"));

  await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("You've successfully connected with Ahrefs!"),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Ahrefs" })).toBeNull();
});

test("A presentation landing prompt starts a chat with its source context", async () => {
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  mockOnboardingNeeded();
  const params = new URLSearchParams({
    prompt: MARKETING_PRESENTATION_PROMPT,
    showcase: MARKETING_PRESENTATION_SHOWCASE,
    vm0_source: "presentation",
    landing_host: "www.okou.ai",
    landing_path: "/en/presentation",
    source_type: "direct",
  });

  await setupPage({
    context,
    path: `/onboarding?${params.toString()}`,
  });

  await expect(
    screen.findByRole("heading", { name: "Try this prompt" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
    MARKETING_PRESENTATION_PROMPT,
  );

  click(buttonByText("Next"));

  await waitFor(() => {
    expect(runPrompt).toBe(MARKETING_PRESENTATION_PROMPT);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
  const handoffParams = new URLSearchParams(search());
  expect(handoffParams.get("showcase")).toBe(MARKETING_PRESENTATION_SHOWCASE);
  expect(handoffParams.get("vm0_source")).toBe("presentation");
  expect(handoffParams.get("landing_host")).toBe("www.okou.ai");
  expect(handoffParams.get("landing_path")).toBe("/en/presentation");
  expect(handoffParams.get("source_type")).toBe("direct");
});

test("A selected website template survives first-time onboarding", async () => {
  const websiteTemplate = WEBSITE_TEMPLATE_ITEMS.find((item) => {
    return item.id === "website-template:warm-cards";
  });
  if (!websiteTemplate) {
    throw new Error("Expected the Warm Cards website template");
  }

  let websiteTemplateId: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      const template = templateFromUserMessage(body.userMessage);
      websiteTemplateId =
        template?.type === "website"
          ? template.selection.websiteTemplateId
          : undefined;
    },
  });
  mockOnboardingNeeded();
  const params = new URLSearchParams({
    prompt: "Build a warm launch page",
    template: websiteTemplate.id,
    showcase: websiteTemplate.previewUrl,
    vm0_source: "web_design",
  });

  await setupPage({
    context,
    path: `/onboarding?${params.toString()}`,
  });

  await expect(
    screen.findByRole("heading", { name: "Try this prompt" }),
  ).resolves.toBeInTheDocument();
  click(buttonByText("Next"));

  await waitFor(() => {
    expect(websiteTemplateId).toBe(websiteTemplate.id);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
  const handoffParams = new URLSearchParams(search());
  expect(handoffParams.get("showcase")).toBe(websiteTemplate.previewUrl);
  expect(handoffParams.get("vm0_source")).toBe("web_design");
});

test("An onboarded workspace runs a marketing deep link directly", async () => {
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  const params = new URLSearchParams({
    prompt: "Summarize this week's launch metrics",
    connector: "google-analytics,slack",
    vm0_source: "marketing",
    landing_path: "/en/workflow-automation-examples",
  });

  await setupPage({
    context,
    path: `/onboarding?${params.toString()}`,
  });

  await waitFor(() => {
    expect(runPrompt).toBe("Summarize this week's launch metrics");
    expect(pathname()).toMatch(/^\/chats\//u);
  });
  const handoffParams = new URLSearchParams(search());
  expect(handoffParams.get("connector")).toBeNull();
  expect(handoffParams.get("vm0_source")).toBe("marketing");
  expect(handoffParams.get("landing_path")).toBe(
    "/en/workflow-automation-examples",
  );
});

test("A presentation template can be previewed and selected from a deep link", async () => {
  const template = firstItem(PRESENTATION_TEMPLATE_PICKER_ITEMS);
  mockOnboardingNeeded();
  await setupPage({
    context,
    path: "/onboarding/presentation-template?choice=presentation",
  });

  await expect(
    screen.findByRole("heading", {
      name: "Pick a presentation template to start from",
    }),
  ).resolves.toBeInTheDocument();
  const templateButton = buttonByAriaLabel(
    `Select ${template.title} presentation template`,
  );
  expect(templateButton).toHaveAttribute("aria-pressed", "false");

  click(buttonByAriaLabel(`View ${template.title} presentation`));
  const preview = await screen.findByRole("dialog", {
    name: template.title,
  });
  click(buttonByAriaLabel("Show next slide", preview));
  expect(
    within(preview).getByAltText(`${template.title} slide 2`),
  ).toBeVisible();
  click(buttonByText("Select this template", preview));
  click(buttonByText("Continue"));

  await expect(
    screen.findByRole("heading", { name: "Fulfil your presentation" }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/onboarding/presentation-run");
  expect(
    screen.getByLabelText("Presentation content and instruction"),
  ).toBeVisible();
  expect(new URLSearchParams(search()).get("template")).toBe(template.slug);
});

test("An illustration template starts the chosen generation run", async () => {
  const template = firstItem(ILLUSTRATION_TEMPLATE_ITEMS);
  let runPrompt: string | undefined;
  let generationType: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
      generationType = templateTypeFromUserMessage(body.userMessage);
    },
  });

  mockOnboardingNeeded();
  await setupPage({
    context,
    path: "/onboarding/image-template?choice=images",
  });

  await expect(
    screen.findByRole("heading", {
      name: "Pick an illustration template to start from",
    }),
  ).resolves.toBeInTheDocument();
  chooseTemplate(template.title, "illustration");

  await expect(
    screen.findByRole("heading", {
      name: "Select one automation you would like to have a try",
    }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Custom illustration scene")).toBeVisible();
  click(buttonByText("Run now"));

  await waitFor(() => {
    expect(runPrompt).toContain(template.title);
    expect(generationType).toBe("illustration");
    expect(pathname()).toMatch(/^\/chats\//u);
  });
});

test("A video brief survives checkout cancellation and success", async () => {
  const template = firstItem(VIDEO_TEMPLATE_ITEMS);
  let successUrl: string | undefined;
  let cancelUrl: string | undefined;
  let runPrompt: string | undefined;
  let generationType: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
      generationType = templateTypeFromUserMessage(body.userMessage);
    },
  });
  context.mocks.api(
    billingUsagePackCheckoutContract.create,
    ({ body, respond }) => {
      successUrl = body.successUrl;
      cancelUrl = body.cancelUrl;
      return respond(200, {
        url: "https://checkout.stripe.com/test/onboarding-video",
      });
    },
  );
  context.mocks.api(billingCheckoutContract.complete, ({ respond }) => {
    return respond(200, { completed: true });
  });

  mockOnboardingNeeded();
  await setupPage({
    context,
    path: "/onboarding/video-template?choice=video",
  });

  await expect(
    screen.findByRole("heading", {
      name: "Pick a video template to start from",
    }),
  ).resolves.toBeInTheDocument();
  chooseTemplate(template.title, "video");

  await expect(
    screen.findByRole("heading", { name: "Customize your video" }),
  ).resolves.toBeInTheDocument();
  const videoBrief = "A".repeat(6000);
  await fill(screen.getByLabelText("Custom video prompt"), videoBrief);
  const upgradeButton = await waitFor(() => {
    return buttonByText("Upgrade Pro to run");
  });
  click(upgradeButton);

  await waitFor(() => {
    expect(window.location.href).toBe(
      "https://checkout.stripe.com/test/onboarding-video",
    );
  });
  expect(successUrl).toBeDefined();
  expect(cancelUrl).toBeDefined();
  if (!successUrl || !cancelUrl) {
    throw new Error("Expected onboarding checkout return URLs");
  }
  const success = new URL(successUrl);
  const canceled = new URL(cancelUrl);
  expect(successUrl.length).toBeLessThanOrEqual(5000);
  expect(cancelUrl.length).toBeLessThanOrEqual(5000);
  expect(success.pathname).toBe("/onboarding/video-run");
  expect(success.searchParams.get("template")).toBe(template.id);
  expect(success.searchParams.get("onboarding_template")).toBe(template.slug);
  expect(success.searchParams.has("prompt")).toBeFalsy();
  expect(success.searchParams.has("onboarding_note")).toBeFalsy();
  expect(success.searchParams.get("onboarding_billing_session_id")).toBe(
    "{CHECKOUT_SESSION_ID}",
  );
  expect(canceled.pathname).toBe("/onboarding/video-run");
  expect(canceled.searchParams.get("onboarding_billing")).toBe("canceled");
  expect(canceled.searchParams.has("prompt")).toBeFalsy();
  expect(canceled.searchParams.has("onboarding_note")).toBeFalsy();

  mockOnboardingNeeded();
  pushState(null, "", canceled);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await expect(
    screen.findByRole("heading", { name: "Customize your video" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Custom video prompt")).toHaveValue(videoBrief);

  success.searchParams.set(
    "onboarding_billing_session_id",
    "cs_test_onboarding_stored",
  );
  mockOnboardingNeeded();
  pushState(null, "", success);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() => {
    expect(runPrompt).toContain(videoBrief);
    expect(generationType).toBe("video");
    expect(pathname()).toMatch(/^\/chats\//u);
  });
});

test("Video onboarding offers Pro with an initial usage pack", async () => {
  const template = firstItem(VIDEO_TEMPLATE_ITEMS);
  let usagePackCheckoutBody:
    | {
        readonly tier: "pro" | "team";
        readonly memberUsagePacks: readonly MemberUsagePack[];
      }
    | undefined;
  context.mocks.api(
    billingUsagePackCheckoutContract.create,
    ({ body, respond }) => {
      usagePackCheckoutBody = body;
      return respond(200, {
        url: "https://checkout.stripe.com/test/usage-pack-onboarding-video",
      });
    },
  );

  mockOnboardingNeeded();
  await setupPage({
    context,
    path: "/onboarding/video-template?choice=video",
  });
  await expect(
    screen.findByRole("heading", {
      name: "Pick a video template to start from",
    }),
  ).resolves.toBeInTheDocument();
  chooseTemplate(template.title, "video");
  await expect(
    screen.findByRole("heading", { name: "Customize your video" }),
  ).resolves.toBeInTheDocument();
  await fill(
    screen.getByLabelText("Custom video prompt"),
    "A product launch video with a fast-paced opening.",
  );
  click(buttonByText("Upgrade Pro to run"));

  await waitFor(() => {
    expect(window.location.href).toBe(
      "https://checkout.stripe.com/test/usage-pack-onboarding-video",
    );
  });
  expect(usagePackCheckoutBody).toMatchObject({
    tier: "pro",
    memberUsagePacks: [{ memberId: "test-user-123", usagePackUsd: 20 }],
  });
});

test("A completed video checkout resumes onboarding and the run", async () => {
  const gtag = installGtagMock();
  const template = firstItem(VIDEO_TEMPLATE_ITEMS);
  let runPrompt: string | undefined;
  let generationType: string | undefined;
  let checkoutCompletionAttempts = 0;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
      generationType = templateTypeFromUserMessage(body.userMessage);
    },
  });
  context.mocks.api(billingCheckoutContract.complete, ({ respond }) => {
    checkoutCompletionAttempts += 1;
    return respond(
      200,
      checkoutCompletionAttempts >= 2
        ? {
            completed: true,
            googleAdsConversion: {
              googleAdsAccountId: "7935750692",
              transactionId: "in_onboarding_paid",
              valueUsd: 49,
            },
          }
        : { completed: false },
    );
  });
  mockOnboardingNeeded();
  const params = new URLSearchParams({
    choice: "video",
    prompt: "Create a launch video",
    template: template.id,
    onboarding_billing: "pro",
    onboarding_billing_session_id: "cs_test_onboarding",
  });

  await setupPage({
    context,
    path: `/onboarding/video-run?${params.toString()}`,
  });

  await waitFor(() => {
    expect(runPrompt).toBe("Create a launch video");
    expect(generationType).toBe("video");
    expect(checkoutCompletionAttempts).toBe(2);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
  expect(gtag).toHaveBeenCalledWith("event", "conversion", {
    send_to: ADSMARCH_PAID_IN_ONBOARDING_SEND_TO,
    value: 49,
    currency: "USD",
    transaction_id: "in_onboarding_paid",
  });
});

test("Missing checkout state recovers to video configuration", async () => {
  const template = firstItem(VIDEO_TEMPLATE_ITEMS);
  mockOnboardingNeeded();
  const params = new URLSearchParams({
    choice: "video",
    template: template.id,
    onboarding_template: template.slug,
    onboarding_billing: "pro",
    onboarding_billing_session_id: "cs_test_missing_storage",
    [ONBOARDING_CHECKOUT_STATE_PARAM]: "missing-state",
  });

  await setupPage({
    context,
    path: `/onboarding/video-run?${params.toString()}`,
  });

  await expect(
    screen.findByRole("heading", { name: "Customize your video" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Custom video prompt")).toHaveValue("");
});

test("An invalid template link returns to the matching picker", async () => {
  mockOnboardingNeeded();
  await setupPage({
    context,
    path: "/onboarding/image-run?template=missing-template",
  });

  await expect(
    screen.findByRole("heading", {
      name: "Pick an illustration template to start from",
    }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/onboarding/image-template");
});

test.each([
  {
    accountId: "1001302527",
    onboarding: [ONBOARDING_START_SEND_TO],
    checkout: [CHECKOUT_START_SEND_TO],
  },
  {
    accountId: "7935750692",
    onboarding: [ADSMARCH_ONBOARDING_START_SEND_TO],
    checkout: [ADSMARCH_CHECKOUT_START_SEND_TO],
  },
  { accountId: null, onboarding: [], checkout: [] },
])(
  "Onboarding and checkout route only to $accountId",
  async ({ accountId, onboarding, checkout }) => {
    const marketing = "https://www.okou.ai/api/marketing/acquisition";
    const observations: ObservedAcquisitionEvent[] = [];
    context.mocks.http.post(`${marketing}/events`, async ({ request }) => {
      const batch = marketingAcquisitionContract.events.body.parse(
        await request.json(),
      );
      observations.push(...batch.events);
      return Response.json({
        recorded: true,
        consented: true,
      });
    });
    context.mocks.api(
      acquisitionAttributionContract.resolveGoogleAdsAccount,
      ({ respond }) => {
        return respond(200, { googleAdsAccountId: accountId });
      },
    );
    const gtag = installGtagMock();
    const template = firstItem(VIDEO_TEMPLATE_ITEMS);
    mockChatLifecycle(context);
    context.mocks.api(billingCheckoutContract.create, ({ respond }) => {
      return respond(200, {
        url: "https://checkout.stripe.com/test/onboarding-video",
      });
    });

    mockOnboardingNeeded();
    await setupPage({
      context,
      path: "/onboarding/video-template?choice=video",
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.MarketingAcquisitionShadow]: true },
    });

    await expect(
      screen.findByRole("heading", {
        name: "Pick a video template to start from",
      }),
    ).resolves.toBeInTheDocument();

    await waitFor(() => {
      return expect(sentConversions(gtag)).toStrictEqual(onboarding);
    });
    chooseTemplate(template.title, "video");

    await expect(
      screen.findByRole("heading", { name: "Customize your video" }),
    ).resolves.toBeInTheDocument();
    await fill(
      screen.getByLabelText("Custom video prompt"),
      "A 20-second launch teaser for a habit-tracking app.",
    );
    click(
      await waitFor(() => {
        return buttonByText("Upgrade Pro to run");
      }),
    );

    await waitFor(() => {
      expect(window.location.href).toContain("checkout.stripe.com");
      expect(sentConversions(gtag)).toStrictEqual([...onboarding, ...checkout]);
    });
    await waitFor(() => {
      expect(
        observations.map((event) => {
          return event.name;
        }),
      ).toStrictEqual(
        expect.arrayContaining([
          "StepViewed",
          "CheckoutCreated",
          "RedirectToStripe",
        ]),
      );
    });
    for (const observation of observations) {
      expect(observation.properties).not.toHaveProperty("gclid");
      expect(observation.properties).not.toHaveProperty("ga_client_id");
    }
  },
);
