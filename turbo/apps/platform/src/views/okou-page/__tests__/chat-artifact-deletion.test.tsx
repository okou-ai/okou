import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
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
import {
  findNamedLink,
  findNamedMenuItem,
} from "./chat-attachment-test-helpers.ts";
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

function mockReport(available: () => boolean, sourceUrl = url) {
  const detail = fileArtifactDetail(report, {
    filename: report.title,
    contentType: "text/plain",
    fileId: "f0000000-0000-4000-a000-000000000921",
    url: sourceUrl,
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
      click(await findNamedLink(report.title));
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
    click(await findNamedLink(report.title));
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

test.each(["dialog", "sidebar"] as const)(
  "an owner can open Share beside an open More menu in the %s preview",
  async (surface) => {
    const user = userEvent.setup({ delay: null });
    const fileId = "f0000000-0000-4000-a000-000000000921";
    const canonical = artifactReferencePath(fileId, report.title);
    const resourceReady = context.mocks.deferred<void>();
    const ownershipRequested = context.mocks.deferred<void>();
    const sharingRequested = context.mocks.deferred<void>();
    const sharingReady = context.mocks.deferred<void>();
    mockReport(() => {
      return true;
    }, canonical);
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      if (!ownershipRequested.settled()) {
        ownershipRequested.resolve();
      }
      return respond(
        200,
        fileArtifactDetail(report, {
          filename: report.title,
          contentType: "text/plain",
          fileId,
          url: canonical,
        }),
      );
    });
    context.mocks.api(
      artifactReferencesContract.resolve,
      async ({ respond }) => {
        await resourceReady.promise;
        // Rendering the text witnesses eager ownership loading while More is
        // still closed, without observing application state or waiting on time.
        await ownershipRequested.promise;
        return respond(200, {
          url,
          downloadUrl: url,
          expiresAt: "2099-01-01T00:00:00.000Z",
          filename: report.title,
          contentType: "text/plain",
          target: { kind: "file", id: fileId },
        });
      },
    );
    context.mocks.api(artifactSharesContract.status, async ({ respond }) => {
      if (!sharingRequested.settled()) {
        sharingRequested.resolve();
      }
      await sharingReady.promise;
      return respond(200, {
        ownerUrl: new URL(canonical, "https://app.okou.ai").href,
        shareId: null,
        audience: "private",
        organization: { id: "org_test", name: "Acme" },
        selectedTarget: null,
        selectedVersion: null,
        candidateVersion: null,
        url: null,
        shortUrl: null,
      });
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
      featureSwitches: {
        [FeatureSwitchKey.ArtifactSidebarPreview]: surface === "sidebar",
        [FeatureSwitchKey.ArtifactPreviewToolbar]: true,
      },
    });
    click(await findNamedLink(report.title));
    const preview = await screen.findByTestId(
      surface === "sidebar" ? "artifact-sidebar" : "attachment-lightbox",
    );
    const more = buttonNamed("More artifact actions", preview);
    const shareLabel = surface === "sidebar" ? "Share artifact" : "Share";
    expect(more).toBeEnabled();
    expect(
      within(preview).queryByLabelText(shareLabel),
    ).not.toBeInTheDocument();
    resourceReady.resolve();
    await expect(
      within(preview).findByText("Thread report content"),
    ).resolves.toBeInTheDocument();
    await sharingRequested.promise;
    // Resolved identity alone must not expose Share before its permissions load.
    expect(
      within(preview).queryByLabelText(shareLabel),
    ).not.toBeInTheDocument();
    expect(more).toBeEnabled();
    sharingReady.resolve();
    await waitFor(() => {
      expect(buttonNamed(shareLabel, preview)).toBeEnabled();
    });
    await user.click(more);
    const menu = await screen.findByRole("menu");
    await expect(
      findNamedMenuItem("Delete", menu),
    ).resolves.toBeInTheDocument();
    await user.click(buttonNamed(shareLabel, preview));
    const share = await screen.findByRole("dialog", { name: "Share" });
    await expect(
      within(share).findByText("Only me"),
    ).resolves.toBeInTheDocument();
    expect(buttonNamed("Copy link", share)).toBeEnabled();
    await waitFor(() => {
      expect(more).toHaveAttribute("aria-expanded", "false");
    });
  },
);

test.each([
  { surface: "dialog", failedAction: "deletion" },
  { surface: "sidebar", failedAction: "sharing" },
] as const)(
  "Retry recovers owner actions after a failed $failedAction read in the $surface preview",
  async ({ surface, failedAction }) => {
    const user = userEvent.setup({ delay: null });
    const fileId = "f0000000-0000-4000-a000-000000000921";
    const canonical = artifactReferencePath(fileId, report.title);
    const ownershipRecovered = context.mocks.deferred<void>();
    const clipboard = context.mocks.browser.clipboardWriteText();
    let unavailable = true;
    mockReport(() => {
      return true;
    }, canonical);
    // A transient 503 is outside the catalog's declared success/denial statuses.
    context.mocks.http.get("*/api/artifacts/catalog/:artifactId", () => {
      if (unavailable && failedAction === "deletion") {
        return HttpResponse.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Catalog unavailable",
            },
          },
          { status: 503 },
        );
      }
      if (!ownershipRecovered.settled()) {
        ownershipRecovered.resolve();
      }
      return HttpResponse.json(
        fileArtifactDetail(report, {
          filename: report.title,
          contentType: "text/plain",
          fileId,
          url: canonical,
        }),
      );
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
    context.mocks.api(artifactSharesContract.status, ({ respond }) => {
      if (unavailable && failedAction === "sharing") {
        return respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Sharing unavailable" },
        });
      }
      return respond(200, {
        ownerUrl: new URL(canonical, "https://app.okou.ai").href,
        shareId: null,
        audience: "private",
        organization: { id: "org_test", name: "Acme" },
        selectedTarget: null,
        selectedVersion: null,
        candidateVersion: null,
        url: null,
        shortUrl: null,
      });
    });
    context.mocks.http.get(url, async () => {
      // The rendered content witnesses a successful ownership response. In the
      // deletion-failure case it cannot appear until Retry reaches the API.
      await ownershipRecovered.promise;
      return HttpResponse.text("Thread report content");
    });
    await setupPage({
      context,
      path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
      host: "app.okou.ai",
      featureSwitches: {
        [FeatureSwitchKey.ArtifactSidebarPreview]: surface === "sidebar",
        [FeatureSwitchKey.ArtifactPreviewToolbar]: true,
      },
    });
    click(await findNamedLink(report.title));
    const preview = await screen.findByTestId(
      surface === "sidebar" ? "artifact-sidebar" : "attachment-lightbox",
    );
    const more = buttonNamed("More artifact actions", preview);
    const shareLabel = surface === "sidebar" ? "Share artifact" : "Share";
    await waitFor(() => {
      const ready =
        failedAction === "sharing"
          ? within(preview).getByText("Thread report content")
          : buttonNamed(shareLabel, preview);
      expect(ready).toBeInTheDocument();
    });
    click(more);
    const failedMenu = await screen.findByRole("menu");
    await expect(
      within(failedMenu).findByText("Some actions are unavailable"),
    ).resolves.toBeInTheDocument();
    await expect(
      findNamedMenuItem("Download", failedMenu),
    ).resolves.not.toHaveAttribute("aria-disabled", "true");
    const unavailableControl =
      failedAction === "sharing"
        ? within(preview).queryByLabelText(shareLabel)
        : queryAllByRoleFast("menuitem", failedMenu).find((item) => {
            return item.textContent?.trim() === "Delete";
          });
    expect(unavailableControl).toBeFalsy();
    unavailable = false;
    click(await findNamedMenuItem("Retry", failedMenu));
    await waitFor(() => {
      expect(failedMenu).not.toBeInTheDocument();
    });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(
      within(preview).findByText("Thread report content"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(buttonNamed(shareLabel, preview)).toBeEnabled();
    });
    click(buttonNamed(shareLabel, preview));
    const share = await screen.findByRole("dialog", { name: "Share" });
    await expect(
      within(share).findByText("Only me"),
    ).resolves.toBeInTheDocument();
    click(buttonNamed("Copy link", share));
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([
        new URL(canonical, "https://app.okou.ai").href,
      ]);
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(share).not.toBeInTheDocument();
    });
    click(more);
    const recoveredMenu = await screen.findByRole("menu");
    const deleteItem = await findNamedMenuItem("Delete", recoveredMenu);
    expect(deleteItem).not.toHaveAttribute("aria-disabled", "true");
    expect(
      within(recoveredMenu).queryByText("Some actions are unavailable"),
    ).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("menuitem", recoveredMenu).some((item) => {
        return item.textContent?.trim() === "Retry";
      }),
    ).toBeFalsy();
    click(deleteItem);
    const confirmation = await screen.findByRole("dialog", {
      name: `Delete ${report.title}?`,
    });
    expect(buttonNamed("Delete", confirmation)).toBeEnabled();
    click(buttonNamed("Cancel", confirmation));
    await waitFor(() => {
      expect(confirmation).not.toBeInTheDocument();
    });
  },
);

