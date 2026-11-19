import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { CLIENT_TYPE_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

function composerFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected the composer file input");
  }
  return input;
}

async function messageComposer(): Promise<HTMLElement> {
  return await screen.findByRole("textbox", { name: "Message" });
}

function composerCard(): HTMLElement {
  const card = document.querySelector<HTMLElement>(
    "[data-slot='chat-composer-card']",
  );
  if (!card) {
    throw new Error("Expected the composer card");
  }
  return card;
}

function uploadId(caseId: number, slot: number): string {
  return `f8000000-0000-4000-a000-${(caseId * 100 + slot)
    .toString()
    .padStart(12, "0")}`;
}

function uploadUrl(caseId: number, filename: string): string {
  return `https://uploads.vm7.test/${caseId}/${encodeURIComponent(filename)}`;
}

function captureStorageTransfers(): XMLHttpRequestUpload[] {
  const uploads: XMLHttpRequestUpload[] = [];
  const addListener = XMLHttpRequestUpload.prototype.addEventListener;
  // MSW wraps upload targets in a proxy whose dispatchEvent is a no-op.
  vi.spyOn(
    XMLHttpRequestUpload.prototype,
    "addEventListener",
  ).mockImplementation(function (
    this: XMLHttpRequestUpload,
    type,
    listener,
    options,
  ) {
    if (type === "progress") {
      uploads.push(this);
    }
    addListener.call(this, type, listener, options);
  });
  return uploads;
}

function reportSentBytes(
  upload: XMLHttpRequestUpload,
  loaded: number,
  total: number,
): void {
  act(() => {
    upload.dispatchEvent(
      new ProgressEvent("progress", { loaded, total, lengthComputable: true }),
    );
  });
}

function installSimpleUploads(
  caseId: number,
  captured?: Map<string, string>,
): void {
  let requestIndex = 0;
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    requestIndex += 1;
    captured?.set(body.filename, body.contentType);
    return respond(200, {
      id: uploadId(caseId, requestIndex),
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url: `https://cdn.vm7.io/chat-continuity/${caseId}/${encodeURIComponent(body.filename)}`,
      uploadUrl: uploadUrl(caseId, body.filename),
      uploadHeaders: {},
    });
  });
}

function sentFilenames(
  parts: readonly {
    readonly type: string;
    readonly filenameSnapshot?: string;
  }[],
): string[] {
  return parts.flatMap((part) => {
    return part.type === "file" && part.filenameSnapshot
      ? [part.filenameSnapshot]
      : [];
  });
}

async function setupAttachmentInputMethods() {
  const thread = continuityThread(9, 1, "Attachment input methods");
  const workspace = installContinuityWorkspace(context, {
    caseId: 9,
    threads: [thread],
  });
  const contentTypes = new Map<string, string>();
  const transferCredentials: {
    cookie: string | null;
    authorization: string | null;
    clientType: string | null;
    previewBypass: string | null;
  }[] = [];
  installSimpleUploads(9, contentTypes);
  context.mocks.http.put("https://uploads.vm7.test/9/*", ({ request }) => {
    transferCredentials.push({
      cookie: request.headers.get("Cookie"),
      authorization: request.headers.get("Authorization"),
      clientType: request.headers.get(CLIENT_TYPE_HEADER),
      previewBypass: request.headers.get("X-Vercel-Protection-Bypass"),
    });
    return new HttpResponse(null, { status: 200 });
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });
  await messageComposer();
  return { contentTypes, transferCredentials };
}

test("Picked files attach with their content types and credential-free storage transfers", async () => {
  const { contentTypes, transferCredentials } =
    await setupAttachmentInputMethods();
  const ordinary = new File(["# Notes"], "release-notes.md");
  const uncommon = new File(["custom"], "sample.uncommon");
  await userEvent.upload(composerFileInput(), [ordinary, uncommon]);
  await waitFor(() => {
    expect(fastButton("Remove release-notes.md")).toBeVisible();
    expect(fastButton("Remove sample.uncommon")).toBeVisible();
  });
  expect(contentTypes.get("release-notes.md")).toBe("text/markdown");
  expect(contentTypes.get("sample.uncommon")).toBe("application/octet-stream");
  expect(transferCredentials).toStrictEqual([
    {
      cookie: null,
      authorization: null,
      clientType: null,
      previewBypass: null,
    },
    {
      cookie: null,
      authorization: null,
      clientType: null,
      previewBypass: null,
    },
  ]);
});

