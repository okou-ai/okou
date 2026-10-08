import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import {
  onboardingCompleteContract,
  onboardingRecommendationContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { billingRedeemCodeContract } from "@okouai/api-contracts/contracts/billing";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@okouai/core/brand-presentation";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";
import {
  mockOnboardingConnectorCatalog,
  onboardingSourceItem,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const draftStorage = localStorageSignals("onboarding:sources-first-draft");

const INDUSTRY_QUESTION = "What kind of work do you do?";
const SOURCES_QUESTION = "Connect a work tool";
const MARKETING_FIELD = "Marketing & content";
const READY_TITLE = "Start with a task that matters";
const START_ACTION = "Start with Okou";
/** The preset request for a marketer with Gmail connected. */
const FALLBACK_REQUEST =
  "Find recurring customer questions in my Gmail emails from the past week and turn them into five social post ideas.";
const HANDOFF_PROMPT = "Draft the launch plan";
const PROMPT_TITLE = "Try this prompt";
const PROMPT_INTRO =
  "Okou is the work assistant for you and your team. It turns scattered information into finished work, in the cloud.";
const COMPLIANCE_TITLE = "Okou’s compliance, built for your trust";
function generatedProfile() {
  return {
    overview: "Your inbox has several conversations to keep moving.",
    professionalIdentity: ["You coordinate work through email"],
    communicationStyle: [],
    priorities: ["Keep important replies moving"],
  };
}

function templateFromUserMessage(document: UserMessageDocument | undefined) {
  const part = document?.parts.find((candidate) => {
    return candidate.type === "template";
  });
  return part?.type === "template" ? part.template : undefined;
}

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

/**
 * What the API answers an invited member who has neither
 * finished their own run nor started using the workspace: onboarding is
 * theirs to do, while `onboardingComplete` stays the organization's answer —
 * here the owner has already set the workspace up.
 */
function mockMemberOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: true,
    isAdmin: false,
  });
  // Slack is not in the workspace yet, and a member cannot add it.
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: false,
      installUrl: null,
      connectUrl: null,
    });
  });
}

/**
 * Completion answers at once, while the onboarding status read the handoff to
 * the first chat waits on is held until the test releases it.
 */
function holdChatHandoffAfterCompletion(): {
  readonly handoffPending: Promise<void>;
  readonly release: () => void;
} {
  let completed = false;
  const handoffPending = context.mocks.deferred<void>();
  const releaseHandoff = context.mocks.deferred<void>();
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    completed = true;
    return respond(200, {
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });
  context.mocks.api(
    onboardingStatusContract.getStatus,
    async ({ respond, withSignal }) => {
      const finished = completed;
      if (finished) {
        handoffPending.resolve(undefined);
        await withSignal(releaseHandoff.promise);
      }
      return respond(200, {
        needsOnboarding: !finished,
        onboardingComplete: finished,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "c0000000-0000-4000-a000-000000000001",
        defaultAgentMetadata: { displayName: DEFAULT_AGENT_DISPLAY_NAME },
      });
    },
  );
  return {
    handoffPending: handoffPending.promise,
    release: () => {
      releaseHandoff.resolve(undefined);
    },
  };
}

/** A member cannot add Slack, so the step names who can and lets them go on. */
async function leaveSlackStepWithNotNow(): Promise<void> {
  await expect(
    screen.findByText("Ask a workspace admin to add Okou to Slack."),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingSlack);
  click(getButtonByName("Not now"));
}

/** One catalog entry, so the source step has a grid to render. */
function mockCatalog({
  connected = false,
}: {
  connected?: boolean;
} = {}): void {
  mockOnboardingConnectorCatalog(context, [
    onboardingSourceItem({
      slug: "gmail",
      label: "Gmail",
      description: "Connect Gmail to continue",
      connected,
    }),
  ]);
}

function getButtonByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
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

/** The control of the field card carrying `name`, as a user would aim at it. */
function fieldRadio(name: string): HTMLElement {
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

test("/onboarding opens the field question and continues to the sources step", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Continue")).toBeDisabled();

  click(fieldRadio(MARKETING_FIELD));

  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });

  click(getButtonByName("Continue"));

  // Keep the current question in place while the next route is being set up.
  // The full-screen app loader would otherwise flash over every step change.
  expect(
    screen.getByRole("heading", { name: INDUSTRY_QUESTION }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("status", { name: "Loading" }),
  ).not.toBeInTheDocument();

  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingSources);
  // Nothing is connected yet, so the one requirement of this step holds it.
  expect(getButtonByName("Continue")).toBeDisabled();

  click(getButtonByName("Back"));

  expect(
    screen.getByRole("heading", { name: SOURCES_QUESTION }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("status", { name: "Loading" }),
  ).not.toBeInTheDocument();

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboarding);
  // The answer survives the way back, so the field can be changed.
  expect(fieldRadio(MARKETING_FIELD)).toBeChecked();
});

