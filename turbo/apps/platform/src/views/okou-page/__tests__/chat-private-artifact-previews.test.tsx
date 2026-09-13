import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedMenuItem,
  findNamedLink,
  mockAttachmentChat,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const FILE_ID = "f0000000-0000-4000-a000-000000000941";
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const FIRST_URL = `${R2_ORIGIN}/private/photo%20%2B.png?X-Amz-Credential=key%2F20260911%2Fauto%2Fs3%2Faws4_request&X-Amz-Security-Token=token%2B%2F%3D&X-Amz-Signature=first&response-cache-control=private%2C%20no-store`;
const NEXT_URL = `${R2_ORIGIN}/private/photo.png?X-Amz-Signature=next`;
const THUMBNAIL_PREFIX =
  "https://cdn.vm7.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/";
const THUMBNAIL_URL = `${THUMBNAIL_PREFIX}${FIRST_URL}`;

function mockPrivateImage(content?: string) {
  const canonical = artifactReferencePath(FILE_ID, "photo.png");
  mockAttachmentChat(context, {
    artifacts: [
      artifactFile("photo.png", {
        id: FILE_ID,
        contentType: "image/png",
        url: canonical,
      }),
    ],
    chatEvents: [
      {
        id: "private-preview-message",
        role: "assistant",
        content: content ?? `![photo.png](${canonical})`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "private-preview-event",
        sequenceNumber: 1,
        createdAt: "2026-09-09T00:00:00.000Z",
      },
    ],
  });
  let responseUrl = FIRST_URL;
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    const url = responseUrl;
    responseUrl = NEXT_URL;
    return respond(200, {
      url,
      expiresAt: "2026-09-11T00:00:00.000Z",
      filename: "photo.png",
      contentType: "image/png",
      target: { kind: "file", id: FILE_ID },
    });
  });
}

async function openChat() {
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const image = await screen.findByAltText("photo.png");
  await waitFor(() => {
    expect(image).toHaveAttribute("src", THUMBNAIL_URL);
  });
  return image;
}

async function closePreview() {
  click(await findNamedButton("Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
}

test("production thread thumbnails use a.okou.io and open the same original", async () => {
  mockPrivateImage();
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  const image = await screen.findByAltText("photo.png");
  await waitFor(() => {
    expect(image).toHaveAttribute(
      "src",
      THUMBNAIL_URL.replace("https://cdn.vm7.io/", "https://a.okou.io/"),
    );
  });
  fireEvent.load(image);
  click(image);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      FIRST_URL,
    );
  });
});

test("opening and reopening an image uses the same presign as its thread thumbnail", async () => {
  mockPrivateImage();
  const image = await openChat();
  fireEvent.load(image);

  click(image);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      FIRST_URL,
    );
  });
  await closePreview();

  click(image);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      FIRST_URL,
    );
  });
  expect(screen.getByAltText("photo.png")).toHaveAttribute(
    "src",
    THUMBNAIL_URL,
  );
  expect(screen.queryByTestId("markdown-image-preview-loading")).toBeNull();
});

test("repeated thread images and their lightbox share one resolved original", async () => {
  const canonical = artifactReferencePath(FILE_ID, "photo.png");
  mockPrivateImage(`![photo.png](${canonical})\n\n![photo.png](${canonical})`);
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const images = await screen.findAllByAltText("photo.png");
  expect(images).toHaveLength(2);
  await waitFor(() => {
    for (const image of images) {
      expect(image).toHaveAttribute("src", THUMBNAIL_URL);
    }
  });
  click(images[0]!);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(dialog).findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", FIRST_URL);
});

test("downloads obtain a fresh credential without replacing the open image", async () => {
  mockPrivateImage();
  const downloads = context.mocks.browser.blobDownload();
  context.mocks.browser.requestCacheMode();
  context.mocks.http.get(`${R2_ORIGIN}/private/photo.png`, ({ request }) => {
    expect(request.cache).toBe("default");
    return new URL(request.url).searchParams.get("X-Amz-Signature") === "next"
      ? HttpResponse.text("private image bytes")
      : new HttpResponse(null, { status: 403 });
  });
  const image = await openChat();
  click(image);
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      FIRST_URL,
    );
  });
  click(await findNamedButton("Download options"));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    expect(downloads.downloads[0]?.filename).toBe("photo.png");
  });
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "src",
    FIRST_URL,
  );
  expect(image).toHaveAttribute("src", THUMBNAIL_URL);
});

