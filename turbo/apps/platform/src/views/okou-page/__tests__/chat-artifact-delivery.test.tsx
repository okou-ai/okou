import {
  artifactReferencesContract,
  artifactReferencePath,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, waitFor, within, act } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactFile,
  findNamedButton,
  findNamedMenuItem,
  getNamedButton,
  draftAttachment,
  draftForAttachment,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";
import {
  chatPath,
  openMessageFile,
} from "./chat-artifact-preview-test-helpers.ts";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { chatArtifactCatalogChangedEvent } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactRun,
  artifactSummary,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
  hostedSiteArtifactDetail,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  assistantRow,
  attachment,
  serveReference,
  serveUploaded,
  conversation,
  fileParts,
  userRow,
} from "./attachment-preview-boundaries.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  entryHtml,
  publication,
  servePublication,
} from "./hosted-download-boundaries.ts";

const context = testContext();

async function chooseDownload(preview: HTMLElement) {
  click(await findNamedButton("Download artifact", preview));
  click(await findNamedMenuItem("Download"));
}

test.each([
  {
    id: "001",
    filename: "report.png",
    contentType: "image/png",
    bytes: [137, 80, 78, 71, 13, 10, 26, 10],
  },
  {
    id: "002",
    filename: "report.pdf",
    contentType: "application/pdf",
    bytes: [37, 80, 68, 70, 45, 49, 46, 55],
  },
])(
  "chat-artifact-download-$id retains the downloaded $filename bytes until leaving the chat",
  async ({ filename, contentType, bytes }) => {
    context.mocks.browser.requestCacheMode();
    const file = artifactFile(filename, { contentType });
    context.mocks.http.get(file.url, ({ request }) => {
      return request.cache === "reload"
        ? HttpResponse.arrayBuffer(Uint8Array.from(bytes).buffer, {
            headers: { "Content-Type": contentType },
          })
        : new HttpResponse(null, { status: 412 });
    });
    const browser = context.mocks.browser.blobDownload({ deferRead: true });
    const viewer = await openMessageFile(context, file);
    await chooseDownload(viewer);
    await waitFor(() => {
      return expect(browser.downloads[0]?.filename).toBe(filename);
    });
    const saved = browser.downloads[0]!;
    expect(saved.blob?.type).toBe(contentType);
    expect(
      Array.from(new Uint8Array(await saved.blob!.arrayBuffer())),
    ).toStrictEqual(bytes);
    expect(location.pathname).toBe(chatPath);
    click(getNamedButton("Close artifact", viewer));
    await waitFor(() => {
      return expect(
        screen.queryByRole("dialog", { name: filename + " preview" }),
      ).not.toBeInTheDocument();
    });
    expect(browser.blobForUrl(saved.url)).toBe(saved.blob);
    click(screen.getByText("New chat", { selector: "a span" }));
    await waitFor(() => {
      return expect(browser.revokedUrls).toContain(saved.url);
    });
    expect(location.pathname).toBe("/");
    expect(browser.blobForUrl(saved.url)).toBeNull();
  },
);

test.each([
  { id: "003", filename: "photo.png", type: "image", contentType: "image/png" },
  {
    id: "004",
    filename: "report.pdf",
    type: "pdf",
    contentType: "application/pdf",
  },
  {
    id: "008",
    filename: "proposal.DOCX",
    type: "document",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
])(
  "chat-artifact-download-$id delivers each $filename grant from the open preview",
  async ({ filename, type, contentType }) => {
    const previewUrl = "https://media.example.test/review/" + filename;
    let grant = previewUrl + "?mode=preview";
    context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
      return respond(200, {
        url: previewUrl,
        downloadUrl: grant,
        expiresAt: "2099-01-01T00:00:00Z",
        publicUrl: null,
      });
    });
    const browser = context.mocks.browser.blobDownload();
    const analytics = context.mocks.posthog();
    const navigation = context.mocks.browser.locationAssign();
    const viewer = await openMessageFile(
      context,
      artifactFile(filename, {
        url: "https://api.okou.ai/api/web/file-url?file_id=" + filename,
        contentType,
      }),
      { host: "app.okou.ai" },
    );
    for (const token of ["first", "renewed"]) {
      grant = previewUrl + "?ticket=" + token;
      const start = analytics.events.length;
      await chooseDownload(viewer);
      await waitFor(() => {
        return expect(browser.downloads).toContainEqual({
          url: grant,
          filename,
          blob: null,
        });
      });
      expect(analytics.events.slice(start)).toContainEqual(
        expect.objectContaining({
          name: "artifact_action_clicked",
          properties: {
            action: "download",
            surface: "page",
            artifact_type: type,
          },
        }),
      );
      expect(location.pathname).toBe(chatPath);
      expect(navigation.calls).toStrictEqual([]);
    }
  },
);

