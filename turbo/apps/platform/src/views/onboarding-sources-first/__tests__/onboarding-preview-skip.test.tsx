import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();
const PREVIEW_HOST = "pr-25304-app-okou-app-preview.vm0.workers.dev";
const DEFAULT_AGENT_CHAT = "/agents/c0000000-0000-4000-a000-000000000001/chat";
const INDUSTRY_QUESTION = "What kind of work do you do?";

function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

async function homeMessage(): Promise<HTMLElement> {
  const message = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(pathname()).toBe(DEFAULT_AGENT_CHAT);
  });
  expect(screen.queryByRole("heading", { name: INDUSTRY_QUESTION })).toBeNull();
  return message;
}

test("The authorized PR shortcut completes onboarding and opens home without a dummy request", async () => {
  mockOnboardingNeeded();
  let completionBypass: string | null = null;
  context.mocks.api(
    onboardingCompleteContract.complete,
    ({ request, respond }) => {
      completionBypass = request.headers.get("x-vercel-protection-bypass");
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
    host: PREVIEW_HOST,
    prPreview: true,
    path: "/onboarding?skipOnboarding=true&prompt=123&x-vercel-protection-bypass=preview-test&x-vercel-set-bypass-cookie=true",
  });

  await expect(homeMessage()).resolves.toHaveTextContent(/^$/u);
  const params = new URLSearchParams(search());
  expect(params.has("skipOnboarding")).toBeFalsy();
  expect(params.has("prompt")).toBeFalsy();
  expect(completionBypass).toBe("preview-test");
});

test("The onboarding guard carries the shortcut from an ordinary acceptance URL", async () => {
  mockOnboardingNeeded();

  await setupPage({
    context,
    host: PREVIEW_HOST,
    prPreview: true,
    path: "/agents?skipOnboarding=true",
  });

  await expect(homeMessage()).resolves.toHaveTextContent(/^$/u);
});

test("An invited member can complete their own onboarding with the PR shortcut", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: true,
    isAdmin: false,
  });

  await setupPage({
    context,
    host: PREVIEW_HOST,
    prPreview: true,
    path: "/onboarding?skipOnboarding=true",
  });

  await expect(homeMessage()).resolves.toHaveTextContent(/^$/u);
});

test("The shortcut also handles a direct link to a later onboarding step", async () => {
  mockOnboardingNeeded();

  await setupPage({
    context,
    host: PREVIEW_HOST,
    prPreview: true,
    path: "/onboarding/ready?skipOnboarding=true",
  });

  await expect(homeMessage()).resolves.toHaveTextContent(/^$/u);
});

test("An already-onboarded preview visitor still opens home without running the supplied prompt", async () => {
  await setupPage({
    context,
    host: PREVIEW_HOST,
    prPreview: true,
    path: "/onboarding?skipOnboarding=true&prompt=123",
  });

  await expect(homeMessage()).resolves.toHaveTextContent(/^$/u);
});

test.each([
  { host: PREVIEW_HOST, prPreview: undefined },
  { host: "staging-app.vm6.ai", prPreview: false },
  { host: "app.okou.ai", prPreview: true },
  { host: "localhost", prPreview: true },
])(
  "$host without both preview gates keeps ordinary onboarding",
  async ({ host, prPreview }) => {
    mockOnboardingNeeded();

    await setupPage({
      context,
      host,
      prPreview,
      path: "/onboarding?skipOnboarding=true",
    });

    await expect(
      screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/onboarding");
  },
);

test.each(["", "?skipOnboarding=false", "?skipOnboarding=1"])(
  "An authorized preview requires the exact opt-in value: %s",
  async (query) => {
    mockOnboardingNeeded();

    await setupPage({
      context,
      host: PREVIEW_HOST,
      prPreview: true,
      path: `/onboarding${query}`,
    });

    await expect(
      screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/onboarding");
  },
);

test("A failed completion shows the API error and keeps the normal onboarding flow available", async () => {
  mockOnboardingNeeded();
  const failureMessage = "Could not complete onboarding for this preview";
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: failureMessage },
    });
  });

  await setupPage({
    context,
    host: PREVIEW_HOST,
    prPreview: true,
    path: "/onboarding?skipOnboarding=true",
  });

  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe("/onboarding");
  expect(screen.getByText(failureMessage)).toBeInTheDocument();
});