test("The first step introduces Okou and its compliance progress", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "Okou is the work assistant for you and your team. It turns scattered information into finished work, in the cloud. Pick your field for a first task that fits.",
    ),
  ).toBeInTheDocument();
  const badges = Array.from(
    document.querySelectorAll('[data-slot="badge"]'),
  ).map((badge) => {
    return badge.textContent;
  });
  expect(badges).toStrictEqual([
    "SOC 2 Type IIIn progress",
    "CCPA / CPRACompliant",
    "GDPRCompliant",
    "HIPAAAligned",
    "ISO/IEC 27001Aligned",
  ]);
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === "Security details";
  });
  expect(link).toHaveAttribute("href", "https://www.okou.ai/en/security");
});

test.each([
  {
    locale: "ja-JP" as const,
    href: "https://www.okou.ai/ja/security",
  },
  {
    locale: "zh-Hant" as const,
    href: "https://www.okou.ai/zh-Hant/security",
  },
])(
  "The source step links to the security page in $locale",
  async ({ locale, href }) => {
    mockOnboardingNeeded();
    mockCatalog();

    await setupPage({
      context,
      locale,
      path: ROUTES.onboardingSources,
    });

    await waitFor(() => {
      const link = queryAllByRoleFast("link").find((candidate) => {
        return candidate.textContent?.trim() === "How Okou protects your data";
      });
      expect(link).toHaveAttribute("href", href);
    });
  },
);

test("A later step returns to the entry until a source is connected", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboarding);
});

test("Connected account context replaces the static starting prompt", async () => {
  mockMemberOnboardingNeeded();
  mockCatalog({ connected: true });
  // Installed after the catalog's slug route, so a status read lands here.
  let statusReads = 0;
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    statusReads += 1;
    return respond(200, { connectors: [] });
  });
  const jobId = "e8b94a61-0c73-4ba4-904a-45f6a9f7493e";
  const generatedPrompt =
    "Review my recent Gmail workload, group the messages that need a reply, and draft the three most important responses for my approval.";
  let startBody: unknown;
  context.mocks.api(
    onboardingRecommendationContract.start,
    ({ body, respond }) => {
      startBody = body;
      return respond(202, { jobId, status: "pending" });
    },
  );
  let pollCount = 0;
  context.mocks.api(onboardingRecommendationContract.get, ({ respond }) => {
    pollCount += 1;
    return pollCount === 1
      ? respond(200, { jobId, status: "running" })
      : respond(200, {
          jobId,
          status: "completed",
          recommendation: {
            kind: "task",
            title: "Clear the replies that matter",
            outcome: "Three priority responses ready for review",
            prompt: generatedPrompt,
            profile: generatedProfile(),
          },
        });
  });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
  });

  click(fieldRadio(MARKETING_FIELD));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", {
      name: "How would you like to start with Okou?",
    }),
  ).resolves.toBeInTheDocument();
  click(fieldRadio("I'm new to AI agents"));
  click(getButtonByName("Continue"));
  await leaveSlackStepWithNotNow();

  await expect(
    screen.findByText("Clear the replies that matter"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByDisplayValue(generatedPrompt)).toBeInTheDocument();
  expect(startBody).toStrictEqual({
    industry: "marketing",
    locale: "en-US",
  });
  expect(pollCount).toBe(2);
  // Every step reads the onboarding sources, never the full catalog status.
  expect(statusReads).toBe(0);
});