test.each([null, "https://a.okou.io/0123456789.png"])(
  "uploaded images reuse their thread presign with publicUrl=%s",
  async (publicUrl) => {
    const url = privateAttachmentUrl(FILE_ID);
    mockAttachmentChat(context, {
      artifacts: [
        artifactFile("upload.png", {
          id: FILE_ID,
          contentType: "image/png",
          url,
        }),
      ],
      chatEvents: [
        {
          id: "uploaded-image-message",
          role: "user",
          content: null,
          runId: ATTACHMENT_RUN_ID,
          createdAt: "2026-09-09T00:00:00.000Z",
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
    let responseUrl = FIRST_URL;
    context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
      const resolved = responseUrl;
      responseUrl = NEXT_URL;
      return respond(200, {
        url: resolved,
        expiresAt: "2026-09-13T00:00:00.000Z",
        publicUrl,
      });
    });
    await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
    const image = await screen.findByAltText("upload.png");
    await waitFor(() => {
      expect(image).toHaveAttribute("src", THUMBNAIL_URL);
    });
    expect(image.closest("a")).toHaveAttribute("href", FIRST_URL);
    click(await findNamedLink("Preview upload.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "src",
        FIRST_URL,
      );
    });
    expect(image).toHaveAttribute("src", THUMBNAIL_URL);
  },
);

test("promoting a thread image to split view keeps the same original credential", async () => {
  mockPrivateImage();
  const image = await openChat();
  click(image);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(dialog).findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", FIRST_URL);
  click(await findNamedButton("Open in split view"));
  await waitFor(() => {
    const images = screen.getAllByAltText("photo.png");
    expect(
      images.some((candidate) => {
        return candidate.getAttribute("src") === FIRST_URL;
      }),
    ).toBeTruthy();
  });
  expect(image).toHaveAttribute("src", THUMBNAIL_URL);
});

test.each(["assistant", "user"] as const)(
  "navigating %s images reuses the original already resolved by each thread card",
  async (role) => {
    const secondId = "f0000000-0000-4000-a000-000000000942";
    const files = [
      { id: FILE_ID, filename: "photo.png", original: FIRST_URL },
      { id: secondId, filename: "second.png", original: NEXT_URL },
    ].map((file) => {
      return {
        ...file,
        url:
          role === "assistant"
            ? artifactReferencePath(file.id, file.filename)
            : privateAttachmentUrl(file.id),
      };
    });
    mockAttachmentChat(context, {
      artifacts: files.map((file) => {
        return artifactFile(file.filename, {
          id: file.id,
          contentType: "image/png",
          url: file.url,
        });
      }),
      chatEvents: [
        {
          id: "two-private-images",
          role,
          content:
            role === "assistant"
              ? files
                  .map((file) => {
                    return `![${file.filename}](${file.url})`;
                  })
                  .join("\n\n")
              : null,
          runId: ATTACHMENT_RUN_ID,
          runEventId: "two-private-images-event",
          sequenceNumber: 1,
          createdAt: "2026-09-09T00:00:00.000Z",
          ...(role === "user"
            ? {
                userMessage: {
                  version: 1 as const,
                  parts: files.map((file) => {
                    return {
                      type: "file" as const,
                      fileId: file.id,
                      filenameSnapshot: file.filename,
                      contentType: "image/png",
                    };
                  }),
                },
              }
            : {}),
        },
      ],
    });
    const resolvedIds = new Set<string>();
    const resolveOriginal = (id: string) => {
      const file = files.find((candidate) => {
        return candidate.id === id;
      });
      if (!file) {
        throw new Error("Unexpected image reference");
      }
      const url = resolvedIds.has(id)
        ? `${R2_ORIGIN}/unexpected.png?X-Amz-Signature=reissued`
        : file.original;
      resolvedIds.add(id);
      return {
        url,
        filename: file.filename,
        expiresAt: "2026-09-13T00:00:00.000Z",
        contentType: "image/png",
        target: { kind: "file" as const, id },
      };
    };
    context.mocks.api(
      artifactReferencesContract.resolve,
      ({ params, respond }) => {
        const file = files.find((candidate) => {
          return artifactReferencePath(
            candidate.id,
            candidate.filename,
          ).endsWith(params.reference);
        });
        if (!file) {
          throw new Error("Unexpected image reference");
        }
        return respond(200, resolveOriginal(file.id));
      },
    );
    context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
      return respond(200, {
        ...resolveOriginal(query.file_id),
        publicUrl: null,
      });
    });
    await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
    const first = await screen.findByAltText("photo.png");
    const second = await screen.findByAltText("second.png");
    await waitFor(() => {
      expect(first).toHaveAttribute("src", THUMBNAIL_URL);
      expect(second).toHaveAttribute("src", `${THUMBNAIL_PREFIX}${NEXT_URL}`);
    });
    if (role === "user") {
      click(await findNamedLink("Preview photo.png"));
    } else {
      click(first);
    }
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "src",
        FIRST_URL,
      );
    });
    click(await findNamedButton("Next image artifact"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "src",
        NEXT_URL,
      );
    });
    click(await findNamedButton("Previous image artifact"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "src",
        FIRST_URL,
      );
    });
    expect(first).toHaveAttribute("src", THUMBNAIL_URL);
    expect(second).toHaveAttribute("src", `${THUMBNAIL_PREFIX}${NEXT_URL}`);
  },
);
