import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";

import { renderEmailLayout } from "./email-layout";
import {
  markdownRenderer,
  plainTextFromHtml,
} from "./official-automation-result-email-renderer";

/**
 * Bounds of the native Morning Brief result email.
 *
 * The accepted generation result is capped at 32 KiB of final rendered
 * Markdown, and Chat, plain text, and HTML all have to carry that same body.
 * The legacy Official Automation template stays on its own 8,000 Unicode
 * character and 96 KiB limits, which are unchanged by this template.
 */
export const MORNING_BRIEF_RESULT_EMAIL_BODY_MAX_BYTES = 32 * 1024;
export const MORNING_BRIEF_RESULT_EMAIL_TITLE_MAX_CHARACTERS = 160;
/**
 * HTML ceiling for a fully escaped worst case. A 32 KiB body of `&` expands to
 * 160 KiB of `&amp;` before the surrounding document, so this bound can always
 * carry an accepted result and only rejects genuinely pathological expansion.
 */
const MORNING_BRIEF_RESULT_EMAIL_HTML_MAX_BYTES = 512 * 1024;

interface MorningBriefResultEmailRenderProps {
  readonly title: string;
  readonly resultMarkdown: string;
  readonly threadUrl: string;
  readonly manageUrl: string;
}

interface RenderedMorningBriefResultEmail {
  readonly html: string;
  readonly text: string;
}

/**
 * Raised when the accepted body cannot be carried by this template. Delivery
 * records an explicit failure instead of mailing a shorter brief than the one
 * Chat already shows.
 */
export class MorningBriefResultEmailRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MorningBriefResultEmailRenderError";
  }
}

const MORNING_BRIEF_HERO_URL = "https://a.okou.io/vfv041yxil.png";

function morningBriefResultEmailHtml(
  props: MorningBriefResultEmailRenderProps,
  resultBodyHtml: string,
  unsubscribeUrl: string,
): string {
  const assistantName = PUBLIC_BRAND_PRESENTATION.assistantName;
  return renderEmailLayout({
    title: props.title,
    heroUrl: MORNING_BRIEF_HERO_URL,
    heroAlt: "Wake up to what matters. Your morning brief is ready.",
    bodyHtml: resultBodyHtml,
    action: { label: `Open in ${assistantName}`, url: props.threadUrl },
    footerText: `Sent by ${assistantName} Morning Brief`,
    footerLinks: [
      { label: "Manage", url: props.manageUrl },
      { label: "Unsubscribe", url: unsubscribeUrl },
    ],
  });
}

/**
 * Render the accepted brief for email.
 *
 * The Markdown pipeline, link policy, and plain-text conversion are the shared
 * primitives the Official Automation template already uses, so an unsafe link
 * loses its anchor while keeping its visible label, and raw HTML in the body
 * stays inert. Nothing here summarises, rewrites, or truncates: this template
 * either carries the whole accepted body or fails.
 */
export function renderMorningBriefResultEmail(
  props: MorningBriefResultEmailRenderProps,
  unsubscribeUrl: string,
): RenderedMorningBriefResultEmail {
  const bodyBytes = Buffer.byteLength(props.resultMarkdown, "utf8");
  if (bodyBytes > MORNING_BRIEF_RESULT_EMAIL_BODY_MAX_BYTES) {
    throw new MorningBriefResultEmailRenderError(
      `Morning Brief result body is ${bodyBytes} bytes, above the ${MORNING_BRIEF_RESULT_EMAIL_BODY_MAX_BYTES} byte template bound`,
    );
  }

  const html = morningBriefResultEmailHtml(
    props,
    markdownRenderer.render(props.resultMarkdown),
    unsubscribeUrl,
  );
  const htmlBytes = Buffer.byteLength(html, "utf8");
  if (htmlBytes > MORNING_BRIEF_RESULT_EMAIL_HTML_MAX_BYTES) {
    throw new MorningBriefResultEmailRenderError(
      `Morning Brief result email is ${htmlBytes} bytes of HTML, above the ${MORNING_BRIEF_RESULT_EMAIL_HTML_MAX_BYTES} byte template bound`,
    );
  }

  return { html, text: plainTextFromHtml(html) };
}