test("the More menu applies late artifact metadata and ownership on its next opening", async () => {
  mockReport(() => {
    return true;
  });
  context.mocks.browser.requestCacheMode();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const metadata = context.mocks.deferred<void>();
  const ownershipRequested = context.mocks.deferred<void>();
  const downloadRequested = context.mocks.deferred<void>();
  const downloadReady = context.mocks.deferred<void>();
  const filename = "resolved-report.txt";
  context.mocks.api(chatThreadArtifactsContract.list, async ({ respond }) => {
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
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    if (!ownershipRequested.settled()) {
      ownershipRequested.resolve();
    }
    return respond(
      200,
      fileArtifactDetail(report, {
        filename,
        contentType: "text/plain",
        fileId: "f0000000-0000-4000-a000-000000000921",
        url,
      }),
    );
  });
  context.mocks.http.get(url, async ({ request }) => {
    if (request.cache === "reload") {
      downloadRequested.resolve();
      await downloadReady.promise;
    } else {
      await ownershipRequested.promise;
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
  click(await findNamedLink(report.title));
  const preview = await screen.findByTestId("attachment-lightbox");
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
  await expect(
    within(preview).findByText("Thread report content"),
  ).resolves.toBeInTheDocument();
  expect(within(preview).getByText(filename)).toBeInTheDocument();
  await userEvent.keyboard("{Home}", { delay: null });
  await expect(findNamedMenuItem("Download", menu)).resolves.toHaveFocus();
  expect(
    queryAllByRoleFast("menuitem", menu).some((item) => {
      return item.textContent?.trim() === "Delete";
    }),
  ).toBeFalsy();
  expect(buttonNamed("More artifact actions", preview)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await userEvent.keyboard("{Escape}", { delay: null });
  await waitFor(() => {
    expect(menu).not.toBeInTheDocument();
  });
  click(buttonNamed("More artifact actions", preview));
  const resolvedMenu = await screen.findByRole("menu");
  await expect(
    findNamedMenuItem("Delete", resolvedMenu),
  ).resolves.not.toHaveAttribute("aria-disabled", "true");
  click(await findNamedMenuItem("Download", resolvedMenu));
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

test("a read-only artifact offers Download and link copy without Delete or Retry", async () => {
  const fileId = "f0000000-0000-4000-a000-000000000921";
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
    featureSwitches: { [FeatureSwitchKey.ArtifactPreviewToolbar]: true },
  });
  click(await findNamedLink(report.title));
  const preview = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(preview).findByText("Thread report content"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(buttonNamed("Share", preview)).toBeEnabled();
  });
  click(buttonNamed("Share", preview));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([
      new URL(canonical, "https://app.okou.ai").href,
    ]);
  });
  expect(
    screen.queryByRole("dialog", { name: "Share" }),
  ).not.toBeInTheDocument();
  click(buttonNamed("More artifact actions", preview));
  const menu = await screen.findByRole("menu");
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
  expect(
    within(menu).queryByText("Some actions are unavailable"),
  ).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("menuitem", menu).some((item) => {
      return item.textContent?.trim() === "Retry";
    }),
  ).toBeFalsy();
});