test("chat-artifact-download-011 keeps the PDF available when download requires a plan", async () => {
  const url = "https://media.example.test/review/report.pdf";
  const file = artifactFile("report.pdf", {
    url: "https://app.okou.ai/artifacts/cafe002611.pdf",
    contentType: "application/pdf",
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url,
      downloadUrl: url + "?save",
      filename: file.filename,
      contentType: file.contentType,
      downloadAllowed: false,
      expiresAt: "2099-01-01T00:00:00Z",
      target: { kind: "file", id: "10000000-0000-4000-8000-000000000026" },
    });
  });
  const browser = context.mocks.browser.blobDownload();
  const viewer = await openMessageFile(context, file, { host: "app.okou.ai" });
  const frame = await within(viewer).findByTitle(/\.pdf preview$/u);
  await chooseDownload(viewer);
  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
  expect(frame).toBeInTheDocument();
  expect(frame).toHaveAttribute("src", url + "#navpanes=0");
  expect(browser.downloads).toStrictEqual([]);
});

const ARTIFACT_ID = "e0000000-0000-4000-a000-000000000950";
const SITE_ID = "e0000000-0000-4000-a000-000000000951";
const FILE_ID = "e0000000-0000-4000-a000-000000000952";
const TITLE = "Release report";
const FILENAME = "release-report.html";
const TOPIC = chatArtifactCatalogChangedEvent(NAVIGATION_ARTIFACT_THREAD_ID);

function previewUrl(version: number) {
  return `https://pv-release-v${version}.okou.app/`;
}

