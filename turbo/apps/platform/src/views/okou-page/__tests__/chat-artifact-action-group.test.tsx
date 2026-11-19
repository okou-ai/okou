import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactFile,
  findNamedLink,
  findNamedMenuItem,
  mockSplitAttachmentChats,
  publicArtifactUrl,
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
  "a0000000-0000-4000-a000-000000000941",
  "file",
  "action-group.txt",
);
const fileId = "f0000000-0000-4000-a000-000000000941";
const canonical = artifactReferencePath(fileId, report.title);
const resourceUrl = "https://files.example.test/action-group.txt";

type Surface = "dialog" | "sidebar";

function mockPreview({
  metadataReady,
  ownershipReady,
  sharingReady,
  contentReady,
  owned = true,
  failure,
  available = () => {
    return true;
  },
}: {
  metadataReady?: Promise<void>;
  ownershipReady?: Promise<void>;
  sharingReady?: Promise<void>;
  contentReady?: Promise<void>;
  owned?: boolean;
  failure?: "ownership" | "sharing";
  available?: () => boolean;
} = {}) {
  const detail = fileArtifactDetail(report, {
    filename: report.title,
    contentType: "text/plain",
    fileId,
    url: canonical,
  });
  const runs = () => {
    return available()
      ? [
          artifactRun({
            artifactId: report.id,
            filename: report.title,
            contentType: "text/plain",
            fileId,
            url: canonical,
          }),
        ]
      : [];
  };
  mockArtifactConversation(context, {
    catalog: [report],
    getDetail: () => {
      return available() ? detail : null;
    },
    artifactRuns: runs,
    chatEvents: [
      {
        id: "action-group-message",
        role: "assistant",
        content: `[${report.title}](${canonical})`,
        runId: "navigation-artifact-run",
        seqId: 1,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
      {
        id: "action-group-completed",
        role: "assistant",
        content: null,
        runId: "navigation-artifact-run",
        runLifecycleEvent: "completed",
        seqId: 2,
        createdAt: "2026-09-01T12:00:01.000Z",
      },
    ],
  });
  context.mocks.api(chatThreadArtifactsContract.list, async ({ respond }) => {
    await metadataReady;
    return respond(200, { runs: runs() });
  });
  context.mocks.api(artifactCatalogContract.get, async ({ respond }) => {
    await ownershipReady;
    if (failure === "ownership") {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Ownership unavailable",
        },
      });
    }
    return owned && available()
      ? respond(200, detail)
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Artifact not found" },
        });
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: resourceUrl,
      downloadUrl: resourceUrl,
      expiresAt: "2099-01-01T00:00:00.000Z",
      filename: report.title,
      contentType: "text/plain",
      target: { kind: "file", id: fileId },
    });
  });
  context.mocks.api(artifactSharesContract.status, async ({ respond }) => {
    await sharingReady;
    if (failure === "sharing") {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Sharing unavailable",
        },
      });
    }
    return owned
      ? respond(200, {
          ownerUrl: new URL(canonical, "https://app.okou.ai").href,
          shareId: null,
          audience: "private",
          organization: { id: "org_test", name: "Acme" },
          selectedTarget: null,
          selectedVersion: null,
          candidateVersion: null,
          url: null,
          shortUrl: null,
        })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Artifact not found" },
        });
  });
  context.mocks.http.get(resourceUrl, async () => {
    await contentReady;
    return HttpResponse.text("Action group content");
  });
}

async function openPreview(surface: Surface) {
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: surface === "sidebar",
      [FeatureSwitchKey.ArtifactPreviewActionGroup]: true,
    },
  });
  click(await findNamedLink(report.title));
  return screen.findByTestId(
    surface === "sidebar" ? "artifact-sidebar" : "attachment-lightbox",
  );
}

function downloadLabel(surface: Surface) {
  return surface === "sidebar" ? "Download artifact" : "Download options";
}

function readyDownload(preview: HTMLElement, surface: Surface) {
  return waitFor(() => {
    const download = buttonNamed(downloadLabel(surface), preview);
    expect(download).toBeVisible();
    return download;
  });
}

