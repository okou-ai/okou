import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { generateMarkdownDocxBlob } from "../markdown-docx.ts";
import type { PdfAssets } from "../message-pdf/types.ts";

function emptyAssets(): PdfAssets {
  return { images: new Map(), diagrams: new Map() };
}

describe("markdown DOCX export", () => {
  it("creates a Word package with headings, emphasis, tables, and safe links", async () => {
    const blob = await generateMarkdownDocxBlob(
      "# Quarterly report\n\n**Gross margin** improved.\n\n[Source](https://example.test/report)\n\n| Quarter | Revenue |\n| --- | ---: |\n| Q1 | $42m |\n",
      emptyAssets(),
      "https://example.test/source.md",
      AbortSignal.any([]),
    );
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const documentXml = new TextDecoder().decode(files["word/document.xml"]);
    const relationshipsXml = new TextDecoder().decode(
      files["word/_rels/document.xml.rels"],
    );

    expect(blob.type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(documentXml).toContain("Quarterly report");
    expect(documentXml).toContain('w:val="Heading1"');
    expect(documentXml).toContain("Gross margin");
    expect(documentXml).toContain("Revenue");
    expect(documentXml).toContain("$42m");
    expect(relationshipsXml).toContain("https://example.test/report");
  });

  it("honors cancellation before creating the document", async () => {
    await expect(
      generateMarkdownDocxBlob(
        "# Canceled",
        emptyAssets(),
        "https://example.test/source.md",
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
