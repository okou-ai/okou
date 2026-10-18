import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { downloadBrowser } from "./sandbox-file-download-test-helpers.ts";
import {
  entry,
  listing,
  filesButton,
  openFiles,
  setupFilesPage,
  type FilesRequest,
  type FilesReply,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();
const textBytes = (text: string) => {
  return new TextEncoder().encode(text);
};

/** External Guest fixture; production Router and WSS framing remain real. */
function previewGuest(files: Record<string, Uint8Array>) {
  const handles = new Map<string, Uint8Array>();
  let sequence = 0;
  return (request: FilesRequest): FilesReply => {
    if (request.operation === "list") {
      return listing(
        Object.keys(files).map((name) => {
          return entry(name);
        }),
      );
    }
    if (request.operation === "open") {
      const path = request.params.path;
      const token = Array.isArray(path) ? path.at(-1) : undefined;
      const name = Object.keys(files).find((candidate) => {
        return entry(candidate).nameToken === token;
      });
      const bytes = name === undefined ? undefined : files[name];
      if (!name || !bytes) {
        return { error: { code: "not_found" } };
      }
      const mode = request.params.mode;
      if (mode === "preview" && bytes.length > 16 * 1024 * 1024) {
        return { error: { code: "limit_exceeded" } };
      }
      const selected = mode === "prefix" ? bytes.slice(0, 65_536) : bytes;
      const handle = `file${++sequence}`;
      handles.set(handle, selected);
      return {
        result: {
          handle,
          nameToken: entry(name).nameToken,
          displayName: name,
          fileSize: String(bytes.length),
          selectedSize: String(selected.length),
          truncated: selected.length < bytes.length,
        },
      };
    }
    if (request.operation === "read") {
      const { handle, offset, length } = request.params;
      if (
        typeof handle !== "string" ||
        typeof offset !== "string" ||
        typeof length !== "number"
      ) {
        throw new Error("Invalid Guest read");
      }
      const bytes = handles
        .get(handle)
        ?.slice(Number(offset), Number(offset) + length);
      if (!bytes) {
        return { error: { code: "not_found" } };
      }
      return {
        result: {
          offset,
          length: bytes.length,
          data: Buffer.from(bytes).toString("base64"),
        },
      };
    }
    return { result: {} };
  };
}

async function openPreview(name: string) {
  await screen.findByText(name);
  const button = filesButton(`Preview ${name}`);
  click(button);
  return screen.findByRole("dialog", { name });
}

test.each([
  ["notes.txt", "A short note"],
  ["guide.md", "# Preview heading"],
  ["answer.json", '{"answer":42}'],
  ["data.csv", "name,value\nalpha,42"],
])("A user previews %s through the shared renderer", async (name, source) => {
  await setupFilesPage(context, {
    handler: previewGuest({ [name]: textBytes(source) }),
  });
  await openFiles();
  const dialog = await openPreview(name);
  const expected = name.endsWith("md")
    ? "Preview heading"
    : name.endsWith("csv")
      ? "alpha"
      : name.endsWith("json")
        ? /"answer": 42/
        : source;
  await expect(
    within(dialog).findByText(expected),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Copy link")).not.toBeInTheDocument();
});

test.each(["page.html", "image.svg"])(
  "%s stays escaped source without an executing frame",
  async (name) => {
    const source =
      '<script>alert("sandbox")</script><img src="https://untrusted.example/image">';
    await setupFilesPage(context, {
      handler: previewGuest({ [name]: textBytes(source) }),
    });
    await openFiles();
    const dialog = await openPreview(name);
    await expect(
      within(dialog).findByText(source),
    ).resolves.toBeInTheDocument();
    expect(dialog.querySelector("iframe, script, img")).toBeNull();
  },
);

test.each([
  ["deep", "[".repeat(10_000) + "0" + "]".repeat(10_000)],
  [
    "expanded",
    JSON.stringify(
      Array.from({ length: 20_000 }, () => {
        return 0;
      }),
    ),
  ],
  ["malformed", '{"unfinished":'],
])(
  "A %s JSON document remains readable without breaking the page",
  async (_name, source) => {
    await setupFilesPage(context, {
      handler: previewGuest({ "source.json": textBytes(source) }),
    });
    await openFiles();
    const dialog = await openPreview("source.json");
    await waitFor(() => {
      expect(dialog.querySelector("pre")?.textContent).toBe(source);
    });
    expect(filesButton("Download", dialog)).toBeEnabled();
  },
);

test.each(["partial.json", "partial.csv", "partial.txt"])(
  "%s shows a bounded UTF-8 prefix as readable source",
  async (name) => {
    const bytes = textBytes("a".repeat(65_535) + "€tail");
    const fixture = await setupFilesPage(context, {
      handler: previewGuest({ [name]: bytes }),
    });
    await openFiles();
    const dialog = await openPreview(name);
    await expect(
      within(dialog).findByText(
        "Showing the first 64 KiB. Download the file for its full contents.",
      ),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(dialog.querySelector("pre")?.textContent).toBe("a".repeat(65_535));
    });
    expect(dialog.querySelector("table")).toBeNull();
    const reads = fixture.requests.filter((request) => {
      return request.operation === "read";
    });
    expect(
      reads.reduce((total, request) => {
        return total + Number(request.params.length);
      }, 0),
    ).toBe(65_536);
  },
);

test.each(["empty.txt", "empty.pdf"])(
  "%s has an explicit empty state",
  async (name) => {
    await setupFilesPage(context, {
      handler: previewGuest({ [name]: new Uint8Array() }),
    });
    await openFiles();
    const dialog = await openPreview(name);
    await expect(
      within(dialog).findByText("This file is empty."),
    ).resolves.toBeInTheDocument();
  },
);

test.each([
  [
    "binary.docx",
    Uint8Array.of(1),
    "Preview isn't available for this file type. You can still download it.",
  ],
  [
    "bad.txt",
    Uint8Array.of(255),
    "This file couldn't be decoded. You can still download it.",
  ],
  [
    "bad.png",
    textBytes("not an image"),
    "This file isn't a valid preview. You can still download it.",
  ],
  [
    "bad.pdf",
    textBytes("<html>not a PDF</html>"),
    "This file isn't a valid preview. You can still download it.",
  ],
  [
    "huge.pdf",
    new Uint8Array(16 * 1024 * 1024 + 1),
    "This file is too large to preview. You can still download it.",
  ],
])(
  "%s explains preview failure and retains Download",
  async (name, bytes, message) => {
    await setupFilesPage(context, { handler: previewGuest({ [name]: bytes }) });
    await openFiles();
    const dialog = await openPreview(name);
    await expect(
      within(dialog).findByText(message),
    ).resolves.toBeInTheDocument();
    expect(filesButton("Download", dialog)).toBeEnabled();
  },
);

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWL6z8DwHwAAAP//A3ONEwAAAAZJREFUAwAFCgIByRpMngAAAABJRU5ErkJggg==",
    "base64",
  ),
);

