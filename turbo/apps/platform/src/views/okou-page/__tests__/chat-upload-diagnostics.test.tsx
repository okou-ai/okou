import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { initSentry } from "../../../lib/sentry.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();
const BYTES = 5 * 1024 * 1024;
const FILENAME = "private-recording.mp4";
const TARGET = "https://uploads.vm7.test/private-recording.mp4";
const SIGNED_TARGET =
  `${TARGET}?X-Amz-Signature=private-signature` +
  "&X-Amz-Credential=private-credential&uploadId=private-upload-id&partNumber=1";

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected the composer file input");
  }
  return input;
}

function installUpload(caseId: number) {
  const thread = continuityThread(caseId, 1, "Upload diagnostics");
  const workspace = installContinuityWorkspace(context, {
    caseId,
    threads: [thread],
  });
  const id = `f8000000-0000-4000-a000-${String(caseId).padStart(12, "0")}`;
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    return respond(200, {
      id,
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url: `https://cdn.vm7.io/uploads/${caseId}/recording.mp4`,
      multipart: {
        uploadId: "private-upload-id",
        partSize: BYTES,
        parts: [{ partNumber: 1, uploadUrl: SIGNED_TARGET }],
      },
    });
  });
  context.mocks.api(uploadsContract.completeMultipart, ({ respond }) => {
    return respond(200, {
      id,
      url: `https://cdn.vm7.io/uploads/${caseId}/recording.mp4`,
    });
  });
  return { id, thread, workspace };
}

async function openComposer(fixture: ReturnType<typeof installUpload>) {
  await setupPage({
    context,
    path: `/chats/${fixture.thread.id}`,
    ...fixture.workspace.pageOptions,
  });
  await screen.findByRole("textbox", { name: "Message" });
}

test("reports one exhausted upload with safe terminal diagnostics", async () => {
  const fixture = installUpload(40);
  const sentry = context.mocks.sentry();
  initSentry();
  // happy-dom does not implement the native XHR timeout property's default.
  const open = XMLHttpRequest.prototype.open;
  vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(function (
    this: XMLHttpRequest,
    ...args
  ) {
    this.timeout = 0;
    open.apply(this, args);
  });
  context.mocks.http.put(TARGET, () => {
    return HttpResponse.error();
  });
  await openComposer(fixture);
  await userEvent.upload(
    fileInput(),
    new File([new Uint8Array(BYTES)], FILENAME, { type: "video/mp4" }),
  );
  await expect(
    screen.findByText(`Failed to upload ${FILENAME}.`),
  ).resolves.toBeInTheDocument();

  const reports = sentry.reports.filter((report) => {
    return (
      report.type === "exception" &&
      report.error instanceof TypeError &&
      report.error.message === "Storage upload failed"
    );
  });
  const report = reports[0];
  const options = sentry.initializations.at(-1)?.options;
  if (
    report?.type !== "exception" ||
    !options?.beforeSend ||
    !options.beforeBreadcrumb
  ) {
    throw new Error("Expected the existing upload exception and privacy hooks");
  }
  expect(reports).toHaveLength(1);
  const event = await options.beforeSend(
    { type: undefined, request: { url: SIGNED_TARGET } },
    { originalException: report.error },
  );
  expect(event?.contexts?.storage_upload).toMatchObject({
    file_id: fixture.id,
    file_size: BYTES,
    part_number: 1,
    part_count: 1,
    attempt: 5,
    request_event: "error",
    target_origin: "https://uploads.vm7.test",
    response_status: 0,
    total_bytes: BYTES,
    elapsed_ms: expect.any(Number),
    reported_bytes: expect.any(Number),
    timeout_ms: 0,
    online: true,
    with_credentials: false,
  });
  const breadcrumb = options.beforeBreadcrumb(
    { category: "xhr", data: { method: "PUT", url: SIGNED_TARGET } },
    {},
  );
  expect(breadcrumb?.data?.url).toBe(
    "https://uploads.vm7.test/[presigned-object]",
  );
  expect(JSON.stringify({ event, breadcrumb })).not.toContain("private-");
});

test("does not report an upload error when a transient network failure recovers", async () => {
  const fixture = installUpload(41);
  const sentry = context.mocks.sentry();
  initSentry();
  let attempts = 0;
  context.mocks.http.put(TARGET, () => {
    attempts += 1;
    return attempts === 1
      ? HttpResponse.error()
      : new HttpResponse(null, { status: 200 });
  });
  await openComposer(fixture);
  await userEvent.upload(
    fileInput(),
    new File([new Uint8Array(BYTES)], FILENAME, { type: "video/mp4" }),
  );
  await waitFor(() => {
    expect(fastButton(`Remove ${FILENAME}`)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  expect(sentry.reports).toStrictEqual([]);
});

test("does not report an upload error when the user cancels", async () => {
  const fixture = installUpload(43);
  const sentry = context.mocks.sentry();
  initSentry();
  const started = createDeferredPromise<void>(context.signal);
  context.mocks.http.put(TARGET, () => {
    started.resolve();
    return createDeferredPromise<never>(context.signal).promise;
  });
  await openComposer(fixture);
  await userEvent.upload(
    fileInput(),
    new File([new Uint8Array(BYTES)], FILENAME, { type: "video/mp4" }),
  );
  await screen.findByRole("progressbar", { name: `Loading ${FILENAME}` });
  await started.promise;
  click(fastButton(`Cancel upload ${FILENAME}`));
  await waitFor(() => {
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  expect(
    screen.queryByText(`Failed to upload ${FILENAME}.`),
  ).not.toBeInTheDocument();
  expect(sentry.reports).toStrictEqual([]);
});
