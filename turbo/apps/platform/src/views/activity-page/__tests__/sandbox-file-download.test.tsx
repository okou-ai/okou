import { readFile, stat } from "node:fs/promises";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  downloadBrowser,
  fileGuest,
  readyDownload,
} from "./sandbox-file-download-test-helpers.ts";
import {
  filesButton,
  filesTab,
  entry,
  listing,
  openFiles,
  setupFilesPage,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();
const complete =
  "Download sent to your browser. Check Downloads for the result.";

test.each([0, 70_003])(
  "A user downloads exact complete bytes (%i)",
  async (size) => {
    const browser = await downloadBrowser(context);
    await setupFilesPage(context, { handler: fileGuest(size) });
    const files = await openFiles();
    await screen.findByText("report.bin");
    const control = await readyDownload(files);
    click(control);
    await expect(
      within(files).findByText(complete),
    ).resolves.toBeInTheDocument();
    const result = await browser.outcome;
    expect(result.saved).toBeTruthy();
    const bytes = await readFile(result.file);
    expect(bytes).toHaveLength(size);
    expect(
      bytes.every((value, index) => {
        return value === index % 251;
      }),
    ).toBeTruthy();
    expect(result.headers.get("Content-Length")).toBe(String(size));
    expect(result.headers.get("Content-Disposition")).toContain(
      "filename*=UTF-8''report.bin",
    );
    expect(result.headers.get("Cache-Control")).toBe("no-store, no-transform");
  },
);

test("A changed file fails without committing the withheld final chunk", async () => {
  const browser = await downloadBrowser(context);
  await setupFilesPage(context, {
    handler: fileGuest(70_003, { failFinish: true }),
  });
  const files = await openFiles();
  await screen.findByText("report.bin");
  const control = await readyDownload(files);
  click(control);
  await expect(
    screen.findByText("This file changed during download. Download it again."),
  ).resolves.toBeInTheDocument();
  const result = await browser.outcome;
  expect(result.saved).toBeFalsy();
  await expect(stat(result.file)).rejects.toMatchObject({ code: "ENOENT" });
});

test("A raw filename with an expanded display label remains downloadable", async () => {
  const browser = await downloadBrowser(context);
  const name = String.raw`\xff`.repeat(255);
  const nameToken = Buffer.alloc(255, 255).toString("base64url");
  const guest = fileGuest(3);
  await setupFilesPage(context, {
    handler(request) {
      if (request.operation === "list") {
        return listing([{ ...entry("file"), nameToken, displayName: name }]);
      }
      if (request.operation === "open") {
        return {
          result: {
            handle: "file",
            nameToken,
            displayName: name,
            fileSize: "3",
            selectedSize: "3",
            truncated: false,
          },
        };
      }
      return guest(request);
    },
  });
  const files = await openFiles();
  click(await readyDownload(files, name));
  const result = await browser.outcome;
  expect(result.saved).toBeTruthy();
  await expect(readFile(result.file)).resolves.toStrictEqual(
    Buffer.from([0, 1, 2]),
  );
  expect(result.headers.get("Content-Disposition")).toContain(
    "filename*=UTF-8''" + "_xff".repeat(255),
  );
});

test.each(["wrong-offset", "short-read", "closed-source"] as const)(
  "A %s after a prefix fails without committing a complete file",
  async (failure) => {
    const browser = await downloadBrowser(context);
    const guest = fileGuest(70_003);
    const fixture = await setupFilesPage(context, {
      handler(request) {
        if (request.operation === "read" && request.params.offset !== "0") {
          const length = request.params.length;
          if (typeof length !== "number") {
            throw new Error("Invalid length");
          }
          if (failure === "closed-source") {
            fixture.sockets.at(-1)?.close();
          } else {
            const size = failure === "short-read" ? length - 1 : length;
            return {
              result: {
                offset:
                  failure === "wrong-offset" ? "1" : request.params.offset,
                length: size,
                data: Buffer.alloc(size).toString("base64"),
              },
            };
          }
        }
        return guest(request);
      },
    });
    const files = await openFiles();
    click(await readyDownload(files));
    await expect(
      screen.findByText("Download failed. Try again."),
    ).resolves.toBeInTheDocument();
    const result = await browser.outcome;
    expect(result.saved).toBeFalsy();
    await expect(stat(result.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(browser.partialFile)).size).toBe(32_768);
  },
);

test("A partial preview slice cannot be handed off as a complete download", async () => {
  await downloadBrowser(context);
  const guest = fileGuest(70_003);
  await setupFilesPage(context, {
    handler(request) {
      if (request.operation === "open") {
        return {
          result: {
            handle: "file",
            nameToken: entry("report.bin").nameToken,
            displayName: "report.bin",
            fileSize: "70003",
            selectedSize: "1",
            truncated: true,
          },
        };
      }
      return guest(request);
    },
  });
  const files = await openFiles();
  click(await readyDownload(files));
  await expect(
    screen.findByText("Download failed. Try again."),
  ).resolves.toBeInTheDocument();
  expect(
    document.querySelector('iframe[src*="/sandbox-file-downloads/v1/"]'),
  ).toBeNull();
});

test("A user cancels a download while the browser destination is blocked", async () => {
  const browser = await downloadBrowser(context, { holdWrite: true });
  await setupFilesPage(context, { handler: fileGuest(1024 * 1024) });
  const files = await openFiles();
  await screen.findByText("report.bin");
  const control = await readyDownload(files);
  click(control);
  await browser.firstChunk;
  click(filesButton("Cancel download", files));
  await expect(
    screen.findByText("Download cancelled"),
  ).resolves.toBeInTheDocument();
  browser.releaseWrite();
  expect((await browser.outcome).saved).toBeFalsy();
});

test("A blocked disk keeps WSS demand bounded and attachment URLs are one-use", async () => {
  const browser = await downloadBrowser(context, { holdWrite: true });
  const guest = fileGuest(128 * 1024 * 1024);
  let servedBytes = 0;
  await setupFilesPage(context, {
    handler(request) {
      if (request.operation === "read") {
        const length = request.params.length;
        if (typeof length !== "number") {
          throw new Error("Invalid read length");
        }
        servedBytes += length;
      }
      return guest(request);
    },
  });
  const files = await openFiles();
  click(await readyDownload(files));
  await browser.firstChunk;
  const frame = document.querySelector<HTMLIFrameElement>(
    'iframe[src*="/sandbox-file-downloads/v1/"]',
  );
  if (!frame) {
    throw new Error("Download frame missing");
  }
  const duplicate = await browser.request(new Request(frame.src));
  expect(duplicate.status).toBe(404);
  const method = await browser.request(
    new Request(frame.src, { method: "POST" }),
  );
  expect(method.status).toBe(405);
  expect(method.headers.get("Allow")).toBe("GET");
  expect(
    (
      await browser.request(
        new Request(frame.src, { headers: { Range: "bytes=0-1" } }),
      )
    ).status,
  ).toBe(416);
  expect(
    (await browser.request(new Request(frame.src + "?token=untrusted"))).status,
  ).toBe(416);
  expect((await stat(browser.partialFile)).size).toBe(32_768);
  expect(servedBytes).toBe(32_768);
  click(filesButton("Cancel download", files));
  browser.releaseWrite();
  expect((await browser.outcome).saved).toBeFalsy();
});

test("Leaving Files cancels a blocked transfer", async () => {
  const browser = await downloadBrowser(context, { holdWrite: true });
  await setupFilesPage(context, { handler: fileGuest(1024 * 1024) });
  const files = await openFiles();
  await screen.findByText("report.bin");
  const control = await readyDownload(files);
  click(control);
  await browser.firstChunk;
  click(filesTab("Steps"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("region", { name: "Files" }),
    ).not.toBeInTheDocument();
  });
  browser.releaseWrite();
  expect((await browser.outcome).saved).toBeFalsy();
});