test.each([
  [
    "valid.jpg",
    "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABwn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAYqm//Z",
  ],
  [
    "valid.webp",
    "UklGRh4CAABXRUJQVlA4WAoAAAAgAAAAAAAAAAAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggMAAAANABAJ0BKgEAAQABQCYloAJ0ugH4AAOwAP7y63/82BXNc+/3/9Lg/S4P0uD/0pAAAA==",
  ],
  ["valid.gif", "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"],
])("A validated %s uses the shared image renderer", async (name, base64) => {
  const urls = context.mocks.browser.imageDimensions({ width: 1, height: 1 });
  await setupFilesPage(context, {
    handler: previewGuest({
      [name]: Uint8Array.from(Buffer.from(base64, "base64")),
    }),
  });
  await openFiles();
  const dialog = await openPreview(name);
  const image = await within(dialog).findByAltText(name);
  expect(image).toHaveAttribute("src", urls.createdUrls.at(-1));
});

test("An image preview releases its temporary and rendered object URLs on close and restores focus", async () => {
  const images = context.mocks.browser.imageDimensions({ width: 1, height: 1 });
  await setupFilesPage(context, {
    handler: previewGuest({ "photo.png": png }),
  });
  await openFiles();
  const button = filesButton("Preview photo.png");
  button.focus();
  const dialog = await openPreview("photo.png");
  const image = await within(dialog).findByAltText("photo.png");
  expect(image).toHaveAttribute("src", images.createdUrls.at(-1));
  expect(images.revokedUrls).toHaveLength(1);
  click(filesButton("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(images.revokedUrls).toStrictEqual(images.createdUrls);
  await waitFor(() => {
    expect(button).toHaveFocus();
  });
});

test.each(["decode", "dimensions"])(
  "Image %s failures never render unvalidated bytes",
  async (failure) => {
    const images = context.mocks.browser.imageDimensions(
      failure === "decode" ? null : { width: 2, height: 1 },
    );
    await setupFilesPage(context, {
      handler: previewGuest({ "photo.png": png }),
    });
    await openFiles();
    const dialog = await openPreview("photo.png");
    await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
      failure === "decode" ? "couldn't be decoded" : "isn't a valid preview",
    );
    expect(images.revokedUrls).toStrictEqual(images.createdUrls);
    expect(dialog.querySelector("img")).toBeNull();
  },
);

test("An oversized image is rejected before invoking the browser decoder", async () => {
  const images = context.mocks.browser.imageDimensions({
    width: 9000,
    height: 1,
  });
  const bytes = png.slice();
  new DataView(bytes.buffer).setUint32(16, 9000);
  await setupFilesPage(context, {
    handler: previewGuest({ "huge.png": bytes }),
  });
  await openFiles();
  const dialog = await openPreview("huge.png");
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "too large to preview",
  );
  expect(images.createdUrls).toHaveLength(0);
});

