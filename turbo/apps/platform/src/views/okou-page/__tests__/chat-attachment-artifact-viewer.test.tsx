import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import {
  findNamedMenuItem,
  ATTACHMENT_THREAD_ID,
  SECOND_ATTACHMENT_THREAD_ID,
  mockAttachmentChat,
  mockSplitAttachmentChats,
  artifactFile,
} from "./chat-attachment-test-helpers.ts";
import { createHash } from "node:crypto";
import { test, expect, vi } from "vitest";
import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import { HttpResponse } from "msw";
import { unzipSync, strFromU8 } from "fflate";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  attachment,
  assistantRow,
  userRow,
  fileParts,
  conversation,
  serveReference,
  serveUploaded,
} from "./attachment-preview-boundaries.ts";
const context = testContext();
const site = "https://launch-site.okou.app/";
function publicSite() {
  context.mocks.api(hostContract.sitePreview, ({ respond }) => {
    return respond(200, { url: site, expiresAt: null });
  });
  return artifactFile("launch-site.html", {
    url: site,
    title: "Expedition brief",
    aliasUrl: site,
    artifactKind: "hosted-site",
    contentType: "text/html",
  });
}
async function openSite() {
  const artifact = publicSite();
  await conversation(context, {
    chatEvents: [assistantRow("[Open expedition](" + site + ")")],
    artifacts: [artifact],
  });
  click(await findAction("link", "Open expedition"));
  return screen.findByTestId("attachment-lightbox");
}
test("chat-attachment-artifact-viewer-001 reopening the private text uses the original grant in both destinations", async () => {
  const f = attachment("notes.txt", "text/plain");
  const renewal = "https://cdn.okou.io/artifacts/review/session/renewed.txt";
  let next = f.url;
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    return respond(200, {
      url: next,
      downloadUrl: next,
      publicUrl: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  context.mocks.http.get(f.url.split("?")[0], () => {
    return HttpResponse.text("Original field notes");
  });
  context.mocks.http.get(renewal, () => {
    return HttpResponse.text("Renewed content");
  });
  await conversation(context, { chatEvents: [userRow(fileParts([f]))] });
  const open = await findAction("button", "Open text preview for notes.txt");
  click(open);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await within(dialog).findByText("Original field notes");
  next = renewal;
  click(await findAction("button", "Close", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  click(open);
  const again = await screen.findByTestId("attachment-lightbox");
  await within(again).findByText("Original field notes");
  click(await findAction("button", "Open in split view", again));
  const side = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(side).findByText("Original field notes"),
  ).resolves.toBeVisible();
});
test("chat-attachment-artifact-viewer-002 reselecting the hosted site and then audio reuses the sidebar", async () => {
  const f = attachment("debrief.mp3", "audio/mpeg");
  serveUploaded(context, [f]);
  const hosted = publicSite();
  await conversation(context, {
    chatEvents: [
      userRow(fileParts([f])),
      assistantRow("[Expedition](" + site + ")"),
    ],
    artifacts: [hosted],
  });
  const link = await findAction("link", "Expedition");
  click(link);
  const panel = await screen.findByTestId("attachment-lightbox");
  click(await findAction("button", "Open in split view", panel));
  const side = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(side.querySelector("iframe")?.src).toContain(site);
  });
  click(link);
  expect(screen.getAllByTestId("artifact-sidebar")).toHaveLength(1);
  expect(
    screen.getByTestId("artifact-sidebar").querySelector("iframe")?.src,
  ).toContain(site);
  expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  click(await findAction("button", "Open audio preview for debrief.mp3"));
  await waitFor(() => {
    return expect(side.querySelector("audio")).toHaveAttribute("src", f.url);
  });
  expect(side.querySelector("iframe")).toBeNull();
  expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
});
test("chat-attachment-artifact-viewer-003 the public site's title and publication date follow it into split view", async () => {
  const dialog = await openSite();
  async function header(surface: HTMLElement) {
    const title = await findAction("link", "Expedition brief", surface);
    expect(title).toHaveAttribute("href", site);
    expect(title).toHaveAttribute("target", "_blank");
    await expect(
      within(surface).findByText(/Updated at/),
    ).resolves.toBeVisible();
    expect(surface).not.toHaveTextContent(
      /launch-site\.html|Hosted site|[\d.]+\s*(?:KB|KiB|bytes)/,
    );
  }
  await header(dialog);
  click(await findAction("button", "Open in split view", dialog));
  const side = await screen.findByTestId("artifact-sidebar");
  await header(side);
  expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
});
test("chat-attachment-artifact-viewer-004 private site metadata shows an unlinked filename and update time", async () => {
  const f = attachment("private-site.html", "text/html");
  serveReference(context, f);
  await conversation(context, {
    chatEvents: [assistantRow("[Private publication](" + f.path + ")")],
    artifacts: [
      artifactFile(f.filename, {
        url: f.path,
        artifactKind: "hosted-site",
        contentType: f.contentType,
      }),
    ],
  });
  click(await findAction("link", "Private publication"));
  const dialog = await screen.findByTestId("attachment-lightbox");
  const name = await within(dialog).findByText(f.filename);
  expect(name.closest("a")).toBeNull();
  await expect(
    within(dialog).findByText(/Hosted site.*Updated at/),
  ).resolves.toBeVisible();
});
test("chat-attachment-artifact-viewer-006 each open chat navigates only its own private image sequence", async () => {
  const left = [
    attachment("shared.png", "image/png"),
    attachment("left-second.png", "image/png"),
  ];
  const right = [
    attachment("shared.png", "image/png"),
    attachment("right-second.png", "image/png"),
  ];
  left[0].url += "&pane=left";
  right[0].url += "&pane=right";
  serveUploaded(context, [...left, ...right]);
  mockSplitAttachmentChats(
    context,
    {
      threadId: ATTACHMENT_THREAD_ID,
      title: "Summit left",
      events: [
        userRow([...fileParts(left), { type: "text", text: "West route" }]),
      ],
    },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Summit right",
      events: [
        userRow([...fileParts(right), { type: "text", text: "East route" }]),
      ],
    },
  );
  await setupPage({
    context,
    path:
      "/chats/" +
      ATTACHMENT_THREAD_ID +
      "?sidebar=" +
      SECOND_ATTACHMENT_THREAD_ID,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });
  async function next(text: string, files: typeof left) {
    const row = (await screen.findByText(text)).closest('[data-role="user"]')!;
    click(await findAction("link", "Preview shared.png", row));
    const dialog = await screen.findByTestId("attachment-lightbox");
    await waitFor(() => {
      return expect(dialog.querySelector("img")).toHaveAttribute(
        "src",
        files[0].url,
      );
    });
    click(await findAction("button", "Next image artifact", dialog));
    await waitFor(() => {
      return expect(dialog.querySelector("img")).toHaveAttribute(
        "src",
        files[1].url,
      );
    });
    return dialog;
  }
  const east = await next("East route", right);
  click(await findAction("button", "Close", east));
  await waitFor(() => {
    return expect(east).not.toBeInTheDocument();
  });
  const west = await next("West route", left);
  click(await findAction("button", "Open in split view", west));
  const side = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(
      within(side).getByTestId("artifact-sidebar-body-image"),
    ).toHaveAttribute("src", left[1].url);
  });
  click(await findAction("button", "Previous image artifact", side));
  await waitFor(() => {
    return expect(
      within(side).getByTestId("artifact-sidebar-body-image"),
    ).toHaveAttribute("src", left[0].url);
  });
});
test("chat-attachment-artifact-viewer-007 only the agent image offers a share action that copies its URL", async () => {
  const files = [
    attachment("camp.png", "image/png"),
    attachment("crew.png", "image/png"),
  ];
  serveUploaded(context, files);
  const url = "https://cdn.okou.io/artifacts/field/run/overview.png";
  const clipboard = context.mocks.browser.clipboardWriteText();
  await conversation(context, {
    chatEvents: [
      userRow(fileParts(files)),
      assistantRow("![Overview](" + url + ")"),
    ],
    artifacts: [
      artifactFile("overview.png", { url, contentType: "image/png" }),
    ],
  });
  for (const f of files) {
    click(await findAction("link", "Preview " + f.filename));
    const dialog = await screen.findByTestId("attachment-lightbox");
    await waitFor(() => {
      return expect(dialog.querySelector("img")).toHaveAttribute("src", f.url);
    });
    await expect(
      findAction("button", "Download options", dialog),
    ).resolves.toBeEnabled();
    expect(queryAction("button", "Share", dialog)).toBeNull();
    click(await findAction("button", "Close", dialog));
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
  }
  click(await screen.findByAltText("Overview"));
  const agent = await screen.findByTestId("attachment-lightbox");
  click(await findAction("button", "Share", agent));
  await waitFor(() => {
    return expect(clipboard.writes).toContain(url);
  });
});
test("chat-attachment-artifact-viewer-008 the private site card uses its resolved screenshot when the thread inventory fails", async () => {
  const f = attachment("basecamp.html", "text/html");
  f.url = "https://pv-field.okou.app/";
  const cover = "https://cdn.okou.io/artifacts/field/run/basecamp.png";
  serveReference(context, f, cover);
  mockAttachmentChat(context, {
    chatEvents: [assistantRow("![Basecamp](" + f.path + ")")],
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Inventory unavailable",
      },
    });
  });
  await setupPage({
    context,
    path: "/chats/" + ATTACHMENT_THREAD_ID,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });
  const photo = await waitFor(() => {
    const img = Array.from(document.querySelectorAll("img")).find((i) => {
      return i.src.includes("basecamp.png");
    });
    if (!img) {
      throw new Error("Missing site cover");
    }
    return img;
  });
  fireEvent.load(photo);
  const card = photo.closest("a,button")!;
  expect(card.querySelector("iframe")).toBeNull();
  click(card);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    return expect(dialog.querySelector("iframe")?.src).toContain(f.url);
  });
});
test.each([
  ["chat-attachment-artifact-viewer-013", "restricted.png", 404],
  ["chat-attachment-artifact-viewer-014", "restricted.pdf", 403],
  ["chat-attachment-artifact-viewer-015", "restricted.txt", 401],
] as const)(
  "%s explains a denied reference inside its lightbox",
  async (_id, name, status) => {
    const f = attachment(name, "application/octet-stream");
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(status, {
        error: { code: "DENIED", message: "Access refused" },
      });
    });
    await conversation(context, {
      chatEvents: [assistantRow("[" + name + "](" + f.path + ")")],
    });
    click(await findAction("link", name));
    const dialog = await screen.findByTestId("attachment-lightbox");
    await expect(
      within(dialog).findByText(
        /may not exist.*different account or organization/,
      ),
    ).resolves.toBeVisible();
    await expect(
      within(dialog).findByText(
        /Ask the person who shared this link to check access/,
      ),
    ).resolves.toBeVisible();
    await expect(
      findAction("button", "Switch account", dialog),
    ).resolves.toBeEnabled();
  },
);
async function downloadSite() {
  const dialog = await openSite();
  click(await findAction("button", "Download options", dialog));
  click(await findNamedMenuItem("Download"));
}
function publication(
  contents: Record<string, string>,
  deploymentId: string = crypto.randomUUID(),
) {
  const members = Object.entries(contents).map(([path, body]) => {
    return {
      path,
      size: new TextEncoder().encode(body).length,
      sha256: createHash("sha256").update(body).digest("hex"),
      contentType: path.endsWith(".css") ? "text/css" : "text/html",
      downloadUrl: new URL(path, site).href,
    };
  });
  for (const [path, body] of Object.entries(contents)) {
    context.mocks.http.get(new URL(path, site).href, () => {
      return HttpResponse.text(body);
    });
  }
  return {
    siteId: crypto.randomUUID(),
    deploymentId,
    publicSlug: "launch-site",
    url: site,
    fileCount: members.length,
    size: members.reduce((sum, file) => {
      return sum + file.size;
    }, 0),
    files: members,
  };
}
test("chat-attachment-artifact-viewer-023 the ZIP preserves both published paths and their content", async () => {
  const files = {
    "/index.html": '<link rel="stylesheet" href="/assets/field.css">',
    "/assets/field.css": "body { color: teal; }",
  };
  const manifest = publication(files);
  context.mocks.api(hostContract.files, ({ respond }) => {
    return respond(200, manifest);
  });
  const browser = context.mocks.browser.blobDownload();
  await downloadSite();
  await waitFor(() => {
    return expect(
      browser.downloads.map((d) => {
        return d.filename;
      }),
    ).toStrictEqual(["launch-site.zip"]);
  });
  const archive = unzipSync(
    new Uint8Array(await browser.downloads[0].blob!.arrayBuffer()),
  );
  expect(
    Object.fromEntries(
      Object.entries(archive).map(([path, bytes]) => {
        return ["/" + path, strFromU8(bytes)];
      }),
    ),
  ).toStrictEqual(files);
});
test("chat-attachment-artifact-viewer-024 a failed publication listing reports failure before producing any file", async () => {
  context.mocks.api(hostContract.files, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Listing unavailable" },
    });
  });
  const browser = context.mocks.browser.blobDownload();
  await downloadSite();
  await expect(screen.findByText("Download failed")).resolves.toBeVisible();
  expect(browser.downloads).toStrictEqual([]);
});
test("chat-attachment-artifact-viewer-025 a single-page publication downloads the original page directly", async () => {
  const listed = context.mocks.deferred<void>();
  const page = attachment("launch-site.html", "text/html");
  page.url = site;
  serveReference(context, page);
  const manifest = publication(
    { "/index.html": "<!doctype html><h1>Launch overview</h1>" },
    page.id,
  );
  context.mocks.api(artifactDownloadsContract.files, ({ params, respond }) => {
    if ("/artifacts/" + params.reference !== page.path) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unknown publication" },
      });
    }
    listed.resolve();
    return respond(200, manifest);
  });
  const browser = context.mocks.browser.blobDownload();
  await conversation(context, {
    chatEvents: [assistantRow("[Launch publication](" + page.path + ")")],
    artifacts: [
      artifactFile(page.filename, {
        id: page.id,
        url: page.path,
        contentType: page.contentType,
        artifactKind: "hosted-site",
      }),
    ],
  });
  click(await findAction("link", "Launch publication"));
  const dialog = await screen.findByTestId("attachment-lightbox");
  await within(dialog).findByText(/Hosted site.*Updated at/);
  const createObjectUrl = vi.spyOn(URL, "createObjectURL");
  click(await findAction("button", "Download options", dialog));
  click(await findNamedMenuItem("Download"));
  await listed.promise;
  await waitFor(() => {
    return expect(browser.downloads).toStrictEqual([
      { url: site, filename: "launch-site.html", blob: null },
    ]);
  });
  expect(createObjectUrl).not.toHaveBeenCalled();
});
