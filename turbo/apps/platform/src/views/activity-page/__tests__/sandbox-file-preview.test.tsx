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
  type FilesReply,
} from "./sandbox-files-test-helpers.ts";
import { previewGuest } from "./sandbox-file-preview-test-helpers.ts";

const context = testContext();
const textBytes = (text: string) => {
  return new TextEncoder().encode(text);
};

async function openPreview(name: string) {
  await screen.findByText(name);
  const button = filesButton(`Preview ${name}`);
  click(button);
  return screen.findByRole("dialog", { name });
}

test.each([
  ["notes.txt", "A short note"],
  ["guide.md", "# Preview heading"],
  ["answer.json", String.raw`{"answer":42,"note":" a b \"quoted\" \\ tail "}`],
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

test.each(["config", ".bashrc", "config.custom"])(
  "An unrecognized filename %s still previews validated UTF-8 text",
  async (name) => {
    const source = '#!/bin/sh\nprintf "你好 🌍"\nVALUE=" a < b "\t# note\n';
    await setupFilesPage(context, {
      handler: previewGuest({ [name]: textBytes(source) }),
    });
    await openFiles();
    const dialog = await openPreview(name);
    await waitFor(() => {
      expect(dialog.querySelector("pre")?.textContent).toBe(source);
    });
    expect(filesButton("Download", dialog)).toBeEnabled();
  },
);

test.each(["page.html", "image.svg", "document"])(
  "%s stays escaped source without an executing frame",
  async (name) => {
    const source =
      '<img src="invalid" onerror="window.__sandboxPreviewExecuted = true">';
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

test.each(["sparse", "rectangular"])(
  "A wide %s CSV keeps complete readable source instead of expanding a large table",
  async (shape) => {
    const source = [
      Array.from({ length: 101 }, (_, index) => {
        return `column${index}`;
      }).join(","),
      ...Array.from({ length: 100 }, (_, index) => {
        return `row${index}${shape === "rectangular" ? ",".repeat(100) : ""}`;
      }),
    ].join("\n");
    await setupFilesPage(context, {
      handler: previewGuest({ "wide.csv": textBytes(source) }),
    });
    await openFiles();
    const dialog = await openPreview("wide.csv");
    await waitFor(() => {
      expect(dialog.querySelector("pre")?.textContent).toBe(source);
    });
    expect(dialog.querySelector("table")).toBeNull();
    expect(filesButton("Download", dialog)).toBeEnabled();
  },
);

test("Quoted CSV fields retain commas, line breaks, escaped quotes and spaces", async () => {
  const source =
    'name,note,value\r\n"Doe, Jane","first\r\nsecond ""quoted"" line", 42 \r\n';
  await setupFilesPage(context, {
    handler: previewGuest({ "quoted.csv": textBytes(source) }),
  });
  await openFiles();
  const dialog = await openPreview("quoted.csv");
  const table = await within(dialog).findByRole("table");
  expect(
    Array.from(table.querySelectorAll("tbody td"), (cell) => {
      return cell.textContent;
    }),
  ).toStrictEqual(["Doe, Jane", 'first\r\nsecond "quoted" line', " 42 "]);
});

test.each([
  'name,note\nvalue,"unfinished',
  'name,note\nvalue,bare"quote',
  'name,note\nvalue,"closed"extra',
  "name,note\nvalue,one,extra",
])("Unrepresentable CSV retains its readable source: %s", async (source) => {
  await setupFilesPage(context, {
    handler: previewGuest({ "malformed.csv": textBytes(source) }),
  });
  await openFiles();
  const dialog = await openPreview("malformed.csv");
  await waitFor(() => {
    expect(dialog.querySelector("pre")?.textContent).toBe(source);
  });
  expect(dialog.querySelector("table")).toBeNull();
  expect(filesButton("Download", dialog)).toBeEnabled();
});

test("Embedded HTML in Markdown stays readable without creating an executing frame", async () => {
  const html =
    '<iframe title="&lt;source&gt;" srcdoc="<img src=invalid onerror=parent.__sandboxPreviewExecuted=true>"></iframe>';
  await setupFilesPage(context, {
    handler: previewGuest({
      "untrusted.md": textBytes("# Safe Markdown\n\n" + html),
    }),
  });
  await openFiles();
  const dialog = await openPreview("untrusted.md");
  await expect(
    within(dialog).findByText("Safe Markdown"),
  ).resolves.toBeInTheDocument();
  await expect(within(dialog).findByText(html)).resolves.toBeInTheDocument();
  expect(dialog.querySelector("iframe, embed, object, script, img")).toBeNull();
});

test("A Markdown preview preserves literal code and angle-bracket autolinks", async () => {
  const inline = "<span>&lt;</span>";
  const fenced = '<div title="a < b">&lt; source</div>';
  const source = [
    "# Code samples",
    `Use \`${inline}\` literally.`,
    "",
    "```html",
    fenced,
    "```",
    "",
    "<https://example.com/preview>",
  ].join("\n");
  await setupFilesPage(context, {
    handler: previewGuest({ "code.md": textBytes(source) }),
  });
  await openFiles();
  const dialog = await openPreview("code.md");
  await expect(within(dialog).findByText(inline)).resolves.toBeInTheDocument();
  expect(dialog.querySelector("pre code")?.textContent?.trimEnd()).toBe(fenced);
  expect(
    dialog.querySelector('a[href="https://example.com/preview"]'),
  ).toBeInTheDocument();
});

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
  ["large-integer", '{"id":9223372036854775807}'],
  ["overflowing-number", '{"value":1e309}'],
  ["negative-zero", '{"value":-0}'],
  ["duplicate-keys", '{"mode":"first","mode":"second"}'],
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

test.each(["partial.json", "partial.csv", "partial.txt", "config"])(
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

test.each(["empty.txt", "empty.pdf", "empty"])(
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

test.each([
  ["program", Uint8Array.of(127, 69, 76, 70, 0, 1)],
  [".cache", Uint8Array.of(255, 254, 97, 0)],
])("An unknown binary %s remains download-only", async (name, bytes) => {
  const browser = await downloadBrowser(context);
  await setupFilesPage(context, {
    handler: previewGuest({ [name]: bytes }),
  });
  await openFiles();
  const dialog = await openPreview(name);
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Preview isn't available for this file type. You can still download it.",
  );
  expect(dialog.querySelector("pre, img, iframe")).toBeNull();
  click(filesButton("Download", dialog));
  const saved = await browser.outcome;
  expect(saved.saved).toBeTruthy();
  await expect(readFile(saved.file)).resolves.toStrictEqual(Buffer.from(bytes));
});

test.each(["notes.txt", "notes"])(
  "Closing a truncated %s preview leaves its independent full-file Download intact",
  async (name) => {
    const browser = await downloadBrowser(context, { holdWrite: true });
    const bytes = textBytes("full content\n".repeat(6000));
    const fixture = await setupFilesPage(context, {
      handler: previewGuest({ [name]: bytes }),
    });
    await openFiles();
    const dialog = await openPreview(name);
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
  },
);

test("Dialog Download preparation retains keyboard focus and survives closing the preview", async () => {
  const registration = createDeferredPromise<void>(context.signal);
  const browser = await downloadBrowser(context, {
    registration: registration.promise,
  });
  await setupFilesPage(context, {
    handler: previewGuest({ "notes.txt": textBytes("complete") }),
  });
  await openFiles();
  const dialog = await openPreview("notes.txt");
  await within(dialog).findByText("complete");
  const button = filesButton("Download", dialog);
  const user = userEvent.setup();
  button.focus();
  await user.keyboard("{Enter}");
  await browser.registered;
  await waitFor(() => {
    expect(button).toHaveAttribute("aria-busy", "true");
  });
  expect(button).toHaveFocus();
  click(filesButton("Close", dialog));
  await act(() => {
    registration.resolve();
  });
  const saved = await browser.outcome;
  expect(saved.saved).toBeTruthy();
  await expect(readFile(saved.file)).resolves.toStrictEqual(
    Buffer.from("complete"),
  );
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

test("A failed initial preview connection shows an error and permits an explicit retry", async () => {
  let networkUnavailable = false;
  await setupFilesPage(context, {
    handler: previewGuest({ "notes.txt": textBytes("reconnected source") }),
    get bootstrapUnavailable() {
      return networkUnavailable ? "network" : false;
    },
  });
  await openFiles();
  await screen.findByText("notes.txt");
  networkUnavailable = true;
  const dialog = await openPreview("notes.txt");
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Preview unavailable",
  );
  expect(filesButton("Download", dialog)).toBeEnabled();
  networkUnavailable = false;
  click(filesButton("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  const next = await openPreview("notes.txt");
  await expect(
    within(next).findByText("reconnected source"),
  ).resolves.toBeInTheDocument();
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
