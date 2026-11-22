import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

async function uploader() {
  await setupPage({ context, path: RUN_PATH });
  await findComposerEditor();
  const picker = document.querySelector<HTMLInputElement>(
    "input[type=file][multiple]",
  );
  if (!picker) {
    throw new Error("File picker unavailable");
  }
  return picker;
}
const origin = "https://storage.example.test";
const metadata = (
  file: { filename: string; contentType: string; size: number },
  id: string,
) => {
  return {
    id,
    ...file,
    url: "http://localhost/api/web/file-url?file_id=" + id,
  };
};
test("chat-continuity-uploads-001 each file uses its own MIME type and storage receives no credentials", async () => {
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  const types = new Map<string, string>(),
    requests = new Map<string, Request>();
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    types.set(body.filename, body.contentType);
    return respond(200, {
      ...metadata(body, body.filename),
      uploadUrl: origin + "/" + body.filename,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(origin + "/:name", ({ request }) => {
    requests.set(new URL(request.url).pathname.slice(1), request);
    return new HttpResponse(null, { status: 200 });
  });
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    return respond(
      200,
      metadata(
        { filename: body.id, contentType: types.get(body.id)!, size: 4 },
        body.id,
      ),
    );
  });
  const picker = await uploader();
  await userEvent.upload(picker, [
    new File(["note"], "plan.md"),
    new File(["data"], "plot.xx76"),
  ]);
  for (const [name, mime] of [
    ["plan.md", "text/markdown"],
    ["plot.xx76", "application/octet-stream"],
  ]) {
    await findFastControl("button", "Remove " + name);
    expect(types.get(name)).toBe(mime);
    const request = requests.get(name)!;
    expect(request.credentials).not.toBe("include");
    for (const header of [
      "cookie",
      "authorization",
      "x-client-type",
      "x-vercel-protection-bypass",
    ]) {
      expect(request.headers.has(header)).toBeFalsy();
    }
  }
});
test("chat-continuity-uploads-004 after a storage failure only the ready file accompanies the sent message", async () => {
  const sent = context.mocks.deferred<unknown>();
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    onSendRequest: (b) => {
      return sent.resolve(b);
    },
  });
  const records = new Map<string, ReturnType<typeof metadata>>();
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    const file = metadata(body, crypto.randomUUID());
    records.set(file.id, file);
    return respond(200, {
      ...file,
      uploadUrl: origin + "/" + body.filename,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(origin + "/ready.txt", () => {
    return new HttpResponse(null, { status: 200 });
  });
  context.mocks.http.put(origin + "/failed.txt", () => {
    return new HttpResponse(null, { status: 503 });
  });
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    return respond(200, records.get(body.id)!);
  });
  const picker = await uploader();
  await fill(await findComposerEditor(), "Ship the ready file");
  await userEvent.upload(
    picker,
    ["ready", "failed"].map((n) => {
      return new File([n], n + ".txt", { type: "text/plain" });
    }),
  );
  await screen.findByText("Failed to upload failed.txt.");
  expect(screen.getAllByText("Failed to upload failed.txt.")).toHaveLength(1);
  await findFastControl("button", "Remove ready.txt");
  expect(queryFastControl("button", "Remove failed.txt")).toBeNull();
  click(await findFastControl("button", "Send"));
  const body = await sent.promise;
  expect(JSON.stringify(body)).toContain("ready.txt");
  expect(JSON.stringify(body)).not.toContain("failed.txt");
});
test("chat-continuity-uploads-013 a file exactly at the limit starts uploading and can be cancelled", async () => {
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  const prepared = context.mocks.deferred<number>();
  const held = context.mocks.deferred<void>();
  context.mocks.api(uploadsContract.prepare, async ({ body, respond }) => {
    prepared.resolve(body.size);
    await held.promise;
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Unused" },
    });
  });
  const recording = new File(["a"], "recording.webm", { type: "video/webm" });
  Object.defineProperty(recording, "size", { value: 5 * 1024 ** 3 });
  await userEvent.upload(await uploader(), recording);
  const cancel = await findFastControl(
    "button",
    "Cancel upload recording.webm",
  );
  await expect(screen.findByRole("progressbar")).resolves.toBeInTheDocument();
  await expect(prepared.promise).resolves.toBe(5 * 1024 ** 3);
  click(cancel);
  await waitFor(() => {
    return expect(cancel).not.toBeInTheDocument();
  });
  held.resolve();
});

