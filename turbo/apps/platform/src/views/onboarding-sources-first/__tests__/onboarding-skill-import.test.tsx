import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  SKILL_IMPORT_LIMITS,
  skillImportSessionsContract,
} from "@okouai/api-contracts/contracts/skill-import";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import {
  workflowsCollectionContract,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { pathname } from "../../../signals/location.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();
const draftStorage = localStorageSignals("onboarding:sources-first-draft");
const completedDraftStorage = localStorageSignals(
  "onboarding:sources-first-draft",
);

const SOURCES_FIRST_ON = {
  [FeatureSwitchKey.OnboardingSourcesFirst]: true,
} as const;

const EXPERIENCE_QUESTION = "Have you used Codex or Claude Code?";
const SKILLS_QUESTION = "Bring the skills you already wrote.";
const SKILLS_ARRIVED_TITLE = "Your skills are in Okou";
const SLACK_QUESTION = "Give Okou a job without leaving Slack.";
const CODEX_CARD = "Codex";
const PROMPT_LABEL = "Skill import prompt";
/** The prompt's own opening line, as the user's agent would read it. */
const PROMPT_OPENING = "Import my local skills into Okou.";
const WAITING_FOR_SKILLS = "Imported skills appear here as they arrive.";
/** The token the mocked session hands out, which only the prompt carries. */
const SESSION_TOKEN = "vm0_skillimport_mock-session-token";
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const SKILL_DISPLAY_NAME = "Weekly report";
const SKILL_NAME = "weekly-report";
/** A skill on another agent, which this step is not importing into. */
const OTHER_AGENT_SKILL = "Someone else's skill";

/** One connected source, which every step after the source step requires. */
function mockConnectedSource(): void {
  const connector: PublicConnectorCatalogStatusItem = {
    slug: "gmail",
    label: "Gmail",
    description: "Connect Gmail to continue",
    icon: {
      url: "https://icons.example.test/onboarding-gmail.svg",
      invertInDarkMode: false,
    },
    category: "productivity",
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
    connected: true,
    connectionStatus: "connected",
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

function workflow(entry: {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly displayName: string;
}): WorkflowSummary {
  return {
    id: entry.id,
    agentId: entry.agentId,
    agentName: null,
    agentDisplayName: null,
    name: entry.name,
    displayName: entry.displayName,
    description: "What last week looked like",
    visibility: "private",
    ownerUserId: "test-user-123",
    createdAt: "2026-09-21T10:00:00.000Z",
    canManage: true,
    canPublish: false,
    official: null,
  };
}

function importedSkill(): WorkflowSummary {
  return workflow({
    id: "d0000000-0000-4000-a000-000000000011",
    agentId: DEFAULT_AGENT_ID,
    name: SKILL_NAME,
    displayName: SKILL_DISPLAY_NAME,
  });
}

/** A private workflow on an agent this run never imports into. */
function otherAgentSkill(): WorkflowSummary {
  return workflow({
    id: "d0000000-0000-4000-a000-000000000012",
    agentId: OTHER_AGENT_ID,
    name: "someone-elses-skill",
    displayName: OTHER_AGENT_SKILL,
  });
}

/**
 * The workflow list the step polls, scoped by agent the way the route is: the
 * test decides what the user's own Codex or Claude Code session has written.
 */
function mockAgentWorkflows(): {
  readonly write: (workflows: readonly WorkflowSummary[]) => void;
} {
  let workflows: readonly WorkflowSummary[] = [];
  context.mocks.api(workflowsCollectionContract.list, ({ query, respond }) => {
    const agentId = query.agentId;
    return respond(
      200,
      agentId === undefined
        ? [...workflows]
        : workflows.filter((candidate) => {
            return candidate.agentId === agentId;
          }),
    );
  });
  return {
    write: (next) => {
      workflows = next;
    },
  };
}

function getButtonByName(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

async function waitForContinueEnabled(): Promise<void> {
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
}

/** The control of the answer card carrying `name`, as a user would aim at it. */
function answerRadio(name: string): HTMLElement {
  const card = screen.getByText(name).closest("label");
  if (!card) {
    throw new Error(`Expected the "${name}" choice card`);
  }
  const radio = queryAllByRoleFast("radio", card)[0];
  if (!radio) {
    throw new Error(`Expected the "${name}" radio`);
  }
  return radio;
}

function onboardingEvent(name: string, properties: Record<string, unknown>) {
  return expect.objectContaining({
    name: `Onboarding: ${name}`,
    properties: expect.objectContaining(properties),
  });
}

/**
 * The step after this one reads its org's Slack and Teams installations, so a
 * run that continues into it needs both to answer.
 */
function mockChatChannelInstalls(): void {
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: "https://slack.example.test/oauth/install",
      connectUrl: null,
      scopeMismatch: false,
      reinstallUrl: null,
      workspaceName: null,
    });
  });
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      connectUrl: "/api/teams/oauth/connect?orgId=org_default",
    });
  });
}

/**
 * The skills step belongs to the branch a plan answer opens, so the run walks
 * into it the way a person does.
 */