test("The ready step shows the generated request once the shared context result arrives", async () => {
  mockMemberOnboardingNeeded();
  mockCatalog({ connected: true });
  const jobId = "e8b94a61-0c73-4ba4-904a-45f6a9f7496e";
  const releaseResult = context.mocks.deferred<void>();
  const generatedPrompt = "Draft replies to the most important messages.";
  context.mocks.api(onboardingRecommendationContract.start, ({ respond }) => {
    return respond(202, { jobId, status: "pending" });
  });
  context.mocks.api(
    onboardingRecommendationContract.get,
    async ({ respond }) => {
      await releaseResult.promise;
      return respond(200, {
        jobId,
        status: "completed",
        recommendation: {
          kind: "task",
          title: "Clear the inbox",
          outcome: "Priority replies ready for review",
          prompt: generatedPrompt,
          profile: generatedProfile(),
        },
      });
    },
  );

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
  });

  click(fieldRadio(MARKETING_FIELD));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  click(getButtonByName("Continue"));
  await screen.findByRole("heading", { name: SOURCES_QUESTION });
  click(getButtonByName("Continue"));
  await screen.findByRole("heading", {
    name: "How would you like to start with Okou?",
  });
  click(fieldRadio("I'm new to AI agents"));
  click(getButtonByName("Continue"));
  await leaveSlackStepWithNotNow();

  await screen.findByRole("heading", { name: READY_TITLE });
  expect(screen.queryByDisplayValue(generatedPrompt)).not.toBeInTheDocument();

  releaseResult.resolve();
  await expect(
    screen.findByDisplayValue(generatedPrompt),
  ).resolves.toBeInTheDocument();
});

test("A failed recommendation leaves the preset request on the ready step", async () => {
  mockMemberOnboardingNeeded();
  mockCatalog({ connected: true });
  const failedJobId = "e8b94a61-0c73-4ba4-904a-45f6a9f7497e";
  context.mocks.api(onboardingRecommendationContract.start, ({ respond }) => {
    return respond(202, { jobId: failedJobId, status: "pending" });
  });
  context.mocks.api(onboardingRecommendationContract.get, ({ respond }) => {
    return respond(200, { jobId: failedJobId, status: "failed" });
  });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
  });

  click(fieldRadio(MARKETING_FIELD));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  click(getButtonByName("Continue"));
  await screen.findByRole("heading", { name: SOURCES_QUESTION });
  click(getButtonByName("Continue"));
  await screen.findByRole("heading", {
    name: "How would you like to start with Okou?",
  });
  click(fieldRadio("I'm new to AI agents"));
  click(getButtonByName("Continue"));
  await leaveSlackStepWithNotNow();

  await screen.findByRole("heading", { name: READY_TITLE });
  await expect(
    screen.findByDisplayValue(FALLBACK_REQUEST),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName(START_ACTION)).toBeEnabled();
});

test("The ready step completes onboarding once, before it runs the first request", async () => {
  mockOnboardingNeeded();
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  // Where the browser still was when completion went out, so the order of the
  // two is observable rather than assumed.
  const completedFrom: string[] = [];
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    completedFrom.push(pathname());
    context.mocks.data.onboardingStatus({
      needsOnboarding: false,
      onboardingComplete: true,
    });
    return respond(200, {
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
  });

  await expect(
    screen.findByRole("heading", { name: READY_TITLE }),
  ).resolves.toBeInTheDocument();

  click(getButtonByName(START_ACTION));

  await waitFor(() => {
    expect(runPrompt).toBeTruthy();
  });
  expect(completedFrom).toStrictEqual([ROUTES.onboardingReady]);
});

