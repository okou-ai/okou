import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";

import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  setupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
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
  mockMessageArtifactDetails,
} from "./chat-attachment-test-helpers.ts";
import {
  artifactSummary,
  fileArtifactDetail,
} from "./chat-navigation-artifact-test-helpers.ts";
const context = testContext();
function resource(title: string, filename = "dispatch.pdf") {
  const file = attachment(filename, "application/pdf");
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
    artifactAccessContract.getVisibility,
    async ({ params, respond }) => {
      await options.share;
      if (options.readOnly || params.artifactId !== r.file.id) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Not owned" },
        });
      }
      return respond(200, {
        artifactId: r.file.id,
        kind: "file",
        visibility: "private",
        ownerUrl,
        shareUrl: null,
        shortUrl: null,
        organization: { id: "org_default", name: "Field team" },
      });
    },
  );
  return ownerUrl;
}
async function route(other = false) {
  await setupPage({
    context,
    host: "app.okou.ai",
    path:
      "/chats/" +
      ATTACHMENT_THREAD_ID +
      (other ? "?sidebar=" + SECOND_ATTACHMENT_THREAD_ID : ""),
  });
}
async function page(
  options: {
    share?: Hold;
    owner?: Hold;
    title?: string;
    filename?: string;
    meta?: Hold;
    readOnly?: boolean;
    onOwnerReturned?: () => void;
    ownerError?: boolean;
    configureRights?: (entry: ReturnType<typeof resource>) => void;
  } = {},
) {
  const r = resource(
    options.title ?? "Atlas of sampling stations",
    options.filename,
  );
  mockAttachmentChat(context, {
    chatEvents: [r.message],
    artifacts: [r.metadata],
  });
  if (options.meta) {
    mockMessageArtifactDetails(context, async () => {
      await options.meta;
      return [r.metadata];
    });
  }
  const ownerUrl = rights(r, options);
  options.configureRights?.(r);
  await route();
  const button = await findAction("link", r.item.title);
  click(button);
  const panel = await screen.findByTestId("artifact-sidebar");
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
  mockMessageArtifactDetails(context, async (url) => {
    if (url === next.metadata.url) {
      await hold.promise;
    }
    return [earlier.metadata, next.metadata];
  });
  rights(next);
  await route(true);
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
  expect(getAction("button", "Share artifact", panel)).toBeVisible();
});
test("chat-artifact-action-group-006 metadata unlocks actions after the document is already readable", async () => {
  const metadata = context.mocks.deferred<void>();
  const { panel } = await page({ meta: metadata.promise });
  hiddenDownload(panel);
  metadata.resolve();
  await ready(panel);
  expect(getAction("button", "Download artifact", panel)).toBeEnabled();
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
  click(await findAction("button", "Close artifact", panel));
  await waitFor(() => {
    return expect(panel).not.toBeInTheDocument();
  });
  owner.resolve();
  await returned.promise;
  click(button);
  const current = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(current.querySelector("iframe")?.src).toContain(file.url);
  });
  await expect(
    findAction("button", "Download artifact", current),
  ).resolves.toBeEnabled();
});
test("chat-artifact-action-group-012 a read-only viewer copies the reference without ownership controls", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const { panel, ownerUrl } = await page({ readOnly: true });
  click(await findAction("button", "Share artifact", panel));
  await waitFor(() => {
    return expect(clipboard.writes).toContain(ownerUrl);
  });
  expect(getAction("button", "Download artifact", panel)).toBeVisible();
  expect(queryAction("button", "More artifact actions", panel)).toBeNull();
});