async function openSkillsStep(
  provider: "Codex" | "Claude Code" = CODEX_CARD,
  fromStart = false,
): Promise<void> {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  mockConnectedSource();
  mockChatChannelInstalls();

  await setupPage({
    context,
    locale: "en-US",
    path: fromStart ? ROUTES.onboarding : ROUTES.onboardingExperience,
    host: "app.okou.ai",
    featureSwitches: SOURCES_FIRST_ON,
  });

  if (fromStart) {
    await screen.findByRole("heading", {
      name: "What kind of work do you do?",
    });
    click(answerRadio("Marketing & content"));
    await waitForContinueEnabled();
    click(getButtonByName("Continue"));
    await screen.findByRole("heading", {
      name: "Okou is for you, and shared across your whole team.",
    });
    click(getButtonByName("Continue"));
    await screen.findByRole("heading", {
      name: "Bring the people who do this work with you.",
    });
    click(getButtonByName("Not now"));
  }

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();

  click(answerRadio(provider));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SKILLS_QUESTION }),
  ).resolves.toBeInTheDocument();
}

test("The skills step requires a selected tool", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  mockConnectedSource();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingSkills,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingExperience);
});

test("Refreshing the skills step restores the chosen tool", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  mockConnectedSource();
  mockAgentWorkflows();
  // A fresh browser app starts with storage from the previous app lifetime.
  context.store.set(
    draftStorage.set$,
    JSON.stringify({
      version: 2,
      orgId: "org_default",
      userId: "test-user-123",
      industry: "marketing",
      experienced: true,
      provider: "claudeCode",
      startingPromptDraft: "Draft my launch plan",
      startingPromptKey: "marketing:gmail",
      recommendationJobId: null,
      recommendationStartedAt: null,
    }),
  );

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingSkills,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: SKILLS_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingSkills);
  expect(screen.getByText("Run this in Claude Code")).toBeInTheDocument();
});

test("A saved draft from another user cannot select the current user's tool", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  mockConnectedSource();
  context.store.set(
    draftStorage.set$,
    JSON.stringify({
      version: 2,
      orgId: "org_default",
      userId: "another-user",
      industry: "marketing",
      experienced: true,
      provider: "claudeCode",
      startingPromptDraft: "",
      startingPromptKey: "",
      recommendationJobId: null,
      recommendationStartedAt: null,
    }),
  );

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingExperience,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Continue")).toBeDisabled();
  expect(answerRadio("Claude Code")).not.toBeChecked();
});

test("The step hands over the prompt its session produced, and copies it whole", async () => {
  const posthog = context.mocks.posthog();
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockAgentWorkflows();

  await openSkillsStep();

  expect(screen.getByText("Run this in Codex")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Paste this prompt into your own Codex session and it brings the skills on your machine into Okou.",
    ),
  ).toBeInTheDocument();

  const prompt = await screen.findByRole("region", { name: PROMPT_LABEL });
  expect(prompt).toHaveTextContent(PROMPT_OPENING);
  // The prompt is what carries the session, so the token is in it and the
  // upload route it posts to is named.
  expect(prompt.textContent).toContain(SESSION_TOKEN);
  expect(prompt.textContent).toContain("/api/skill-import/skills");

  click(getButtonByName("Copy prompt"));

  await expect(screen.findByText("Copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([prompt.textContent]);
  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([
      onboardingEvent("ImportPromptShown", {
        flow: "source_first",
        step_key: "skills",
        route_path: ROUTES.onboardingSkills,
      }),
      onboardingEvent("PromptCopied", { step_key: "skills" }),
    ]),
  );
  // The token is the session; it belongs on the clipboard and nowhere else.
  expect(JSON.stringify(posthog.events)).not.toContain(SESSION_TOKEN);
});

test.each([
  {
    card: "Codex" as const,
    provider: "codex",
    fromStart: true,
    scenario: "full flow",
    expectedIndustry: "marketing",
  },
  {
    card: "Claude Code" as const,
    provider: "claudeCode",
    fromStart: true,
    scenario: "full flow",
    expectedIndustry: "marketing",
  },
  {
    card: "Claude Code" as const,
    provider: "claudeCode",
    fromStart: false,
    scenario: "resumed without an industry answer",
    expectedIndustry: undefined,
  },
])(
  "Finishing onboarding sends the selected $card model preference after a $scenario",
  async ({ card, provider, fromStart, expectedIndustry }) => {
    mockAgentWorkflows();
    mockChatLifecycle(context);
    let sentProvider: string | undefined;
    let sentIndustry: string | undefined;
    context.mocks.api(
      onboardingCompleteContract.complete,
      ({ query, body, respond }) => {
        sentProvider = query?.modelProvider;
        sentIndustry = body.industry;
        context.mocks.data.onboardingStatus({
          needsOnboarding: false,
          onboardingComplete: true,
        });
        return respond(200, {
          onboardingComplete: true,
          needsOnboarding: false,
        });
      },
    );

    await openSkillsStep(card, fromStart);
    click(getButtonByName("Continue"));
    await expect(
      screen.findByRole("heading", { name: SLACK_QUESTION }),
    ).resolves.toBeInTheDocument();
    click(getButtonByName("Skip for now"));
    await expect(
      screen.findByRole("heading", { name: "Okou is ready for you" }),
    ).resolves.toBeInTheDocument();
    expect(context.store.get(draftStorage.get$)).not.toBeNull();
    click(getButtonByName("Start with Okou"));
    await waitFor(() => {
      expect(sentProvider).toBe(provider);
    });
    expect(sentIndustry).toBe(expectedIndustry);
    await waitFor(() => {
      expect(context.store.get(completedDraftStorage.get$)).toBeNull();
    });
  },
);

