import { test, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { onboardingDraftContract } from "@okouai/api-contracts/contracts/onboarding";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  findAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";
const context = testContext();
const stepKey = "okou_onboarding:sources-first-step";
const draftKey = "okou_onboarding:sources-first-draft";
const identity = { userId: "test-user-123", orgId: "org_default" } as const;
function answers(text: string) {
  return {
    industry: "marketing" as const,
    experienced: false,
    provider: null,
    startingPromptDraft: text,
    startingPromptKey: "edited",
    startingPromptOutput: null,
    recommendationJobId: null,
    recommendationStartedAt: null,
  };
}
function browserDraft(step: string, text = "", orgId: string = identity.orgId) {
  const member = { ...identity, orgId };
  const browser = new Storage();
  vi.stubGlobal("localStorage", browser);
  browser.setItem(stepKey, JSON.stringify({ ...member, step }));
  browser.setItem(
    draftKey,
    JSON.stringify({ ...member, version: 2, ...answers(text) }),
  );
  return browser;
}
function newcomer() {
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}
test("onboarding-progress-001 resuming sources keeps redemption through a trip back to the work question", async () => {
  newcomer();
  browserDraft("sources");
  await setupPage({ context, path: "/?redeemCode=RESUME" });
  await screen.findByRole("heading", { name: "Connect a work tool" });
  expect(new URL(location.href).searchParams.get("redeemCode")).toBe("RESUME");
  click(getAction("button", "Back"));
  await screen.findByRole("heading", { name: "What kind of work do you do?" });
  click(await findAction("button", "Continue"));
  await expect(
    screen.findByRole("heading", { name: "Connect a work tool" }),
  ).resolves.toBeVisible();
  expect(new URL(location.href).searchParams.get("redeemCode")).toBe("RESUME");
});
test("onboarding-progress-003 a clean browser restores the task saved on another device", async () => {
  newcomer();
  const text = "Restore this task from my other device";
  context.mocks.api(onboardingDraftContract.get, ({ respond }) => {
    return respond(200, {
      draft: {
        revision: crypto.randomUUID(),
        step: "ready",
        answers: answers(text),
      },
    });
  });
  await setupPage({ context, path: "/onboarding" });
  await expect(
    screen.findByRole("heading", { name: /start your first task/i }),
  ).resolves.toBeVisible();
  expect(screen.getByLabelText("Your first task")).toHaveValue(text);
  expect(location.pathname).toBe("/onboarding/ready");
});
test("onboarding-progress-004 acknowledged migration clears both browser records and preserves the edited launch plan", async () => {
  newcomer();
  const text = "Draft my launch plan";
  const browser = browserDraft("ready", text);
  const held = context.mocks.deferred<unknown>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(onboardingDraftContract.get, ({ respond }) => {
    return respond(200, { draft: null });
  });
  context.mocks.api(onboardingDraftContract.save, async ({ body, respond }) => {
    if (!held.settled()) {
      held.resolve(body);
    }
    await release.promise;
    return respond(200, { revision: crypto.randomUUID() });
  });
  try {
    await setupPage({ context, path: "/onboarding" });
    await expect(
      screen.findByLabelText("Your first task"),
    ).resolves.toHaveValue(text);
    await expect(held.promise).resolves.toMatchObject({
      step: "ready",
      revision: null,
      answers: { startingPromptDraft: text },
    });
    expect(browser.getItem(stepKey)).not.toBeNull();
    expect(browser.getItem(draftKey)).not.toBeNull();
  } finally {
    release.resolve();
  }
  await waitFor(() => {
    expect(browser.getItem(draftKey)).toBeNull();
    expect(browser.getItem(stepKey)).toBeNull();
  });
});
test("onboarding-progress-006 an explicit work-tool URL overrides the saved ready step", async () => {
  newcomer();
  browserDraft("ready", "Draft my launch plan");
  await setupPage({ context, path: "/onboarding/sources" });
  await expect(
    screen.findByRole("heading", { name: "Connect a work tool" }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/onboarding/sources");
});
test("onboarding-progress-008 the invited Gmail member resumes at experience from a legacy team bookmark", async () => {
  context.mocks.data.onboardingStatus({
    isAdmin: false,
    needsOnboarding: true,
    onboardingComplete: true,
  });
  browserDraft("team");
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  await setupPage({ context, path: "/onboarding" });
  await expect(
    screen.findByRole("heading", {
      name: "How would you like to start with Okou?",
    }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/onboarding/experience");
});
test("onboarding-progress-011 another workspace's progress cannot choose the member's starting step", async () => {
  newcomer();
  browserDraft("ready", "Other workspace task", "org_other");
  await setupPage({ context, path: "/onboarding" });
  await expect(
    screen.findByRole("heading", { name: "What kind of work do you do?" }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/onboarding");
});
test("onboarding-progress-014 completed onboarding opens the Home composer despite stored ready progress", async () => {
  browserDraft("ready", "Draft my launch plan");
  context.mocks.data.onboardingStatus({
    needsOnboarding: false,
    onboardingComplete: true,
  });
  await setupPage({ context, path: "/" });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/");
});
