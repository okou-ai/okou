import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow, now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  draftAttachment,
  draftForAttachment,
  privateAttachmentUrl,
  findNamedButton,
  findNamedLink,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const NOW = Date.parse("2026-09-14T00:00:00.000Z");
const TTL = 2 * 24 * 60 * 60 * 1000;
const FILE_ID = "f0000000-0000-4000-a000-000000000943";
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const THUMBNAIL_PREFIX =
  "https://cdn.vm7.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/";

function mockExpiringArtifact({
  filename = "photo.png",
  contentType = "image/png",
  firstLifetime = TTL,
  duplicate = false,
  denied = false,
  expiredResponse = false,
}: {
  filename?: string;
  contentType?: string;
  firstLifetime?: number;
  duplicate?: boolean;
  denied?: boolean;
  expiredResponse?: boolean;
} = {}) {
  mockNow(NOW, context.signal);
  const canonical = artifactReferencePath(FILE_ID, filename);
  const firstUrl = `${R2_ORIGIN}/private/${filename}?X-Amz-Signature=first`;
  const nextUrl = `${R2_ORIGIN}/private/${filename}?X-Amz-Signature=next`;
  const content =
    contentType === "image/png"
      ? `![${filename}](${canonical})`
      : `[${filename}](${canonical})`;
  mockAttachmentChat(context, {
    artifacts: [
      artifactFile(filename, { id: FILE_ID, contentType, url: canonical }),
    ],
    chatEvents: [
      {
        id: "expiring-artifact-message",
        role: "assistant",
        content: duplicate ? `${content}\n\n${content}` : content,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "expiring-artifact-event",
        sequenceNumber: 1,
        createdAt: new Date(NOW).toISOString(),
      },
    ],
  });
  const resolutions: string[] = [];
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      resolutions.push(params.reference);
      if (denied && resolutions.length > 1) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Access denied" },
        });
      }
      const expired = now() >= NOW + firstLifetime;
      return respond(200, {
        url: expired ? nextUrl : firstUrl,
        expiresAt: new Date(
          expiredResponse && expired
            ? NOW
            : expired
              ? now() + TTL
              : NOW + firstLifetime,
        ).toISOString(),
        filename,
        contentType,
        target: { kind: "file", id: FILE_ID },
      });
    },
  );
  return { firstUrl, nextUrl, resolutions };
}

async function openChatImage(firstUrl: string) {
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const image = await screen.findByAltText("photo.png");
  await waitFor(() => {
    expect(image).toHaveAttribute("src", `${THUMBNAIL_PREFIX}${firstUrl}`);
  });
  fireEvent.load(image);
  return image;
}

async function openImage(image: HTMLElement, expectedUrl: string) {
  click(image);
  const original = await waitFor(() => {
    const current = screen.getByTestId("attachment-lightbox-image");
    expect(current).toHaveAttribute("src", expectedUrl);
    return current;
  });
  fireEvent.load(original);
  return original;
}