test("A skill the import writes appears without the step being asked again", async () => {
  const posthog = context.mocks.posthog();
  const agentWorkflows = mockAgentWorkflows();

  await openSkillsStep();

  await expect(
    screen.findByText(WAITING_FOR_SKILLS),
  ).resolves.toBeInTheDocument();

  agentWorkflows.write([importedSkill(), otherAgentSkill()]);

  await expect(
    screen.findByText(SKILL_DISPLAY_NAME),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByRole("heading", { name: SKILLS_ARRIVED_TITLE }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(WAITING_FOR_SKILLS)).not.toBeInTheDocument();
  // The list is the org's default agent, not every workflow the user can see.
  expect(screen.queryByText(OTHER_AGENT_SKILL)).not.toBeInTheDocument();
  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([
      onboardingEvent("SkillImported", {
        step_key: "skills",
        imported_count: 1,
      }),
    ]),
  );
  // A skill's own name is the user's writing, so the funnel counts it instead.
  expect(JSON.stringify(posthog.events)).not.toContain(SKILL_NAME);
  expect(JSON.stringify(posthog.events)).not.toContain(SKILL_DISPLAY_NAME);

  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SLACK_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingSlack);
});

test("Coming back to the step keeps the prompt it already gave and what arrived", async () => {
  const agentWorkflows = mockAgentWorkflows();
  let issued = 0;
  context.mocks.api(skillImportSessionsContract.create, ({ respond }) => {
    issued += 1;
    return respond(200, {
      uploadUrl: "https://api.okou.test/api/skill-import/skills",
      // A second session would carry a token the pasted prompt does not have.
      token: `${SESSION_TOKEN}-${String(issued)}`,
      expiresAt: new Date(now() + 60 * 60 * 1000).toISOString(),
      limits: SKILL_IMPORT_LIMITS,
    });
  });

  await openSkillsStep();

  const prompt = await screen.findByRole("region", { name: PROMPT_LABEL });
  expect(prompt.textContent).toContain(`${SESSION_TOKEN}-1`);

  agentWorkflows.write([importedSkill()]);
  await expect(
    screen.findByText(SKILL_DISPLAY_NAME),
  ).resolves.toBeInTheDocument();

  click(getButtonByName("Back"));
  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SKILLS_ARRIVED_TITLE }),
  ).resolves.toBeInTheDocument();
  // The same session the person may already have pasted, and the skill it
  // wrote: the way back does not restart the import.
  const returned = await screen.findByRole("region", { name: PROMPT_LABEL });
  expect(returned.textContent).toContain(`${SESSION_TOKEN}-1`);
  expect(screen.getByText(SKILL_DISPLAY_NAME)).toBeInTheDocument();
});

test("The step can be left with nothing imported", async () => {
  const posthog = context.mocks.posthog();
  mockAgentWorkflows();

  await openSkillsStep();

  await expect(
    screen.findByText(WAITING_FOR_SKILLS),
  ).resolves.toBeInTheDocument();

  click(getButtonByName("Skip for now"));

  await expect(
    screen.findByRole("heading", { name: SLACK_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingSlack);
  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([onboardingEvent("Skip", { step_key: "skills" })]),
  );
});

test("A session that cannot be opened leaves the step passable and offers it again", async () => {
  mockAgentWorkflows();
  let attempts = 0;
  context.mocks.api(skillImportSessionsContract.create, ({ respond }) => {
    attempts += 1;
    if (attempts === 1) {
      return respond(403, {
        error: { message: "Skill import is not enabled", code: "FORBIDDEN" },
      });
    }
    return respond(200, {
      uploadUrl: "https://api.okou.test/api/skill-import/skills",
      token: SESSION_TOKEN,
      expiresAt: new Date(now() + 60 * 60 * 1000).toISOString(),
      limits: SKILL_IMPORT_LIMITS,
    });
  });

  await openSkillsStep();

  await expect(
    screen.findByText("The import session could not be opened."),
  ).resolves.toBeInTheDocument();
  // Nothing on this step is required, so a failure never holds the run back.
  expect(getButtonByName("Continue")).toBeEnabled();

  click(getButtonByName("Try again"));

  const prompt = await screen.findByRole("region", { name: PROMPT_LABEL });
  expect(prompt).toHaveTextContent(PROMPT_OPENING);
});
