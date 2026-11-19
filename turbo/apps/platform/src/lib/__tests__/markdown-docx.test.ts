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
    expect(documentXml).toContain('w:orient="portrait"');
    expect(documentXml).toContain("Revenue");
    expect(documentXml).toContain("$42m");
    expect(relationshipsXml).toContain("https://example.test/report");
    const stylesXml = new TextDecoder().decode(files["word/styles.xml"]);
    const colors = [...stylesXml.matchAll(/<w:color w:val="([^"]+)"/gu)].map(
      (match) => {
        return match[1];
      },
    );
    expect(new Set(colors)).toStrictEqual(new Set(["000000"]));
    expect(documentXml).toContain('<w:rStyle w:val="Hyperlink"/>');
    expect(documentXml).toContain('w:color="000000"');
  });

  it("fits wide CJK tables to a landscape page with content-sized columns", async () => {
    const headings = [
      "品种",
      "分组 · 原产地",
      "肩高",
      "体重",
      "寿命",
      "被毛",
      "掉毛",
      "美容",
      "运动",
      "吠叫",
      "新手友好",
    ];
    const values = [
      "示例犬",
      "伴侣犬（长名称示例）· 德国 / 波兰",
      "18–24",
      "1.4–3.2",
      "12–16",
      "双层长毛",
      "中",
      "专业美容",
      "中",
      "极多",
      "进阶",
    ];
    const source = [
      headings,
      headings.map(() => {
        return "---";
      }),
      values,
    ]
      .map((cells) => {
        return `| ${cells.join(" | ")} |`;
      })
      .join("\n");
    const blob = await generateMarkdownDocxBlob(
      source,
      emptyAssets(),
      "https://example.test/source.md",
      AbortSignal.any([]),
    );
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const xml = new TextDecoder().decode(files["word/document.xml"]);
    const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/gu)].map(
      (match) => {
        return Number(match[1]);
      },
    );

    expect(xml).toContain('w:orient="landscape"');
    expect(xml).toContain("<w:tblHeader/>");
    expect(xml).toContain("<w:cantSplit/>");
    expect(widths).toHaveLength(headings.length);
    expect(widths[1]).toBeGreaterThan(widths[0]);
    expect(
      widths.reduce((total, width) => {
        return total + width;
      }, 0),
    ).toBe(15_038);
  });

  it("preserves independent list start values and Word line breaks", async () => {
    const blob = await generateMarkdownDocxBlob(
      "1. Alpha\n2. Beta\n\nContinue\n\n3. Gamma\n4. Delta\n\nFirst  \nSecond\n\n```text\nLine 1\nLine 2\n```",
      emptyAssets(),
      "https://example.test/source.md",
      AbortSignal.any([]),
    );
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const decoder = new TextDecoder();
    const documentXml = decoder.decode(files["word/document.xml"]);
    const numberingXml = decoder.decode(files["word/numbering.xml"]);
    const listIds = [
      ...documentXml.matchAll(/<w:numId w:val="(\d+)"\/>/gu),
    ].map((match) => {
      return match[1];
    });

    expect(listIds).toHaveLength(4);
    expect(listIds[0]).toBe(listIds[1]);
    expect(listIds[2]).toBe(listIds[3]);
    expect(listIds[0]).not.toBe(listIds[2]);
    expect(numberingXml).toContain('<w:startOverride w:val="3"/>');
    expect(documentXml.match(/<w:br\/>/gu)).toHaveLength(2);
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
