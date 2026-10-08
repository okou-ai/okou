import { expect, type Page } from "@playwright/test";

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

/**
 * Onboards a fresh admin through the prompt handoff, the one onboarding path
 * that needs no connected work source: the prompt it brings completes
 * onboarding and starts the first chat with that request.
 */
export async function completePromptOnboarding(
  page: Page,
  options: OnboardingFlowOptions & { readonly prompt: string },
): Promise<void> {
  const onboardingUrl = new URL("/onboarding", options.appUrl);
  onboardingUrl.searchParams.set("prompt", options.prompt);
  await page.goto(onboardingUrl.toString(), {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { name: "Try this prompt" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Onboarding prompt")).toHaveValue(
    options.prompt,
  );
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await waitForChatPage(page, options.appUrl);
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
