import MarkdownIt from "markdown-it";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";

import { safeSync, safeUrlParse } from "../utils";
import {
  escapeEmailHtml as escapeHtml,
  plainTextFromEmailHtml,
  renderEmailLayout,
} from "./email-layout";

const OFFICIAL_AUTOMATION_RESULT_EMAIL_HTML_MAX_BYTES = 96 * 1024;
const MORNING_BRIEF_HERO_URL = "https://a.okou.io/vfv041yxil.png";

const SAFE_LINK_INFO = "official-email-safe-link";
const UNSAFE_LINK_INFO = "official-email-unsafe-link";
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

interface OfficialAutomationResultEmailRenderProps {
  readonly title: string;
  readonly resultText: string;
  readonly runUrl: string;
  readonly manageUrl: string;
}

interface OfficialAutomationResultEmailFallback {
  readonly reason: "render-error" | "size-limit";
  readonly attemptedHtmlBytes: number | null;
  readonly fallbackHtmlBytes: number;
}

interface RenderedOfficialAutomationResultEmail {
  readonly html: string;
  readonly text: string;
  readonly fallback: OfficialAutomationResultEmailFallback | null;
}

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

function createMarkdownRenderer(): MarkdownIt {
  const markdown = new MarkdownIt({
    html: false,
    breaks: false,
    linkify: false,
    typographer: false,
  });

  // Link destinations have already been entity-decoded and normalized when
  // validateLink runs. Retain every parsed link token here so the renderer can
  // remove only an unsafe anchor while preserving its visible label.
  markdown.validateLink = () => {
    return true;
  };
  markdown.core.ruler.after("inline", "official_email_link_policy", (state) => {
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || blockToken.children === null) {
        continue;
      }
      const safeLinkStack: boolean[] = [];
      for (const token of blockToken.children) {
        if (token.type === "link_open") {
          const safe = linkDestinationIsSafe(token.attrGet("href") ?? "");
          safeLinkStack.push(safe);
          token.info = safe ? SAFE_LINK_INFO : UNSAFE_LINK_INFO;
        } else if (token.type === "link_close") {
          token.info = safeLinkStack.pop() ? SAFE_LINK_INFO : UNSAFE_LINK_INFO;
        }
      }
    }
  });

  markdown.renderer.rules.heading_open = (tokens, index) => {
    const token = tokens[index]!;
    const style = HEADING_STYLES[token.tag] ?? HEADING_STYLES.h6;
    return `<${token.tag} style="${style}">`;
  };
  markdown.renderer.rules.paragraph_open = () => {
    return `<p style="${PARAGRAPH_STYLE}">`;
  };
  markdown.renderer.rules.bullet_list_open = () => {
    return `<ul style="${LIST_STYLE}">`;
  };
  markdown.renderer.rules.ordered_list_open = (tokens, index) => {
    const start = tokens[index]!.attrGet("start");
    const startAttribute = start ? ` start="${escapeHtml(start)}"` : "";
    return `<ol${startAttribute} style="${LIST_STYLE}">`;
  };
  markdown.renderer.rules.list_item_open = () => {
    return `<li style="${LIST_ITEM_STYLE}">`;
  };
  markdown.renderer.rules.strong_open = () => {
    return '<strong style="font-weight:700">';
  };
  markdown.renderer.rules.em_open = () => {
    return '<em style="font-style:italic">';
  };
  markdown.renderer.rules.s_open = () => {
    return '<s style="text-decoration:line-through">';
  };
  markdown.renderer.rules.blockquote_open = () => {
    return '<blockquote style="margin:0 0 24px;padding:2px 0 2px 14px;border-left:3px solid #dbcdc6;color:#555555;overflow-wrap:anywhere;word-break:break-word">';
  };
  markdown.renderer.rules.code_inline = (tokens, index) => {
    return `<code style="${INLINE_CODE_STYLE}">${escapeHtml(tokens[index]!.content)}</code>`;
  };
  const renderCodeBlock = (
    tokens: Parameters<NonNullable<typeof markdown.renderer.rules.fence>>[0],
    index: number,
  ): string => {
    return `<pre style="${CODE_BLOCK_STYLE}"><code>${escapeHtml(tokens[index]!.content)}</code></pre>\n`;
  };
  markdown.renderer.rules.fence = renderCodeBlock;
  markdown.renderer.rules.code_block = renderCodeBlock;
  markdown.renderer.rules.hr = () => {
    return '<hr style="height:1px;margin:24px 0;border:0;background-color:#dbcdc6">\n';
  };
  markdown.renderer.rules.table_open = () => {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse;margin:0 0 16px">';
  };
  markdown.renderer.rules.thead_open = () => {
    return '<thead style="background-color:#faf5f3">';
  };
  markdown.renderer.rules.th_open = () => {
    return `<th style="${TABLE_CELL_STYLE};font-weight:700">`;
  };
  markdown.renderer.rules.td_open = () => {
    return `<td style="${TABLE_CELL_STYLE}">`;
  };
  markdown.renderer.rules.link_open = (tokens, index) => {
    const token = tokens[index]!;
    if (token.info !== SAFE_LINK_INFO) {
      return "";
    }
    return `<a href="${escapeHtml(token.attrGet("href") ?? "")}" style="${LINK_STYLE}">`;
  };
  markdown.renderer.rules.link_close = (tokens, index) => {
    return tokens[index]!.info === SAFE_LINK_INFO ? "</a>" : "";
  };
  markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const children = tokens[index]!.children ?? [];
    return escapeHtml(renderer.renderInlineAsText(children, options, env));
  };

  return markdown;
}

