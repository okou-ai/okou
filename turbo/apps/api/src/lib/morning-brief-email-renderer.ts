import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";

import { renderEmailLayout } from "../signals/services/email-layout";
import { safeSync } from "../signals/utils";
import {
  escapeHtml,
  markdownRenderer,
  plainTextFromHtml,
} from "./email-markdown";

const MORNING_BRIEF_EMAIL_HTML_MAX_BYTES = 96 * 1024;
const MORNING_BRIEF_HERO_URL = "https://a.okou.io/vfv041yxil.png";

interface MorningBriefEmailRenderProps {
  readonly title: string;
  readonly resultText: string;
  readonly runUrl: string;
  readonly manageUrl: string;
}

interface RenderedMorningBriefEmail {
  readonly html: string;
  readonly text: string;
}

function morningBriefEmailHtml(
  props: MorningBriefEmailRenderProps,
  resultBodyHtml: string,
  unsubscribeUrl: string,
): string {
  const assistantName = BRAND_PRESENTATION.assistantName;
  return renderEmailLayout({
    title: props.title,
    heroUrl: MORNING_BRIEF_HERO_URL,
    heroAlt: "Wake up to what matters. Your morning brief is ready.",
    bodyHtml: resultBodyHtml,
    action: { label: `Open in ${assistantName}`, url: props.runUrl },
    footerText: `Sent by an ${assistantName} automation`,
    footerLinks: [
      { label: "Manage", url: props.manageUrl },
      { label: "Unsubscribe", url: unsubscribeUrl },
    ],
  });
}

/**
 * Render the Morning Brief presentation shared by Agent notifications and debug
 * emails. Markdown that fails to render or exceeds the size bound falls back to
 * escaped preformatted text.
 */
export function renderMorningBriefEmail(
  props: MorningBriefEmailRenderProps,
  unsubscribeUrl: string,
): RenderedMorningBriefEmail {
  const renderAttempt = safeSync(() => {
    const html = morningBriefEmailHtml(
      props,
      markdownRenderer.render(props.resultText),
      unsubscribeUrl,
    );
    const htmlBytes = Buffer.byteLength(html, "utf8");
    return htmlBytes <= MORNING_BRIEF_EMAIL_HTML_MAX_BYTES
      ? { html, text: plainTextFromHtml(html) }
      : null;
  });

  if ("ok" in renderAttempt && renderAttempt.ok) {
    return renderAttempt.ok;
  }

  const fallbackHtml = morningBriefEmailHtml(
    props,
    `<pre style="margin:0;font-family:inherit;font-size:14px;line-height:1.58;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word">${escapeHtml(
      props.resultText,
    )}</pre>`,
    unsubscribeUrl,
  );
  if (
    Buffer.byteLength(fallbackHtml, "utf8") > MORNING_BRIEF_EMAIL_HTML_MAX_BYTES
  ) {
    throw new Error("Morning Brief email fallback exceeded its size bound");
  }

  return { html: fallbackHtml, text: plainTextFromHtml(fallbackHtml) };
}