test("Cancelling an empty download before navigation does not claim browser handoff", async () => {
  const browser = await downloadBrowser(context, { holdNavigation: true });
  await setupFilesPage(context, { handler: fileGuest(0) });
  const files = await openFiles();
  click(await readyDownload(files));
  await browser.navigationRequested;
  click(filesButton("Cancel download", files));
  await expect(
    screen.findByText("Download cancelled"),
  ).resolves.toBeInTheDocument();
  browser.releaseWrite();
  expect((await browser.outcome).saved).toBeFalsy();
});

test("An incompatible resident worker asks the user to refresh", async () => {
  await downloadBrowser(context, { oldWorker: true });
  await setupFilesPage(context, { handler: fileGuest(70_003) });
  const files = await openFiles();
  await screen.findByText("report.bin");
  const control = await readyDownload(files);
  click(control);
  await expect(
    screen.findByText(
      "Refresh this page and try again. If downloads remain unavailable, start a new run.",
    ),
  ).resolves.toBeInTheDocument();
});

test("Stale worker registration cannot start a late download", async () => {
  const registration = createDeferredPromise<void>(context.signal);
  const browser = await downloadBrowser(context, {
    registration: registration.promise,
  });
  await setupFilesPage(context, { handler: fileGuest(70_003) });
  const files = await openFiles();
  await screen.findByText("report.bin");
  const control = await readyDownload(files);
  click(control);
  await browser.registered;
  click(filesTab("Steps"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("region", { name: "Files" }),
    ).not.toBeInTheDocument();
  });
  registration.resolve();
  const reopened = await openFiles();
  const retry = await readyDownload(reopened);
  click(retry);
  await expect(screen.findByText(complete)).resolves.toBeInTheDocument();
  expect((await browser.outcome).saved).toBeTruthy();
});