test("A refreshed ready step keeps the industry and edited request", async () => {
  mockOnboardingNeeded();
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  let sentIndustry: string | undefined;
  context.mocks.api(
    onboardingCompleteContract.complete,
    ({ body, respond }) => {
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
    path: ROUTES.onboardingReady,
  });

  await expect(
    screen.findByRole("heading", { name: READY_TITLE }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Your starting prompt")).toHaveValue(
    "Draft my launch plan",
  );

  click(getButtonByName(START_ACTION));
  await waitFor(() => {
    expect(runPrompt).toBe("Draft my launch plan");
  });
  expect(sentIndustry).toBe("marketing");
});

test("The ready step keeps the request on screen until the first chat opens", async () => {
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  const handoff = holdChatHandoffAfterCompletion();
  context.store.set(
    draftStorage.set$,
    JSON.stringify({
      version: 2,
      orgId: "org_default",
      userId: "test-user-123",
      industry: "marketing",
      experienced: true,
      provider: null,
      startingPromptDraft: "Draft my launch plan",
      startingPromptKey: "marketing:gmail",
      recommendationJobId: null,
      recommendationStartedAt: null,
    }),
  );

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
  });

  await expect(
    screen.findByRole("heading", { name: READY_TITLE }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName(START_ACTION));
  await handoff.handoffPending;

  expect(screen.getByLabelText("Your starting prompt")).toHaveValue(
    "Draft my launch plan",
  );

  handoff.release();
  await waitFor(() => {
    expect(runPrompt).toBe("Draft my launch plan");
    expect(pathname()).toMatch(/^\/chats\//u);
  });
});

test("A member runs every step but the invite, then completes their own onboarding and enters chat", async () => {
  mockMemberOnboardingNeeded();
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  const completedFrom: string[] = [];
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    completedFrom.push(pathname());
    // The member is done; the organization's answer is the owner's, unchanged.
    context.mocks.data.onboardingStatus({ needsOnboarding: false });
    return respond(200, {
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
  });

  click(fieldRadio(MARKETING_FIELD));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  click(getButtonByName("Continue"));
  await screen.findByRole("heading", { name: SOURCES_QUESTION });
  click(getButtonByName("Continue"));

  // Straight from the sources to the AI question: no invite step.
  await screen.findByRole("heading", {
    name: "How would you like to start with Okou?",
  });
  expect(pathname()).toBe(ROUTES.onboardingExperience);
  expect(
    screen.queryByLabelText("Team member’s email"),
  ).not.toBeInTheDocument();
  click(fieldRadio("I'm new to AI agents"));
  click(getButtonByName("Continue"));

  await leaveSlackStepWithNotNow();

  await screen.findByRole("heading", { name: READY_TITLE });
  await fill(
    screen.getByLabelText("Your starting prompt"),
    "Draft my meeting agenda",
  );
  click(getButtonByName(START_ACTION));

  await waitFor(() => {
    expect(runPrompt).toBe("Draft my meeting agenda");
  });
  // Completion went out from the last step, before the first request.
  expect(completedFrom).toStrictEqual([ROUTES.onboardingReady]);
  expect(pathname()).not.toMatch(/^\/onboarding/);
});

test("A step keeps the redeem code it arrived with", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?redeemCode=LAUNCH50`,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();

  click(fieldRadio(MARKETING_FIELD));
  await waitFor(() => {
    expect(getButtonByName("Continue")).toBeEnabled();
  });
  click(getButtonByName("Continue"));

  await expect(
    screen.findByRole("heading", { name: SOURCES_QUESTION }),
  ).resolves.toBeInTheDocument();
  const params = new URLSearchParams(search());
  expect(params.get("redeemCode")).toBe("LAUNCH50");
});

test("A new user who brings a prompt tries it on the source-first flow's single step", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?prompt=${encodeURIComponent(HANDOFF_PROMPT)}`,
  });

  await expect(
    screen.findByRole("heading", { name: PROMPT_TITLE }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
    HANDOFF_PROMPT,
  );
  // The first question's introduction and compliance beside the prompt.
  expect(screen.getByText(PROMPT_INTRO)).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: COMPLIANCE_TITLE }),
  ).toBeInTheDocument();
  // The source-first flow's filling track, as one step of one.
  expect(
    screen.getAllByRole("progressbar", { name: "Step 1 of 1" }).length,
  ).toBeGreaterThan(0);
  expect(getButtonByName("Next")).toBeEnabled();
  expect(
    screen.queryByRole("heading", { name: INDUSTRY_QUESTION }),
  ).not.toBeInTheDocument();
});

test("A prompt that asks for a connector shows its Connect card", async () => {
  mockOnboardingNeeded();

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?prompt=${encodeURIComponent("Review last week's Google Ads campaign performance")}&connector=google-ads`,
  });

  await expect(
    screen.findByRole("heading", { name: PROMPT_TITLE }),
  ).resolves.toBeInTheDocument();
  // The source step's own card, connected from anywhere on it.
  await waitFor(() => {
    expect(getButtonByName("Connect Google Ads")).toBeEnabled();
  });
  expect(
    screen.getByText("Manage Google Ads campaigns and reports."),
  ).toBeInTheDocument();
});

test("The sheet's connector card connects the tool the prompt link names", async () => {
  mockOnboardingNeeded();
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ params, respond }) => {
      expect(params.connectorSlug).toBe("ahrefs");
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

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?prompt=${encodeURIComponent("Track keyword rankings")}&connector=ahrefs`,
  });

  click(
    await waitFor(() => {
      return getButtonByName("Connect Ahrefs");
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Ahrefs" });
  await fill(
    within(dialog).getByPlaceholderText("your-ahrefs-api-token"),
    "test-ahrefs-token",
  );
  click(getButtonByName("Save", dialog));

  await expect(screen.findByText("Connected")).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
    "Track keyword rankings",
  );
});

