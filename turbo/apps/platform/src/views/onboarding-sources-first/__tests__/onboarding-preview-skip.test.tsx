import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  getAction,
  findAction,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
const context = testContext();
const preview = "pr-40584-app-okou-app-preview.vm0.workers.dev";
async function enter(host: string, path = "/onboarding") {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  await setupPage({ context, host, path });
}
const industry = "What kind of work do you do?";
test("onboarding-preview-skip-001 an admin skips the unanswered field question on the preview deployment", async () => {
  await enter(preview);
  await screen.findByRole("heading", { name: industry });
  click(getAction("button", "Skip"));
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/");
  expect(
    screen.queryByRole("heading", { name: industry }),
  ).not.toBeInTheDocument();
});
test.each([
  ["onboarding-preview-skip-005", "app.okou.ai"],
  ["onboarding-preview-skip-007", "localhost"],
])("%s requires an answer on %s", async (_id, host) => {
  await enter(host);
  await screen.findByRole("heading", { name: industry });
  expect(location.hostname).toBe(host);
  expect(queryAction("button", "Skip")).toBeNull();
  expect(getAction("button", "Continue")).toBeDisabled();
});
test("onboarding-preview-skip-009 the sources Skip requires confirmation before experience opens", async () => {
  await enter(preview, "/onboarding/sources");
  click(await findAction("button", "Skip"));
  const confirm = await findAction("button", "Skip for now");
  expect(screen.getByText("Put your everyday tools to work")).toBeVisible();
  expect(location.pathname).toBe("/onboarding/sources");
  click(confirm);
  await expect(
    screen.findByRole("heading", {
      name: "How would you like to start with Okou?",
    }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/onboarding/experience");
});
test("onboarding-preview-skip-010 a failed preview skip unlocks retry on the unanswered page", async () => {
  const release = context.mocks.deferred<void>();
  let retry = false;
  context.mocks.api(
    onboardingCompleteContract.complete,
    async ({ respond }) => {
      if (!retry) {
        await release.promise;
        return respond(500, {
          error: {
            code: "UNAVAILABLE",
            message: "Unable to finish preview onboarding",
          },
        });
      }
      context.mocks.data.onboardingStatus({
        needsOnboarding: false,
        onboardingComplete: true,
      });
      return respond(200, { needsOnboarding: false, onboardingComplete: true });
    },
  );
  await enter(preview);
  const skip = await findAction("button", "Skip");
  click(skip);
  try {
    await waitFor(() => {
      return expect(skip).toBeDisabled();
    });
    expect(skip).toHaveAttribute("aria-busy", "true");
    expect(location.pathname).toBe("/onboarding");
  } finally {
    release.resolve();
  }
  await expect(
    screen.findByText(/unable to finish preview onboarding/i),
  ).resolves.toBeVisible();
  expect(skip).toBeEnabled();
  expect(location.pathname).toBe("/onboarding");
  retry = true;
  click(skip);
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/");
});
test("onboarding-preview-skip-011 skipping the launch handoff opens an empty Home composer", async () => {
  const task = "Draft the launch plan";
  const messages: string[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    messages.push(body.prompt ?? "");
    return respond(201, { threadId: body.threadId ?? crypto.randomUUID() });
  });
  await enter(
    preview,
    "/onboarding?" +
      new URLSearchParams({ prompt: task, redeemCode: "PRO-LAUNCH" }),
  );
  await expect(
    screen.findByLabelText("Onboarding prompt"),
  ).resolves.toHaveValue(task);
  click(getAction("button", "Skip"));
  const box = await screen.findByRole("textbox", { name: "Message" });
  expect(box.textContent).toBe("");
  expect(location.pathname).toBe("/");
  expect(location.search).toBe("");
  expect(
    messages.some((prompt) => {
      return prompt.includes(task);
    }),
  ).toBeFalsy();
});