test("An upload with an absolute private Artifact URL completes once and attaches", async () => {
  const thread = continuityThread(14, 1, "Absolute private upload");
  const workspace = installContinuityWorkspace(context, {
    caseId: 14,
    threads: [thread],
  });
  const id = uploadId(14, 1);
  const artifactUrl = "http://localhost/artifacts/abc123def4.txt";
  const completedIds: string[] = [];
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    return respond(200, {
      id,
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url: artifactUrl,
      uploadUrl: uploadUrl(14, body.filename),
      uploadHeaders: {},
    });
  });
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    completedIds.push(body.id);
    return respond(200, {
      id,
      filename: "private.txt",
      contentType: "text/plain",
      size: 7,
      url: artifactUrl,
    });
  });
  context.mocks.http.put(uploadUrl(14, "private.txt"), () => {
    return new HttpResponse(null, { status: 200 });
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  await messageComposer();
  await userEvent.upload(
    composerFileInput(),
    new File(["private"], "private.txt", { type: "text/plain" }),
  );
  await waitFor(() => {
    expect(fastButton("Remove private.txt")).toBeVisible();
  });
  expect(completedIds).toStrictEqual([id]);
});

test("A failed upload leaves the successful attachment to be sent alone", async () => {
  const thread = continuityThread(11, 1, "Partial upload result");
  const workspace = installContinuityWorkspace(context, {
    caseId: 11,
    threads: [thread],
  });
  installSimpleUploads(11);
  context.mocks.http.put(uploadUrl(11, "ready.txt"), () => {
    return new HttpResponse(null, { status: 200 });
  });
  context.mocks.http.put(uploadUrl(11, "failed.txt"), () => {
    return new HttpResponse(null, { status: 503 });
  });
  let deliveredAttachments: string[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (body.userMessage === undefined) {
      throw new Error("Expected a user message send");
    }
    deliveredAttachments = sentFilenames(body.userMessage.parts);
    return respond(201, {
      threadId: body.threadId ?? thread.id,
      createdAt: "2026-08-11T04:00:00.000Z",
    });
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const composer = await messageComposer();
  await userEvent.type(composer, "Send the file that succeeded");
  await userEvent.upload(composerFileInput(), [
    new File(["good"], "ready.txt", { type: "text/plain" }),
    new File(["bad"], "failed.txt", { type: "text/plain" }),
  ]);

  await expect(
    screen.findByText("Failed to upload failed.txt."),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(fastButton("Remove ready.txt", composerCard())).toBeVisible();
    expect(fastButton("Send")).toBeEnabled();
  });
  expect(composerCard()).not.toHaveTextContent("failed.txt");
  expect(screen.getAllByText("Failed to upload failed.txt.")).toHaveLength(1);
  await userEvent.click(fastButton("Send"));
  await waitFor(() => {
    expect(deliveredAttachments).toStrictEqual(["ready.txt"]);
  });
});

const PART_BYTES = 5 * 1024 * 1024;

async function setupMultipartUpload(
  caseId: number,
  complete: () => Promise<void> = async () => {},
) {
  const thread = continuityThread(caseId, 1, "Large attachment upload");
  const workspace = installContinuityWorkspace(context, {
    caseId,
    threads: [thread],
  });
  const id = uploadId(caseId, 1);
  const url = `https://cdn.vm7.io/uploads/${caseId}/recording.mp4`;
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    expect(body.multipart).toBeTruthy();
    return respond(200, {
      id,
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url,
      multipart: {
        uploadId: `multipart-${caseId}`,
        partSize: PART_BYTES,
        parts: Array.from(
          { length: Math.ceil(body.size / PART_BYTES) },
          (_, index) => {
            return {
              partNumber: index + 1,
              uploadUrl: `https://uploads.vm7.test/${caseId}/part-${index + 1}`,
            };
          },
        ),
      },
    });
  });
  context.mocks.api(uploadsContract.completeMultipart, async ({ respond }) => {
    await complete();
    return respond(200, { id, url });
  });
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });
  await messageComposer();
}

