import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import type { DocumentExportRequest } from "../../../lib/message-pdf/types.ts";
import { platformMessagePdfFontUrls } from "../../../lib/static-assets.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
  mockAttachmentChat,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";
import { pdfServices, readSavedPdf } from "./message-export-boundaries.ts";

const context = testContext();
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000951";
const FILENAME = "summary.md";
const SOURCE_URL = publicArtifactUrl(FILENAME);
const EXPORTS = [
  {
    format: "pdf",
    label: "PDF",
    contentType: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.7\n%%EOF"),
  },
  {
    format: "docx",
    label: "DOCX",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: new Uint8Array([80, 75, 3, 4, 0, 1, 127, 128, 255]),
  },
] as const;

async function openExportMenu(
  tier: "limited-free-1" | "pro",
  url = SOURCE_URL,
  source = "# Summary report\n\nThe launch plan is ready.",
): Promise<HTMLElement> {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier,
      ...billingPlanCapabilities(tier),
      onboardingPaymentPending: false,
    });
  });
  context.mocks.http.get(SOURCE_URL, () => {
    return HttpResponse.text(source, {
      headers: { "Content-Type": "text/markdown" },
    });
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "markdown-export-message",
        role: "assistant",
        content: `[Report](${url})`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "markdown-export-event",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
    artifacts: [
      artifactFile(FILENAME, {
        id: ARTIFACT_ID,
        url,
        contentType: "text/markdown",
      }),
    ],
  });

  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.FreePlanArtifactPaywall]: true,
      [FeatureSwitchKey.MarkdownFirstOutput]: true,
    },
  });
  click(await findNamedLink("Report"));
  const preview = await screen.findByTestId("artifact-sidebar");
  await within(preview).findByRole("heading", {
    level: 1,
    name: "Summary report",
  });
  click(await findNamedButton("Download artifact", preview));
  return screen.findByRole("menu");
}

test.each(EXPORTS)(
  "Free-plan Markdown $label exports show Pro and open plans without downloading",
  async ({ label }) => {
    const browser = context.mocks.browser.blobDownload();
    const menu = await openExportMenu("limited-free-1");
    const item = await findNamedMenuItem(`Download as ${label}`, menu);
    await expect(within(item).findByText("Pro")).resolves.toBeInTheDocument();

    click(item);

    await expect(
      screen.findByRole("dialog", { name: "Choose a plan" }),
    ).resolves.toBeInTheDocument();
    expect(browser.downloads).toStrictEqual([]);
  },
);

test.each(EXPORTS)(
  "Server-denied Markdown $label exports open plans even with local Pro billing",
  async ({ label }) => {
    const url = artifactReferencePath(ARTIFACT_ID, FILENAME);
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(200, {
        url: SOURCE_URL,
        downloadUrl: `https://api.okou.ai/api/artifact-references/${ARTIFACT_ID.replaceAll("-", "")}/download`,
        downloadAllowed: false,
        expiresAt: "2099-01-01T00:00:00Z",
        filename: FILENAME,
        contentType: "text/markdown",
        target: { kind: "file", id: ARTIFACT_ID },
      });
    });
    const browser = context.mocks.browser.blobDownload();
    const menu = await openExportMenu("pro", url);

    click(await findNamedMenuItem(`Download as ${label}`, menu));

    await expect(
      screen.findByRole("dialog", { name: "Choose a plan" }),
    ).resolves.toBeInTheDocument();
    expect(browser.downloads).toStrictEqual([]);
  },
);

test.each([
  {
    name: "dollar-delimited display formulas",
    source: String.raw`$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$`,
    centered: true,
    inset: 0,
  },
  {
    name: "bracket-delimited display matrices",
    source: String.raw`\[
\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}
\]`,
    centered: true,
    inset: 0,
  },
  {
    name: "display formulas inside blockquotes",
    source: "> $$\n> x = 1\n> $$",
    centered: true,
    inset: 18,
  },
  {
    name: "inline formulas at the paragraph start",
    source: String.raw`\(x + 1\) stays at the paragraph start.`,
    centered: false,
    inset: 0,
  },
])(
  "Markdown artifact PDF exports position $name within their container",
  async ({ source, centered, inset }) => {
    const browser = pdfServices(context, "summary");
    const menu = await openExportMenu(
      "pro",
      SOURCE_URL,
      `# Summary report\n\n${source}`,
    );
    click(await findNamedMenuItem("Download as PDF", menu));
    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    const download = browser.downloads[0];
    if (!download?.blob) {
      throw new Error("Expected a downloaded PDF");
    }
    const pages = await readSavedPdf(download.blob);
    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    const { left, right } = page.vectorBounds;
    expect(right).toBeGreaterThan(left);
    const actualPosition = centered ? (left + right) / 2 : left;
    const expectedPosition = centered ? (page.width + inset) / 2 : 48;
    expect(Math.abs(actualPosition - expectedPosition)).toBeLessThan(1);
  },
);

test("Markdown artifact PDF exports preserve Unicode subscripts and superscripts", async () => {
  const browser = pdfServices(context, "summary");
  const menu = await openExportMenu(
    "pro",
    SOURCE_URL,
    "# Summary report\n\nF + CHD₃ → HF + CD₃\n\nν₁ = 1; mol⁻¹",
  );
  click(await findNamedMenuItem("Download as PDF", menu));
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  const download = browser.downloads[0];
  expect(download?.filename).toBe("summary.pdf");
  if (!download?.blob) {
    throw new Error("Expected a downloaded PDF");
  }
  const pages = await readSavedPdf(download.blob);
  const text = pages
    .map((page) => {
      return page.text;
    })
    .join("")
    .replace(/\s/gu, "");
  expect(text).toContain("F+CHD₃→HF+CD₃");
  expect(text).toContain("ν₁=1;mol⁻¹");
});

test.each(EXPORTS)(
  "Pro Markdown $label exports download the expected filename and worker bytes",
  async ({ format, label, contentType, bytes }) => {
    for (const url of [
      platformMessagePdfFontUrls.regular,
      platformMessagePdfFontUrls.bold,
    ]) {
      context.mocks.http.get(url, () => {
        return HttpResponse.arrayBuffer(new ArrayBuffer(8));
      });
    }
    context.mocks.browser.dedicatedWorker((message) => {
      const request = message as DocumentExportRequest;
      const output = "kind" in request ? EXPORTS[1] : EXPORTS[0];
      return Promise.resolve({
        ok: true,
        blob: new Blob([output.bytes], { type: output.contentType }),
      });
    });
    const browser = context.mocks.browser.blobDownload({ deferRead: true });
    const menu = await openExportMenu("pro");

    click(await findNamedMenuItem(`Download as ${label}`, menu));

    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    const [download] = browser.downloads;
    expect(download?.filename).toBe(`summary.${format}`);
    const blob = download?.blob;
    if (!blob) {
      throw new Error("Expected a downloaded document blob");
    }
    expect(blob.type).toBe(contentType);
    expect(new Uint8Array(await blob.arrayBuffer())).toStrictEqual(bytes);
  },
);
