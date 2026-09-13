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

export const STORAGE_STATE = path.join(__dirname, ".auth/storage-state.json");
const appUrl = deriveAppUrl(apiUrl);
const retainBlobReport = process.env.PLAYWRIGHT_PROJECT !== "auth-v1";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup",
  globalTeardown: "./global-teardown",
  reporter:
    process.env.CI && retainBlobReport
      ? [["list"], ["blob", { outputDir: "blob-report" }]]
      : "list",
  timeout: 120_000,
  use: {
    baseURL: appUrl,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [
    {
      name: "setup",
      testMatch: "smoke.spec.ts",
    },
    {
      name: "paid-onboarding",
      testMatch: "paid-onboarding.spec.ts",
    },
    {
      name: "auth-v1",
      testMatch: "auth-v1.spec.ts",
      workers: 1,
      use: {
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
    {
      name: "features",
      testMatch: [
        "agents.spec.ts",
        "chat.spec.ts",
        "create-agent.spec.ts",
        "billing-payment.spec.ts",
        "workflows.spec.ts",
      ],
      dependencies: ["setup"],
      use: {
        storageState: STORAGE_STATE,
      },
    },
  ],
});
