import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { findNamedMenuItem } from "./chat-attachment-test-helpers.ts";
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

test.each([
  { surface: "lightbox", refined: false },
  { surface: "sidebar", refined: false },
  { surface: "resources", refined: false },
  { surface: "lightbox", refined: true },
  { surface: "sidebar", refined: true },
  { surface: "resources", refined: true },
] as const)(
  "a thread artifact can be deleted from $surface with refined toolbar $refined",
  async ({ surface, refined }) => {
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
        [FeatureSwitchKey.ArtifactSidebarPreview]: surface === "sidebar",
        [FeatureSwitchKey.ArtifactPreviewToolbar]: refined,
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
    const requestDeletion = async () => {
      if (refined) {
        click(buttonNamed("More artifact actions", preview));
        const menu = await screen.findByRole("menu");
        click(await findNamedMenuItem("Delete", menu));
      } else {
        const button = await waitFor(() => {
          return buttonNamed("Delete", preview);
        });
        click(button);
      }
    };
    await requestDeletion();
    const cancelled = await screen.findByRole("dialog", {
      name: `Delete ${report.title}?`,
    });
    click(buttonNamed("Cancel", cancelled));
    await waitFor(() => {
      return expect(cancelled).not.toBeInTheDocument();
    });
    expect(preview).toBeInTheDocument();
    expect(removed).toBeFalsy();
    await waitFor(() => {
      expect(
        buttonNamed(refined ? "More artifact actions" : "Delete", preview),
      ).toHaveFocus();
    });
    await requestDeletion();
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
    if (refined) {
      click(buttonNamed("More artifact actions", reopened));
      const menu = await screen.findByRole("menu");
      await findNamedMenuItem("Download", menu);
    }
    expect(
      queryAllByRoleFast("menuitem").some((item) => {
        return item.textContent?.trim() === "Delete";
      }),
    ).toBeFalsy();
    expect(
      queryAllByRoleFast("button", reopened).find((button) => {
        return button.getAttribute("aria-label") === "Delete";
      }),
    ).toBeUndefined();
  },
);

test("the More menu stays usable as artifact metadata and ownership arrive", async () => {
  mockReport(() => {
    return true;
  });
  context.mocks.browser.requestCacheMode();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const metadata = context.mocks.deferred<void>();
  const metadataRequested = context.mocks.deferred<void>();
  const downloadRequested = context.mocks.deferred<void>();
  const downloadReady = context.mocks.deferred<void>();
  const filename = "resolved-report.txt";
  context.mocks.api(chatThreadArtifactsContract.list, async ({ respond }) => {
    metadataRequested.resolve();
    await metadata.promise;
    return respond(200, {
      runs: [
        artifactRun({
          artifactId: report.id,
          filename,
          contentType: "text/plain",
          fileId: "f0000000-0000-4000-a000-000000000921",
          url,
        }),
      ],
    });
  });
  context.mocks.http.get(url, async ({ request }) => {
    if (request.cache === "reload") {
      downloadRequested.resolve();
      await downloadReady.promise;
    }
    return HttpResponse.text("Thread report content");
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ArtifactPreviewToolbar]: true },
  });
  click(await screen.findByLabelText(`Open text preview for ${report.title}`));
  const preview = await screen.findByTestId("attachment-lightbox");
  await metadataRequested.promise;
  expect(buttonNamed("Share", preview)).toBeEnabled();
  expect(buttonNamed("Open in split view", preview)).toBeEnabled();
  click(buttonNamed("Share", preview));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([url]);
  });
  click(buttonNamed("Enter fullscreen", preview));
  click(
    await waitFor(() => {
      return buttonNamed("Exit fullscreen", preview);
    }),
  );
  click(buttonNamed("More artifact actions", preview));
  const menu = await screen.findByRole("menu");
  await expect(
    findNamedMenuItem("Download", menu),
  ).resolves.not.toHaveAttribute("aria-disabled", "true");
  metadata.resolve();
  await expect(findNamedMenuItem("Delete", menu)).resolves.not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(buttonNamed("More artifact actions", preview)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  click(await findNamedMenuItem("Download", menu));
  await downloadRequested.promise;
  expect(buttonNamed("More artifact actions", preview)).toBeEnabled();
  click(buttonNamed("More artifact actions", preview));
  const pendingMenu = await screen.findByRole("menu");
  await expect(
    findNamedMenuItem("Download", pendingMenu),
  ).resolves.toHaveAttribute("aria-disabled", "true");
  downloadReady.resolve();
  await waitFor(() => {
    expect(browser.downloads[0]?.filename).toBe(filename);
  });
  await userEvent.keyboard("{Escape}");
  click(buttonNamed("Open in split view", preview));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  expect(buttonNamed("Share artifact", sidebar)).toBeEnabled();
  expect(buttonNamed("More artifact actions", sidebar)).toBeEnabled();
  expect(buttonNamed("Enter fullscreen", sidebar)).toBeEnabled();
  click(buttonNamed("Close artifact", sidebar));
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar")).toBeNull();
  });
});

test("a missing or foreign catalog identity does not expose deletion in a thread preview", async () => {
  mockReport(() => {
    return true;
  });
  const ownership = context.mocks.deferred<void>();
  context.mocks.api(artifactCatalogContract.get, async ({ respond }) => {
    await ownership.promise;
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ArtifactPreviewToolbar]: true },
  });
  click(await screen.findByLabelText(`Open text preview for ${report.title}`));
  const preview = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(preview).findByText("Thread report content"),
  ).resolves.toBeInTheDocument();
  click(buttonNamed("More artifact actions", preview));
  const menu = await screen.findByRole("menu");
  await expect(
    findNamedMenuItem("Loading permissions", menu),
  ).resolves.toHaveAttribute("aria-disabled", "true");
  ownership.resolve();
  await waitFor(() => {
    expect(within(menu).queryByText("Loading permissions")).toBeNull();
  });
  await expect(
    findNamedMenuItem("Download", menu),
  ).resolves.not.toHaveAttribute("aria-disabled", "true");
  expect(
    queryAllByRoleFast("menuitem", menu).some((item) => {
      return item.textContent?.trim() === "Delete";
    }),
  ).toBeFalsy();
  expect(
    queryAllByRoleFast("button", preview).find((button) => {
      return button.getAttribute("aria-label") === "Delete";
    }),
  ).toBeUndefined();
});
