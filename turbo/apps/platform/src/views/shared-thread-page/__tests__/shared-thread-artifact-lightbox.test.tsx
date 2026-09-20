import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
const FILE_ID = "f0000000-0000-4000-a000-000000000942";
const SITE = "https://app.okou.ai/artifacts/lightsite1.html#slide-2";
const VIDEO = "https://app.okou.ai/artifacts/lightvid01.mp4#t=2";
const SITE_COVER = "https://app.okou.ai/artifacts/siteshot01.webp";
const VIDEO_COVER = "https://app.okou.ai/artifacts/vidcover01.jpg";
const R2_ORIGIN = `https://${"b".repeat(32)}.r2.cloudflarestorage.com`;
const SITE_URL = `https://ps-${"b".repeat(48)}.okou.app/`;
const SITE_DOWNLOAD_URL = `${R2_ORIGIN}/snapshots/site.html?X-Amz-Signature=download&response-content-disposition=attachment`;
const VIDEO_URL = `${R2_ORIGIN}/snapshots/launch.mp4?X-Amz-Signature=preview`;
const SITE_COVER_URL = `${R2_ORIGIN}/snapshots/site.webp?X-Amz-Signature=cover`;
const VIDEO_COVER_URL = `${R2_ORIGIN}/snapshots/video.jpg?X-Amz-Signature=cover`;
const THUMBNAIL_PREFIX =
  "https://a.okou.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/";

interface SnapshotResource {
  url: string;
  filename: string;
  contentType: string;
  kind: "file" | "html";
  previewImageUrl?: string;
  downloadUrl?: string;
  status?: 403 | 404;
}

function mockSnapshotResources({
  anonymous = true,
  previewImages = true,
}: {
  anonymous?: boolean;
  previewImages?: boolean;
} = {}) {
  const site: SnapshotResource = {
    url: SITE_URL,
    filename: "lightsite1.html",
    contentType: "text/html",
    kind: "html",
    ...(previewImages ? { previewImageUrl: SITE_COVER } : {}),
  };
  const video: SnapshotResource = {
    url: VIDEO_URL,
    filename: "lightvid01.mp4",
    contentType: "video/mp4",
    kind: "file",
    ...(previewImages ? { previewImageUrl: VIDEO_COVER } : {}),
  };
  const resources: Readonly<Record<string, SnapshotResource>> = {
    "lightsite1.html": site,
    "lightvid01.mp4": video,
    "siteshot01.webp": {
      url: SITE_COVER_URL,
      filename: "site.webp",
      contentType: "image/webp",
      kind: "file",
    },
    "vidcover01.jpg": {
      url: VIDEO_COVER_URL,
      filename: "video.jpg",
      contentType: "image/jpeg",
      kind: "file",
    },
  };
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, request, respond }) => {
      expect(request.headers.has("authorization")).toBe(!anonymous);
      const resource = resources[params.reference];
      if (!resource) {
        throw new Error(`Unexpected artifact reference: ${params.reference}`);
      }
      if (resource.status) {
        return respond(resource.status, {
          error: { code: "NOT_FOUND", message: "Artifact unavailable" },
        });
      }
      return respond(200, {
        url: resource.url,
        filename: resource.filename,
        contentType: resource.contentType,
        expiresAt: "2099-01-01T00:00:00Z",
        sharedThreadSnapshot: true,
        target: { kind: resource.kind, id: FILE_ID },
        ...(resource.previewImageUrl
          ? { previewImageUrl: resource.previewImageUrl }
          : {}),
        ...(resource.downloadUrl ? { downloadUrl: resource.downloadUrl } : {}),
      });
    },
  );
  return { site, video };
}

function mockSharedMessage(content: string) {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [{ messageIndex: 0, role: "assistant", content }],
      }),
    );
  });
}