test("A validated PDF uses the shared native document frame and releases its URL", async () => {
  const urls = context.mocks.browser.imageDimensions(null);
  await setupFilesPage(context, {
    handler: previewGuest({ "report.pdf": textBytes("%PDF-1.4\nfixture") }),
  });
  await openFiles();
  const dialog = await openPreview("report.pdf");
  const frame = await within(dialog).findByTitle("report.pdf preview");
  expect(frame).toHaveAttribute(
    "src",
    `${urls.createdUrls.at(-1)}#toolbar=0&navpanes=0`,
  );
  click(filesButton("Close", dialog));
  await waitFor(() => {
    expect(urls.revokedUrls).toStrictEqual(urls.createdUrls);
  });
});

test("Closing a truncated preview leaves its independent full-file Download intact", async () => {
  const browser = await downloadBrowser(context, { holdWrite: true });
  const bytes = textBytes("full content\n".repeat(6000));
  const fixture = await setupFilesPage(context, {
    handler: previewGuest({ "notes.txt": bytes }),
  });
  await openFiles();
  const dialog = await openPreview("notes.txt");
  await within(dialog).findByText(
    "Showing the first 64 KiB. Download the file for its full contents.",
  );
  click(filesButton("Download", dialog));
  await browser.firstChunk;
  click(filesButton("Close", dialog));
  browser.releaseWrite();
  const saved = await browser.outcome;
  expect(saved.saved).toBeTruthy();
  const savedBytes = await readFile(saved.file);
  expect(savedBytes).toHaveLength(bytes.length);
  expect(createHash("sha256").update(savedBytes).digest("hex")).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(
    fixture.requests
      .filter((request) => {
        return request.operation === "open";
      })
      .map((request) => {
        return request.params.mode;
      }),
  ).toStrictEqual(["prefix", "download"]);
});

test("Closing a pending read suppresses its stale result after another file opens", async () => {
  const blocked = createDeferredPromise<FilesReply>(context.signal);
  const requested = createDeferredPromise<void>(context.signal);
  const guest = previewGuest({
    "old.txt": textBytes("stale"),
    "new.txt": textBytes("current"),
  });
  let hold = true;
  const fixture = await setupFilesPage(context, {
    handler(request) {
      if (request.operation === "read" && hold) {
        hold = false;
        requested.resolve();
        return blocked.promise;
      }
      return guest(request);
    },
  });
  await openFiles();
  const old = await openPreview("old.txt");
  await requested.promise;
  const source = fixture.sockets.at(-1);
  click(filesButton("Close", old));
  await waitFor(() => {
    expect(source?.readyState).toBe(WebSocket.CLOSED);
  });
  const next = await openPreview("new.txt");
  await expect(within(next).findByText("current")).resolves.toBeInTheDocument();
  await act(() => {
    blocked.resolve({
      result: {
        offset: "0",
        length: 5,
        data: Buffer.from("stale").toString("base64"),
      },
    });
  });
  expect(within(next).queryByText("stale")).not.toBeInTheDocument();
});

test.each(["Files leave", "Run completion", "Workspace change", "Logout"])(
  "%s releases a resident preview",
  async (reason) => {
    const urls = context.mocks.browser.imageDimensions({ width: 1, height: 1 });
    const fixture = await setupFilesPage(context, {
      handler: previewGuest({ "photo.png": png }),
    });
    await openFiles();
    const dialog = await openPreview("photo.png");
    await within(dialog).findByAltText("photo.png");
    if (reason === "Files leave") {
      act(() => {
        window.history.back();
      });
    } else if (reason === "Workspace change") {
      fixture.setStatusUnavailable(true);
      const clerk = context.mocks.clerk();
      act(() => {
        clerk.organization({
          activeOrg: { id: "org_preview_next", name: "Next workspace" },
          memberships: [{ id: "org_preview_next" }],
        });
        clerk.stateChanged();
      });
    } else if (reason === "Logout") {
      act(() => {
        context.mocks.clerk().sessionSignedOut(true);
      });
    } else {
      fixture.setStatus("completed");
      fireEvent(document, new Event("visibilitychange"));
    }
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "photo.png" }),
      ).not.toBeInTheDocument();
    });
    expect(urls.revokedUrls).toStrictEqual(urls.createdUrls);
  },
);

