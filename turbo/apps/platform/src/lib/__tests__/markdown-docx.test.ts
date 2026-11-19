import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { renderMarkdownDocx } from "../markdown-docx/render.ts";
import type { PdfAssets } from "../message-pdf/types.ts";

function emptyAssets(): PdfAssets {
  return { images: new Map(), diagrams: new Map() };
}

function render(source: string): Promise<Blob> {
  return renderMarkdownDocx({
    source,
    assets: emptyAssets(),
    baseUrl: "https://example.test/source.md",
  });
}

describe("markdown DOCX export", () => {
  it("creates a Word package with headings, emphasis, tables, and safe links", async () => {
    const blob = await render(
      "# Quarterly report\n\n**Gross margin** improved.\n\n[Source](https://example.test/report)\n\n| Quarter | Revenue |\n| --- | ---: |\n| Q1 | $42m |\n",
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
    const emphasizedRun = [
      ...documentXml.matchAll(/<w:r>([\s\S]*?)<\/w:r>/gu),
    ].find(([, run]) => {
      return run?.includes(">Gross margin<");
    });
    expect(emphasizedRun?.[1]).toMatch(/<w:b(?:\s[^>]*)?\s*\/>/u);
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
    expect(documentXml).toMatch(/<w:rStyle w:val="Hyperlink"\s*\/>/u);
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
    const blob = await render(source);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const xml = new TextDecoder().decode(files["word/document.xml"]);
    const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\s*\/>/gu)].map(
      (match) => {
        return Number(match[1]);
      },
    );

    expect(xml).toContain('w:orient="landscape"');
    expect(xml).toMatch(/<w:tblHeader(?:\s[^>]*)?\/>/u);
    expect(xml).toContain("<w:cantSplit/>");
    expect(widths).toHaveLength(headings.length);
    expect(widths[1]).toBeGreaterThan(widths[0]);
    expect(
      widths.reduce((total, width) => {
        return total + width;
      }, 0),
    ).toBe(15_038);
  });

  it("exports native bookmarks, footnotes, equations, and task states", async () => {
    const blob = await render(String.raw`# Methods

[Back to methods](#methods)

Sample note.[^note]

Inline \(x = 2\).

$$
y = \frac{1}{2}
$$

- [x] Complete
- [ ] Waiting

[^note]: Method details remain readable.
`);
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const decoder = new TextDecoder();
    const xml = decoder.decode(archive["word/document.xml"]);

    expect(xml).toContain('w:anchor="methods"');
    expect(xml).toContain('w:name="methods"');
    expect(xml).toContain("<w:footnoteReference ");
    expect(decoder.decode(archive["word/footnotes.xml"])).toContain("Method");
    expect(xml.match(/<m:oMath>/gu)).toHaveLength(2);
    const numbering = decoder.decode(archive["word/numbering.xml"]);
    expect(numbering).toContain("☒");
    expect(numbering).toContain("☐");
  });
});
