import { errors, expect, type Page } from "@playwright/test";

import { apiFailureMessage } from "./api-response";

import {
  captureClerkReadiness,
  describeClerkReadiness,
} from "./clerk-readiness";

const VIDEO_TEMPLATE_BOOTSTRAP_TIMEOUTS_MS = [15_000, 30_000] as const;

type AuthHeaders = Readonly<
  Record<"Authorization", string> &
    Partial<Record<"x-vercel-protection-bypass", string>>
>;

interface OnboardingFlowOptions {
  readonly appUrl: string;
}

interface RunnerOrganizationReadinessOptions {
  readonly apiUrl: string;
  readonly clerkSessionToken: string;
  readonly vercelAutomationBypassSecret?: string;
}

export function authHeadersForToken(
  token: string,
  bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
): AuthHeaders {
  return {
    Authorization: `Bearer ${token}`,
    ...(bypassSecret
      ? { "x-vercel-protection-bypass": bypassSecret }
      : undefined),
  };
}

/**
 * The onboarding status route synchronously creates the fresh organization's
 * default agent, limited-free entitlement, and onboarding credit grant.
 */
export async function ensureRunnerOrganizationReady(
  options: RunnerOrganizationReadinessOptions,
): Promise<void> {
  const response = await fetch(
    new URL("/api/onboarding/status", options.apiUrl),
    {
      headers: authHeadersForToken(
        options.clerkSessionToken,
        options.vercelAutomationBypassSecret,
      ),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Runner organization onboarding status failed with HTTP ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (cause) {
    throw new Error(
      "Runner organization onboarding status returned invalid JSON",
      {
        cause,
      },
    );
  }

  if (!isReadyRunnerOrganization(body)) {
    throw new Error(
      "Runner organization onboarding status did not return a ready admin organization",
    );
  }
}

export async function completeExploreOnboarding(
  page: Page,
  options: OnboardingFlowOptions,
): Promise<void> {
  await openOnboarding(page, options);
  await submitExploreOnboarding(page);
  await waitForChatPage(page, options.appUrl);
}

export async function startVideoOnboardingCheckout(
  page: Page,
  options: OnboardingFlowOptions & { readonly apiUrl: string },
): Promise<void> {
  await openOnboarding(page, options);
  // The primary video choice now completes onboarding and opens the in-product
  // template picker. Keep paid checkout coverage on the supported legacy deep
  // link instead.
  const videoTemplateUrl = new URL(
    "/onboarding/video-template?choice=video",
    options.appUrl,
  );
  await openVideoTemplatePicker(page, videoTemplateUrl);
  expect(new URL(page.url()).pathname).toBe("/onboarding/video-template");

  // The template pickers no longer pre-select a default, so a template must be
  // chosen before Continue becomes enabled.
  const videoTemplate = page
    .getByRole("button", { name: /video template$/iu })
    .first();
  await expect(videoTemplate).toBeVisible({ timeout: 30_000 });
  await videoTemplate.click();
  await expect(videoTemplate).toHaveAttribute("aria-pressed", "true");

  await clickOnboardingButton(page, /^Continue$/i);
  await expect(
    page.getByRole("heading", { name: /customize your video/i }),
  ).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/onboarding/video-run");

  const apiOrigin = new URL(options.apiUrl).origin;
  const [response] = await Promise.all([
    page.context().waitForEvent("response", {
      predicate: (response) => {
        const url = new URL(response.url());
        return (
          url.origin === apiOrigin &&
          url.pathname === "/api/billing/usage-pack-checkout" &&
          response.request().method() === "POST"
        );
      },
      timeout: 60_000,
    }),
    clickOnboardingButton(page, /^Upgrade Pro to run$/i),
  ]);
  if (!response.ok()) {
    throw new Error(
      apiFailureMessage(
        "Create onboarding checkout",
        response.status(),
        response.request().headers()["x-client-request-id"] ?? null,
        response.headers()["retry-after"] ?? null,
      ),
    );
  }
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 60_000 });
}