function getButtonByName(name: string, container: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

test.each([false, true])(
  "a shared site keeps its screenshot, stable link and download in an independent viewer (signed in: %s)",
  async (signedIn) => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    const browser = context.mocks.browser.blobDownload();
    const { site } = mockSnapshotResources({ anonymous: !signedIn });
    mockSharedMessage(`![Launch site](${SITE})`);

    await setupSharedThreadPage(context, {
      host: "app.okou.ai",
      ...(signedIn
        ? {
            auth: {
              user: { id: "user_shared_artifact_viewer", fullName: "Viewer" },
            },
          }
        : {}),
      featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: false },
    });

    const card = await screen.findByTestId("markdown-artifact-preview-html");
    const thumbnail = await within(card).findByTestId(
      "attachment-preview-thumbnail",
    );
    expect(thumbnail).toHaveAttribute(
      "src",
      `${THUMBNAIL_PREFIX}${SITE_COVER_URL}`,
    );
    fireEvent.load(thumbnail);
    expect(card).toHaveAttribute("href", SITE);
    expect(card.querySelector("iframe")).not.toBeInTheDocument();

    click(card);

    const dialog = await screen.findByRole("dialog");
    const frame = await within(dialog).findByTestId(
      "artifact-dialog-body-html",
    );
    expect(frame).toHaveAttribute("src", `${SITE_URL}#slide-2`);
    expect(frame).toHaveAttribute("sandbox", "allow-same-origin allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "origin");
    expect(dialog).toHaveAttribute("data-mode", "windowed");
    expect(
      queryAllByRoleFast("button", dialog)
        .map((button) => {
          return (
            button.getAttribute("aria-label") ?? button.textContent?.trim()
          );
        })
        .sort(),
    ).toStrictEqual(["Close", "Copy link", "Download", "Enter fullscreen"]);
    expect(within(dialog).queryByRole("radiogroup")).not.toBeInTheDocument();

    click(getButtonByName("Copy link", dialog));

    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([SITE]);
    });
    site.downloadUrl = SITE_DOWNLOAD_URL;
    click(getButtonByName("Download", dialog));

    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    expect(browser.downloads[0]).toStrictEqual({
      url: SITE_DOWNLOAD_URL,
      filename: "lightsite1.html",
      blob: null,
    });
    expect(frame).toHaveAttribute("src", `${SITE_URL}#slide-2`);

    click(getButtonByName("Enter fullscreen", dialog));

    await waitFor(() => {
      expect(dialog).toHaveAttribute("data-mode", "fullscreen");
    });
    click(getButtonByName("Exit fullscreen", dialog));

    await waitFor(() => {
      expect(dialog).toHaveAttribute("data-mode", "windowed");
    });
    click(getButtonByName("Close", dialog));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(card).toBeInTheDocument();
  },
);

test("a signed-in viewer downloads freshly authorized bytes from a normal artifact reference", async () => {
  const browser = context.mocks.browser.blobDownload();
  const previewUrl = `${R2_ORIGIN}/files/launch.mp4?X-Amz-Signature=preview`;
  const video = { url: previewUrl };
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ request, respond }) => {
      expect(request.headers.has("authorization")).toBeTruthy();
      return respond(200, {
        url: video.url,
        filename: "lightvid01.mp4",
        contentType: "video/mp4",
        expiresAt: "2099-01-01T00:00:00Z",
        target: { kind: "file", id: FILE_ID },
      });
    },
  );
  const downloadUrl = `${R2_ORIGIN}/files/launch.mp4?X-Amz-Signature=download`;
  context.mocks.http.get(`${R2_ORIGIN}/files/launch.mp4`, ({ request }) => {
    return new URL(request.url).searchParams.get("X-Amz-Signature") ===
      "download"
      ? HttpResponse.text("shared video bytes", {
          headers: { "Content-Type": "video/mp4" },
        })
      : new HttpResponse(null, { status: 403 });
  });
  mockSharedMessage(`![Launch video](${VIDEO})`);

  await setupSharedThreadPage(context, {
    host: "app.okou.ai",
    auth: { user: { id: "user_shared_artifact_viewer", fullName: "Viewer" } },
  });

  const card = await screen.findByTestId("markdown-artifact-preview-video");
  await waitFor(() => {
    expect(card.querySelector("video")).toHaveAttribute(
      "src",
      `${previewUrl}#t=0.001`,
    );
  });

  click(card);

  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(dialog.querySelector("video")).toHaveAttribute(
      "src",
      `${previewUrl}#t=2`,
    );
  });
  video.url = downloadUrl;
  click(getButtonByName("Download", dialog));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]?.filename).toBe("lightvid01.mp4");
  await expect(browser.downloads[0]?.blob?.text()).resolves.toBe(
    "shared video bytes",
  );
  expect(dialog.querySelector("video")).toHaveAttribute(
    "src",
    `${previewUrl}#t=2`,
  );
});

