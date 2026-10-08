import dotenv from "dotenv";
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

import { resolveApiBackendUrl } from "./api-backend-url";

dotenv.config({ path: path.join(__dirname, "../.env.local") });

const apiUrl = resolveApiBackendUrl();

type PublicService = "api" | "app" | "www";

const SERVICE_LABELS = ["api", "app", "www"] as const;

export function deriveServiceOrigin(
  sourceUrl: string,
  service: PublicService,
): string {
  const url = new URL(sourceUrl);
  const labels = url.hostname.split(".");
  const firstLabel = labels[0];
  if (!firstLabel) {
    return url.origin;
  }

  if (SERVICE_LABELS.some((label) => label === firstLabel)) {
    labels[0] = service;
  } else {
    for (const label of SERVICE_LABELS) {
      const suffix = `-${label}`;
      if (firstLabel.endsWith(suffix)) {
        labels[0] = `${firstLabel.slice(0, -label.length)}${service}`;
        break;
      }
    }
  }

  url.hostname = labels.join(".");
  return url.origin;
}

export function deriveAppUrl(sourceUrl: string): string {
  return process.env.OKOU_APP_URL || deriveServiceOrigin(sourceUrl, "app");
}

const appUrl = deriveAppUrl(apiUrl);

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup",
  globalTeardown: "./global-teardown",
  reporter: process.env.CI
    ? [["list"], ["blob", { outputDir: "blob-report" }]]
    : "list",
  timeout: 120_000,
  use: {
    baseURL: appUrl,
    ignoreHTTPSErrors: true,
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chat-smoke",
      testMatch: "smoke.spec.ts",
    },
  ],
});
