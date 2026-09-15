import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { CLIENT_TYPE_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuitySidebarLink,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";

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

function composerDropTarget(): HTMLElement {
  const target = document.querySelector<HTMLElement>(
    "[data-slot='chat-composer-card']",
  );
  if (!target) {
    throw new Error("Expected the composer drop target");
  }
  return target;
}

function uploadId(caseId: number, slot: number): string {
  return `f8000000-0000-4000-a000-${(caseId * 100 + slot)
    .toString()
    .padStart(12, "0")}`;
}

function uploadUrl(caseId: number, filename: string): string {
  return `https://uploads.vm7.test/${caseId}/${encodeURIComponent(filename)}`;
}

function installSimpleUploads(
  caseId: number,
  captured: Map<string, string>,
): void {
  let requestIndex = 0;
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    requestIndex += 1;
    captured.set(body.filename, body.contentType);
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

test("Attach supported files by picker or drag and drop", async () => {
  const thread = continuityThread(9, 1, "Attachment input methods");
  const workspace = installContinuityWorkspace(context, {
    caseId: 9,
    threads: [thread],
  });
  const contentTypes = new Map<string, string>();
  const transferCredentials: {
    credentials: RequestCredentials;
    authorization: string | null;
    clientType: string | null;
    previewBypass: string | null;
  }[] = [];
  installSimpleUploads(9, contentTypes);
  context.mocks.http.put("https://uploads.vm7.test/9/*", ({ request }) => {
    transferCredentials.push({
      credentials: request.credentials,
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
      credentials: "omit",
      authorization: null,
      clientType: null,
      previewBypass: null,
    },
    {
      credentials: "omit",
      authorization: null,
      clientType: null,
      previewBypass: null,
    },
  ]);

  const dropped = new File(["drop"], "dropped.txt", { type: "text/plain" });
  const oversized = new File(["too large"], "archive.iso", {
    type: "application/octet-stream",
  });
  Object.defineProperty(oversized, "size", {
    configurable: true,
    value: 1024 * 1024 * 1024 + 1,
  });
  fireEvent.drop(composerDropTarget(), {
    dataTransfer: { files: [dropped, oversized] },
  });

  await expect(
    screen.findByText("archive.iso exceeds the 1 GB limit"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(fastButton("Remove dropped.txt")).toBeVisible();
  });
  expect(contentTypes.get("dropped.txt")).toBe("text/plain");
  expect(contentTypes.has("archive.iso")).toBeFalsy();
});

test("Keep a pending upload with the conversation that started it", async () => {
  const owner = continuityThread(10, 1, "Upload owner");
  const neighbor = continuityThread(10, 2, "Upload neighbor");
  const workspace = installContinuityWorkspace(context, {
    caseId: 10,
    threads: [owner, neighbor],
  });
  const transfer = context.mocks.deferred<void>();
  installSimpleUploads(10, new Map());
  context.mocks.http.put(uploadUrl(10, "owned-upload.txt"), async () => {
    await transfer.promise;
    return new HttpResponse(null, { status: 200 });
  });

  await setupPage({
    context,
    path: `/chats/${owner.id}`,
    ...workspace.pageOptions,
  });

  await messageComposer();
  const file = new File(["pending"], "owned-upload.txt", {
    type: "text/plain",
  });
  await userEvent.upload(composerFileInput(), file);
  await waitFor(() => {
    expect(fastButton("Cancel upload owned-upload.txt")).toBeVisible();
  });

  await waitFor(() => {
    expect(continuitySidebarLink(neighbor.id)).toBeVisible();
  });
  const neighborLink = continuitySidebarLink(neighbor.id);
  click(neighborLink);
  await waitFor(() => {
    expect(continuitySidebarLink(neighbor.id)).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      document.querySelector(
        `[data-chat-thread-container-id="${neighbor.id}"]`,
      ),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("owned-upload.txt");
  });
  transfer.resolve();
  await waitFor(() => {
    expect(continuitySidebarLink(owner.id)).toBeVisible();
  });
  const ownerLink = continuitySidebarLink(owner.id);
  click(ownerLink);
  await waitFor(() => {
    expect(continuitySidebarLink(owner.id)).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      document.querySelector(`[data-chat-thread-container-id="${owner.id}"]`),
    ).toBeVisible();
    expect(fastButton("Remove owned-upload.txt")).toBeVisible();
  });
  expect(document.body).toHaveTextContent("owned-upload.txt");
});

test("Keep successful attachments after another upload fails", async () => {
  const thread = continuityThread(11, 1, "Partial upload result");
  const workspace = installContinuityWorkspace(context, {
    caseId: 11,
    threads: [thread],
  });
  installSimpleUploads(11, new Map());
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
      runId: "a8000000-0000-4000-a000-000000000011",
      threadId: body.threadId ?? thread.id,
      status: "pending",
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
    screen.findByText("Failed to upload failed.txt"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(fastButton("Remove ready.txt")).toBeVisible();
    expect(fastButton("Send")).toBeEnabled();
  });
  expect(document.body).not.toHaveTextContent("Cancel upload failed.txt");
  await userEvent.click(fastButton("Send"));
  await waitFor(() => {
    expect(deliveredAttachments).toStrictEqual(["ready.txt"]);
  });
});

test("Wait for an attachment upload before sending the draft", async () => {
  const thread = continuityThread(13, 1, "Wait for upload before send");
  const workspace = installContinuityWorkspace(context, {
    caseId: 13,
    threads: [thread],
  });
  const transfer = context.mocks.deferred<void>();
  installSimpleUploads(13, new Map());
  context.mocks.http.put(uploadUrl(13, "delayed.txt"), async () => {
    await transfer.promise;
    return new HttpResponse(null, { status: 200 });
  });
  let sendCalls = 0;
  let deliveredAttachments: string[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (body.userMessage === undefined) {
      throw new Error("Expected a user message send");
    }
    sendCalls += 1;
    deliveredAttachments = sentFilenames(body.userMessage.parts);
    return respond(201, {
      runId: "a8000000-0000-4000-a000-000000000013",
      threadId: body.threadId ?? thread.id,
      status: "pending",
      createdAt: "2026-08-13T04:00:00.000Z",
    });
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const composer = await messageComposer();
  await userEvent.type(composer, "Send after the upload is ready");
  await userEvent.upload(
    composerFileInput(),
    new File(["pending"], "delayed.txt", { type: "text/plain" }),
  );
  await waitFor(() => {
    expect(fastButton("Cancel upload delayed.txt")).toBeVisible();
    expect(fastButton("Send")).toBeDisabled();
  });
  await userEvent.click(composer);
  await userEvent.keyboard("{Enter}");
  expect(sendCalls).toBe(0);
  expect(composer).toHaveTextContent("Send after the upload is ready");
  expect(transfer.settled()).toBeFalsy();

  transfer.resolve();
  await waitFor(() => {
    expect(fastButton("Remove delayed.txt")).toBeVisible();
    expect(fastButton("Send")).toBeEnabled();
  });
  await userEvent.click(fastButton("Send"));
  await waitFor(() => {
    expect(sendCalls).toBe(1);
    expect(deliveredAttachments).toStrictEqual(["delayed.txt"]);
  });
});
