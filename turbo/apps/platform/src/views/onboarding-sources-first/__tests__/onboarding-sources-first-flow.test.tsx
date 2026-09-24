import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  onboardingCompleteContract,
  onboardingRecommendationContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import {
  listLocalStorageEntries,
  localStorageSignals,
} from "../../../signals/external/local-storage.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";
import {
  mockOnboardingConnectorCatalog,
  onboardingSourceItem,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const draftStorage = localStorageSignals("onboarding:sources-first-draft");
const completedDraftStorage = localStorageSignals(
  "onboarding:sources-first-draft",
);

const SOURCES_FIRST_ON = {
  [FeatureSwitchKey.OnboardingSourcesFirst]: true,
} as const;

const MAKE_QUESTION = "What do you want to make first";
const INDUSTRY_QUESTION = "What kind of work do you do?";
const SOURCES_QUESTION = "Connect a work tool";
const MARKETING_FIELD = "Marketing & content";
const READY_TITLE = "Start with a task that matters";
const PROFILE_TITLE = "Here's what we've learned about you";
const START_ACTION = "Start with Okou";
const HANDOFF_PROMPT = "Draft the launch plan";
function generatedProfile() {
  return {
    overview: "Your inbox has several conversations to keep moving.",
    professionalIdentity: ["You coordinate work through email"],
    communicationStyle: [],
    priorities: ["Keep important replies moving"],
  };
}

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

function mockMemberOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: false,
  });
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

