import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chatThreadPdfFilenameContract } from "@okouai/api-contracts/contracts/chat-thread-pdf-filename";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { renderMessagePdf } from "../../../lib/message-pdf/render.ts";
import type {
  PdfWorkerRequest,
  PdfWorkerResponse,
} from "../../../lib/message-pdf/types.ts";
import {
  platformMessagePdfFontUrls,
  platformPreviewMessagePdfFontUrls,
} from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000951";
const ANSWER = "The launch plan has three phases.";
const ASSISTANT_EVENT_ID = "b0000000-0000-4000-a000-000000000954";

function button(name: string): HTMLElement {
  const result = queryAllByRoleFast("button", document.body).find((element) => {
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
  const result = queryAllByRoleFast("link", document.body).find((element) => {
    return element.getAttribute("aria-label") === "Download PDF";
  });
  if (!(result instanceof HTMLAnchorElement)) {
    throw new Error("PDF download link not found");
  }
  return result;
}

function generatedPdf(): Blob {
  return new Blob(["%PDF-1.7\n%%EOF"], { type: "application/pdf" });
}

async function setupPdfChat({
  content = ANSWER,
  host = "app.okou.ai",
  loadFont = () => {
    return HttpResponse.arrayBuffer(new ArrayBuffer(8));
  },
  filenameResponse = () => {
    return HttpResponse.json("Launch-plan");
  },
}: {
  content?: string;
  host?: string;
  loadFont?: (request: Request) => Response | Promise<Response>;
  filenameResponse?: () => Response;
} = {}) {
  context.mocks.http.post(
    `*${chatThreadPdfFilenameContract.generate.path}`,
    async ({ request, params }) => {
      expect(params.threadId).toBe(THREAD_ID);
      await expect(request.json()).resolves.toStrictEqual({
        eventIds: [ASSISTANT_EVENT_ID],
      });
      return filenameResponse();
    },
  );
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "b0000000-0000-4000-a000-000000000953",
        role: "user",
        content: "Summarize the launch plan",
        runId: "pdf-run",
        createdAt: "2026-08-01T10:00:00Z",
      },
      {
        id: ASSISTANT_EVENT_ID,
        role: "assistant",
        content,
        runId: "pdf-run",
        createdAt: "2026-08-01T10:00:01Z",
      },
    ],
  });
  const production = host === "app.okou.ai";
  const fontUrls = production
    ? platformMessagePdfFontUrls
    : platformPreviewMessagePdfFontUrls;
  for (const url of Object.values(fontUrls)) {
    const filename = new URL(url, "https://app.okou.ai").pathname
      .split("/")
      .at(-1);
    const pattern = production
      ? `https://static.okou.io/platform/message-pdf/fonts/${filename}`
      : `*/${filename}`;
    context.mocks.http.get(pattern, ({ request }) => {
      expect(new URL(request.url).origin).toBe(
        production ? "https://static.okou.io" : location.origin,
      );
      expect(request.credentials).toBe(production ? "omit" : "same-origin");
      return loadFont(request);
    });
  }
  await setupPage({ context, path: `/chats/${THREAD_ID}`, host });
  await screen.findByText(ANSWER);
  await waitFor(() => {
    expect(button("Generate PDF")).toBeInTheDocument();
  });
}

test("Generating a PDF offers a native download whose bytes survive repeated clicks", async () => {
  const response = context.mocks.deferred<PdfWorkerResponse>();
  context.mocks.browser.dedicatedWorker(() => {
    return response.promise;
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPdfChat();

  button("Generate PDF").focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(button("Generating PDF…")).toBeVisible();
  });
  expect(button("Generating PDF…")).toHaveFocus();
  const pdf = generatedPdf();
  response.resolve({ ok: true, blob: pdf });
  await waitFor(() => {
    expect(downloadLink()).toHaveAttribute("download", "Launch-plan.pdf");
  });
  const link = downloadLink();
  expect(link).toHaveFocus();
  const url = link.href;
  expect(fireEvent.click(link)).toBeTruthy();
  expect(browser.blobForUrl(url)).toBe(pdf);
  expect(fireEvent.click(link)).toBeTruthy();
  expect(browser.blobForUrl(url)).toBe(pdf);

  click(button("New chat"));
  await waitFor(() => {
    expect(location.pathname).not.toBe(`/chats/${THREAD_ID}`);
  });
  expect(browser.blobForUrl(url)).toBeNull();
});

