// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  onboardingOAuth,
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";
import {
  receiveFirstChat,
  findSentPrompt,
} from "./onboarding-first-chat-test-helpers.ts";
const context = testContext();
test("onboarding-sources-first-telemetry-002 reports the owner's three page views and selected starting experience", async () => {
  const events = context.mocks.posthog().events;
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  await setupPage({ context, path: "/onboarding" });
  click(await screen.findByText("Marketing & content"));
  click(await findAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a work tool" });
  const next = await findAction("button", "Continue");
  await waitFor(() => {
    return expect(next).toBeEnabled();
  });
  click(next);
  click(await screen.findByText("Start with Okou"));
  click(await findAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Keep Okou a message away" });
  for (const [step, index] of [
    ["industry", 0],
    ["sources", 1],
    ["experience", 2],
  ] as const) {
    expect(events).toContainEqual(
      expect.objectContaining({
        name: "Onboarding: StepViewed",
        properties: expect.objectContaining({
          flow: "source_first",
          is_owner: true,
          step_key: step,
          step_index: index,
          step_count: 6,
        }),
      }),
    );
  }
  expect(events).not.toContainEqual(
    expect.objectContaining({
      name: "Onboarding: StepViewed",
      properties: expect.objectContaining({ step_key: "team" }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      name: "Onboarding: IndustrySelected",
      properties: expect.objectContaining({
        is_owner: true,
        industry: "marketing",
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      name: "Onboarding: ExperienceAnswered",
      properties: expect.objectContaining({
        is_owner: true,
        experienced: false,
        provider: "none",
      }),
    }),
  );
});
test("onboarding-sources-first-telemetry-005 records only edit metadata when starting the weekly summary", async () => {
  const events = context.mocks.posthog().events;
  const sent = receiveFirstChat(context);
  const text = "Summarise last week for me";
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({ context, path: "/onboarding/ready" });
  await fill(await screen.findByLabelText("Your first task"), text);
  click(await findAction("button", "Start my first task"));
  expect((await sent).prompt).toBe(text);
  await expect(findSentPrompt(text)).resolves.toBeVisible();
  for (const event of ["PromptEdited", "StartClicked"]) {
    expect(events).toContainEqual(
      expect.objectContaining({
        name: "Onboarding: " + event,
        properties: expect.objectContaining({
          is_owner: true,
          step_key: "ready",
          prompt_edited: true,
          prompt_length: text.length,
        }),
      }),
    );
  }
  expect(JSON.stringify(events)).not.toContain(text);
});
test("onboarding-sources-first-telemetry-003 opening Notion authorization from the grid reports the connected owner's account", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  const events = context.mocks.posthog().events;
  const auth = onboardingOAuth(context, "notion", "Notion");
  await setupPage({ context, path: "/onboarding/sources" });
  click(await findAction("button", "Connect Notion"));
  await expect(auth.started).resolves.toStrictEqual({
    slug: "notion",
    intent: "add",
  });
  await waitFor(() => {
    return expect(auth.popup.location.href).toBe(auth.url);
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  auth.authorize();
  await expect(
    screen.findByText("Connected", { exact: true }),
  ).resolves.toBeVisible();
  await expect(findAction("button", "Continue")).resolves.toBeEnabled();
  for (const name of ["SourceConnectStarted", "SourceConnected"]) {
    expect(events).toContainEqual(
      expect.objectContaining({
        name: "Onboarding: " + name,
        properties: expect.objectContaining({
          source_origin: "grid",
          connector_slug: "notion",
          step_key: "sources",
          is_owner: true,
        }),
      }),
    );
  }
});
