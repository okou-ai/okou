// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { expect, test } from "vitest";
import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { conversation, assistantRow } from "./attachment-preview-boundaries.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { pdfServices, readSavedPdf } from "./message-export-boundaries.ts";
const context = testContext();

async function downloadLink() {
  return await waitFor(() => {
    const link = document.querySelector(
      'a[aria-label="Download PDF"][download][href]',
    );
    if (!(link instanceof HTMLAnchorElement)) {
      throw new Error("Waiting for the native PDF download");
    }
    return link;
  });
}

async function exportMessage(body: string, name = "Field-notes") {
  const browser = pdfServices(context, name);
  await conversation(context, { chatEvents: [assistantRow(body)] });
  click(await findAction("button", "Generate PDF"));
  const link = await downloadLink();
  const blob = browser.blobForUrl(link.href);
  if (!blob) {
    throw new Error("The download link has no PDF");
  }
  return { link, pages: await readSavedPdf(blob) };
}
test("chat-message-pdf-001 Enter generates a focused native link that survives two downloads until navigation", async () => {
  const naming = createDeferredPromise<string>(context.signal);
  const browser = pdfServices(context, naming.promise);
  await conversation(context, {
    chatEvents: [assistantRow("Field launch checklist")],
  });
  const generate = await findAction("button", "Generate PDF");
  generate.focus();
  await userEvent.setup({ delay: null }).keyboard("{Enter}");
  await expect(
    findAction("button", "Generating PDF…"),
  ).resolves.toHaveAccessibleName("Generating PDF…");
  naming.resolve("Launch-plan");
  const link = await downloadLink();
  expect(link).toHaveFocus();
  expect(link.download).toBe("Launch-plan.pdf");
  const url = link.href;
  link.click();
  link.click();
  expect(
    browser.downloads.map((file) => {
      return [file.url, file.filename];
    }),
  ).toStrictEqual([
    [url, "Launch-plan.pdf"],
    [url, "Launch-plan.pdf"],
  ]);
  const [first, second] = browser.downloads;
  const firstBytes = new Uint8Array(await first!.blob!.arrayBuffer());
  expect(firstBytes).toStrictEqual(
    new Uint8Array(await second!.blob!.arrayBuffer()),
  );
  expect((await readSavedPdf(first!.blob!))[0]!.text).toContain(
    "Field launch checklist",
  );
  click(await findAction("link", "Artifacts"));
  await waitFor(() => {
    return expect(browser.revokedUrls).toContain(url);
  });
  expect(location.pathname).toBe("/artifacts");
  expect(browser.blobForUrl(url)).toBeNull();
});
test("chat-message-pdf-002 an empty naming response preserves the exported message under the default name", async () => {
  const { link, pages } = await exportMessage(
    "Final dispatch to the northern camp",
    "",
  );
  expect(link.download).toBe("okou-message.pdf");
  expect(pages[0]!.text).toContain("Final dispatch to the northern camp");
});
test("chat-message-pdf-008 the exported font faces preserve Chinese emphasis and literal unmatched markers", async () => {
  const { pages } = await exportMessage(
    "Ordinary text. **重点** and *说明* then ***中文***.\n\nUnpaired **marker",
  );
  const items = pages.flatMap((page) => {
    return page.items;
  });
  for (const [word, style] of [
    ["Ordinary text.", "Regular"],
    ["重点", "Bold"],
    ["说明", "Italic"],
    ["中文", "BoldItalic"],
  ] as const) {
    expect(
      items.find((item) => {
        return item.text.includes(word);
      })?.font,
    ).toMatch(new RegExp(style + "$"));
  }
  expect(pages[0]!.text).toContain("**marker");
  expect(pages[0]!.text.replace("**marker", "")).not.toContain("*");
});
test("chat-message-pdf-009 prose around whitespace-only emphasis survives export", async () => {
  const { pages } = await exportMessage("Before **  ** Between *   * After");
  expect(pages[0]!.text).toMatch(/Before.*Between.*After/u);
});
test("chat-message-pdf-010 long cells and merged headers preserve text within both page margins", async () => {
  const { pages } = await exportMessage(
    "| Region | Notes | Boundary |\n|---|---|---|\n| North | " +
      "Trade winds and tidal records ".repeat(18) +
      ' | RIGHTEDGE |\n\n<table><tr><th colspan="2">Merged group</th><th>Last column</th></tr><tr><td colspan="2">Combined observations</td><td>Final note</td></tr></table>',
  );
  const text = pages
    .map((page) => {
      return page.text;
    })
    .join(" ");
  for (const word of [
    "RIGHTEDGE",
    "Last column",
    "Merged group",
    "Combined observations",
    "Final note",
  ]) {
    expect(text).toContain(word);
  }
  for (const page of pages) {
    for (const item of page.items) {
      expect(item.x).toBeGreaterThanOrEqual(47);
      expect(item.x + item.width).toBeLessThanOrEqual(page.width - 47);
    }
  }
});
test("chat-message-pdf-012 one tall row spans pages without losing or duplicating any line", async () => {
  const lines = Array.from({ length: 75 }, (_, i) => {
    return "Marker" + String(i + 1).padStart(2, "0");
  });
  const { pages } = await exportMessage(
    "<table><tr><th>Observations</th></tr><tr><td>" +
      lines.join("<br>") +
      "</td></tr></table>\n\nEnd of survey",
  );
  expect(pages.length).toBeGreaterThan(1);
  expect(
    pages.flatMap((page) => {
      return page.text.match(/Marker\d\d/gu) ?? [];
    }),
  ).toStrictEqual(lines);
  expect(pages.at(-1)!.text).toContain("End of survey");
});
test("chat-message-pdf-013 short rows keep their identifiers, descriptions, details and statuses together", async () => {
  const rows = Array.from({ length: 42 }, (_, i) => {
    return String(i + 1).padStart(2, "0");
  });
  const body = [
    "| ID | Description | Detail | Status |",
    "|---|---|---|---|",
    ...rows.map((n) => {
      return "| Field" + n + " | 中文说明 | Detail" + n + " | Open" + n + " |";
    }),
  ].join("\n");
  const { pages } = await exportMessage(body);
  expect(pages.length).toBeGreaterThan(1);
  for (const n of rows) {
    const containing = pages.filter((page) => {
      return page.text.includes("Field" + n);
    });
    expect(containing).toHaveLength(1);
    const text = containing[0]!.text;
    expect(text).toContain("中文说明");
    expect(text).toContain("Detail" + n);
    expect(text).toContain("Open" + n);
  }
});