test("Run completion interrupts an active download", async () => {
  const browser = await downloadBrowser(context, { holdWrite: true });
  const fixture = await setupFilesPage(context, {
    handler: fileGuest(1024 * 1024),
  });
  const files = await openFiles();
  const control = await readyDownload(files);
  click(control);
  await browser.firstChunk;
  fixture.setStatus("completed");
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    screen.findByText("Files are available while a run is active."),
  ).resolves.toBeInTheDocument();
  browser.releaseWrite();
  expect((await browser.outcome).saved).toBeFalsy();
});

test("Changing workspace interrupts the previous owner's download", async () => {
  const browser = await downloadBrowser(context, { holdWrite: true });
  const fixture = await setupFilesPage(context, {
    handler: fileGuest(1024 * 1024),
  });
  const files = await openFiles();
  const control = await readyDownload(files);
  click(control);
  await browser.firstChunk;
  fixture.setStatusUnavailable(true);
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.organization({
      activeOrg: { id: "org_download_next", name: "Next workspace" },
      memberships: [{ id: "org_download_next" }],
    });
    clerk.stateChanged();
  });
  await expect(
    screen.findByText("Files are unavailable. Try again."),
  ).resolves.toBeInTheDocument();
  browser.releaseWrite();
  expect((await browser.outcome).saved).toBeFalsy();
  expect(screen.queryByText("report.bin")).not.toBeInTheDocument();
});

test("Unsupported browser capabilities leave an explicit unavailable download", async () => {
  vi.stubGlobal("isSecureContext", false);
  await setupFilesPage(context, { handler: fileGuest(70_003) });
  const files = await openFiles();
  await expect(
    within(files).findByText(
      "File downloads aren't supported in this browser.",
    ),
  ).resolves.toBeInTheDocument();
  await screen.findByText("report.bin");
  expect(filesButton("Download report.bin", files)).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("Large decimal file sizes stay exact in download progress", async () => {
  const browser = await downloadBrowser(context, { holdWrite: true });
  await setupFilesPage(context, { handler: fileGuest(9_007_199_254_740_993n) });
  const files = await openFiles();
  const control = await readyDownload(files);
  click(control);
  await browser.firstChunk;
  await expect(
    within(files).findByText(/9,007,199,254,740,993 bytes/),
  ).resolves.toBeInTheDocument();
  click(filesButton("Cancel download", files));
  await expect(
    within(files).findByText("Download cancelled"),
  ).resolves.toBeInTheDocument();
  browser.releaseWrite();
  expect((await browser.outcome).saved).toBeFalsy();
});

test("Leaving Files does not claim to undo bytes already handed to the browser", async () => {
  const browser = await downloadBrowser(context, { holdWrite: true });
  await setupFilesPage(context, { handler: fileGuest(1) });
  const files = await openFiles();
  const control = await readyDownload(files);
  click(control);
  await expect(within(files).findByText(complete)).resolves.toBeInTheDocument();
  await browser.firstChunk;
  click(filesTab("Steps"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("region", { name: "Files" }),
    ).not.toBeInTheDocument();
  });
  browser.releaseWrite();
  const result = await browser.outcome;
  expect(result.saved).toBeTruthy();
  await expect(readFile(result.file)).resolves.toStrictEqual(Buffer.from([0]));
});
