import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
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
import { renderMessagePdf } from "../../../lib/message-pdf/render.ts";
import { platformMessagePdfFontUrls } from "../../../lib/static-assets.ts";
import type {
  PdfWorkerRequest,
  PdfWorkerResponse,
} from "../../../lib/message-pdf/types.ts";
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
  for (const url of Object.values(platformMessagePdfFontUrls)) {
    context.mocks.http.get(url, ({ request }) => {
      return loadFont(request);
    });
  }
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
  first.resolve({ ok: false });
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Could not generate PDF.",
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
    [platformMessagePdfFontUrls.emoji, "noto-emoji-emoji-400-normal.woff"],
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
  await setupPdfChat(`${ANSWER}\n\n${markdown}`, async (request) => {
    const filename = fontFiles.get(request.url);
    if (!filename) {
      throw new Error("Unexpected PDF font request");
    }
    const data = await readFile(
      require.resolve(
        `../../../../test-fixtures/message-pdf-fonts/${filename}`,
      ),
    );
    return HttpResponse.arrayBuffer(Uint8Array.from(data).buffer);
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

test("Whitespace-only emphasis still exports the surrounding text", async () => {
  const { pdf, task } = await exportRenderedPdf(
    "Before<em> </em>between<strong><em> </em></strong>after.",
  );
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    const text = content.items
      .map((item) => {
        return "str" in item ? item.str : "";
      })
      .join("");
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

test("Exported typography preserves code alignment, emphasis, emoji and Markdown breaks", async () => {
  const { pdf, task } =
    await exportRenderedPdf(`Normal **Bold** *Italic* ***BoldItalic*** 中文 *中文斜体* ✅ 🚀 👩‍💻 🇨🇳 1️⃣

H<sub>2</sub>O x<sup>2</sup>

soft_first
soft_second

hard_first${"  "}
hard_second

\`\`\`text
iiii|VALUE
WWWW|VALUE
1111|VALUE
\`\`\``);
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const items = content.items.filter((item) => {
      return "str" in item;
    });
    const text = items
      .map((item) => {
        return item.str;
      })
      .join("");
    expect(text).toContain("✅");
    expect(text).toContain("🚀");
    expect(text).toContain("👩‍💻");
    expect(text).toContain("🇨🇳");
    const find = (value: string) => {
      const item = items.find((entry) => {
        return entry.str.includes(value);
      });
      if (!item) {
        throw new Error(`Missing PDF text: ${value}`);
      }
      return item;
    };
    expect(find("Italic").fontName).not.toBe(find("Normal").fontName);
    expect(find("BoldItalic").fontName).not.toBe(find("Bold").fontName);
    expect(find("soft_first").transform[5]).toBe(
      find("soft_second").transform[5],
    );
    expect(find("hard_first").transform[5]).toBeGreaterThan(
      find("hard_second").transform[5],
    );
    expect(find("iiii|VALUE").width).toBeCloseTo(find("WWWW|VALUE").width, 2);
    expect(find("1111|VALUE").width).toBeCloseTo(find("WWWW|VALUE").width, 2);
    const twos = items.filter((item) => {
      return item.str === "2";
    });
    expect(twos).toHaveLength(2);
    expect(twos[0]?.transform[5]).toBeLessThan(find("H").transform[5]);
    expect(twos[1]?.transform[5]).toBeGreaterThan(find("x").transform[5]);
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
    let text = "";
    for (let number = 1; number <= pdf.numPages; number++) {
      const content = await (await pdf.getPage(number)).getTextContent();
      text += content.items
        .map((item) => {
          return "str" in item ? item.str : "";
        })
        .join("");
    }
    for (const line of lines) {
      expect(text.split(line)).toHaveLength(2);
    }
    expect(text).toContain("TABLE_END");
  } finally {
    await task.destroy();
  }
});

test("Exported short table rows keep their identifiers, descriptions and statuses on one page", async () => {
  const rows = Array.from({ length: 42 }, (_, index) => {
    const id = String(index + 1).padStart(2, "0");
    return `| ROW_${id} | 中文说明；A short description for record ${id}. DETAIL_${id} | OK_${id} |`;
  });
  const { pdf, task } = await exportRenderedPdf(
    `| Row | Description | Status |\n|---|---|---|\n${rows.join("\n")}\n\nTABLE_END`,
  );
  try {
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

test("An exported heading stays with the following table at a page boundary", async () => {
  const fillers = Array.from({ length: 22 }, (_, index) => {
    return `FILLER_${index} — Pagination calibration paragraph.`;
  }).join("\n\n");
  const { pdf, task } = await exportRenderedPdf(
    `# Heading pagination\n\n${fillers}\n\n## Important table heading\n\n| Name | Status |\n|---|---|\n| CONTENT_START | Ready |`,
  );
  try {
    const locations = new Map<string, number>();
    for (let number = 1; number <= pdf.numPages; number++) {
      const content = await (await pdf.getPage(number)).getTextContent();
      for (const item of content.items) {
        if ("str" in item) {
          locations.set(item.str, number);
        }
      }
    }
    expect(locations.get("Important table heading")).toBe(2);
    expect(locations.get("CONTENT_START")).toBe(2);
  } finally {
    await task.destroy();
  }
});