test("replacing the sidebar from another chat waits for that chat's metadata", async () => {
  const leftThreadId = "b0000000-0000-4000-a000-000000000941";
  const rightThreadId = "b0000000-0000-4000-a000-000000000942";
  const leftName = "left-action.txt";
  const rightName = "right-action.txt";
  const leftUrl = publicArtifactUrl(leftName);
  const rightUrl = publicArtifactUrl(rightName);
  const rightReport = artifactSummary(
    "a0000000-0000-4000-a000-000000000942",
    "file",
    "resolved-right.txt",
  );
  const leftFile = artifactFile(leftName, {
    id: fileId,
    artifactId: report.id,
    contentType: "text/plain",
    url: leftUrl,
  });
  const rightFile = artifactFile(rightReport.title, {
    id: "f0000000-0000-4000-a000-000000000942",
    artifactId: rightReport.id,
    contentType: "text/plain",
    url: rightUrl,
  });
  const metadata = context.mocks.deferred<void>();
  mockSplitAttachmentChats(
    context,
    {
      threadId: leftThreadId,
      title: "Left artifacts",
      events: [
        {
          id: "left-action-message",
          role: "assistant",
          content: `[${leftName}](${leftUrl})`,
          runId: "replacement-action-run",
          seqId: 1,
          createdAt: "2026-09-01T12:00:00.000Z",
        },
      ],
      artifacts: [leftFile],
    },
    {
      threadId: rightThreadId,
      title: "Right artifacts",
      events: [
        {
          id: "right-action-message",
          role: "assistant",
          content: `[${rightName}](${rightUrl})`,
          runId: "replacement-action-run",
          seqId: 1,
          createdAt: "2026-09-01T12:00:00.000Z",
        },
      ],
      artifacts: [rightFile],
    },
  );
  context.mocks.api(
    chatThreadArtifactsContract.list,
    async ({ params, respond }) => {
      if (params.threadId === rightThreadId) {
        await metadata.promise;
      }
      return respond(200, {
        runs: [
          {
            runId: "replacement-action-run",
            files: [params.threadId === rightThreadId ? rightFile : leftFile],
          },
        ],
      });
    },
  );
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    const summary = params.artifactId === rightReport.id ? rightReport : report;
    return respond(
      200,
      fileArtifactDetail(summary, {
        contentType: "text/plain",
        fileId: summary === rightReport ? rightFile.id : leftFile.id,
        filename: summary.title,
        url: summary === rightReport ? rightUrl : leftUrl,
      }),
    );
  });
  context.mocks.http.get(leftUrl, () => {
    return HttpResponse.text("Left content");
  });
  context.mocks.http.get(rightUrl, () => {
    return HttpResponse.text("Right content");
  });

  await setupPage({
    context,
    path: `/chats/${leftThreadId}?sidebar=${rightThreadId}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: true,
      [FeatureSwitchKey.ArtifactPreviewActionGroup]: true,
    },
  });
  click(await findNamedLink(leftName));
  const firstPreview = await screen.findByTestId("artifact-sidebar");
  await readyDownload(firstPreview, "sidebar");

  click(await findNamedLink(rightName));
  const preview = await waitFor(() => {
    const sidebar = screen.getByTestId("artifact-sidebar");
    expect(within(sidebar).getByText("Right content")).toBeInTheDocument();
    return sidebar;
  });
  expect(within(preview).queryByRole("status")).not.toBeInTheDocument();
  expect(within(preview).getByLabelText("Download artifact")).not.toBeVisible();
  expect(buttonNamed("Close artifact", preview)).toBeEnabled();
  metadata.resolve();
  await readyDownload(preview, "sidebar");
  await expect(
    within(preview).findByText(rightReport.title),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(buttonNamed("More artifact actions", preview)).toBeEnabled();
  });
});

test.each([
  { surface: "dialog", first: "ownership" },
  { surface: "dialog", first: "sharing" },
  { surface: "sidebar", first: "ownership" },
  { surface: "sidebar", first: "sharing" },
] as const)(
  "the $surface reveals all actions together when $first resolves first",
  async ({ surface, first }) => {
    const ownership = context.mocks.deferred<void>();
    const sharing = context.mocks.deferred<void>();
    const firstReady = first === "ownership" ? ownership : sharing;
    const lastReady = first === "ownership" ? sharing : ownership;
    mockPreview({
      ownershipReady: ownership.promise,
      sharingReady: sharing.promise,
      contentReady: firstReady.promise,
    });
    const preview = await openPreview(surface);
    expect(
      buttonNamed(surface === "sidebar" ? "Close artifact" : "Close", preview),
    ).toBeEnabled();
    firstReady.resolve();
    await expect(
      within(preview).findByText("Action group content"),
    ).resolves.toBeInTheDocument();
    expect(within(preview).queryByRole("status")).not.toBeInTheDocument();
    expect(
      within(preview).getByLabelText(downloadLabel(surface)),
    ).not.toBeVisible();
    lastReady.resolve();
    await readyDownload(preview, surface);
    expect(
      buttonNamed(surface === "sidebar" ? "Share artifact" : "Share", preview),
    ).toBeVisible();
    expect(buttonNamed("More artifact actions", preview)).toBeVisible();
  },
);

test.each(["dialog", "sidebar"] as const)(
  "the %s waits for artifact metadata before choosing its actions",
  async (surface) => {
    const metadata = context.mocks.deferred<void>();
    mockPreview({ metadataReady: metadata.promise });
    const preview = await openPreview(surface);
    await expect(
      within(preview).findByText("Action group content"),
    ).resolves.toBeInTheDocument();
    expect(within(preview).queryByRole("status")).not.toBeInTheDocument();
    expect(
      within(preview).getByLabelText(downloadLabel(surface)),
    ).not.toBeVisible();
    metadata.resolve();
    await readyDownload(preview, surface);
    expect(buttonNamed("More artifact actions", preview)).toBeVisible();
  },
);

test.each(["dialog", "sidebar"] as const)(
  "the %s can close during action loading and reopen normally",
  async (surface) => {
    const ownership = context.mocks.deferred<void>();
    mockPreview({ ownershipReady: ownership.promise });
    const preview = await openPreview(surface);
    await expect(
      within(preview).findByText("Action group content"),
    ).resolves.toBeInTheDocument();
    expect(within(preview).queryByRole("status")).not.toBeInTheDocument();
    expect(
      within(preview).getByLabelText(downloadLabel(surface)),
    ).not.toBeVisible();
    click(
      buttonNamed(surface === "sidebar" ? "Close artifact" : "Close", preview),
    );
    await waitFor(() => {
      expect(preview).not.toBeInTheDocument();
    });
    ownership.resolve();
    click(await findNamedLink(report.title));
    const reopened = await screen.findByTestId(
      surface === "sidebar" ? "artifact-sidebar" : "attachment-lightbox",
    );
    await readyDownload(reopened, surface);
  },
);

test.each(["dialog", "sidebar"] as const)(
  "the %s keeps Download separate from deletion and restores More focus on cancel",
  async (surface) => {
    const user = userEvent.setup({ delay: null });
    const browser = context.mocks.browser.blobDownload();
    let removed = false;
    mockPreview({
      available: () => {
        return !removed;
      },
    });
    context.mocks.api(artifactCatalogContract.delete, ({ respond }) => {
      removed = true;
      return respond(200, { deleted: true });
    });
    const preview = await openPreview(surface);
    const download = await readyDownload(preview, surface);
    const more = buttonNamed("More artifact actions", preview);
    click(more);
    const menu = await screen.findByRole("menu");
    expect(
      queryAllByRoleFast("menuitem", menu).map((item) => {
        return item.textContent?.trim();
      }),
    ).toStrictEqual(["Delete"]);
    await user.click(
      buttonNamed(surface === "sidebar" ? "Share artifact" : "Share", preview),
    );
    await expect(
      screen.findByRole("dialog", { name: "Share" }),
    ).resolves.toBeInTheDocument();
    await user.keyboard("{Escape}");
    click(download);
    const downloads = await screen.findByRole("menu");
    click(await findNamedMenuItem("Download", downloads));
    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    expect(browser.downloads[0]?.filename).toBe(report.title);
    click(more);
    click(await findNamedMenuItem("Delete", await screen.findByRole("menu")));
    const cancelled = await screen.findByRole("dialog", {
      name: `Delete ${report.title}?`,
    });
    click(buttonNamed("Cancel", cancelled));
    await waitFor(() => {
      expect(more).toHaveFocus();
    });
    click(more);
    click(await findNamedMenuItem("Delete", await screen.findByRole("menu")));
    const confirmed = await screen.findByRole("dialog", {
      name: `Delete ${report.title}?`,
    });
    click(buttonNamed("Delete", confirmed));
    await expect(
      screen.findByText("Artifact deleted"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(preview).not.toBeInTheDocument();
    });
  },
);

test.each(["dialog", "sidebar"] as const)(
  "a read-only %s offers link copy and Download without an empty management menu",
  async (surface) => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    mockPreview({ owned: false });
    const preview = await openPreview(surface);
    await readyDownload(preview, surface);
    click(
      buttonNamed(surface === "sidebar" ? "Share artifact" : "Share", preview),
    );
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([
        new URL(canonical, "https://app.okou.ai").href,
      ]);
    });
    expect(
      queryAllByRoleFast("button", preview).find((button) => {
        return button.getAttribute("aria-label") === "More artifact actions";
      }),
    ).toBeUndefined();
  },
);

test.each(["ownership", "sharing"] as const)(
  "a failed %s read still releases Download and Close",
  async (failure) => {
    const browser = context.mocks.browser.blobDownload();
    mockPreview({ failure });
    const preview = await openPreview("dialog");
    click(await readyDownload(preview, "dialog"));
    const menu = await screen.findByRole("menu");
    click(await findNamedMenuItem("Download", menu));
    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    expect(buttonNamed("Close", preview)).toBeEnabled();
  },
);
