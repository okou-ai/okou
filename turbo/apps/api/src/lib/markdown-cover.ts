import { escapeHtml } from "markdown-it/lib/common/utils.mjs";
import { createSafeMarkdownRenderer } from "./safe-markdown";

export const MARKDOWN_COVER_RENDERER = "markdown-cover-v1";
export const MARKDOWN_COVER_MAX_BYTES = 256 * 1024;
export const MARKDOWN_COVER_VIEWPORT = {
  width: 1200,
  height: 630,
  deviceScaleFactor: 1,
} as const;

export function isMarkdownCoverSource(file: {
  readonly filename: string;
  readonly contentType: string;
}): boolean {
  return (
    /\.(?:md|markdown)$/iu.test(file.filename) &&
    [
      "text/markdown",
      "text/x-markdown",
      "text/plain",
      "application/octet-stream",
    ].includes(file.contentType.split(";")[0]!.trim().toLowerCase())
  );
}

/** Render content only: no uploaded HTML, navigation, scripts or network assets. */
export function markdownCoverHtml(source: string): string {
  const markdown = createSafeMarkdownRenderer();
  markdown.renderer.rules.image = (tokens, index) => {
    return `<span>${escapeHtml(tokens[index]!.content)}</span>`;
  };
  markdown.renderer.rules.link_open = () => {
    return "";
  };
  markdown.renderer.rules.link_close = () => {
    return "";
  };
  const content = markdown.render(source);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><title>Markdown preview</title><style>
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#fff;color:#171717}body{padding:48px 56px;font:24px/1.45 system-ui,"Noto Sans CJK SC",sans-serif;overflow-wrap:anywhere}main{height:534px;overflow:hidden}h1,h2,h3,h4,h5,h6{line-height:1.2;margin:0 0 20px;font-weight:700}h1{font-size:46px}h2{font-size:34px}h3{font-size:28px}p,ul,ol,blockquote,pre,table{margin:0 0 20px}li{margin:4px 0}blockquote{border-left:4px solid #d4d4d4;padding-left:20px;color:#525252}pre,code{font-family:ui-monospace,monospace;font-size:20px;background:#f5f5f5}pre{padding:16px;white-space:pre-wrap;overflow:hidden;border-radius:8px}code{padding:2px 4px}pre code{padding:0}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:22px}th,td{border:1px solid #d4d4d4;padding:10px 14px;text-align:left}th{background:#f5f5f5}hr{border:0;border-top:1px solid #d4d4d4}
</style></head><body><main data-markdown-cover="${MARKDOWN_COVER_RENDERER}">${content}</main></body></html>`;
}
