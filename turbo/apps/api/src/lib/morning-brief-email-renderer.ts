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

interface MorningBriefEmailFallback {
  readonly reason: "render-error" | "size-limit";
  readonly attemptedHtmlBytes: number | null;
  readonly fallbackHtmlBytes: number;
}

interface RenderedMorningBriefEmail {
  readonly html: string;
  readonly text: string;
  readonly fallback: MorningBriefEmailFallback | null;
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
 * Render the Morning Brief presentation shared by Agent notifications, debug
 * emails and legacy completion outbox entries.
 */
export function renderMorningBriefEmail(
  props: MorningBriefEmailRenderProps,
  unsubscribeUrl: string,
): RenderedMorningBriefEmail {
  let attemptedHtmlBytes: number | null = null;
  let fallbackReason: MorningBriefEmailFallback["reason"] = "render-error";

  const renderAttempt = safeSync(() => {
    const html = morningBriefEmailHtml(
      props,
      markdownRenderer.render(props.resultText),
      unsubscribeUrl,
    );
    const htmlBytes = Buffer.byteLength(html, "utf8");
    if (htmlBytes <= MORNING_BRIEF_EMAIL_HTML_MAX_BYTES) {
      return {
        kind: "rendered" as const,
        html,
        text: plainTextFromHtml(html),
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

  const fallbackHtml = morningBriefEmailHtml(
    props,
    `<pre style="margin:0;font-family:inherit;font-size:14px;line-height:1.58;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word">${escapeHtml(
      props.resultText,
    )}</pre>`,
    unsubscribeUrl,
  );
  const fallbackHtmlBytes = Buffer.byteLength(fallbackHtml, "utf8");
  if (fallbackHtmlBytes > MORNING_BRIEF_EMAIL_HTML_MAX_BYTES) {
    throw new Error("Morning Brief email fallback exceeded its size bound");
  }

  return {
    html: fallbackHtml,
    text: plainTextFromHtml(fallbackHtml),
    fallback: {
      reason: fallbackReason,
      attemptedHtmlBytes,
      fallbackHtmlBytes,
    },
  };
}
