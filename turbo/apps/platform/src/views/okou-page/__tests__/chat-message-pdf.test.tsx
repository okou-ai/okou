import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { PdfWorkerResponse } from "../../../lib/message-pdf/types.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000951";
const ANSWER = "The launch plan has three phases.";

function button(name: string): HTMLElement {
  const result = queryAllByRoleFast("button").find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
  if (!result) {
    throw new Error(`Button not found: ${name}`);
  }
  return result;
}

function downloadLink(): HTMLAnchorElement {
  const result = queryAllByRoleFast("link").find((element) => {
    return element.getAttribute("aria-label") === "Download PDF";
  });
  if (!(result instanceof HTMLAnchorElement)) {
    throw new Error("PDF download link not found");
  }
  return result;
}

async function setupPdfChat(
  content = ANSWER,
  loadFont: (request: Request) => Response | Promise<Response> = () => {
    return HttpResponse.arrayBuffer(new ArrayBuffer(8));
  },
) {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "pdf-user-prompt",
        role: "user",
        content: "Summarize the launch plan",
        runId: "pdf-run",
        createdAt: "2026-08-01T10:00:00Z",
      },
      {
        id: "pdf-assistant-response",
        role: "assistant",
        content,
        runId: "pdf-run",
        createdAt: "2026-08-01T10:00:01Z",
      },
    ],
  });
  context.mocks.http.get(
    /NotoSansCJKsc-(Regular|Bold)\.otf/u,
    ({ request }) => {
      return loadFont(request);
    },
  );
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ChatMessagePdf]: true },
  });
  await screen.findByText(ANSWER);
  await waitFor(() => {
    expect(button("Generate PDF")).toBeInTheDocument();
  });
}

test("Generate first, then offer a native PDF download whose bytes survive repeated clicks", async () => {
  const response = context.mocks.deferred<PdfWorkerResponse>();
  context.mocks.browser.dedicatedWorker(() => {
    return response.promise;
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPdfChat();

  button("Generate PDF").focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(button("Generating PDF…")).toHaveAttribute("aria-disabled", "true");
  });
  expect(button("Generating PDF…")).toHaveFocus();
  const pdf = new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" });
  response.resolve({ ok: true, blob: pdf });
  await waitFor(() => {
    expect(downloadLink()).toHaveAttribute("download", "okou-message.pdf");
  });
  const link = downloadLink();
  expect(link).toHaveFocus();
  const url = link.href;
  expect(browser.blobForUrl(url)).toBe(pdf);
  // Generation alone must not automatically start a download.
  expect(browser.downloads).toHaveLength(0);
  expect(fireEvent.click(link)).toBeTruthy();
  expect(fireEvent.click(link)).toBeTruthy();
  expect(browser.blobForUrl(url)).toBe(pdf);

  const newChat = queryAllByRoleFast("button").find((element) => {
    return element.getAttribute("aria-label") === "New chat";
  });
  if (!newChat) {
    throw new Error("New chat button not found");
  }
  click(newChat);
  await waitFor(() => {
    expect(location.pathname).not.toBe(`/chats/${THREAD_ID}`);
  });
  expect(browser.blobForUrl(url)).toBeNull();
});

test("A generation error is visible and the PDF action can be retried", async () => {
  const first = context.mocks.deferred<PdfWorkerResponse>();
  const retry = context.mocks.deferred<PdfWorkerResponse>();
  let response = first;
  context.mocks.browser.dedicatedWorker(() => {
    return response.promise;
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPdfChat();

  click(button("Generate PDF"));
  await waitFor(() => {
    expect(button("Generating PDF…")).toHaveAttribute("aria-disabled", "true");
  });
  first.resolve({ ok: false, message: "The PDF renderer failed" });
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Could not generate PDF. Try again.",
  );
  response = retry;
  click(button("Generate PDF"));
  const pdf = new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" });
  retry.resolve({ ok: true, blob: pdf });
  await waitFor(() => {
    expect(browser.blobForUrl(downloadLink().href)).toBe(pdf);
  });
});

test("PDF generation resolves private image access again instead of reusing the preview grant", async () => {
  const imageId = "b0000000-0000-4000-a000-000000000952";
  const imageUrl = artifactReferencePath(imageId, "chart.png");
  let resourceUrl = "https://storage.example.test/preview.png";
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: resourceUrl,
      downloadUrl: resourceUrl,
      expiresAt: "2099-01-01T00:00:00Z",
      filename: "chart.png",
      contentType: "image/png",
      target: { kind: "file", id: imageId },
    });
  });
  context.mocks.browser.imageDimensions({ width: 640, height: 480 });
  context.mocks.browser.canvasRendering();
  const pdf = new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" });
  context.mocks.browser.dedicatedWorker(() => {
    return Promise.resolve({ ok: true, blob: pdf } satisfies PdfWorkerResponse);
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPdfChat(`${ANSWER}\n\n![Private chart](${imageUrl})`);
  await screen.findByAltText("Private chart");

  resourceUrl = "https://storage.example.test/export.png";
  context.mocks.http.get(resourceUrl, () => {
    return HttpResponse.arrayBuffer(new ArrayBuffer(8), {
      headers: { "Content-Type": "image/png" },
    });
  });
  click(button("Generate PDF"));
  await waitFor(() => {
    expect(browser.blobForUrl(downloadLink().href)).toBe(pdf);
  });
});

test("Removing the message actions cancels PDF generation without leaving the page", async () => {
  const fontStarted = context.mocks.deferred<Request>();
  const fontGate = context.mocks.deferred<void>();
  const pdf = new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" });
  context.mocks.browser.dedicatedWorker(() => {
    return Promise.resolve({ ok: true, blob: pdf } satisfies PdfWorkerResponse);
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPdfChat(ANSWER, async (request) => {
    if (!fontStarted.settled()) {
      fontStarted.resolve(request);
    }
    await fontGate.promise;
    return HttpResponse.arrayBuffer(new ArrayBuffer(8));
  });

  click(button("Generate PDF"));
  const request = await fontStarted.promise;
  click(button("Share messages"));
  await screen.findAllByText("0 selected");
  expect(request.signal.aborted).toBeTruthy();
  expect(location.pathname).toBe(`/chats/${THREAD_ID}`);
  fontGate.resolve();

  click(button("Cancel"));
  await waitFor(() => {
    expect(button("Generate PDF")).toBeInTheDocument();
  });
  click(button("Generate PDF"));
  await waitFor(() => {
    expect(browser.blobForUrl(downloadLink().href)).toBe(pdf);
  });
});