test("A preview deployment offers the same generated PDF bytes on repeated downloads", async () => {
  const pdf = generatedPdf();
  context.mocks.browser.dedicatedWorker(() => {
    return Promise.resolve({ ok: true, blob: pdf } satisfies PdfWorkerResponse);
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPdfChat({ host: "pr-1-app.omby.ai" });

  click(button("Generate PDF"));
  await waitFor(() => {
    expect(downloadLink()).toHaveAttribute("download", "Launch-plan.pdf");
  });
  const link = downloadLink();
  expect(fireEvent.click(link)).toBeTruthy();
  expect(browser.blobForUrl(link.href)).toBe(pdf);
  expect(fireEvent.click(link)).toBeTruthy();
  expect(browser.blobForUrl(link.href)).toBe(pdf);
});

test("An empty filename result keeps the default PDF filename", async () => {
  const pdf = generatedPdf();
  context.mocks.browser.dedicatedWorker(() => {
    return Promise.resolve({ ok: true, blob: pdf } satisfies PdfWorkerResponse);
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPdfChat({
    filenameResponse: () => {
      return HttpResponse.json("");
    },
  });

  click(button("Generate PDF"));
  await waitFor(() => {
    expect(downloadLink()).toHaveAttribute("download", "okou-message.pdf");
  });
  expect(browser.blobForUrl(downloadLink().href)).toBe(pdf);
});

async function exportRenderedPdf(markdown: string) {
  const require = createRequire(import.meta.url);
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
  const fontFiles = new Map([
    [platformMessagePdfFontUrls.regular, "NotoSansCJKsc-Regular.otf"],
    [platformMessagePdfFontUrls.bold, "NotoSansCJKsc-Bold.otf"],
    [platformMessagePdfFontUrls.italic, "sarasa-gothic-sc-italic.ttf"],
    [platformMessagePdfFontUrls.boldItalic, "sarasa-gothic-sc-bolditalic.ttf"],
  ]);
  const rendered = context.mocks.deferred<void>();
  // Replace only the browser transport. The page command, Markdown parser,
  // document builder, font loading and PDF renderer all execute unchanged.
  context.mocks.browser.dedicatedWorker(async (message) => {
    const blob = await renderMessagePdf(message as PdfWorkerRequest);
    rendered.resolve();
    return { ok: true, blob };
  });
  const browser = context.mocks.browser.blobDownload();
  await setupPdfChat({
    content: `${ANSWER}\n\n${markdown}`,
    loadFont: async (request) => {
      const filename = [...fontFiles].find(([url]) => {
        return new URL(url, location.href).href === request.url;
      })?.[1];
      if (!filename) {
        throw new Error("Unexpected PDF font request");
      }
      const data = await readFile(
        require.resolve(
          `../../../../test-fixtures/message-pdf-fonts/${filename}`,
        ),
      );
      return HttpResponse.arrayBuffer(Uint8Array.from(data).buffer);
    },
  });
  click(button("Generate PDF"));
  await rendered.promise;
  await waitFor(() => {
    expect(downloadLink()).toBeInTheDocument();
  });
  const blob = browser.blobForUrl(downloadLink().href);
  if (!blob) {
    throw new Error("PDF download has no data");
  }
  const task = getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    useSystemFonts: false,
  });
  return { pdf: await task.promise, task };
}

type ExportedPdf = Awaited<ReturnType<typeof exportRenderedPdf>>["pdf"];

async function pageTexts(pdf: ExportedPdf): Promise<string[]> {
  const pages: string[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const content = await (await pdf.getPage(number)).getTextContent();
    pages.push(
      content.items
        .map((item) => {
          return "str" in item ? item.str : "";
        })
        .join(""),
    );
  }
  return pages;
}

test("PDF text and typography render CJK emphasis", async () => {
  const { pdf, task } = await exportRenderedPdf(
    [
      "Normal **Bold** *Italic* ***BoldItalic***",
      "**机构与身份：**个人站",
      "*说明：*后文",
      "***重点：***后文",
      "未闭合**（保留",
    ].join("\n\n"),
  );
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    const items = content.items.filter((item) => {
      return "str" in item;
    });
    const text = items
      .map((item) => {
        return item.str;
      })
      .join("");
    expect(text).toContain("机构与身份：个人站");
    expect(text).toContain("说明：后文");
    expect(text).toContain("重点：后文");
    expect(text).toContain("未闭合**（保留");
    const fontFor = (value: string) => {
      const item = items.find((entry) => {
        return entry.str.includes(value);
      });
      if (!item) {
        throw new Error(`Missing PDF text: ${value}`);
      }
      return item.fontName;
    };
    expect(
      new Set([
        fontFor("Normal"),
        fontFor("Bold"),
        fontFor("Italic"),
        fontFor("BoldItalic"),
      ]).size,
    ).toBe(4);
    expect(fontFor("机构与身份：")).toBe(fontFor("Bold"));
    expect(fontFor("说明：")).toBe(fontFor("Italic"));
    expect(fontFor("重点：")).toBe(fontFor("BoldItalic"));
  } finally {
    await task.destroy();
  }
});

test("Whitespace-only emphasis still exports the surrounding text", async () => {
  const { pdf, task } = await exportRenderedPdf(
    "Before<em> </em>between<strong><em> </em></strong>after.",
  );
  try {
    const [text] = await pageTexts(pdf);
    expect(text).toContain("Before");
    expect(text).toContain("between");
    expect(text).toContain("after.");
  } finally {
    await task.destroy();
  }
});

test("Exported table text stays inside the page and merged columns preserve all cells", async () => {
  const { pdf, task } = await exportRenderedPdf(`| Rank | Candidate | Reason |
|---|---|---|
| 1 | org_members_metadata.translation_language | RIGHT_EDGE_SENTINEL |
| 2 | ${"https://example.com/" + "longpath".repeat(25)} | LAST_COLUMN |

<table><tr><th colspan="2">Group header</th><th>Notes</th></tr><tr><td>A</td><td>B</td><td>Normal row</td></tr><tr><td colspan="2">Combined columns</td><td>Final note</td></tr></table>`);
  try {
    let text = "";
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const width = page.getViewport({ scale: 1 }).width;
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item)) {
          continue;
        }
        text += item.str;
        expect(item.transform[4]).toBeGreaterThanOrEqual(47);
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(width - 47);
      }
    }
    expect(text).toContain("RIGHT_EDGE_SENTINEL");
    expect(text).toContain("LAST_COLUMN");
    expect(text).toContain("Group header");
    expect(text).toContain("Combined columns");
    expect(text).toContain("Final note");
  } finally {
    await task.destroy();
  }
});