test("Native keyboard opens and dismisses the preview with focus returned to the filename", async () => {
  await setupFilesPage(context, {
    handler: previewGuest({ "notes.txt": textBytes("keyboard preview") }),
  });
  await openFiles();
  await screen.findByText("notes.txt");
  const control = filesButton("Preview notes.txt");
  const user = userEvent.setup();
  control.focus();
  await user.keyboard("{Enter}");
  await expect(
    screen.findByText("keyboard preview"),
  ).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(control).toHaveFocus();
  });
});

test.each(["wrong-offset", "changed", "oversized-selection"])(
  "A %s response is rejected without rendering content",
  async (failure) => {
    const guest = previewGuest({ "notes.txt": textBytes("unsafe") });
    await setupFilesPage(context, {
      handler(request) {
        if (failure === "wrong-offset" && request.operation === "read") {
          return {
            result: {
              offset: "1",
              length: 6,
              data: Buffer.from("unsafe").toString("base64"),
            },
          };
        }
        if (failure === "changed" && request.operation === "finish") {
          return { error: { code: "file_changed" } };
        }
        if (failure === "oversized-selection" && request.operation === "open") {
          return {
            result: {
              handle: "large",
              nameToken: entry("notes.txt").nameToken,
              displayName: "notes.txt",
              fileSize: "65537",
              selectedSize: "65537",
              truncated: false,
            },
          };
        }
        return guest(request);
      },
    });
    await openFiles();
    const dialog = await openPreview("notes.txt");
    const message = await within(dialog).findByRole("alert");
    expect(message).toHaveTextContent(
      failure === "changed"
        ? "This file changed"
        : failure === "oversized-selection"
          ? "too large to preview"
          : "isn't a valid preview",
    );
    expect(within(dialog).queryByText("unsafe")).not.toBeInTheDocument();
  },
);

test("A new preview with a different fs version requires refresh without a legacy read", async () => {
  const categories = { fs: 3 };
  const fixture = await setupFilesPage(context, {
    categories,
    handler: previewGuest({ "notes.txt": textBytes("exact version") }),
  });
  await openFiles();
  await screen.findByText("notes.txt");
  categories.fs = 2;
  const dialog = await openPreview("notes.txt");
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Refresh",
  );
  expect(
    fixture.requests.some((request) => {
      return request.operation === "open";
    }),
  ).toBeFalsy();
});

test("A preview size rejection still permits saving the entire file", async () => {
  const browser = await downloadBrowser(context);
  const bytes = new Uint8Array(16 * 1024 * 1024 + 1).fill(42);
  await setupFilesPage(context, {
    handler: previewGuest({ "large.pdf": bytes }),
  });
  await openFiles();
  const dialog = await openPreview("large.pdf");
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "too large to preview",
  );
  click(filesButton("Download", dialog));
  const saved = await browser.outcome;
  expect(saved.saved).toBeTruthy();
  const savedBytes = await readFile(saved.file);
  expect(savedBytes).toHaveLength(bytes.length);
  expect(createHash("sha256").update(savedBytes).digest("hex")).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
});

test("Closing a pending image decode immediately releases its temporary URL", async () => {
  const urls = context.mocks.browser.imageDimensions("pending");
  const fixture = await setupFilesPage(context, {
    handler: previewGuest({ "photo.png": png }),
  });
  await openFiles();
  const dialog = await openPreview("photo.png");
  await waitFor(() => {
    expect(urls.createdUrls).toHaveLength(1);
  });
  const source = fixture.sockets.at(-1);
  click(filesButton("Close", dialog));
  await waitFor(() => {
    expect(urls.revokedUrls).toStrictEqual(urls.createdUrls);
  });
  expect(source?.readyState).toBe(WebSocket.CLOSED);
});

test("Focus returns to Files navigation when an automatically refreshed row disappears", async () => {
  const files = { "notes.txt": textBytes("resident preview") };
  const guest = previewGuest(files);
  let removed = false;
  await setupFilesPage(context, {
    handler(request) {
      return removed && request.operation === "list"
        ? listing([entry("replacement.txt")])
        : guest(request);
    },
  });
  const panel = await openFiles();
  const dialog = await openPreview("notes.txt");
  await within(dialog).findByText("resident preview");
  removed = true;
  fireEvent(document, new Event("visibilitychange"));
  await within(panel).findByText("replacement.txt");
  click(filesButton("Close", dialog));
  await waitFor(() => {
    expect(panel.contains(document.activeElement)).toBeTruthy();
  });
  expect(document.activeElement?.getAttribute("aria-label")).not.toBe(
    "Preview notes.txt",
  );
});