async function setupPublication(
  source: "site" | "reference" | "snapshot" | "deployment",
  resolveUrl: (version: number) => string | Promise<string> = previewUrl,
) {
  let version = 1;
  const canonicalUrl =
    source === "site"
      ? "https://release-report.okou.app/"
      : source === "deployment"
        ? `https://dpl-${FILE_ID}.okou.app/`
        : artifactReferencePath(FILE_ID, FILENAME);
  const summary = artifactSummary(ARTIFACT_ID, "hosted-site", TITLE);
  context.mocks.browser.matchMedia(true);
  mockArtifactConversation(context, {
    catalog: [summary],
    getDetail: () => {
      if (source === "reference" || source === "snapshot") {
        return {
          ...summary,
          kind: "file",
          file: {
            id: FILE_ID,
            filename: FILENAME,
            contentType: "text/html",
            size: 128,
            url: canonicalUrl,
            previewImageUrl: null,
          },
        };
      }
      return {
        ...summary,
        kind: "hosted-site",
        site: {
          id: SITE_ID,
          slug: "release-report",
          publicSlug: "release-report",
          url: canonicalUrl,
          deploymentVersion: version,
          entrypoint: "index.html",
          spaFallback: false,
        },
      };
    },
    artifactRuns: () => {
      return [
        artifactRun({
          artifactId: ARTIFACT_ID,
          filename: FILENAME,
          fileId: FILE_ID,
          contentType: "text/html",
          url: canonicalUrl,
        }),
      ];
    },
    chatEvents: [
      {
        id: "release-report-message",
        createdAt: "2026-09-01T12:00:00.000Z",
        role: "assistant",
        content: `![${FILENAME}](${canonicalUrl})`,
        runId: NAVIGATION_ARTIFACT_RUN_ID,
        seqId: 1,
      },
      {
        id: "release-report-completed",
        createdAt: "2026-09-01T12:00:01.000Z",
        role: "assistant",
        content: null,
        runId: NAVIGATION_ARTIFACT_RUN_ID,
        runLifecycleEvent: "completed",
        seqId: 2,
      },
    ],
  });
  context.mocks.api(hostContract.sitePreview, async ({ params, respond }) => {
    const resolvedVersion = params.publicSlug.startsWith("dpl-") ? 1 : version;
    return respond(200, {
      url: await resolveUrl(resolvedVersion),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  context.mocks.api(artifactReferencesContract.resolve, async ({ respond }) => {
    const url = await resolveUrl(source === "snapshot" ? 1 : version);
    return respond(200, {
      url,
      downloadUrl: new URL("?download=1", url).href,
      expiresAt: "2099-01-01T00:00:00.000Z",
      filename: FILENAME,
      contentType: "text/html",
      target: { kind: "file", id: FILE_ID },
      ...(source === "snapshot" ? { sharedThreadSnapshot: true as const } : {}),
    });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(TOPIC)).toBeTruthy();
  });
  return {
    publish: async (
      nextVersion: number,
      delivery: "catalog" | "artifact" = "catalog",
    ) => {
      version = nextVersion;
      await act(() => {
        context.mocks.ably.trigger(
          delivery === "catalog" ? TOPIC : "artifact:changed",
          { artifactId: ARTIFACT_ID },
        );
      });
    },
  };
}

async function openPreview(entry: "message" | "catalog") {
  if (entry === "catalog") {
    await openResourceArtifact(TITLE);
  } else {
    click(await screen.findByLabelText(`Open html preview for ${FILENAME}`));
  }
  return await screen.findByTestId("artifact-sidebar");
}

async function expectVersion(expected: number) {
  await waitFor(() => {
    expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
      "src",
      previewUrl(expected),
    );
  });
}

async function closePreview() {
  const sidebar = screen.getByTestId("artifact-sidebar");
  click(buttonNamed("Close artifact", sidebar));
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });
}

test.each([
  { entry: "message", source: "site", delivery: "catalog" },
  { entry: "catalog", source: "site", delivery: "catalog" },
  { entry: "message", source: "reference", delivery: "catalog" },
  { entry: "message", source: "reference", delivery: "artifact" },
  { entry: "catalog", source: "site", delivery: "artifact" },
] as const)(
  "The $entry sidebar follows $source updates from $delivery notifications while open and after reopening",
  async ({ entry, source, delivery }) => {
    const publication = await setupPublication(source);
    await openPreview(entry);
    await expectVersion(1);
    await closePreview();
    await openPreview(entry);
    await expectVersion(1);

    await publication.publish(2, delivery);
    await expectVersion(2);
    await closePreview();
    await openPreview(entry);
    await expectVersion(2);

    await closePreview();
    await publication.publish(3, delivery);
    await openPreview(entry);
    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        previewUrl(3),
      );
    });
  },
);

test.each(["snapshot", "deployment"] as const)(
  "A published update preserves the version of an immutable %s link",
  async (source) => {
    const publication = await setupPublication(source);
    await openPreview("message");
    await expectVersion(1);
    await publication.publish(2);
    await closePreview();
    await openPreview("message");
    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        previewUrl(1),
      );
    });
  },
);

test("A late v1 preview response preserves the published v2 sidebar", async () => {
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<string>();
  const returned = context.mocks.deferred<void>();
  const publication = await setupPublication("site", async (version) => {
    if (version !== 1) {
      return previewUrl(version);
    }
    started.resolve();
    const url = await release.promise;
    returned.resolve();
    return url;
  });
  await openPreview("message");
  await started.promise;
  await publication.publish(2);
  await expectVersion(2);
  await act(async () => {
    release.resolve(previewUrl(1));
    await returned.promise;
  });
  await closePreview();
  await openPreview("message");
  await waitFor(() => {
    expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
      "src",
      previewUrl(2),
    );
  });
});