test("a signed-in viewer switching shared conversations cancels the active download and resets the preview", async () => {
  const browser = context.mocks.browser.blobDownload();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const requested = context.mocks.deferred<void>();
  const cancelled = context.mocks.deferred<void>();
  const videoUrl = `${R2_ORIGIN}/files/launch.mp4?X-Amz-Signature=preview`;
  const nextId = "30000000-0000-4000-8000-000000000703";
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ request, respond }) => {
      expect(request.headers.has("authorization")).toBeTruthy();
      return respond(200, {
        url: videoUrl,
        filename: "lightvid01.mp4",
        contentType: "video/mp4",
        expiresAt: "2099-01-01T00:00:00Z",
        target: { kind: "file", id: FILE_ID },
      });
    },
  );
  context.mocks.api(sharedThreadsContract.get, ({ params, respond }) => {
    return respond(
      200,
      sharedThread({
        id: params.id,
        title:
          params.id === nextId ? "Next shared conversation" : "Launch review",
        messages: [
          {
            messageIndex: 0,
            role: "assistant",
            content: `![Launch video](${VIDEO})`,
          },
        ],
      }),
    );
  });
  context.mocks.http.get(
    `${R2_ORIGIN}/files/launch.mp4`,
    async ({ request }) => {
      request.signal.addEventListener(
        "abort",
        () => {
          cancelled.resolve();
        },
        { once: true },
      );
      requested.resolve();
      await cancelled.promise;
      return HttpResponse.text("shared video bytes", {
        headers: { "Content-Type": "video/mp4" },
      });
    },
  );

  await setupSharedThreadPage(context, {
    host: "app.okou.ai",
    auth: { user: { id: "user_shared_artifact_viewer", fullName: "Viewer" } },
  });

  click(await screen.findByTestId("markdown-artifact-preview-video"));

  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(getButtonByName("Download", dialog)).toBeEnabled();
  });
  click(getButtonByName("Download", dialog));
  await requested.promise;

  act(() => {
    window.history.pushState({}, "", `/share/threads/${nextId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await cancelled.promise;
  await expect(
    screen.findByRole("heading", { name: "Next shared conversation" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(browser.downloads).toStrictEqual([]);

  click(await screen.findByTestId("markdown-artifact-preview-video"));

  const nextDialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(nextDialog.querySelector("video")).toHaveAttribute(
      "src",
      `${videoUrl}#t=2`,
    );
  });
  click(getButtonByName("Copy link", nextDialog));

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([VIDEO]);
  });
});

