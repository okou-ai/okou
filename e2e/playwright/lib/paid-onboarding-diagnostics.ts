import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type Page } from "@playwright/test";

import { captureClerkReadiness } from "./clerk-readiness";
import { collectStripeCheckoutState } from "./stripe-checkout";

export async function capturePaidOnboardingFailure(
  page: Page,
  credentialFileName: string,
  outputDirectory: string,
): Promise<void> {
  const diagnosticDirectory = join(
    outputDirectory,
    "e2e-runner-checkout-diagnostics",
  );
  const fileStem = credentialFileName.replace(/\.json$/u, "");
  await mkdir(diagnosticDirectory, { recursive: true });

  const results = await Promise.allSettled([
    writePaidOnboardingState(
      page,
      join(diagnosticDirectory, `${fileStem}.json`),
    ),
    page.screenshot({
      fullPage: true,
      path: join(diagnosticDirectory, `${fileStem}.png`),
      // A failure may happen after payment fields were filled. Mask controls
      // in every frame, including Stripe's embedded form and child card fields.
      mask: page
        .frames()
        .map((frame) => frame.locator("input, select, textarea")),
      timeout: 5_000,
    }),
  ]);
  if (!results.some((result) => result.status === "fulfilled")) {
    throw new Error("Unable to capture any paid onboarding diagnostic");
  }
}

async function writePaidOnboardingState(
  page: Page,
  path: string,
): Promise<void> {
  const [stripe, clerkReport] = await Promise.all([
    collectStripeCheckoutState(page).catch(() => null),
    captureClerkReadiness(page),
  ]);
  // Unlike app sign-in paths, Checkout pathnames carry a Session capability.
  // Keep only the origin here, and do not serialize a raw evaluation error.
  const clerk =
    clerkReport.kind === "observed"
      ? {
          kind: "observed",
          state: {
            ...clerkReport.state,
            route: new URL(page.url()).origin,
          },
        }
      : { kind: "unavailable" };
  await writeFile(path, `${JSON.stringify({ clerk, stripe }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