test.each([
  ["artifact-download-type-006", "video", "video/mp4", "dialog"],
  ["artifact-download-type-007", "audio", "audio/mpeg", "page"],
] as const)(
  "%s reports the MIME type of the extensionless recording from its own preview",
  async (_id, kind, mime, surface) => {
    const file = attachment("recording", mime),
      sink = context.mocks.posthog(),
      browser = context.mocks.browser.blobDownload();
    serveUploaded(context, [file]);
    const sidebar = surface === "page";
    const draft = draftForAttachment(
      draftAttachment(file.filename, {
        id: file.id,
        contentType: mime,
        url: privateAttachmentUrl(file.id),
      }),
    );
    await conversation(
      context,
      sidebar ? { chatEvents: [userRow(fileParts([file]))] } : { draft },
    );
    click(
      await findAction("button", "Open " + kind + " preview for recording"),
    );
    const panel = await screen.findByTestId(
      sidebar ? "artifact-sidebar" : "attachment-lightbox",
    );
    await waitFor(() => {
      return expect(panel.querySelector(kind)).toHaveAttribute("src", file.url);
    });
    click(
      await findAction(
        "button",
        sidebar ? "Download artifact" : "Download options",
        panel,
      ),
    );
    click(await findNamedMenuItem("Download"));
    await waitFor(() => {
      return expect(browser.downloads).toStrictEqual([
        { url: file.url, filename: file.filename, blob: null },
      ]);
    });
    expect(
      sink.events
        .filter((e) => {
          return e.name === "artifact_action_clicked";
        })
        .map((e) => {
          return e.properties;
        }),
    ).toStrictEqual([{ action: "download", surface, artifact_type: kind }]);
  },
);

test("artifact-download-type-001 the catalog site downloads as HTML even when its title ends in png", async () => {
  const summary = artifactSummary(
    crypto.randomUUID(),
    "hosted-site",
    "Confidential board review.png",
  );
  const detail = hostedSiteArtifactDetail(summary, {
    siteId: crypto.randomUUID(),
    slug: "launch-site",
    url: publication,
  });
  const sink = context.mocks.posthog(),
    browser = context.mocks.browser.blobDownload();
  mockArtifactConversation(context, {
    catalog: [summary],
    details: new Map([[summary.id, detail]]),
  });
  servePublication(context, "single");
  await setupPage({
    context,
    path: "/artifacts",
    host: "app.okou.ai",
  });
  click(await screen.findByText(summary.title));
  const panel = await screen.findByTestId("artifact-sidebar");
  click(await findAction("button", "Download artifact", panel));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    return expect(browser.downloads[0]?.filename).toBe(
      "Confidential board review.html",
    );
  });
  await expect(browser.downloads[0]!.blob!.text()).resolves.toBe(entryHtml);
  expect(sink.events).toContainEqual(
    expect.objectContaining({
      name: "artifact_action_clicked",
      properties: {
        action: "download",
        surface: "page",
        artifact_type: "website",
      },
    }),
  );
});
test("artifact-download-type-005 the preview download classifies the resolved workbook by its MIME type", async () => {
  const file = attachment(
    "forecast.bin",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  const sink = context.mocks.posthog(),
    browser = context.mocks.browser.blobDownload();
  serveReference(context, file);
  await conversation(context, {
    chatEvents: [assistantRow("[forecast.bin](" + file.path + ")")],
    artifacts: [
      artifactFile(file.filename, {
        url: file.path,
        id: file.id,
        contentType: file.contentType,
      }),
    ],
  });
  click(await findAction("link", "forecast.bin"));
  const panel = await screen.findByTestId("artifact-sidebar");
  const nativeFile = expect.objectContaining({ url: file.url, blob: null });
  click(await findAction("button", "Download artifact", panel));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    return expect(browser.downloads[0]).toStrictEqual(nativeFile);
  });
  expect(sink.events).toContainEqual(
    expect.objectContaining({
      name: "artifact_action_clicked",
      properties: {
        action: "download",
        surface: "page",
        artifact_type: "spreadsheet",
      },
    }),
  );
});
