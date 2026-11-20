import { expect, test, vi } from "vitest";

import { runDocumentExportWorker } from "../message-pdf/worker-client.ts";
import type {
  DocumentExportRequest,
  PdfAssets,
  PdfWorkerRequest,
} from "../message-pdf/types.ts";
import {
  createTestRuntime,
  testContext,
} from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

function createRequest(format: "pdf" | "docx"): DocumentExportRequest {
  const assets: PdfAssets = { images: new Map(), diagrams: new Map() };
  if (format === "docx") {
    return {
      kind: "docx",
      input: {
        source: "unique-private-document-content",
        assets,
        baseUrl: "https://example.test/private-resource",
      },
    };
  }
  const request: PdfWorkerRequest = {
    baseUrl: "https://example.test/private-resource",
    tree: { type: "root", children: [] },
    assets,
    regularFont: new ArrayBuffer(0),
    boldFont: new ArrayBuffer(0),
  };
  return request;
}

interface TestWorker extends EventTarget {
  readonly posted: unknown[];
  terminateCount: number;
  ready(): void;
}

function installWorker(
  options: {
    readonly constructorThrows?: boolean;
    readonly postMessageThrows?: boolean;
  } = {},
) {
  const workers: TestWorker[] = [];
  class WorkerStub extends EventTarget implements TestWorker {
    readonly posted: unknown[] = [];
    terminateCount = 0;

    constructor() {
      super();
      if (options.constructorThrows) {
        throw new Error("private bootstrap detail");
      }
      workers.push(this);
    }

    postMessage(message: unknown): void {
      if (options.postMessageThrows) {
        throw new Error("private structured clone detail");
      }
      this.posted.push(message);
    }

    terminate(): void {
      this.terminateCount += 1;
    }

    ready(): void {
      this.dispatchEvent(
        new MessageEvent("message", { data: { ready: true } }),
      );
    }
  }
  vi.stubGlobal("Worker", WorkerStub);
  return {
    workers,
    latest(): TestWorker {
      const worker = workers.at(-1);
      if (!worker) {
        throw new Error("Expected a Worker instance");
      }
      return worker;
    },
  };
}

test("classifies synchronous Worker bootstrap failure without retaining its message", async () => {
  const workers = installWorker({ constructorThrows: true });

  await expect(
    runDocumentExportWorker(createRequest("pdf"), context.signal),
  ).rejects.toMatchObject({
    name: "DocumentExportWorkerError",
    format: "pdf",
    phase: "bootstrap",
    message:
      "Document export worker could not complete (format=pdf, phase=bootstrap)",
  });
  expect(workers.workers).toHaveLength(0);
});

test("classifies pre-ready and post-ready Worker errors separately", async () => {
  const workers = installWorker();
  const beforeReady = runDocumentExportWorker(
    createRequest("pdf"),
    context.signal,
  );
  workers.latest().dispatchEvent(new Event("error"));
  await expect(beforeReady).rejects.toMatchObject({ phase: "bootstrap" });
  expect(workers.latest().terminateCount).toBe(1);

  const afterReady = runDocumentExportWorker(
    createRequest("docx"),
    context.signal,
  );
  const worker = workers.latest();
  worker.ready();
  worker.dispatchEvent(new Event("error"));
  await expect(afterReady).rejects.toMatchObject({
    format: "docx",
    phase: "native_error",
  });
  expect(worker.terminateCount).toBe(1);
});

test("classifies a synchronous postMessage failure without retaining its message", async () => {
  const workers = installWorker({ postMessageThrows: true });
  const result = runDocumentExportWorker(createRequest("pdf"), context.signal);
  const worker = workers.latest();

  await expect(result).rejects.toMatchObject({
    phase: "message_decode",
    message:
      "Document export worker could not complete (format=pdf, phase=message_decode)",
  });
  expect(worker.terminateCount).toBe(1);
});

test("classifies message decoding and controlled rendering failures safely", async () => {
  const workers = installWorker();
  const malformed = runDocumentExportWorker(
    createRequest("pdf"),
    context.signal,
  );
  const malformedWorker = workers.latest();
  malformedWorker.ready();
  malformedWorker.dispatchEvent(
    new MessageEvent("message", { data: { ok: false } }),
  );
  await expect(malformed).rejects.toMatchObject({ phase: "message_decode" });
  expect(malformedWorker.terminateCount).toBe(1);

  const decodeFailure = runDocumentExportWorker(
    createRequest("pdf"),
    context.signal,
  );
  const decodeWorker = workers.latest();
  decodeWorker.ready();
  decodeWorker.dispatchEvent(new Event("messageerror"));
  await expect(decodeFailure).rejects.toMatchObject({
    phase: "message_decode",
  });
  expect(decodeWorker.terminateCount).toBe(1);

  const renderFailure = runDocumentExportWorker(
    createRequest("docx"),
    context.signal,
  );
  const renderWorker = workers.latest();
  renderWorker.ready();
  renderWorker.dispatchEvent(
    new MessageEvent("message", {
      data: { ok: false, failure: "render_rejection" },
    }),
  );
  const error = await renderFailure.then(
    () => {
      return undefined;
    },
    (error: unknown) => {
      return error;
    },
  );
  expect(error).toMatchObject({
    format: "docx",
    phase: "render_rejection",
  });
  expect(String(error)).not.toContain("unique-private-document-content");
  expect(String(error)).not.toContain("private-resource");
  expect(renderWorker.terminateCount).toBe(1);
});

test.each(["pdf", "docx"] as const)(
  "preserves the successful %s export response and request",
  async (format) => {
    const workers = installWorker();
    const request = createRequest(format);
    const result = runDocumentExportWorker(request, context.signal);
    const worker = workers.latest();
    const blob = new Blob(["exported bytes"]);

    worker.ready();
    worker.dispatchEvent(
      new MessageEvent("message", { data: { ok: true, blob } }),
    );

    await expect(result).resolves.toBe(blob);
    expect(worker.posted).toStrictEqual([request]);
    expect(worker.terminateCount).toBe(1);
  },
);

test("keeps cancellation owned by the caller and terminates only once", async () => {
  const workers = installWorker();
  const runtime = createTestRuntime(context);
  const result = runDocumentExportWorker(createRequest("pdf"), runtime.signal);
  const worker = workers.latest();

  runtime.dispose(new DOMException("Export cancelled", "AbortError"));
  worker.dispatchEvent(new Event("error"));

  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.terminateCount).toBe(1);
});