test("The source-first steps stay unreachable while the switch is off", async () => {
  mockOnboardingNeeded();

  await setupPage({ context, locale: "en-US", path: ROUTES.onboardingSources });

  await expect(
    screen.findByRole("heading", { name: MAKE_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboarding);
});

test("The switch opens the field question on /onboarding and continues to the sources step", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Continue")).toBeDisabled();

  click(fieldRadio(MARKETING_FIELD));

  expect(
    JSON.parse(context.store.get(draftStorage.get$) ?? "null"),
  ).toMatchObject({
    orgId: "org_default",
    userId: "test-user-123",
    industry: "marketing",
  });

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
    featureSwitches: SOURCES_FIRST_ON,
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
    name: "Okouのデータ保護について",
    href: "https://www.okou.ai/ja/security",
  },
  {
    locale: "zh-Hant" as const,
    name: "瞭解 Okou 如何保護你的資料",
    href: "https://www.okou.ai/zh-Hant/security",
  },
])(
  "The source step links to the security page in $locale",
  async ({ locale, name, href }) => {
    mockOnboardingNeeded();
    mockCatalog();

    await setupPage({
      context,
      locale,
      path: ROUTES.onboardingSources,
      featureSwitches: SOURCES_FIRST_ON,
    });

    await waitFor(() => {
      const link = queryAllByRoleFast("link").find((candidate) => {
        return candidate.textContent?.trim() === name;
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
    featureSwitches: SOURCES_FIRST_ON,
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
    featureSwitches: SOURCES_FIRST_ON,
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

  await expect(
    screen.findByRole("heading", { name: PROFILE_TITLE }),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Keep important replies moving"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingProfile);
  click(getButtonByName("Continue"));

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

test("The profile step shows a skeleton until the shared context result arrives", async () => {
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
    featureSwitches: SOURCES_FIRST_ON,
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

  await screen.findByRole("heading", { name: PROFILE_TITLE });
  expect(
    screen.getByText("Creating your profile from your connected work…"),
  ).toBeInTheDocument();
  expect(getButtonByName("Continue")).toBeDisabled();

  releaseResult.resolve();
  await screen.findByText("Keep important replies moving");
  expect(
    screen.queryByText("Creating your profile from your connected work…"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("How you communicate")).not.toBeInTheDocument();
  click(getButtonByName("Continue"));
  await screen.findByRole("heading", { name: READY_TITLE });
  expect(screen.getByDisplayValue(generatedPrompt)).toBeInTheDocument();
});

test("A failed profile can be retried without losing the rest of onboarding", async () => {
  mockMemberOnboardingNeeded();
  mockCatalog({ connected: true });
  const failedJobId = "e8b94a61-0c73-4ba4-904a-45f6a9f7497e";
  const retriedJobId = "e8b94a61-0c73-4ba4-904a-45f6a9f7498e";
  const startedIndustries: string[] = [];
  context.mocks.api(
    onboardingRecommendationContract.start,
    ({ body, respond }) => {
      startedIndustries.push(body.industry);
      return respond(202, {
        jobId: startedIndustries.length === 1 ? failedJobId : retriedJobId,
        status: "pending",
      });
    },
  );
  context.mocks.api(
    onboardingRecommendationContract.get,
    ({ params, respond }) => {
      return params.jobId === failedJobId
        ? respond(200, { jobId: failedJobId, status: "failed" })
        : respond(200, {
            jobId: retriedJobId,
            status: "completed",
            recommendation: {
              kind: "task",
              title: "Clear the inbox",
              outcome: "Priority replies ready for review",
              prompt: "Draft replies to the most important messages.",
              profile: generatedProfile(),
            },
          });
    },
  );

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboarding,
    featureSwitches: SOURCES_FIRST_ON,
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

  await screen.findByRole("heading", { name: PROFILE_TITLE });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "We couldn't create your profile right now.",
  );
  click(getButtonByName("Try again"));
  await screen.findByText("Keep important replies moving");
  expect(startedIndustries).toStrictEqual(["marketing", "marketing"]);
  click(getButtonByName("Continue"));
  await screen.findByRole("heading", { name: READY_TITLE });
});

test("A direct profile visit without a selected positioning returns to the first step", async () => {
  mockMemberOnboardingNeeded();
  mockCatalog({ connected: true });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingProfile,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await screen.findByRole("heading", { name: INDUSTRY_QUESTION });
  expect(pathname()).toBe(ROUTES.onboarding);
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
  context.mocks.api(
    onboardingCompleteContract.complete,
    ({ query, respond }) => {
      completedFrom.push(pathname());
      expect(query?.modelProvider).toBeUndefined();
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

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
    featureSwitches: SOURCES_FIRST_ON,
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

test("A refreshed ready step keeps the industry, model choice, and edited request", async () => {
  mockOnboardingNeeded();
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  let sentIndustry: string | undefined;
  let sentProvider: string | undefined;
  context.mocks.api(
    onboardingCompleteContract.complete,
    ({ body, query, respond }) => {
      sentIndustry = body.industry;
      sentProvider = query?.modelProvider;
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
    featureSwitches: SOURCES_FIRST_ON,
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
  expect(sentProvider).toBe("claudeCode");
  expect(context.store.get(completedDraftStorage.get$)).toBeNull();
  expect(listLocalStorageEntries("onboarding:")).toStrictEqual([]);
});

test("A member's run reaches the first request without the admin-only completion", async () => {
  mockMemberOnboardingNeeded();
  mockCatalog({ connected: true });
  let runPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      runPrompt = body.prompt;
    },
  });
  let completions = 0;
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    completions += 1;
    return respond(200, {
      onboardingComplete: true,
      needsOnboarding: false,
    });
  });

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingReady,
    featureSwitches: SOURCES_FIRST_ON,
  });

  await expect(
    screen.findByRole("heading", { name: READY_TITLE }),
  ).resolves.toBeInTheDocument();

  await fill(
    screen.getByLabelText("Your starting prompt"),
    "Draft my meeting agenda",
  );
  click(getButtonByName(START_ACTION));

  await waitFor(() => {
    expect(runPrompt).toBe("Draft my meeting agenda");
  });
  // `POST /api/onboarding/complete` is admin-only, so a member run would only
  // ever collect a 403 from it.
  expect(completions).toBe(0);
  expect(listLocalStorageEntries("onboarding:")).toStrictEqual([]);
});

test("A step keeps the prompt handoff and redeem code it arrived with", async () => {
  mockOnboardingNeeded();
  mockCatalog();

  await setupPage({
    context,
    locale: "en-US",
    path: `${ROUTES.onboarding}?prompt=${encodeURIComponent(HANDOFF_PROMPT)}&redeemCode=LAUNCH50`,
    featureSwitches: SOURCES_FIRST_ON,
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
  expect(params.get("prompt")).toBe(HANDOFF_PROMPT);
  expect(params.get("redeemCode")).toBe("LAUNCH50");
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
    featureSwitches: SOURCES_FIRST_ON,
  });

  await waitFor(() => {
    expect(runPrompt).toBe(HANDOFF_PROMPT);
  });
});