async function closePreview() {
  click(await findNamedButton("Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
}

test("the expiry deadline renews once while loaded thumbnail and original stay stable", async () => {
  const fixture = mockExpiringArtifact({ firstLifetime: 100 });
  const image = await openChatImage(fixture.firstUrl);
  const original = await openImage(image, fixture.firstUrl);
  expect(fixture.resolutions).toHaveLength(1);

  mockNow(NOW + 100, context.signal);
  // The resolution itself is the contract: time passing must cause a request
  // even when every mounted media element has already loaded successfully.
  await waitFor(() => {
    expect(fixture.resolutions).toHaveLength(2);
  });
  expect(image).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${fixture.firstUrl}`,
  );
  expect(original).toHaveAttribute("src", fixture.firstUrl);
  expect(screen.queryByTestId("markdown-image-preview-loading")).toBeNull();

  await closePreview();
  await openImage(image, fixture.nextUrl);
  expect(fixture.resolutions).toHaveLength(2);
  expect(image).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${fixture.firstUrl}`,
  );
});

test("foreground catch-up shares the renewal across mounted consumers without reloading them", async () => {
  const fixture = mockExpiringArtifact();
  const visibility = context.mocks.browser.visibilityState("visible");
  const image = await openChatImage(fixture.firstUrl);
  const original = await openImage(image, fixture.firstUrl);
  visibility.changeTo("hidden");
  mockNow(NOW + TTL, context.signal);
  visibility.changeTo("visible");
  await waitFor(() => {
    expect(fixture.resolutions).toHaveLength(2);
  });
  expect(original).toHaveAttribute("src", fixture.firstUrl);
  expect(image).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${fixture.firstUrl}`,
  );
  visibility.changeTo("hidden");
  visibility.changeTo("visible");
  await closePreview();
  await openImage(image, fixture.nextUrl);
  expect(fixture.resolutions).toHaveLength(2);
});

test("reopening checks expiry even before a delayed timer or visibility event runs", async () => {
  const fixture = mockExpiringArtifact();
  const image = await openChatImage(fixture.firstUrl);
  await openImage(image, fixture.firstUrl);
  await closePreview();
  mockNow(NOW + TTL, context.signal);
  await openImage(image, fixture.nextUrl);
  expect(fixture.resolutions).toHaveLength(2);
  expect(image).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${fixture.firstUrl}`,
  );
});

test("concurrent expired image failures obtain one credential and recover the resource", async () => {
  const fixture = mockExpiringArtifact({ duplicate: true });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const images = await screen.findAllByAltText("photo.png");
  await waitFor(() => {
    for (const image of images) {
      expect(image).toHaveAttribute(
        "src",
        `${THUMBNAIL_PREFIX}${fixture.firstUrl}`,
      );
    }
  });
  mockNow(NOW + TTL, context.signal);
  for (const image of images) {
    fireEvent.error(image);
  }
  await waitFor(() => {
    for (const image of screen.getAllByAltText("photo.png")) {
      expect(image).toHaveAttribute(
        "src",
        `${THUMBNAIL_PREFIX}${fixture.nextUrl}`,
      );
    }
  });
  expect(fixture.resolutions).toHaveLength(2);
  const recovered = screen.getAllByAltText("photo.png")[0]!;
  fireEvent.load(recovered);
  await openImage(recovered, fixture.nextUrl);
  expect(fixture.resolutions).toHaveLength(2);
});

test("media failures during a valid credential do not reauthorize", async () => {
  const fixture = mockExpiringArtifact();
  const image = await openChatImage(fixture.firstUrl);
  fireEvent.error(image);
  await openImage(image, fixture.firstUrl);
  expect(fixture.resolutions).toHaveLength(1);
});

test.each(["denied", "expiredResponse"] as const)(
  "%s renewal stops without falling back or retrying on more foreground events",
  async (failure) => {
    const fixture = mockExpiringArtifact({ [failure]: true });
    const visibility = context.mocks.browser.visibilityState("visible");
    const image = await openChatImage(fixture.firstUrl);
    const original = await openImage(image, fixture.firstUrl);
    visibility.changeTo("hidden");
    mockNow(NOW + TTL, context.signal);
    visibility.changeTo("visible");
    await waitFor(() => {
      expect(fixture.resolutions).toHaveLength(2);
    });
    expect(original).toHaveAttribute("src", fixture.firstUrl);
    await closePreview();
    click(image);
    const dialog = await screen.findByTestId("attachment-lightbox");
    visibility.changeTo("hidden");
    visibility.changeTo("visible");
    fireEvent.error(image);
    await closePreview();
    expect(
      within(dialog).queryByTestId("attachment-lightbox-image"),
    ).toBeNull();
    expect(fixture.resolutions).toHaveLength(2);
    expect(image).toHaveAttribute(
      "src",
      `${THUMBNAIL_PREFIX}${fixture.firstUrl}`,
    );
  },
);

