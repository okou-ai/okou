import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const NOW = "2026-11-20T09:00:00.000Z";
const DOWNLOAD_URL = "https://exports.example.test/okou-export.zip?sig=abc";

test("A completed export shows its contents, expiry, and cooldown", async () => {
  const now = new Date(NOW);
  mockNow(now, context.signal);
  const expiresAt = new Date(now.getTime() + (24 + 12) * 60 * 60 * 1000);
  context.mocks.api(userExportContract.get, ({ respond }) => {
    return respond(200, {
      job: {
        id: "e0000000-0000-4000-a000-000000000a01",
        status: "completed",
        createdAt: "2026-11-20T08:00:00.000Z",
        completedAt: "2026-11-20T08:05:00.000Z",
        expiresAt: expiresAt.toISOString(),
        downloadUrl: DOWNLOAD_URL,
        error: null,
      },
      canExport: true,
      nextExportAt: null,
    });
  });
  // The API still enforces the 24-hour cooldown when a new export starts.
  context.mocks.api(userExportContract.post, ({ respond }) => {
    return respond(429, {
      error: { code: "RATE_LIMITED", message: "Export cooldown active" },
    });
  });
  await setupPage({ context, path: "/export" });
  const download = await screen.findByText("Download export");
  const page = document.querySelector<HTMLElement>("main") ?? document.body;
  for (const item of [
    "Your chat threads",
    "Your chat messages",
    "Instructions",
    "Instructions for workflows you can access",
    "Your current memory files",
    "Artifact, attachment, and workflow supporting files are not included.",
  ]) {
    expect(within(page).getByText(item)).toBeInTheDocument();
  }
  expect(download.closest("a")).toHaveAttribute("href", DOWNLOAD_URL);
  expect(
    within(page).getByText(/The download link expires in/u),
  ).toHaveTextContent("The download link expires in 1d 12h.");

  click(
    queryAllByRoleFast("button", page).find((button) => {
      return button.textContent?.trim() === "Export again";
    }) as HTMLElement,
  );

  await expect(
    screen.findByText("You can export once every 24 hours."),
  ).resolves.toBeInTheDocument();
});
