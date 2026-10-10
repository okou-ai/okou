import { describe, expect, it } from "vitest";
import { artifactHtmlMetadata, artifactOgHtml } from "../artifact-og";

const metadata = {
  title: 'Report <draft> & "review"',
  description: "Quarterly results",
  url: "https://demo.okou.app/",
  imageUrl:
    "https://api.okou.ai/api/artifact-og/image?kind=host&id=abc&version=v1",
};

describe("artifact sharing HTML", () => {
  it("ignores inert templates and SVG titles when finding document metadata", () => {
    const html =
      '<html><head><title>Document title</title><template><meta property="og:title" content="Inert"></template></head><body><svg><title>Chart title</title></svg><meta property="og:image" content="https://example.com/body.png"></body></html>';
    expect(artifactHtmlMetadata(html).title).toBe("Document title");
    const result = artifactOgHtml(html, metadata, false);
    expect(result.slice(0, result.indexOf("</head>"))).toContain(
      'property="og:image"',
    );
    expect(result).toContain("<svg><title>Chart title</title></svg>");
  });

  it("ignores body metadata when the optional body tag is omitted", () => {
    const body =
      '<main><meta property="og:title" content="Body title"><meta property="og:image" content="https://example.com/body.png">Report</main>';
    const html = `<html><head><title>Document title</title></head>${body}</html>`;
    expect(artifactHtmlMetadata(html)).toEqual({
      title: "Document title",
      description: "",
    });
    const result = artifactOgHtml(html, metadata, false);
    const head = result.slice(0, result.indexOf("</head>"));
    expect(head).toContain('property="og:title"');
    expect(head).toContain('property="og:image"');
    expect(head).not.toContain("body.png");
    expect(result).toContain(body);
  });
  it("adds metadata to the initial head without rewriting scripts or authored content", () => {
    const script =
      "<script>const sample = \"<meta property='og:image' content='fake'>\";</script>";
    const html = `<html><head><title>Quarterly &amp; Annual</title><meta name="description" content="Public &amp; reviewed">${script}</head><body><main>Report</main></body></html>`;
    expect(artifactHtmlMetadata(html)).toEqual({
      title: "Quarterly & Annual",
      description: "Public & reviewed",
    });
    const result = artifactOgHtml(html, metadata, false);
    expect(result).toContain(script);
    expect(result).toContain("<body><main>Report</main></body>");
    expect(result).toContain(
      'content="Report &lt;draft&gt; &amp; &quot;review&quot;"',
    );
    expect(result.indexOf('property="og:image"')).toBeLessThan(
      result.indexOf("</head>"),
    );
  });

  it("preserves authored OG and replaces invalid image URLs without duplicate defaults", () => {
    const html =
      '<head><meta property="og:title" content="Author title"><meta property="og:image" content="https://images.example/cover.png"><meta property="og:image" content="http://localhost:3000/duplicate.png"><meta name="twitter:image" content="http://localhost:3000/a.png"></head>';
    const result = artifactOgHtml(html, metadata, false);
    expect(result).toContain('property="og:title" content="Author title"');
    expect(result).toContain(
      'property="og:image" content="https://images.example/cover.png"',
    );
    expect(result.match(/property="og:image"/gu)).toHaveLength(1);
    expect(result).not.toContain("localhost");
    expect(result).toContain(
      'name="twitter:image" content="https://images.example/cover.png"',
    );
    expect(artifactOgHtml(result, metadata, false)).toBe(result);
  });

  it("discards dimensions and alternate URLs that describe a replaced image", () => {
    const html =
      '<head><meta property="og:image" content="/local-cover.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:type" content="image/jpeg"><meta property="og:image:secure_url" content="https://example.com/old.jpg"></head>';
    const result = artifactOgHtml(html, metadata, false);
    expect(result).not.toContain("og:image:width");
    expect(result).not.toContain("og:image:height");
    expect(result).not.toContain("og:image:type");
    expect(result).not.toContain("old.jpg");
    expect(result).toContain('property="og:image"');
  });

  it.each([
    "<!doctype html><html><body>Report</body></html>",
    "<main>Report</main>",
  ])("creates a head when the author omitted it", (html) => {
    const result = artifactOgHtml(html, metadata, false);
    expect(result).toContain("<head>");
    expect(result.indexOf("<head>")).toBeLessThan(result.indexOf("Report</"));
    if (html.startsWith("<!doctype"))
      expect(result).toMatch(/^<!doctype html><html><head>/u);
  });

  it.each([true, false])(
    "replaces sharing metadata without changing the authored document (explicit head=%s)",
    (explicitHead) => {
      const documentMetadata =
        '<title>Authored report</title><meta name="description" content="Authored summary"><link rel="canonical" href="https://reports.example/report">';
      const executable =
        '<style>body { color: blue }</style><script>const title = "Authored report";</script>';
      const head =
        documentMetadata +
        executable +
        '<meta property="og:title" content="Authored sharing"><meta property="og:site_name" content="Authored site"><meta property="og:image" content="https://images.example/cover.png"><meta property="og:image:width" content="1200"><meta property="og:image:secure_url" content="https://images.example/secure.png"><meta name="twitter:creator" content="@author"><meta name="twitter:image" content="https://images.example/twitter.png">';
      const body = '<body><img src="cover.png">Report</body>';
      const html = `<!doctype html><html>${explicitHead ? `<head>${head}</head>` : head}${body}</html>`;
      const result = artifactOgHtml(html, metadata, "social");
      expect(result).toContain(documentMetadata);
      expect(result).toContain(executable);
      expect(result).toContain(body);
      expect(result).not.toContain("Authored sharing");
      expect(result).not.toContain("Authored site");
      expect(result).not.toContain("images.example");
      expect(result).not.toContain("og:image:width");
      expect(result).not.toContain("@author");
      expect(result).toContain(
        'property="og:title" content="Report &lt;draft&gt; &amp; &quot;review&quot;"',
      );
      expect(result).toContain(
        `name="twitter:image" content="${metadata.imageUrl.replaceAll("&", "&amp;")}"`,
      );
      expect(result.match(/<title>/gu)).toHaveLength(1);
      expect(result.match(/name="description"/gu)).toHaveLength(1);
      expect(result.match(/rel="canonical"/gu)).toHaveLength(1);
      expect(result.match(/property="og:image"/gu)).toHaveLength(1);
      expect(artifactOgHtml(result, metadata, "social")).toBe(result);
    },
  );

  it("removes all marketing metadata from the artifact shell and safely escapes public text", () => {
    const html =
      '<html><head><title>Marketing</title><meta name="description" content="Marketing copy"><meta property="og:site_name" content="Marketing"><meta property="og:image" content="https://example.com/ad.png"><meta name="twitter:creator" content="@marketing"><link rel="canonical" href="https://example.com"></head><body><script src="/app.js"></script></body></html>';
    const result = artifactOgHtml(html, metadata, true);
    expect(result).not.toContain("Marketing");
    expect(result).not.toContain("@marketing");
    expect(result).not.toContain("ad.png");
    expect(result).toContain('<script src="/app.js"></script>');
    expect(result).toContain(
      "<title>Report &lt;draft&gt; &amp; &quot;review&quot;</title>",
    );
    expect(result.match(/property="og:image"/gu)).toHaveLength(1);
  });

  it("replaces document metadata when the optional head tags are omitted", () => {
    const html =
      '<!doctype html><html><title>Marketing</title><meta name="description" content="Marketing copy"><body>Report</body></html>';
    const result = artifactOgHtml(html, metadata, true);
    expect(result).toMatch(/^<!doctype html><html><head>/u);
    expect(result).not.toContain("Marketing");
    expect(result).toContain("<body>Report</body>");
    expect(result.match(/<title>/gu)).toHaveLength(1);
    expect(artifactHtmlMetadata(result)).toEqual({
      title: metadata.title,
      description: metadata.description,
    });
  });

  it("keeps tag and attribute injection attempts as metadata text", () => {
    const malicious = {
      ...metadata,
      title: '</title><script>alert("title")</script>',
      description: '"><img src=x onerror=alert(1)> & &#34;',
    };
    const result = artifactOgHtml(
      "<html><head></head><body>Report</body></html>",
      malicious,
      true,
    );
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("<img");
    expect(artifactHtmlMetadata(result)).toEqual({
      title: malicious.title,
      description: malicious.description,
    });
  });
});