test("a shared video uses its generated cover and plays the original in the viewer", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockSnapshotResources();
  mockSharedMessage(`![Launch video](${VIDEO})`);

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const card = await screen.findByTestId("markdown-artifact-preview-video");
  const thumbnail = await within(card).findByTestId(
    "chat-video-preview-thumbnail",
  );
  expect(thumbnail).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${VIDEO_COVER_URL}`,
  );
  fireEvent.load(thumbnail);
  expect(
    within(card).queryByTestId("chat-video-preview-fallback"),
  ).not.toBeInTheDocument();

  click(card);

  const dialog = await screen.findByRole("dialog");
  const stage = await within(dialog).findByTestId(
    "artifact-dialog-video-stage",
  );
  await waitFor(() => {
    expect(stage.querySelector("video")).toHaveAttribute(
      "src",
      `${VIDEO_URL}#t=2`,
    );
  });
  expect(stage.querySelector("video")).toHaveAttribute("controls");
  expect(stage.querySelector("video")).toHaveAttribute("autoplay");

  click(getButtonByName("Copy link", dialog));

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([VIDEO]);
  });
  click(getButtonByName("Enter fullscreen", dialog));

  await waitFor(() => {
    expect(dialog).toHaveAttribute("data-mode", "fullscreen");
  });
  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(dialog).toHaveAttribute("data-mode", "windowed");
  });
  expect(stage.querySelector("video")).toHaveAttribute(
    "src",
    `${VIDEO_URL}#t=2`,
  );
  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

test.each([
  {
    kind: "html",
    url: SITE,
    selector: "iframe",
    cardUrl: `${SITE_URL}#slide-2`,
    dialogUrl: `${SITE_URL}#slide-2`,
  },
  {
    kind: "video",
    url: VIDEO,
    selector: "video",
    cardUrl: `${VIDEO_URL}#t=0.001`,
    dialogUrl: `${VIDEO_URL}#t=2`,
  },
] as const)(
  "shared $kind snapshots without generated covers remain previewable",
  async ({ kind, url, selector, cardUrl, dialogUrl }) => {
    mockSnapshotResources({ previewImages: false });
    mockSharedMessage(`![Launch preview](${url})`);

    await setupSharedThreadPage(context, { host: "app.okou.ai" });

    const card = await screen.findByTestId(`markdown-artifact-preview-${kind}`);
    await waitFor(() => {
      expect(card.querySelector(selector)).toHaveAttribute("src", cardUrl);
    });
    expect(within(card).queryByRole("img")).not.toBeInTheDocument();

    click(card);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(dialog.querySelector(selector)).toHaveAttribute("src", dialogUrl);
    });
  },
);

test.each([
  {
    kind: "html",
    url: "https://launch-review.okou.app/#slide-2",
    selector: "iframe",
  },
  {
    kind: "video",
    url: "https://a.okou.io/legacyvid1.mp4#t=2",
    selector: "video",
  },
] as const)(
  "legacy shared $kind links open the viewer and keep their original URL when copied",
  async ({ kind, url, selector }) => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    mockSharedMessage(`![Legacy launch preview](${url})`);

    await setupSharedThreadPage(context, { host: "app.okou.ai" });

    const card = await screen.findByTestId(`markdown-artifact-preview-${kind}`);

    click(card);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(dialog.querySelector(selector)).toHaveAttribute("src", url);
    });
    click(getButtonByName("Copy link", dialog));

    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([url]);
    });
  },
);

test.each([403, 404] as const)(
  "an unavailable snapshot shows no private preview content: %s",
  async (status) => {
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(status, {
        error: { code: "NOT_FOUND", message: "Artifact unavailable" },
      });
    });
    mockSharedMessage(
      `![Unavailable site](${SITE})\n\n![Unavailable video](${VIDEO})`,
    );

    await setupSharedThreadPage(context, { host: "app.okou.ai" });

    await waitFor(() => {
      expect(screen.getAllByRole("status")).toHaveLength(2);
    });
    const site = screen.getByTestId("markdown-artifact-preview-html");
    const video = screen.getByTestId("markdown-artifact-preview-video");
    expect(within(site).getByRole("status")).toBeInTheDocument();
    expect(within(video).getByRole("status")).toBeInTheDocument();
    for (const card of [site, video]) {
      expect(card.querySelector("iframe, video, img")).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);