test("A multipart recording runs four parts at a time and shows byte progress until finalized", async () => {
  const completed = createDeferredPromise<void>(context.signal);
  await setupMultipartUpload(31, () => {
    return completed.promise;
  });
  const parts = new Map<
    number,
    ReturnType<typeof createDeferredPromise<void>>
  >();
  const lengths = new Map<number, number>();
  context.mocks.http.put(
    "https://uploads.vm7.test/31/part-:part",
    async ({ request, params, signal }) => {
      const part = Number(params.part);
      lengths.set(part, (await request.arrayBuffer()).byteLength);
      const transferred = createDeferredPromise<void>(signal);
      parts.set(part, transferred);
      await transferred.promise;
      return new HttpResponse(null, { status: 200 });
    },
  );
  const requests = captureStorageTransfers();
  await userEvent.upload(
    composerFileInput(),
    new File([new Uint8Array(4 * PART_BYTES + 1)], "recording.mp4", {
      type: "video/mp4",
    }),
  );
  const progress = await screen.findByRole("progressbar", {
    name: "Loading recording.mp4",
  });
  await waitFor(() => {
    expect(parts.size).toBe(4);
  });
  reportSentBytes(requests[0]!, PART_BYTES / 2, PART_BYTES);
  await waitFor(() => {
    expect(progress).toHaveAttribute("aria-valuenow", "12");
  });
  expect(parts.size).toBe(4);
  parts.get(2)?.resolve();
  await waitFor(() => {
    expect(progress).toHaveAttribute("aria-valuenow", "37");
    expect(parts.size).toBe(5);
  });
  for (const [number, part] of parts) {
    if (number !== 2) {
      part.resolve();
    }
  }
  await waitFor(() => {
    expect(progress).toHaveAttribute("aria-valuenow", "99");
  });
  expect(lengths.get(5)).toBe(1);
  completed.resolve();
  await waitFor(() => {
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(fastButton("Remove recording.mp4")).toBeVisible();
  });
});

test("A multipart finalization failure is reported once without retrying completion", async () => {
  await setupMultipartUpload(35);
  let completions = 0;
  context.mocks.api(uploadsContract.completeMultipart, ({ respond }) => {
    completions += 1;
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Multipart upload not found" },
    });
  });
  context.mocks.http.put("https://uploads.vm7.test/35/*", () => {
    return new HttpResponse(null, { status: 200 });
  });
  await userEvent.upload(
    composerFileInput(),
    new File([new Uint8Array(PART_BYTES)], "recording.mp4", {
      type: "video/mp4",
    }),
  );
  await expect(
    screen.findByText("Multipart upload not found"),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Multipart upload not found")).toHaveLength(1);
  expect(completions).toBe(1);
  expect(
    screen.queryByText("Failed to upload recording.mp4."),
  ).not.toBeInTheDocument();
});

test("A 5 GiB recording at the picker limit starts uploading", async () => {
  await setupMultipartUpload(36);
  const sizes: number[] = [];
  context.mocks.api(uploadsContract.prepare, ({ body, signal }) => {
    sizes.push(body.size);
    return createDeferredPromise<never>(signal).promise;
  });
  const file = new File(["sparse fixture"], "long-recording.mp4", {
    type: "video/mp4",
  });
  Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 * 1024 });
  await userEvent.upload(composerFileInput(), file);
  await expect(
    screen.findByRole("progressbar", { name: "Loading long-recording.mp4" }),
  ).resolves.toBeInTheDocument();
  expect(sizes).toStrictEqual([5 * 1024 * 1024 * 1024]);
  await userEvent.click(fastButton("Cancel upload long-recording.mp4"));
});

test("Cancelling a multipart recording stops without a failure or starting queued parts", async () => {
  await setupMultipartUpload(34);
  let started = 0;
  context.mocks.http.put("https://uploads.vm7.test/34/*", ({ signal }) => {
    started += 1;
    return createDeferredPromise<never>(signal).promise;
  });
  await userEvent.upload(
    composerFileInput(),
    new File([new Uint8Array(4 * PART_BYTES + 1)], "recording.mp4", {
      type: "video/mp4",
    }),
  );
  await waitFor(() => {
    expect(started).toBe(4);
  });
  await userEvent.click(fastButton("Cancel upload recording.mp4"));
  await waitFor(() => {
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  expect(started).toBe(4);
  expect(
    screen.queryByText("Failed to upload recording.mp4."),
  ).not.toBeInTheDocument();
});
