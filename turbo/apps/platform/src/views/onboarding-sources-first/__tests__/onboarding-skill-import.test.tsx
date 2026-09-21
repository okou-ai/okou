import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  SKILL_IMPORT_LIMITS,
  skillImportSessionsContract,
} from "@okouai/api-contracts/contracts/skill-import";
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
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();

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
const SKILL_DISPLAY_NAME = "Weekly report";
const SKILL_NAME = "weekly-report";

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

function importedSkill(): WorkflowSummary {
  return {
    id: "d0000000-0000-4000-a000-000000000011",
    agentId: DEFAULT_AGENT_ID,
    agentName: null,
    agentDisplayName: null,
    name: SKILL_NAME,
    displayName: SKILL_DISPLAY_NAME,
    description: "What last week looked like",
    visibility: "private",
    ownerUserId: "test-user-123",
    createdAt: "2026-09-21T10:00:00.000Z",
    canManage: true,
    canPublish: false,
    official: null,
  };
}

/**
 * The agent's workflow list, as the step polls it: the test decides what the
 * user's own Codex or Claude Code session has written so far.
 */
function mockAgentWorkflows(): {
  readonly write: (workflows: readonly WorkflowSummary[]) => void;
  readonly requestedAgentIds: string[];
} {
  let workflows: readonly WorkflowSummary[] = [];
  const requestedAgentIds: string[] = [];
  context.mocks.api(workflowsCollectionContract.list, ({ query, respond }) => {
    if (query.agentId !== undefined) {
      requestedAgentIds.push(query.agentId);
    }
    return respond(200, [...workflows]);
  });
  return {
    write: (next) => {
      workflows = next;
    },
    requestedAgentIds,
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
 * The skills step belongs to the branch a plan answer opens, so the run walks
 * into it the way a person does.
 */
async function openSkillsStep(): Promise<void> {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockConnectedSource();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingExperience,
    host: "app.okou.ai",
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: EXPERIENCE_QUESTION }),
  ).resolves.toBeInTheDocument();

  click(answerRadio(CODEX_CARD));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SKILLS_QUESTION }),
  ).resolves.toBeInTheDocument();
}

test("The step hands over the prompt its session produced, and copies it whole", async () => {
  const posthog = context.mocks.posthog();
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockAgentWorkflows();

  await openSkillsStep();

  const prompt = await screen.findByLabelText(PROMPT_LABEL);
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

test("A skill the import writes appears without the step being asked again", async () => {
  const posthog = context.mocks.posthog();
  const agentWorkflows = mockAgentWorkflows();

  await openSkillsStep();

  await expect(
    screen.findByText(WAITING_FOR_SKILLS),
  ).resolves.toBeInTheDocument();

  agentWorkflows.write([importedSkill()]);

  await expect(
    screen.findByText(SKILL_DISPLAY_NAME),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByRole("heading", { name: SKILLS_ARRIVED_TITLE }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(WAITING_FOR_SKILLS)).not.toBeInTheDocument();
  // The list is read against the org's default agent, not every workflow the
  // user can see.
  expect(new Set(agentWorkflows.requestedAgentIds)).toStrictEqual(
    new Set([DEFAULT_AGENT_ID]),
  );
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

  const prompt = await screen.findByLabelText(PROMPT_LABEL);
  expect(prompt).toHaveTextContent(PROMPT_OPENING);
});
