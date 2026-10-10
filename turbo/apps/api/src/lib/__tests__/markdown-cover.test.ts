import { expect, test } from "vitest";
import { isMarkdownCoverSource, markdownCoverHtml } from "../markdown-cover";

test("renders real Markdown headings, tables, code and CJK without active content", () => {
  const html = markdownCoverHtml(
    `# Quarterly review 季度回顾\n\n**Revenue** increased.\n\n| Market | Result |\n| --- | --- |\n| China | 42 |\n\n\`\`\`ts\nconst revenue = 42;\n\`\`\`\n\n<span onmouseover="bad()">Raw HTML</span>\n\n![Chart](https://untrusted.example/image.png)\n\n[Details](https://untrusted.example/)`,
  );
  expect(html).toContain("<h1>Quarterly review 季度回顾</h1>");
  expect(html).toContain("<table>");
  expect(html).toContain("<strong>Revenue</strong>");
  expect(html).toContain('<code class="language-ts">');
  expect(html).toContain("&lt;span onmouseover=");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("https://untrusted.example");
  expect(html).toContain("script-src 'none'");
  expect(html).toContain('data-markdown-cover="markdown-cover-v1"');
});

test.each([
  ["report.md", "text/markdown", true],
  ["report.MARKDOWN", "text/plain; charset=utf-8", true],
  ["report.md", "application/octet-stream", true],
  ["report.md", "text/html", false],
  ["report.pdf", "application/pdf", false],
  ["report.xlsx", "application/octet-stream", false],
])(
  "qualifies %s with %s without admitting other formats",
  (filename, contentType, expected) => {
    expect(isMarkdownCoverSource({ filename, contentType })).toBe(expected);
  },
);