test.each(["sharing", "deletion"] as const)(
  "Closing a preview cancels its %s permission read and reopening recovers",
  async (kind) => {
    const began = context.mocks.deferred<void>();
    const aborted = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const responded = context.mocks.deferred<void>();
    let pending = true;
    const hold = async (request: Request) => {
      if (!pending) {
        return false;
      }
      request.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
        },
        { once: true },
      );
      began.resolve();
      await release.promise;
      responded.resolve();
      return true;
    };
    const { panel, button } = await page({
      configureRights: (r) => {
        if (kind === "sharing") {
          context.mocks.api(
            artifactAccessContract.getVisibility,
            async ({ request, respond }) => {
              return (await hold(request))
                ? respond(500, {
                    error: {
                      code: "FAILED",
                      message: "Closed preview permission read failed",
                    },
                  })
                : respond(200, {
                    artifactId: r.file.id,
                    kind: "file",
                    visibility: "private",
                    ownerUrl: "https://app.okou.ai" + r.file.path,
                    shareUrl: null,
                    shortUrl: null,
                    organization: { id: "org_default", name: "Field team" },
                  });
            },
          );
        } else {
          context.mocks.api(
            artifactCatalogContract.get,
            async ({ request, respond }) => {
              return (await hold(request))
                ? respond(500, {
                    error: {
                      code: "FAILED",
                      message: "Closed preview permission read failed",
                    },
                  })
                : respond(200, r.detail);
            },
          );
        }
      },
    });
    await began.promise;
    click(await findAction("button", "Close artifact", panel));
    await waitFor(() => {
      expect(panel).not.toBeInTheDocument();
    });
    await aborted.promise;
    pending = false;
    await act(async () => {
      release.resolve();
      await responded.promise;
    });
    click(button);
    const current = await screen.findByTestId("artifact-sidebar");
    await ready(current);
    expect(getAction("button", "Share artifact", current)).toBeVisible();
    expect(
      screen.queryByText("Closed preview permission read failed"),
    ).not.toBeInTheDocument();
  },
);
test("chat-artifact-action-group-014 a failed ownership read still allows the original document download", async () => {
  const browser = context.mocks.browser.blobDownload();
  const { panel, file } = await page({ ownerError: true });
  click(await findAction("button", "Download artifact", panel));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    return expect(
      browser.downloads.map((d) => {
        return d.url;
      }),
    ).toContain(file.url);
  });
  expect(getAction("button", "Close artifact", panel)).toBeEnabled();
});

test.each([
  ["Coastal atlas.pdf", "station-grid.pdf"],
  ["station-grid.pdf", "Coastal atlas.pdf"],
])(
  "The owned sidebar shows %s and saves %s before deletion",
  async (title, filename) => {
    const downloads = context.mocks.browser.blobDownload();
    context.mocks.api(artifactCatalogContract.delete, ({ respond }) => {
      return respond(200, { deleted: true });
    });
    const { panel, file, item } = await page({ title, filename });
    await ready(panel);
    expect(item.title).not.toBe(file.filename);
    expect(panel).toHaveTextContent(item.title);
    const more = await findAction("button", "More artifact actions", panel);
    const separator = within(panel).getByRole("separator");
    const full = getAction("button", "Enter fullscreen", panel);
    const close = getAction("button", "Close artifact", panel);
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    for (const [before, after] of [
      [more, separator],
      [separator, full],
      [full, close],
    ] as const) {
      expect(
        before.compareDocumentPosition(after) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    click(more);
    const menu = await screen.findByRole("menu");
    expect(
      queryAllByRoleFast("menuitem", menu).map((row) => {
        return row.textContent?.trim();
      }),
    ).toStrictEqual(["Delete"]);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(menu).not.toBeInTheDocument();
    });
    const share = await findAction("button", "Share artifact", panel);
    click(share);
    const shareDialog = await screen.findByRole("dialog", { name: /Share/ });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(shareDialog).not.toBeInTheDocument();
    });
    click(await findAction("button", "Download artifact", panel));
    click(await findNamedMenuItem("Download"));
    await waitFor(() => {
      expect(downloads.downloads).toContainEqual(
        expect.objectContaining({ url: file.url, filename }),
      );
    });
    click(more);
    click(await findNamedMenuItem("Delete"));
    const prompt = await screen.findByRole("dialog", {
      name: "Delete " + item.title + "?",
    });
    click(await findAction("button", "Cancel", prompt));
    await waitFor(() => {
      expect(more).toHaveFocus();
    });
    click(more);
    click(await findNamedMenuItem("Delete"));
    const confirm = await screen.findByRole("dialog", {
      name: "Delete " + item.title + "?",
    });
    click(await findAction("button", "Delete", confirm));
    await screen.findByText("Artifact deleted");
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).toBeNull();
    });
  },
);