test("credential renewal leaves the playing video's source and position unchanged", async () => {
  const fixture = mockExpiringArtifact({
    filename: "demo.mp4",
    contentType: "video/mp4",
  });
  const visibility = context.mocks.browser.visibilityState("visible");
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink("demo.mp4"));
  const stage = await screen.findByTestId("artifact-dialog-video-stage");
  const video = stage.querySelector("video");
  if (!video) {
    throw new Error("Expected video preview");
  }
  await waitFor(() => {
    expect(video).toHaveAttribute("src", fixture.firstUrl);
  });
  fireEvent.loadedData(video);
  video.currentTime = 17;
  fireEvent.play(video);
  const initialResolutions = fixture.resolutions.length;
  visibility.changeTo("hidden");
  mockNow(NOW + TTL, context.signal);
  visibility.changeTo("visible");
  await waitFor(() => {
    expect(fixture.resolutions.length).toBeGreaterThan(initialResolutions);
  });
  expect(video).toHaveAttribute("src", fixture.firstUrl);
  expect(video.currentTime).toBe(17);
  fireEvent.error(video);
  await waitFor(() => {
    expect(video).toHaveAttribute("src", fixture.nextUrl);
  });
  // Model the browser clearing its playhead when replacing a failed source.
  video.currentTime = 0;
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(17);
  await closePreview();
});

test("closing the only credential consumer removes its expiry and wakeup work", async () => {
  const fixture = mockExpiringArtifact({
    filename: "notes.pdf",
    contentType: "application/pdf",
  });
  const visibility = context.mocks.browser.visibilityState("visible");
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  click(await findNamedLink("notes.pdf"));
  const dialog = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    expect(dialog.querySelector("iframe")).toHaveAttribute(
      "src",
      `${fixture.firstUrl}#navpanes=0`,
    );
  });
  await closePreview();
  mockNow(NOW + TTL, context.signal);
  visibility.changeTo("hidden");
  visibility.changeTo("visible");
  click(await findNamedLink("notes.pdf"));
  const reopened = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    expect(reopened.querySelector("iframe")).toHaveAttribute(
      "src",
      `${fixture.nextUrl}#navpanes=0`,
    );
  });
  expect(fixture.resolutions).toHaveLength(2);
});

test("an expired restored draft credential is replaced before its lightbox is used", async () => {
  mockNow(NOW, context.signal);
  const firstUrl = `${R2_ORIGIN}/private/draft.png?X-Amz-Signature=expired`;
  const nextUrl = `${R2_ORIGIN}/private/draft.png?X-Amz-Signature=current`;
  const attachment = draftAttachment("draft.png", {
    id: FILE_ID,
    url: privateAttachmentUrl(FILE_ID),
  });
  mockAttachmentChat(context, { draft: draftForAttachment(attachment, "") });
  const resolutions: string[] = [];
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    resolutions.push(query.file_id);
    return respond(200, {
      url: resolutions.length === 1 ? firstUrl : nextUrl,
      expiresAt: new Date(
        resolutions.length === 1 ? NOW : NOW + TTL,
      ).toISOString(),
      publicUrl: null,
    });
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const preview = await findNamedButton("Open image preview for draft.png");
  await waitFor(() => {
    expect(preview.querySelector("img")).toHaveAttribute(
      "src",
      `${THUMBNAIL_PREFIX}${nextUrl}`,
    );
  });
  click(preview);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      nextUrl,
    );
  });
  // One draft availability check, followed by one expiry resolution; the
  // lightbox consumes that replacement without a third request.
  expect(resolutions).toHaveLength(2);
});

