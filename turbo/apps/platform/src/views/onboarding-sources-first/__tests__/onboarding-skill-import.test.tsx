// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { onboardingOAuth } from "./onboarding-catalog-test-helpers.ts";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  receiveFirstChat,
  findSentPrompt,
} from "./onboarding-first-chat-test-helpers.ts";
import { expect, test } from "vitest";
import { screen, waitFor, cleanup, within } from "@testing-library/react";
import { skillImportSessionsContract } from "@okouai/api-contracts/contracts/skill-import";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import { mockOnboardingDraft } from "../../../__tests__/mock-onboarding-draft.ts";
import {
  findAction,
  getAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
const context = testContext();
function newcomer() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}
const label = "Skill import prompt";
function arrivingSkill() {
  let uploaded = false;
  const workflow = {
    id: crypto.randomUUID(),
    agentId: "c0000000-0000-4000-a000-000000000001",
    agentName: null,
    agentDisplayName: null,
    name: "weekly-budget",
    displayName: "Weekly budget",
    description: "Review a weekly budget",
    visibility: "private",
    ownerUserId: "test-user-123",
    canManage: true,
    canPublish: false,
    official: null,
    importSource: null,
    createdAt: "2026-11-01T00:00:00Z",
  } as const;
  context.mocks.api(skillImportSessionsContract.listSkills, ({ respond }) => {
    return respond(200, uploaded ? [workflow] : []);
  });
  return () => {
    uploaded = true;
    context.mocks.ably.trigger("skillImportChanged");
  };
}
async function chooseCodex() {
  await setupPage({ context, path: "/onboarding/experience" });
  click(await screen.findByRole("radio", { name: /Codex/i }));
  click(await findAction("button", "Continue"));
}
test("onboarding-skill-import-001 copying the mobile import session and receiving a skill unlocks chat-app choice", async () => {
  newcomer();
  context.mocks.browser.matchMedia((q) => {
    return q === "(width < 640px)";
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const arrive = arrivingSkill();
  await chooseCodex();
  await waitFor(() => {
    return expect(getAction("button", "Copy import prompt")).toBeEnabled();
  });
  click(getAction("button", "Copy import prompt"));
  await waitFor(() => {
    return expect(clipboard.writes).toContainEqual(
      expect.stringContaining("vm0_skillimport_mock-session-token"),
    );
  });
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("skillImportChanged"),
    ).toBeTruthy();
  });
  arrive();
  await expect(
    screen.findByRole("heading", { name: "Your skills are in Okou" }),
  ).resolves.toBeVisible();
  click(await findAction("button", "Continue"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding/slack");
  });
  await expect(findAction("button", "Not now")).resolves.toBeVisible();
});
async function selectClaudeForImport() {
  await setupPage({ context, path: "/onboarding/experience" });
  click(await screen.findByText("Claude Code"));
  click(await findAction("button", "Continue"));
  await screen.findByLabelText(label);
}
test("onboarding-skill-import-003 refreshing the skills step restores the same member's Claude Code draft", async () => {
  newcomer();
  const saved = mockOnboardingDraft(context);
  await selectClaudeForImport();
  await waitFor(() => {
    return expect(saved()).toMatchObject({
      step: "skills",
      answers: { provider: "claudeCode" },
    });
  });
  cleanup();
  const replacement = createTestRuntime(context);
  await setupPage({ context: replacement, path: "/onboarding/skills" });
  await expect(screen.findByLabelText(label)).resolves.toHaveTextContent(
    "~/.claude/skills/",
  );
  expect(location.pathname).toBe("/onboarding/skills");
  await expect(
    screen.findByText(/saved skills in Claude Code/),
  ).resolves.toBeVisible();
});
test("onboarding-skill-import-004 another member cannot inherit the previous member's local Claude Code choice", async () => {
  newcomer();
  await selectClaudeForImport();
  cleanup();
  const replacement = createTestRuntime(context);
  await setupPage({
    context: replacement,
    path: "/onboarding/experience",
    auth: { user: { id: "user-second", fullName: "Second Member" } },
  });
  await expect(findAction("button", "Continue")).resolves.toBeDisabled();
  for (const option of [/Claude Code/, /Codex/, /Start with Okou/]) {
    expect(screen.getByRole("radio", { name: option })).not.toBeChecked();
  }
});
test("onboarding-skill-import-005 the Codex guide copies the full private upload instruction and excludes its token from analytics", async () => {
  newcomer();
  const events = context.mocks.posthog().events;
  const clipboard = context.mocks.browser.clipboardWriteText();
  await chooseCodex();
  const block = await screen.findByLabelText(label);
  const prompt = block.textContent;
  expect(prompt).toMatch(/^Import my local personal skills into Okou\./);
  expect(prompt).toContain("vm0_skillimport_mock-session-token");
  expect(prompt).toContain("https://api.okou.test/api/skill-import/skills");
  expect(prompt).toContain("~/.codex/skills/");
  expect(prompt).toContain("<Git repository root>/.codex/skills/");
  expect(prompt).not.toContain("~/.claude/skills/");
  expect(
    within(
      await screen.findByRole("list", { name: /where to run/i }),
    ).getByText("New chat"),
  ).toBeVisible();
  click(await findAction("button", "Copy prompt"));
  await waitFor(() => {
    return expect(clipboard.writes).toContain(prompt);
  });
  await waitFor(() => {
    return expect(events).toContainEqual(
      expect.objectContaining({
        name: "Onboarding: PromptCopied",
        properties: expect.objectContaining({ is_owner: true }),
      }),
    );
  });
  expect(JSON.stringify(events)).not.toContain(
    "vm0_skillimport_mock-session-token",
  );
});
test("onboarding-skill-import-011 leaving skills releases its subscription and returning restores the imported result and original prompt", async () => {
  newcomer();
  const arrive = arrivingSkill();
  await chooseCodex();
  const prompt = (await screen.findByLabelText(label)).textContent;
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("skillImportChanged"),
    ).toBeTruthy();
  });
  arrive();
  await expect(screen.findByText("Weekly budget")).resolves.toBeVisible();
  click(getAction("button", "Back"));
  await screen.findByRole("radio", { name: /Codex/i });
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("skillImportChanged"),
    ).toBeFalsy();
  });
  click(await findAction("button", "Continue"));
  await expect(screen.findByText("Weekly budget")).resolves.toBeVisible();
  expect((await screen.findByLabelText(label)).textContent).toBe(prompt);
});
test("onboarding-skill-import-007 completing the first task after connecting Gmail and skipping optional steps sends the marketing industry", async () => {
  newcomer();
  const gmail = onboardingOAuth(context, "gmail", "Gmail");
  const industry = context.mocks.deferred<string | null | undefined>();
  const sent = receiveFirstChat(context);
  context.mocks.api(
    onboardingCompleteContract.complete,
    ({ body, respond }) => {
      if (!industry.settled()) {
        industry.resolve(body.industry);
      }
      context.mocks.data.onboardingStatus({
        needsOnboarding: false,
        onboardingComplete: true,
      });
      return respond(200, { needsOnboarding: false, onboardingComplete: true });
    },
  );
  await setupPage({ context, path: "/onboarding" });
  click(await screen.findByText("Marketing & content"));
  click(await findAction("button", "Continue"));
  click(await findAction("button", "Connect Gmail"));
  await waitFor(() => {
    return expect(gmail.popup.location.href).toBe(gmail.url);
  });
  gmail.authorize();
  await waitFor(() => {
    return expect(getAction("button", "Continue")).toBeEnabled();
  });
  click(getAction("button", "Continue"));
  click(await screen.findByText("Codex"));
  click(await findAction("button", "Continue"));
  await screen.findByLabelText(label);
  click(await findAction("button", "Not now"));
  await screen.findByRole("heading", { name: "Keep Okou a message away" });
  click(await findAction("button", "Not now"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding/capabilities");
  });
  click(await findAction("button", "Continue"));
  const text = "Summarize this week's launch.";
  await fill(await screen.findByLabelText("Your first task"), text);
  click(await findAction("button", "Start my first task"));
  await expect(industry.promise).resolves.toBe("marketing");
  expect((await sent).prompt).toBe(text);
  await expect(findSentPrompt(text)).resolves.toBeVisible();
});
