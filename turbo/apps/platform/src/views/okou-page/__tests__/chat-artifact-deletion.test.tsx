import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findNamedLink,
  findNamedMenuItem,
} from "./chat-attachment-test-helpers.ts";
import {
  artifactRun,
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const report = artifactSummary(
  "a0000000-0000-4000-a000-000000000921",
  "file",
  "thread-report.txt",
);
const fileId = "f0000000-0000-4000-a000-000000000921";
const url = "https://cdn.vm7.io/artifacts/tests/deletion/thread-report.txt";

function mockReport(
  available: () => boolean,
  sourceUrl = url,
  onArtifactRunsRead?: () => void,
) {
  const detail = fileArtifactDetail(report, {
    filename: report.title,
    contentType: "text/plain",
    fileId,
    url: sourceUrl,
  });
  mockArtifactConversation(context, {
    catalog: [report],
    getDetail: () => {
      return available() ? detail : null;
    },
    artifactRuns: () => {
      onArtifactRunsRead?.();
      return available()
        ? [
            artifactRun({
              artifactId: report.id,
              filename: report.title,
              contentType: "text/plain",
              fileId,
              url: sourceUrl,
            }),
          ]
        : [];
    },
    chatEvents: [
      {
        id: "thread-report-message",
        role: "assistant",
        content: `[${report.title}](${sourceUrl})`,
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

function queryDeleteButton(container: ParentNode) {
  return queryAllByRoleFast("button", container).find((button) => {
    return button.getAttribute("aria-label") === "Delete";
  });
}

async function openReportInLightbox() {
  click(await findNamedLink(report.title));
  const preview = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(preview).findByText("Thread report content"),
  ).resolves.toBeInTheDocument();
  return preview;
}

async function requestDeletion(preview: HTMLElement) {
  const button = await waitFor(() => {
    return buttonNamed("Delete", preview);
  });
  click(button);
  return screen.findByRole("dialog", { name: `Delete ${report.title}?` });
}

test("A thread artifact can be deleted from the original lightbox toolbar", async () => {
  let removed = false;
  const runsReadAfterRemoval = context.mocks.deferred<void>();
  mockReport(
    () => {
      return !removed;
    },
    url,
    () => {
      if (removed && !runsReadAfterRemoval.settled()) {
        runsReadAfterRemoval.resolve();
      }
    },
  );
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
      [FeatureSwitchKey.ArtifactSidebarPreview]: false,
      [FeatureSwitchKey.ArtifactPreviewActionGroup]: false,
    },
  });
  const preview = await openReportInLightbox();

  const cancelled = await requestDeletion(preview);
  click(buttonNamed("Cancel", cancelled));
  await waitFor(() => {
    expect(cancelled).not.toBeInTheDocument();
  });
  expect(preview).toBeInTheDocument();
  expect(within(preview).getByText("Thread report content")).toBeVisible();
  expect(removed).toBeFalsy();
  await waitFor(() => {
    expect(buttonNamed("Delete", preview)).toHaveFocus();
  });

  const confirmed = await requestDeletion(preview);
  click(buttonNamed("Delete", confirmed));
  await expect(
    screen.findByText("Artifact deleted"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
  });
  expect(removed).toBeTruthy();

  const reopened = await openReportInLightbox();
  await runsReadAfterRemoval.promise;
  expect(queryDeleteButton(reopened)).toBeUndefined();
});

test("A read-only artifact copies its link and downloads without offering deletion", async () => {
  const canonical = artifactReferencePath(fileId, report.title);
  const ownershipDenied = context.mocks.deferred<void>();
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockReport(() => {
    return true;
  }, canonical);
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    if (!ownershipDenied.settled()) {
      ownershipDenied.resolve();
    }
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url,
      downloadUrl: url,
      expiresAt: "2099-01-01T00:00:00.000Z",
      filename: report.title,
      contentType: "text/plain",
      target: { kind: "file", id: fileId },
    });
  });
  context.mocks.api(artifactSharesContract.status, async ({ respond }) => {
    await ownershipDenied.promise;
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ArtifactPreviewActionGroup]: false },
  });
  const preview = await openReportInLightbox();

  click(buttonNamed("Share", preview));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([
      new URL(canonical, "https://app.okou.ai").href,
    ]);
  });
  click(buttonNamed("Download options", preview));
  const menu = await screen.findByRole("menu");
  await expect(
    findNamedMenuItem("Download", menu),
  ).resolves.not.toHaveAttribute("aria-disabled", "true");
  await ownershipDenied.promise;
  expect(queryDeleteButton(preview)).toBeUndefined();
});
