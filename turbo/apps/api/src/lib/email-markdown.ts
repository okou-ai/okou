import { convert } from "html-to-text";
import { decodeHTML, escapeUTF8 as escapeHtml } from "entities";
import { Marked } from "marked";

import { safeUrlParse } from "../signals/utils";
import { singleton } from "./singleton";

const LINK_STYLE =
  "color:#171717;text-decoration:underline;text-decoration-color:#f5d90a;text-underline-offset:3px";
const PARAGRAPH_STYLE =
  "margin:0 0 20px;overflow-wrap:anywhere;word-break:break-word";
const LIST_STYLE =
  "margin:0 0 24px;padding-left:20px;overflow-wrap:anywhere;word-break:break-word";
const LIST_ITEM_STYLE =
  "margin:0 0 10px;padding-left:0;overflow-wrap:anywhere;word-break:break-word";
const INLINE_CODE_STYLE =
  "padding:1px 4px;border-radius:4px;background-color:#faf5f3;font-family:SFMono-Regular,Consolas,'Liberation Mono',monospace;font-size:0.92em;white-space:normal;overflow-wrap:anywhere;word-break:break-word";
const CODE_BLOCK_STYLE =
  "margin:0 0 24px;padding:12px 14px;border:1px solid #dbcdc6;border-radius:6px;background-color:#faf5f3;font-family:SFMono-Regular,Consolas,'Liberation Mono',monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word";
const TABLE_CELL_STYLE =
  "padding:8px 10px;border:1px solid #dbcdc6;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word";

const HEADING_STYLES: Readonly<Record<string, string>> = {
  h1: "margin:0 0 24px;font-size:24px;line-height:1.3;letter-spacing:-0.025em",
  h2: "margin:28px 0 10px;font-size:16px;line-height:1.5",
  h3: "margin:24px 0 10px;font-size:15px;line-height:1.5",
  h4: "margin:18px 0 8px;font-size:14px;line-height:1.4",
  h5: "margin:16px 0 8px;font-size:13px;line-height:1.45",
  h6: "margin:16px 0 8px;font-size:12px;line-height:1.45",
};

function linkDestinationIsSafe(destination: string): boolean {
  const parsed = safeUrlParse(destination);
  if (!parsed) {
    return false;
  }

  if (parsed.protocol === "https:") {
    return (
      destination.slice(0, "https://".length).toLowerCase() === "https://" &&
      parsed.hostname.length > 0
    );
  }
  if (parsed.protocol === "mailto:") {
    const mailDestination = destination.slice("mailto:".length);
    return !mailDestination.startsWith("//") && parsed.pathname.length > 0;
  }
  return false;
}

const markdown = singleton(() => {
  return new Marked({
    async: false,
    breaks: false,
    gfm: true,
    tokenizer: {
      // Email bodies are Markdown, not authored HTML. Bare URLs stay plain text.
      html() {
        return undefined;
      },
      tag() {
        return undefined;
      },
      url() {
        return undefined;
      },
    },
    renderer: {
      heading({ tokens, depth }) {
        const tag = `h${depth}`;
        const style = HEADING_STYLES[tag] ?? HEADING_STYLES.h6;
        return `<${tag} style="${style}">${this.parser.parseInline(tokens)}</${tag}>\n`;
      },
      paragraph({ tokens }) {
        return `<p style="${PARAGRAPH_STYLE}">${this.parser.parseInline(tokens)}</p>\n`;
      },
      list({ ordered, start, items }) {
        const tag = ordered ? "ol" : "ul";
        const startAttribute =
          ordered && start !== 1 ? ` start="${escapeHtml(String(start))}"` : "";
        const body = items
          .map((item) => {
            return this.listitem(item);
          })
          .join("");
        return `<${tag}${startAttribute} style="${LIST_STYLE}">\n${body}</${tag}>\n`;
      },
      listitem({ tokens }) {
        return `<li style="${LIST_ITEM_STYLE}">${this.parser.parse(tokens)}</li>\n`;
      },
      checkbox({ raw }) {
        return escapeHtml(raw);
      },
      strong({ tokens }) {
        return `<strong style="font-weight:700">${this.parser.parseInline(tokens)}</strong>`;
      },
      em({ tokens }) {
        return `<em style="font-style:italic">${this.parser.parseInline(tokens)}</em>`;
      },
      del({ tokens }) {
        return `<s style="text-decoration:line-through">${this.parser.parseInline(tokens)}</s>`;
      },
      blockquote({ tokens }) {
        return `<blockquote style="margin:0 0 24px;padding:2px 0 2px 14px;border-left:3px solid #dbcdc6;color:#555555;overflow-wrap:anywhere;word-break:break-word">${this.parser.parse(tokens)}</blockquote>\n`;
      },
      codespan({ text }) {
        return `<code style="${INLINE_CODE_STYLE}">${escapeHtml(text)}</code>`;
      },
      code({ text }) {
        return `<pre style="${CODE_BLOCK_STYLE}"><code>${escapeHtml(text)}\n</code></pre>\n`;
      },
      hr() {
        return '<hr style="height:1px;margin:24px 0;border:0;background-color:#dbcdc6">\n';
      },
      table({ header, rows }) {
        const head = this.tablerow({
          text: header
            .map((cell) => {
              return this.tablecell(cell);
            })
            .join(""),
        });
        const body = rows
          .map((cells) => {
            return this.tablerow({
              text: cells
                .map((cell) => {
                  return this.tablecell(cell);
                })
                .join(""),
            });
          })
          .join("");
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse;margin:0 0 16px"><thead style="background-color:#faf5f3">${head}</thead><tbody>${body}</tbody></table>\n`;
      },
      tablecell({ header, tokens }) {
        const tag = header ? "th" : "td";
        const style = `${TABLE_CELL_STYLE}${header ? ";font-weight:700" : ""}`;
        return `<${tag} style="${style}">${this.parser.parseInline(tokens)}</${tag}>\n`;
      },
      link({ href, tokens }) {
        // Marked retains entities in destinations; validate the browser-visible URL.
        const destination = decodeHTML(href);
        const label = this.parser.parseInline(tokens);
        return linkDestinationIsSafe(destination)
          ? `<a href="${escapeHtml(destination)}" style="${LINK_STYLE}">${label}</a>`
          : label;
      },
      image({ tokens }) {
        const label = this.parser.parseInline(tokens, this.parser.textRenderer);
        return escapeHtml(decodeHTML(label));
      },
    },
  });
});

/** Safe email Markdown: HTTPS/mailto links only, images reduced to alt text. */
export function renderEmailMarkdown(source: string): string {
  return markdown().parse(source, { async: false });
}

export function plainTextFromHtml(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [{ selector: "img", format: "skip" }],
  }).trim();
}
