import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import {
  assistantRow,
  attachment,
  serveReference,
} from "./attachment-preview-boundaries.ts";
import {
  findAction,
  queryAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";
import {
  artifactFile,
  ATTACHMENT_THREAD_ID,
  SECOND_ATTACHMENT_THREAD_ID,
  mockAttachmentChat,
  mockSplitAttachmentChats,
  findNamedMenuItem,
} from "./chat-attachment-test-helpers.ts";
import {
  artifactSummary,
  fileArtifactDetail,
} from "./chat-navigation-artifact-test-helpers.ts";
const context = testContext();
function resource(title: string) {
  const file = attachment("dispatch.pdf", "application/pdf");
  file.url = "https://cdn.okou.io/artifacts/field/private/" + file.id + ".pdf";
  const item = artifactSummary(crypto.randomUUID(), "file", title);
  const metadata = artifactFile(file.filename, {
    id: file.id,
    artifactId: item.id,
    title,
    url: file.path,
    contentType: file.contentType,
  });
  const detail = fileArtifactDetail(item, {
    fileId: file.id,
    filename: file.filename,
    url: file.path,
    contentType: file.contentType,
  });
  return {
    file,
    item,
    metadata,
    detail,
    message: assistantRow("[" + title + "](" + file.path + ")"),
  };
}
type Hold = Promise<void>;
function rights(
  r: ReturnType<typeof resource>,
  options: {
    share?: Hold;
    owner?: Hold;
    readOnly?: boolean;
    onOwnerReturned?: () => void;
    ownerError?: boolean;
  } = {},
) {
  serveReference(context, r.file);
  const ownerUrl = "https://app.okou.ai" + r.file.path;
  context.mocks.api(
    artifactCatalogContract.get,
    async ({ params, respond }) => {
      await options.owner;
      if (options.ownerError) {
        return respond(500, {
          error: { code: "FAILED", message: "Owner unavailable" },
        });
      }
      if (options.readOnly || params.artifactId !== r.item.id) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "No management access" },
        });
      }
      const response = respond(200, r.detail);
      options.onOwnerReturned?.();
      return response;
    },
  );
  context.mocks.api(
    artifactSharesContract.status,
    async ({ body, respond }) => {
      await options.share;
      if (options.readOnly || body.id !== r.file.id) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Not owned" },
        });
      }
      return respond(200, {
        ownerUrl,
        shareId: null,
        audience: "private",
        organization: { id: "org_default", name: "Field team" },
        selectedTarget: null,
        selectedVersion: null,
        candidateVersion: null,
        url: null,
        shortUrl: null,
      });
    },
  );
  return ownerUrl;
}
async function route(sidebar = false, other = false) {
  await setupPage({
    context,
    host: "app.okou.ai",
    path:
      "/chats/" +
      ATTACHMENT_THREAD_ID +
      (other ? "?sidebar=" + SECOND_ATTACHMENT_THREAD_ID : ""),
    featureSwitches: {
      [FeatureSwitchKey.ArtifactPreviewActionGroup]: true,
      [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar,
    },
  });
}
async function page(
  options: {
    share?: Hold;
    owner?: Hold;
    meta?: Hold;
    readOnly?: boolean;
    onOwnerReturned?: () => void;
    ownerError?: boolean;
    sidebar?: boolean;
  } = {},
) {
  const r = resource("Atlas of sampling stations");
  mockAttachmentChat(context, {
    chatEvents: [r.message],
    artifacts: [r.metadata],
  });
  if (options.meta) {
    context.mocks.api(chatThreadArtifactsContract.list, async ({ respond }) => {
      await options.meta;
      return respond(200, {
        runs: [{ runId: crypto.randomUUID(), files: [r.metadata] }],
      });
    });
  }
  const ownerUrl = rights(r, options);
  await route(options.sidebar);
  const button = await findAction("link", r.item.title);
  click(button);
  const panel = await screen.findByTestId(
    options.sidebar ? "artifact-sidebar" : "attachment-lightbox",
  );
  await waitFor(() => {
    return expect(panel.querySelector("iframe")?.src).toContain(r.file.url);
  });
  return { ...r, ownerUrl, button, panel };
}
function downloadLabel(panel: HTMLElement) {
  return panel.dataset.testid === "artifact-sidebar"
    ? "Download artifact"
    : "Download options";
}
function hiddenDownload(panel: HTMLElement) {
  expect(queryAction("button", downloadLabel(panel), panel)).toBeNull();
}
async function ready(panel: HTMLElement) {
  for (const name of [downloadLabel(panel), "More artifact actions"]) {
    await expect(findAction("button", name, panel)).resolves.toBeVisible();
  }
}
test("chat-artifact-action-group-001 a second thread cannot inherit the first preview's ready actions", async () => {
  const earlier = resource("Glacier inventory"),
    next = resource("Estuary inventory");
  const hold = context.mocks.deferred<void>();
  // Each conversation gets an independently accessible file and a distinct metadata response.
  earlier.metadata.url = earlier.file.url;
  earlier.message = assistantRow(
    "[Glacier inventory](" + earlier.file.url + ")",
  );
  mockSplitAttachmentChats(
    context,
    {
      threadId: ATTACHMENT_THREAD_ID,
      title: "Glacier",
      events: [earlier.message],
      artifacts: [earlier.metadata],
    },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Estuary",
      events: [next.message],
      artifacts: [next.metadata],
    },
  );
  context.mocks.api(
    chatThreadArtifactsContract.list,
    async ({ params, respond }) => {
      const right = params.threadId === SECOND_ATTACHMENT_THREAD_ID;
      if (right) {
        await hold.promise;
      }
      return respond(200, {
        runs: [
          {
            runId: params.threadId,
            files: [right ? next.metadata : earlier.metadata],
          },
        ],
      });
    },
  );
  rights(next);
  await route(true, true);
  click(await findAction("link", earlier.item.title));
  const previous = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(previous.querySelector("iframe")?.src).toContain(
      earlier.file.url,
    );
  });
  await expect(
    findAction("button", "Download artifact", previous),
  ).resolves.toBeVisible();
  click(await findAction("link", next.item.title));
  const side = await waitFor(() => {
    const node = screen.getAllByTestId("artifact-sidebar").find((x) => {
      return x.querySelector("iframe")?.src.includes(next.file.url);
    });
    expect(node).toBeDefined();
    return node!;
  });
  hiddenDownload(side);
  hold.resolve();
  await ready(side);
  await waitFor(() => {
    expect(side).toBeInTheDocument();
    expect(side).toHaveTextContent(next.item.title);
    expect(side.querySelector("iframe")?.src).toContain(next.file.url);
  });
});
test("chat-artifact-action-group-002 the visible document waits for sharing before enabling the dialog toolbar", async () => {
  const sharing = context.mocks.deferred<void>(),
    ownerReturned = context.mocks.deferred<void>();
  const { panel } = await page({
    share: sharing.promise,
    onOwnerReturned: () => {
      return ownerReturned.resolve();
    },
  });
  await ownerReturned.promise;
  hiddenDownload(panel);
  sharing.resolve();
  await ready(panel);
  expect(getAction("button", "Share", panel)).toBeVisible();
});
test("chat-artifact-action-group-006 metadata unlocks actions after the document is already readable", async () => {
  const metadata = context.mocks.deferred<void>();
  const { panel } = await page({ meta: metadata.promise });
  hiddenDownload(panel);
  metadata.resolve();
  await ready(panel);
  expect(getAction("button", "Download options", panel)).toBeEnabled();
});
test("chat-artifact-action-group-008 reopening after a pending ownership read restores the document action", async () => {
  const owner = context.mocks.deferred<void>(),
    returned = context.mocks.deferred<void>();
  const { panel, button, file } = await page({
    owner: owner.promise,
    onOwnerReturned: () => {
      return returned.resolve();
    },
  });
  hiddenDownload(panel);
  click(await findAction("button", "Close", panel));
  await waitFor(() => {
    return expect(panel).not.toBeInTheDocument();
  });
  owner.resolve();
  await returned.promise;
  click(button);
  const current = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    return expect(current.querySelector("iframe")?.src).toContain(file.url);
  });
  await expect(
    findAction("button", "Download options", current),
  ).resolves.toBeEnabled();
});
test("chat-artifact-action-group-012 a read-only viewer copies the reference without ownership controls", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const { panel, ownerUrl } = await page({ readOnly: true });
  click(await findAction("button", "Share", panel));
  await waitFor(() => {
    return expect(clipboard.writes).toContain(ownerUrl);
  });
  expect(getAction("button", "Download options", panel)).toBeVisible();
  expect(queryAction("button", "More artifact actions", panel)).toBeNull();
});
test("chat-artifact-action-group-014 a failed ownership read still allows the original document download", async () => {
  const browser = context.mocks.browser.blobDownload();
  const { panel, file } = await page({ ownerError: true });
  click(await findAction("button", "Download options", panel));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    return expect(
      browser.downloads.map((d) => {
        return d.url;
      }),
    ).toContain(file.url);
  });
  expect(getAction("button", "Close", panel)).toBeEnabled();
});
