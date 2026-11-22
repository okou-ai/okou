import { expect, type Page } from "@playwright/test";

type AuthHeaders = Readonly<
  Record<"Authorization", string> &
    Partial<Record<"x-vercel-protection-bypass", string>>
>;

interface OnboardingFlowOptions {
  readonly appUrl: string;
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
    page.getByRole("heading", { name: "Make this task your own" }),
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
  return url.pathname === "/" || /^\/chats\/[^/]+$/.test(url.pathname);
}
