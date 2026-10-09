import { describe, expect, it } from "vitest";
import { artifactOgHtml, normalizeArtifactImageUrls } from "../artifact-og";

const pageUrl = "https://demo.okou.app/reports/quarterly.html";

describe("authored social image URLs", () => {
  it.each([
    ["cover.png", "https://demo.okou.app/reports/cover.png"],
    ["../cover.png", "https://demo.okou.app/cover.png"],
    ["/assets/cover.png", "https://demo.okou.app/assets/cover.png"],
    ["//cdn.example.com/cover.png", "https://cdn.example.com/cover.png"],
  ])("resolves %s against the delivered document URL", (source, absolute) => {
    const html = `<head><meta property="og:image" content="${source}"></head>`;
    expect(normalizeArtifactImageUrls(html, pageUrl)).toBe(
      `<head><meta property="og:image" content="${absolute}"></head>`,
    );
  });

  it("honors the first base href, including one declared after the images", () => {
    const html =
      '<head><meta property="og:image" content="cover.png"><base href="../assets/"><base href="https://ignored.example/"></head>';
    expect(normalizeArtifactImageUrls(html, pageUrl)).toContain(
      'content="https://demo.okou.app/assets/cover.png"',
    );
  });

  it("uses the document URL for an invalid first base and does not select a later base", () => {
    const html =
      '<head><base href="https://["><base href="https://ignored.example/"><meta property="og:image" content="cover.png"></head>';
    expect(normalizeArtifactImageUrls(html, pageUrl)).toContain(
      'content="https://demo.okou.app/reports/cover.png"',
    );
  });

  it("preserves multiple image groups, dimensions, attributes, and body/script bytes", () => {
    const head = `<head><meta data-note="content='unchanged'" PROPERTY='og:image' CONTENT = 'one.png?x=1&amp;y=2'><meta property="og:image:width" content="1200"><meta property="og:image:secure_url" content=/two.png><meta property="og:image" content="three.png"><meta property="og:image:height" content="630"><meta name="twitter:image" content='four.png'></head>`;
    const body = `<body><img src="one.png"><meta property="og:image" content="body.png"><script>const example = '<meta property="og:image" content="script.png">';</script></body>`;
    const result = normalizeArtifactImageUrls(head + body, pageUrl);
    expect(result).toContain(
      `data-note="content='unchanged'" PROPERTY='og:image' content="https://demo.okou.app/reports/one.png?x=1&amp;y=2"`,
    );
    expect(result).toContain(
      'property="og:image:secure_url" content="https://demo.okou.app/two.png"',
    );
    expect(result).toContain(
      'property="og:image" content="https://demo.okou.app/reports/three.png"',
    );
    expect(result).toContain(
      'name="twitter:image" content="https://demo.okou.app/reports/four.png"',
    );
    expect(result).toContain('property="og:image:width" content="1200"');
    expect(result).toContain('property="og:image:height" content="630"');
    expect(result.slice(result.indexOf("<body>"))).toBe(body);
    expect(normalizeArtifactImageUrls(result, pageUrl)).toBe(result);
  });

  it("ignores inert markup and body metadata when the body tag is omitted", () => {
    const html =
      '<head><template><base href="https://ignored.example/"><meta property="og:image" content="inert.png"></template><svg><meta property="og:image" content="svg.png"></meta></svg><meta property="og:image" content="cover.png"></head><main><meta property="og:image" content="body.png"></main>';
    expect(normalizeArtifactImageUrls(html, pageUrl)).toBe(
      html.replace(
        'content="cover.png"',
        'content="https://demo.okou.app/reports/cover.png"',
      ),
    );
  });

  it.each([
    "",
    "https://cdn.example/cover.png",
    "http://cdn.example/cover.png",
    "data:image/png;base64,abc",
    "javascript:alert(1)",
    "blob:https://demo.okou.app/id",
    "https://[",
    "//localhost/cover.png",
    "//user:password@cdn.example/cover.png",
  ])("does not guess or replace %s", (value) => {
    const html = `<head><meta property="og:image" content="${value}"></head>`;
    expect(normalizeArtifactImageUrls(html, pageUrl)).toBe(html);
  });

  it("retains the author's image and dimensions when platform defaults are added", () => {
    const html =
      '<head><meta property="og:image" content="cover.png"><meta property="og:image:width" content="1200"></head>';
    const result = artifactOgHtml(
      normalizeArtifactImageUrls(html, pageUrl),
      {
        title: "Report",
        description: "Summary",
        url: pageUrl,
        imageUrl: "https://api.okou.ai/platform-cover.png",
      },
      false,
    );
    expect(result).toContain(
      'property="og:image" content="https://demo.okou.app/reports/cover.png"',
    );
    expect(result).toContain(
      'name="twitter:image" content="https://demo.okou.app/reports/cover.png"',
    );
    expect(result).toContain('property="og:image:width" content="1200"');
    expect(result).not.toContain("platform-cover.png");
  });
});