test("A prompt with a showcase carries the showcase into the chat", async () => {
  const showcase = "https://cdn.vm0.io/artifacts/example/launch-deck.html";
  mockOnboardingNeeded();
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  const params = new URLSearchParams({ prompt: HANDOFF_PROMPT, showcase });

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?${params.toString()}`,
  });

  await expect(
    screen.findByRole("heading", { name: PROMPT_TITLE }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Next"));

  await waitFor(() => {
    expect(runPrompt).toBe(HANDOFF_PROMPT);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
  expect(new URLSearchParams(search()).get("showcase")).toBe(showcase);
});

test("The prompt step completes onboarding, then runs the prompt as edited", async () => {
  const editedPrompt = "Draft the launch plan for the EU market";
  mockOnboardingNeeded();
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  // Where the browser still was when completion went out, so the order of the
  // two is observable rather than assumed.
  const completedFrom: string[] = [];
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    completedFrom.push(pathname());
    context.mocks.data.onboardingStatus({
      needsOnboarding: false,
      onboardingComplete: true,
    });
    return respond(200, {
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?prompt=${encodeURIComponent(HANDOFF_PROMPT)}`,
  });

  await expect(
    screen.findByRole("heading", { name: PROMPT_TITLE }),
  ).resolves.toBeInTheDocument();
  await fill(screen.getByLabelText("Onboarding prompt"), editedPrompt);
  click(getButtonByName("Next"));

  await waitFor(() => {
    expect(runPrompt).toBe(editedPrompt);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
  expect(completedFrom).toStrictEqual([ROUTES.onboarding]);
});

test("The prompt step keeps the edited prompt on screen until the first chat opens", async () => {
  const editedPrompt = "Draft the launch plan for the EU market";
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  const handoff = holdChatHandoffAfterCompletion();

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?prompt=${encodeURIComponent(HANDOFF_PROMPT)}`,
  });

  await expect(
    screen.findByRole("heading", { name: PROMPT_TITLE }),
  ).resolves.toBeInTheDocument();
  await fill(screen.getByLabelText("Onboarding prompt"), editedPrompt);
  click(getButtonByName("Next"));
  await handoff.handoffPending;

  expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(editedPrompt);

  handoff.release();
  await waitFor(() => {
    expect(runPrompt).toBe(editedPrompt);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
});

test("A prompt link's template carries into the first request", async () => {
  const websiteTemplate = WEBSITE_TEMPLATE_ITEMS[0];
  if (!websiteTemplate) {
    throw new Error("Expected a website template");
  }
  mockOnboardingNeeded();
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
  const params = new URLSearchParams({
    prompt: HANDOFF_PROMPT,
    template: websiteTemplate.id,
  });

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?${params.toString()}`,
  });

  await expect(
    screen.findByRole("heading", { name: PROMPT_TITLE }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Next"));

  await waitFor(() => {
    expect(websiteTemplateId).toBe(websiteTemplate.id);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
});

test("A prompt link's redeem code is redeemed before completion and left out of the chat", async () => {
  mockOnboardingNeeded();
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  const requests: string[] = [];
  context.mocks.api(billingRedeemCodeContract.create, ({ body, respond }) => {
    requests.push(`redeem:${body.code}`);
    return respond(200, { redeemed: true });
  });
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    requests.push("complete");
    context.mocks.data.onboardingStatus({
      needsOnboarding: false,
      onboardingComplete: true,
    });
    return respond(200, {
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?prompt=${encodeURIComponent(HANDOFF_PROMPT)}&redeemCode=%20LAUNCH50%20`,
  });

  await expect(
    screen.findByRole("heading", { name: PROMPT_TITLE }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Next"));

  await waitFor(() => {
    expect(runPrompt).toBe(HANDOFF_PROMPT);
    expect(pathname()).toMatch(/^\/chats\//u);
  });
  expect(requests).toStrictEqual(["redeem:LAUNCH50", "complete"]);
  expect(new URLSearchParams(search()).has("redeemCode")).toBeFalsy();
});

test("A later source-first step opened with a prompt goes back to the prompt page", async () => {
  mockOnboardingNeeded();
  mockCatalog({ connected: true });

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboardingSources}?prompt=${encodeURIComponent(HANDOFF_PROMPT)}`,
  });

  await expect(
    screen.findByRole("heading", { name: PROMPT_TITLE }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboarding);
  expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
    HANDOFF_PROMPT,
  );
});

test("An invited member who brings a prompt still runs the source-first flow", async () => {
  mockMemberOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?prompt=${encodeURIComponent(HANDOFF_PROMPT)}`,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
});

test("A blank prompt still opens the source-first flow", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?prompt=%20%20`,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
});

test("An already-onboarded visitor is forwarded with the prompt they brought", async () => {
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboardingSources}?prompt=${encodeURIComponent(HANDOFF_PROMPT)}`,
  });

  await waitFor(() => {
    expect(runPrompt).toBe(HANDOFF_PROMPT);
  });
});