async function multipartRecording() {
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  const block = 5 * 1024 * 1024,
    id = crypto.randomUUID(),
    filename = "review.webm",
    size = 4 * block + 1;
  const meta = metadata({ filename, contentType: "video/webm", size }, id);
  const transfers = Array.from({ length: 5 }, () => {
    return {
      started: context.mocks.deferred<number>(),
      release: context.mocks.deferred<void>(),
      cancelled: context.mocks.deferred<void>(),
    };
  });
  const finalizing = context.mocks.deferred<void>(),
    completed = context.mocks.deferred<void>();
  context.mocks.api(uploadsContract.prepare, ({ respond }) => {
    return respond(200, {
      ...meta,
      multipart: {
        uploadId: "review-session",
        partSize: block,
        parts: transfers.map((_, i) => {
          return {
            partNumber: i + 1,
            uploadUrl: origin + "/part/" + String(i + 1),
          };
        }),
      },
    });
  });
  context.mocks.api(uploadsContract.completeMultipart, async ({ respond }) => {
    finalizing.resolve();
    await completed.promise;
    return respond(200, { id, url: meta.url });
  });
  const partRequests = new Map<string, EventTarget>();
  class StoragePart extends EventTarget {
    readonly upload = new EventTarget();
    status = 0;
    private url = "";
    private cancelled = false;
    open(method: string, url: string) {
      if (method !== "PUT" || !url.startsWith(origin + "/part/")) {
        throw new Error("Unexpected storage destination " + url);
      }
      this.url = url;
      partRequests.set(url, this.upload);
    }
    readonly headers = new Headers();
    setRequestHeader(name: string, value: string) {
      this.headers.set(name, value);
    }
    async send(body: Blob) {
      const transfer =
        transfers[Number(new URL(this.url).pathname.split("/").at(-1)) - 1]!;
      transfer.started.resolve(body.size);
      await transfer.release.promise;
      if (!this.cancelled) {
        this.status = 200;
        this.dispatchEvent(new Event("load"));
      }
    }
    abort() {
      this.cancelled = true;
      transfers[
        Number(new URL(this.url).pathname.split("/").at(-1)) - 1
      ]!.cancelled.resolve();
      this.dispatchEvent(new Event("abort"));
    }
  }
  vi.stubGlobal("XMLHttpRequest", StoragePart);
  await userEvent.upload(
    await uploader(),
    new File([new Uint8Array(size)], filename, { type: "video/webm" }),
  );
  return { transfers, partRequests, finalizing, completed, block };
}
test("chat-continuity-uploads-006 progress tracks uploaded bytes and waits at 99 until finalization", async () => {
  const { transfers, partRequests, block, completed, finalizing } =
    await multipartRecording();
  await Promise.all(
    transfers.slice(0, 4).map((t) => {
      return t.started.promise;
    }),
  );
  expect(transfers[4]!.started.settled()).toBeFalsy();
  const bar = await screen.findByRole("progressbar");
  partRequests.get(origin + "/part/1")!.dispatchEvent(
    new ProgressEvent("progress", {
      loaded: block / 2,
      total: block,
      lengthComputable: true,
    }),
  );
  await waitFor(() => {
    return expect(bar).toHaveAttribute("aria-valuenow", "12");
  });
  transfers[1]!.release.resolve();
  await expect(transfers[4]!.started.promise).resolves.toBe(1);
  await waitFor(() => {
    return expect(bar).toHaveAttribute("aria-valuenow", "37");
  });
  for (const t of transfers) {
    if (!t.release.settled()) {
      t.release.resolve();
    }
  }
  await finalizing.promise;
  expect(bar).toHaveAttribute("aria-valuenow", "99");
  completed.resolve();
  await findFastControl("button", "Remove review.webm");
  expect(bar).not.toBeInTheDocument();
});
test("chat-continuity-uploads-014 cancelling four active parts leaves the fifth part queued", async () => {
  const { transfers } = await multipartRecording();
  await Promise.all(
    transfers.slice(0, 4).map((t) => {
      return t.started.promise;
    }),
  );
  expect(transfers[4]!.started.settled()).toBeFalsy();
  const progress = await screen.findByRole("progressbar");
  click(await findFastControl("button", "Cancel upload review.webm"));
  await waitFor(() => {
    return expect(progress).not.toBeInTheDocument();
  });
  await Promise.all(
    transfers.slice(0, 4).map((t) => {
      return t.cancelled.promise;
    }),
  );
  expect(transfers[4]!.started.settled()).toBeFalsy();
  expect(screen.queryByText(/failed to upload/i)).toBeNull();
  for (const t of transfers) {
    if (!t.release.settled()) {
      t.release.resolve();
    }
  }
});