async function openVideoTemplatePicker(page: Page, url: URL): Promise<void> {
  const heading = page.getByRole("heading", {
    name: /pick a video template to start from/i,
  });

  for (const [
    attempt,
    timeout,
  ] of VIDEO_TEMPLATE_BOOTSTRAP_TIMEOUTS_MS.entries()) {
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    try {
      await heading.waitFor({ state: "visible", timeout });
      return;
    } catch (error: unknown) {
      if (!(error instanceof errors.TimeoutError)) {
        throw error;
      }

      const report = await captureClerkReadiness(page);
      const currentUrl = new URL(page.url());
      const shouldRetry =
        attempt < VIDEO_TEMPLATE_BOOTSTRAP_TIMEOUTS_MS.length - 1 &&
        currentUrl.origin === url.origin &&
        currentUrl.pathname === url.pathname &&
        report.kind === "observed" &&
        report.state.bootstrapSkeleton === "active";
      if (shouldRetry) {
        console.warn(
          `[e2e] Authenticated app bootstrap stalled; retrying video-template navigation. Observed Clerk state: ${describeClerkReadiness(report)}`,
        );
        continue;
      }

      throw new Error(
        `Timed out waiting for the video-template page to render. Observed Clerk state: ${describeClerkReadiness(report)}`,
        { cause: error },
      );
    }
  }
}

export async function waitForPaidOnboardingCompletion(
  page: Page,
  options: OnboardingFlowOptions,
): Promise<URL> {
  const configuredAppOrigin = new URL(options.appUrl).origin;
  const deadline = Date.now() + 180_000;

  while (true) {
    const currentUrl = new URL(page.url());
    if (
      currentUrl.origin === configuredAppOrigin &&
      isPromptOrChatUrl(currentUrl)
    ) {
      return currentUrl;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out waiting for paid onboarding to complete in ${configuredAppOrigin}; current URL is ${page.url()}`,
      );
    }

    await page.waitForTimeout(Math.min(1_000, remainingMs));
  }
}

async function openOnboarding(
  page: Page,
  options: OnboardingFlowOptions,
): Promise<void> {
  const onboardingUrl = new URL("/onboarding", options.appUrl);
  const currentUrl = new URL(page.url());
  const canReuseAppPage =
    currentUrl.origin === onboardingUrl.origin &&
    currentUrl.pathname === "/onboarding";

  if (!canReuseAppPage) {
    await page.goto(onboardingUrl.toString(), {
      waitUntil: "domcontentloaded",
    });
  }
  await expect(
    page.getByRole("heading", { name: "What do you want to make first" }),
  ).toBeVisible({ timeout: 60_000 });
  expect(new URL(page.url()).pathname).toBe("/onboarding");
}

async function submitExploreOnboarding(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "What do you want to make first" }),
  ).toBeVisible({ timeout: 60_000 });
  await chooseMakeOption(page, "I will explore on my own");
}

async function chooseMakeOption(page: Page, name: string): Promise<void> {
  await page
    .getByRole("group", { name: "First project type" })
    .getByRole("button", { name })
    .click();
}

async function clickOnboardingButton(page: Page, name: RegExp): Promise<void> {
  const button = page.getByRole("button", { name }).last();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
}

async function waitForChatPage(page: Page, appUrl: string): Promise<void> {
  const appOrigin = new URL(appUrl).origin;
  await page.waitForURL((url) => url.origin === appOrigin && isChatUrl(url), {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
}

function isChatUrl(url: URL): boolean {
  return /^\/(?:agents\/[^/]+\/chat|chats\/[^/]+)$/.test(url.pathname);
}

function isPromptOrChatUrl(url: URL): boolean {
  return url.pathname === "/prompt" || isChatUrl(url);
}

function isReadyRunnerOrganization(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "hasOrg" in value &&
    value.hasOrg === true &&
    "isAdmin" in value &&
    value.isAdmin === true &&
    "hasDefaultAgent" in value &&
    value.hasDefaultAgent === true &&
    "defaultAgentId" in value &&
    typeof value.defaultAgentId === "string" &&
    value.defaultAgentId.length > 0
  );
}