test("A table row taller than a page retains every line in the exported PDF", async () => {
  const lines = Array.from({ length: 75 }, (_, index) => {
    return `LONG_ROW_${String(index + 1).padStart(3, "0")}`;
  });
  const { pdf, task } = await exportRenderedPdf(
    `| ID | Content |\n|---|---|\n| A | ${lines.join("<br>")} |\n\nTABLE_END`,
  );
  try {
    expect(pdf.numPages).toBeGreaterThan(1);
    const text = (await pageTexts(pdf)).join("");
    for (const line of lines) {
      expect(text.split(line)).toHaveLength(2);
    }
    expect(text).toContain("TABLE_END");
  } finally {
    await task.destroy();
  }
});

test("Exported short table rows keep each detail and status on their identifier's page", async () => {
  const rows = Array.from({ length: 42 }, (_, index) => {
    const id = String(index + 1).padStart(2, "0");
    return `| ROW_${id} | 中文说明；A short description for record ${id}. DETAIL_${id} | OK_${id} |`;
  });
  const { pdf, task } = await exportRenderedPdf(
    `| Row | Description | Status |\n|---|---|---|\n${rows.join("\n")}\n\nTABLE_END`,
  );
  try {
    const pages = await pageTexts(pdf);
    for (let number = 1; number <= 42; number++) {
      const id = String(number).padStart(2, "0");
      const page = pages.find((text) => {
        return text.includes(`ROW_${id}`);
      });
      expect(page).toContain(`DETAIL_${id}`);
      expect(page).toContain(`OK_${id}`);
    }
  } finally {
    await task.destroy();
  }
});