test("shared prompt attachments retain their covers and open the independent viewer", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockSnapshotResources();
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content: "Review these generated files",
            attachments: [
              {
                filename: "video.mp4",
                contentType: "video/mp4",
                size: 120,
                url: VIDEO,
              },
              {
                filename: "site.html",
                contentType: "text/html",
                size: 80,
                url: SITE,
              },
            ],
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const videoCard = await screen.findByTestId(
    "markdown-artifact-preview-video",
  );
  const videoCover = await within(videoCard).findByTestId(
    "chat-video-preview-thumbnail",
  );
  expect(videoCover).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${VIDEO_COVER_URL}`,
  );
  fireEvent.load(videoCover);
  const siteCard = screen.getByTestId("markdown-artifact-preview-html");
  const siteCover = await within(siteCard).findByTestId(
    "attachment-preview-thumbnail",
  );
  expect(siteCover).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${SITE_COVER_URL}`,
  );
  fireEvent.load(siteCover);

  click(videoCard);

  const videoDialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(videoDialog.querySelector("video")).toHaveAttribute(
      "src",
      `${VIDEO_URL}#t=2`,
    );
  });
  click(getButtonByName("Copy link", videoDialog));

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([VIDEO]);
  });
  click(getButtonByName("Close", videoDialog));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  click(siteCard);

  const siteDialog = await screen.findByRole("dialog");
  await expect(
    within(siteDialog).findByTestId("artifact-dialog-body-html"),
  ).resolves.toHaveAttribute("src", `${SITE_URL}#slide-2`);
  click(getButtonByName("Copy link", siteDialog));

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([VIDEO, SITE]);
  });
});

test("a shared site reuses its card credential across opening and reopening", async () => {
  const { site } = mockSnapshotResources();
  const refreshedUrl = `https://ps-${"d".repeat(48)}.okou.app/`;
  mockSharedMessage(`![Launch site](${SITE})`);

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const card = await screen.findByTestId("markdown-artifact-preview-html");
  const thumbnail = await within(card).findByTestId(
    "attachment-preview-thumbnail",
  );
  expect(thumbnail).toHaveAttribute(
    "src",
    `${THUMBNAIL_PREFIX}${SITE_COVER_URL}`,
  );
  fireEvent.load(thumbnail);
  site.url = refreshedUrl;

  click(card);

  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByTestId("artifact-dialog-body-html"),
  ).resolves.toHaveAttribute("src", `${SITE_URL}#slide-2`);
  expect(getButtonByName("Download", dialog)).toBeEnabled();

  click(getButtonByName("Close", dialog));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  site.status = 404;

  click(card);

  const reopenedDialog = await screen.findByRole("dialog");
  await expect(
    within(reopenedDialog).findByTestId("artifact-dialog-body-html"),
  ).resolves.toHaveAttribute("src", `${SITE_URL}#slide-2`);
  expect(getButtonByName("Download", reopenedDialog)).toBeEnabled();
});

test("revoked download access reports an error without downloading or leaving the shared conversation", async () => {
  const browser = context.mocks.browser.blobDownload();
  const replace = context.mocks.browser.locationReplace();
  const { site } = mockSnapshotResources();
  site.downloadUrl = SITE_DOWNLOAD_URL;
  mockSharedMessage(`![Launch site](${SITE})`);

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const card = await screen.findByTestId("markdown-artifact-preview-html");
  await within(card).findByTestId("attachment-preview-thumbnail");

  click(card);

  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByTestId("artifact-dialog-body-html"),
  ).resolves.toHaveAttribute("src", `${SITE_URL}#slide-2`);
  const sharedPageUrl = window.location.href;
  expect(getButtonByName("Download", dialog)).toBeEnabled();
  site.status = 404;

  click(getButtonByName("Download", dialog));

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Download failed",
  );
  expect(browser.downloads).toStrictEqual([]);
  expect(replace.calls).toStrictEqual([]);
  expect(window.location.href).toBe(sharedPageUrl);
});
