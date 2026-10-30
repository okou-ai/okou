import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactRun,
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const report = artifactSummary(
  "a0000000-0000-4000-a000-000000000921",
  "file",
  "thread-report.txt",
);
const url = "https://cdn.vm7.io/artifacts/tests/deletion/thread-report.txt";

function mockReport(available: () => boolean) {
  const detail = fileArtifactDetail(report, {
    filename: report.title,
    contentType: "text/plain",
    fileId: "f0000000-0000-4000-a000-000000000921",
    url,
  });
  mockArtifactConversation(context, {
    catalog: [report],
    getDetail: () => {
      return available() ? detail : null;
    },
    artifactRuns: () => {
      return available()
        ? [
            artifactRun({
              artifactId: report.id,
              filename: report.title,
              contentType: "text/plain",
              fileId: "f0000000-0000-4000-a000-000000000921",
              url,
            }),
          ]
        : [];
    },
    chatEvents: [
      {
        id: "thread-report-message",
        role: "assistant",
        content: `![${report.title}](${url})`,
        runId: "navigation-artifact-run",
        seqId: 1,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
      {
        id: "thread-report-completed",
        role: "assistant",
        content: null,
        runId: "navigation-artifact-run",
        runLifecycleEvent: "completed",
        seqId: 2,
        createdAt: "2026-09-01T12:00:01.000Z",
      },
    ],
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: available() ? [report] : [],
      nextCursor: null,
    });
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text("Thread report content");
  });
}

test.each(["lightbox", "sidebar", "resources"] as const)(
  "a thread artifact can be deleted from the %s toolbar",
  async (surface) => {
    let removed = false;
    mockReport(() => {
      return !removed;
    });
    context.mocks.api(artifactCatalogContract.delete, ({ params, respond }) => {
      expect(params.artifactId).toBe(report.id);
      removed = true;
      return respond(200, { deleted: true });
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
      featureSwitches: {
        [FeatureSwitchKey.ArtifactDeletion]: true,
        [FeatureSwitchKey.ArtifactSidebarPreview]: surface === "sidebar",
      },
    });
    if (surface === "resources") {
      await openResourceArtifact(report.title);
    } else {
      click(
        await screen.findByLabelText(`Open text preview for ${report.title}`),
      );
    }
    const previewId =
      surface === "lightbox" ? "attachment-lightbox" : "artifact-sidebar";
    const preview = await screen.findByTestId(previewId);
    await expect(
      within(preview).findByText("Thread report content"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(buttonNamed("Delete", preview)).toBeEnabled();
    });
    click(buttonNamed("Delete", preview));
    const cancelled = await screen.findByRole("dialog", {
      name: `Delete ${report.title}?`,
    });
    click(buttonNamed("Cancel", cancelled));
    await waitFor(() => {
      return expect(cancelled).not.toBeInTheDocument();
    });
    expect(preview).toBeInTheDocument();
    expect(removed).toBeFalsy();
    click(buttonNamed("Delete", preview));
    const confirmed = await screen.findByRole("dialog", {
      name: `Delete ${report.title}?`,
    });
    click(buttonNamed("Delete", confirmed));
    await expect(
      screen.findByText("Artifact deleted"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      return expect(screen.queryByTestId(previewId)).not.toBeInTheDocument();
    });
    expect(removed).toBeTruthy();
    // The transcript remains immutable, but no longer grants management of the
    // withdrawn output after the thread's artifact list has refreshed.
    click(
      await screen.findByLabelText(`Open text preview for ${report.title}`),
    );
    const reopenedId =
      surface === "sidebar" ? "artifact-sidebar" : "attachment-lightbox";
    const reopened = await screen.findByTestId(reopenedId);
    await expect(
      within(reopened).findByText("Thread report content"),
    ).resolves.toBeInTheDocument();
    expect(buttonNamed("Delete", reopened)).toBeDisabled();
  },
);

test.each([
  ["lightbox", "owner"],
  ["lightbox", "unavailable"],
  ["lightbox", "failed"],
  ["sidebar", "owner"],
  ["sidebar", "unavailable"],
  ["sidebar", "failed"],
] as const)(
  "the %s delete action stays visible while access resolves to %s",
  async (surface, outcome) => {
    mockReport(() => {
      return true;
    });
    const started = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(artifactCatalogContract.get, async ({ respond }) => {
      started.resolve();
      await release.promise;
      if (outcome === "failed") {
        throw new Error("Owner lookup unavailable");
      }
      if (outcome === "unavailable") {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Artifact not found" },
        });
      }
      return respond(
        200,
        fileArtifactDetail(report, {
          filename: report.title,
          contentType: "text/plain",
          fileId: "f0000000-0000-4000-a000-000000000921",
          url,
        }),
      );
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
      featureSwitches: {
        [FeatureSwitchKey.ArtifactDeletion]: true,
        [FeatureSwitchKey.ArtifactSidebarPreview]: surface === "sidebar",
      },
    });
    click(
      await screen.findByLabelText(`Open text preview for ${report.title}`),
    );
    const preview = await screen.findByTestId(
      surface === "lightbox" ? "attachment-lightbox" : "artifact-sidebar",
    );
    await started.promise;
    const deletion = buttonNamed("Delete", preview);
    expect(deletion).toBeDisabled();
    expect(deletion).toHaveAttribute("aria-busy", "true");
    expect(deletion).toHaveAccessibleDescription("Checking delete access");
    click(deletion);
    expect(
      screen.queryByRole("dialog", {
        name: `Delete ${report.title}?`,
      }),
    ).not.toBeInTheDocument();
    release.resolve();
    const description =
      outcome === "owner"
        ? ""
        : outcome === "failed"
          ? "Couldn't check delete access"
          : "You can't delete this artifact";
    await waitFor(() => {
      const settled = buttonNamed("Delete", preview);
      expect(settled).toHaveProperty("disabled", outcome !== "owner");
      expect(settled).toHaveAccessibleDescription(description);
      expect(settled).not.toHaveAttribute("aria-busy");
    });
    expect(buttonNamed("Delete", preview)).toBeVisible();
    click(buttonNamed("Delete", preview));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", {
          name: `Delete ${report.title}?`,
        }) !== null,
      ).toBe(outcome === "owner");
    });
  },
);