test.each(["reference", "private-deployment"] as const)(
  "%s HTML grants renew while the mounted document stays stable, then reopen with its fragment",
  async (entry) => {
    mockNow(NOW, context.signal);
    const canonical =
      entry === "reference"
        ? `${artifactReferencePath(FILE_ID, "report.html")}#slide-2`
        : `http://localhost/api/host/private-deployments/${FILE_ID}/view#slide-2`;
    const firstUrl = `https://pv-${"a".repeat(48)}.sites.vm7.io/`;
    const nextUrl = `https://pv-${"b".repeat(48)}.sites.vm7.io/`;
    const visibility = context.mocks.browser.visibilityState("visible");
    mockAttachmentChat(context, {
      artifacts: [
        artifactFile("report.html", {
          id: FILE_ID,
          contentType: "text/html",
          url: canonical,
          artifactKind: "hosted-site",
        }),
      ],
      chatEvents: [
        {
          id: "html-grant-message",
          role: "assistant",
          content: `[Report](${canonical})`,
          runId: ATTACHMENT_RUN_ID,
          runEventId: "html-grant-event",
          sequenceNumber: 1,
          createdAt: new Date(NOW).toISOString(),
        },
      ],
    });
    const grants: string[] = [];
    function grant() {
      const url = now() >= NOW + TTL ? nextUrl : firstUrl;
      grants.push(url);
      return { url, expiresAt: new Date(now() + TTL).toISOString() };
    }
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(200, {
        ...grant(),
        filename: "report.html",
        contentType: "text/html",
        target: { kind: "html", id: FILE_ID },
      });
    });
    context.mocks.api(hostContract.privatePreview, ({ respond }) => {
      return respond(200, grant());
    });
    await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
    click(await findNamedLink("Report"));
    const frame = await screen.findByTestId("artifact-dialog-body-html");
    await waitFor(() => {
      expect(frame).toHaveAttribute("src", `${firstUrl}#slide-2`);
    });
    visibility.changeTo("hidden");
    mockNow(NOW + TTL, context.signal);
    visibility.changeTo("visible");
    await waitFor(() => {
      expect(grants).toContain(nextUrl);
    });
    expect(frame).toHaveAttribute("src", `${firstUrl}#slide-2`);
    await closePreview();
    click(await findNamedLink("Report"));
    await waitFor(() => {
      expect(screen.getByTestId("artifact-dialog-body-html")).toHaveAttribute(
        "src",
        `${nextUrl}#slide-2`,
      );
    });
  },
);

test("uploaded image links use the renewed credential while the loaded thumbnail stays stable", async () => {
  mockNow(NOW, context.signal);
  const firstUrl = `${R2_ORIGIN}/private/upload.png?X-Amz-Signature=first`;
  const nextUrl = `${R2_ORIGIN}/private/upload.png?X-Amz-Signature=next`;
  const visibility = context.mocks.browser.visibilityState("visible");
  mockAttachmentChat(context, {
    artifacts: [
      artifactFile("upload.png", {
        id: FILE_ID,
        contentType: "image/png",
        url: privateAttachmentUrl(FILE_ID),
      }),
    ],
    chatEvents: [
      {
        id: "uploaded-expiring-image",
        role: "user",
        content: null,
        runId: ATTACHMENT_RUN_ID,
        createdAt: new Date(NOW).toISOString(),
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: FILE_ID,
              filenameSnapshot: "upload.png",
              contentType: "image/png",
            },
          ],
        },
      },
    ],
  });
  const resolutions: string[] = [];
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    resolutions.push(query.file_id);
    return respond(200, {
      url: now() >= NOW + TTL ? nextUrl : firstUrl,
      expiresAt: new Date(now() + TTL).toISOString(),
      publicUrl: null,
    });
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const link = await findNamedLink("Preview upload.png");
  const image = await screen.findByAltText("upload.png");
  await waitFor(() => {
    expect(image).toHaveAttribute("src", `${THUMBNAIL_PREFIX}${firstUrl}`);
  });
  expect(link).toHaveAttribute("href", firstUrl);
  fireEvent.load(image);
  visibility.changeTo("hidden");
  mockNow(NOW + TTL, context.signal);
  visibility.changeTo("visible");
  await waitFor(() => {
    expect(link).toHaveAttribute("href", nextUrl);
  });
  expect(image).toHaveAttribute("src", `${THUMBNAIL_PREFIX}${firstUrl}`);
  await openImage(link, nextUrl);
  expect(resolutions).toHaveLength(2);
});