const markdownRenderer = createMarkdownRenderer();

function officialAutomationResultEmailHtml(
  props: OfficialAutomationResultEmailRenderProps,
  resultBodyHtml: string,
  unsubscribeUrl: string,
): string {
  const assistantName = PUBLIC_BRAND_PRESENTATION.assistantName;
  return renderEmailLayout({
    title: props.title,
    bodyHtml: resultBodyHtml,
    hero: {
      url: MORNING_BRIEF_HERO_URL,
      alt: "Wake up to what matters. Your morning brief is ready.",
    },
    action: { label: `Open in ${assistantName}`, url: props.runUrl },
    footer: {
      text: `Sent by an ${assistantName} automation`,
      links: [
        { label: "Manage", url: props.manageUrl },
        { label: "Unsubscribe", url: unsubscribeUrl },
      ],
    },
  });
}

export function renderOfficialAutomationResultEmail(
  props: OfficialAutomationResultEmailRenderProps,
  unsubscribeUrl: string,
): RenderedOfficialAutomationResultEmail {
  let attemptedHtmlBytes: number | null = null;
  let fallbackReason: OfficialAutomationResultEmailFallback["reason"] =
    "render-error";

  const renderAttempt = safeSync(() => {
    const html = officialAutomationResultEmailHtml(
      props,
      markdownRenderer.render(props.resultText),
      unsubscribeUrl,
    );
    const htmlBytes = Buffer.byteLength(html, "utf8");
    if (htmlBytes <= OFFICIAL_AUTOMATION_RESULT_EMAIL_HTML_MAX_BYTES) {
      return {
        kind: "rendered" as const,
        html,
        text: plainTextFromEmailHtml(html),
      };
    }
    return { kind: "size-limit" as const, attemptedHtmlBytes: htmlBytes };
  });

  if ("ok" in renderAttempt) {
    if (renderAttempt.ok.kind === "rendered") {
      return {
        html: renderAttempt.ok.html,
        text: renderAttempt.ok.text,
        fallback: null,
      };
    }
    attemptedHtmlBytes = renderAttempt.ok.attemptedHtmlBytes;
    fallbackReason = "size-limit";
  }

  const fallbackHtml = officialAutomationResultEmailHtml(
    props,
    `<pre style="margin:0;font-family:inherit;font-size:14px;line-height:1.58;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word">${escapeHtml(
      props.resultText,
    )}</pre>`,
    unsubscribeUrl,
  );
  const fallbackHtmlBytes = Buffer.byteLength(fallbackHtml, "utf8");
  if (fallbackHtmlBytes > OFFICIAL_AUTOMATION_RESULT_EMAIL_HTML_MAX_BYTES) {
    throw new Error(
      "Official Automation result email fallback exceeded its size bound",
    );
  }

  return {
    html: fallbackHtml,
    text: plainTextFromEmailHtml(fallbackHtml),
    fallback: {
      reason: fallbackReason,
      attemptedHtmlBytes,
      fallbackHtmlBytes,
    },
  };
}
