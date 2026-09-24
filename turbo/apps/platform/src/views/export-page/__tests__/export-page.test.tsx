import {
  userExportContract,
  type UserExportStatusResponse,
} from "@okouai/api-contracts/contracts/user-export";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const EXPORT_JOB_ID = "11111111-1111-4111-8111-111111111111";

function runningJob() {
  return {
    id: EXPORT_JOB_ID,
    status: "running" as const,
    createdAt: "2026-09-01T00:00:00.000Z",
    completedAt: null,
    expiresAt: null,
    downloadUrl: null,
    error: null,
  };
}

function runningExport(): UserExportStatusResponse {
  return {
    job: runningJob(),
    canExport: false,
    nextExportAt: "2026-09-02T00:00:00.000Z",
  };
}

function completedExport(downloadUrl: string): UserExportStatusResponse {
  return {
    ...runningExport(),
    job: {
      ...runningJob(),
      status: "completed",
      completedAt: "2026-09-01T00:05:00.000Z",
      expiresAt: "2026-09-02T00:05:00.000Z",
      downloadUrl,
    },
  };
}

function mockCompletedExport(canExport: boolean): void {
  context.mocks.api(userExportContract.get, ({ respond }) => {
    return respond(200, {
      job: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "completed",
        createdAt: "2026-08-31T23:00:00.000Z",
        completedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-09-02T12:00:00.000Z",
        downloadUrl: "https://downloads.example/export.zip",
        error: null,
      },
      canExport,
      nextExportAt: canExport ? null : "2026-09-02T00:00:00.000Z",
    });
  });
}

function getButton(name: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function getDownloadLink(name: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Download link not found: ${name}`);
  }
  return link;
}

test("A completed export shows its contents, expiry, and cooldown", async () => {
  mockNow(NOW, context.signal);
  mockCompletedExport(true);
  context.mocks.api(userExportContract.post, ({ respond }) => {
    return respond(429, {
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Export cooldown is active",
      },
    });
  });

  await setupPage({ context, path: "/export", host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Export data" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Your chat threads")).toBeInTheDocument();
  expect(screen.getByText("Your chat messages")).toBeInTheDocument();
  expect(
    screen.getByText("Instructions for agents you can access"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Instructions for workflows you can access"),
  ).toBeInTheDocument();
  expect(screen.getByText("Your current memory files")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Artifact, attachment, and workflow supporting files are not included.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText("The download link expires in 1d 12h."),
  ).toBeInTheDocument();
  expect(getDownloadLink("Download export")).toHaveAttribute(
    "href",
    "https://downloads.example/export.zip",
  );

  click(getButton("Export again"));

  await expect(
    screen.findByText("You can export once every 24 hours."),
  ).resolves.toBeInTheDocument();
});

test("Starting an export keeps its progress visible during refresh and offers the completed download", async () => {
  mockNow(NOW, context.signal);
  const refreshing = context.mocks.deferred<void>();
  const complete = context.mocks.deferred<void>();
  let phase: "ready" | "running" | "refreshing" = "ready";
  context.mocks.api(userExportContract.get, async ({ respond }) => {
    if (phase === "ready") {
      return respond(200, { job: null, canExport: true, nextExportAt: null });
    }
    if (phase === "running") {
      phase = "refreshing";
      return respond(200, runningExport());
    }
    refreshing.resolve();
    await complete.promise;
    return respond(200, completedExport("https://downloads.example/new.zip"));
  });
  context.mocks.api(userExportContract.post, ({ respond }) => {
    phase = "running";
    return respond(202, { jobId: EXPORT_JOB_ID, status: "pending" });
  });

  await setupPage({ context, path: "/export", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Ready to export" }),
  ).resolves.toBeInTheDocument();
  click(getButton("Export my data"));

  await refreshing.promise;
  await expect(
    screen.findByRole("heading", { name: "Preparing your export" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Checking export status")).not.toBeInTheDocument();
  complete.resolve();
  await waitFor(() => {
    expect(getDownloadLink("Download export")).toHaveAttribute(
      "href",
      "https://downloads.example/new.zip",
    );
  });
});
