import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";

import {
  escapeHtml,
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
export const MORNING_BRIEF_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS = 180;
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

const BODY_WRAP_STYLE =
  "margin:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word";
const FOOTER_LINK_STYLE = "color:#171717;text-decoration:underline";
const MORNING_BRIEF_HERO_URL = "https://a.okou.io/vfv041yxil.png";

function morningBriefResultEmailHtml(
  props: MorningBriefResultEmailRenderProps,
  resultBodyHtml: string,
  unsubscribeUrl: string,
): string {
  const assistantName = escapeHtml(PUBLIC_BRAND_PRESENTATION.assistantName);
  const footer = `Sent by ${assistantName} Morning Brief &middot; <a href="${escapeHtml(
    props.manageUrl,
  )}" style="${FOOTER_LINK_STYLE}">Manage</a> &middot; <a href="${escapeHtml(
    unsubscribeUrl,
  )}" style="${FOOTER_LINK_STYLE}">Unsubscribe</a>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeHtml(props.title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#ffffff;color:#171717;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;border-collapse:collapse;background-color:#ffffff">
      <tr>
        <td align="center" style="padding:24px 20px 48px">
          <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;text-align:left">
            <tr>
              <td style="padding:0 0 36px">
                <img src="${MORNING_BRIEF_HERO_URL}" width="600" alt="Wake up to what matters. Your morning brief is ready." style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;color:#171717;font-size:24px;font-weight:700;line-height:1.3">
              </td>
            </tr>
            <tr>
              <td style="padding:0">
                <div style="${BODY_WRAP_STYLE}">${resultBodyHtml}</div>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:24px 0 36px">
                  <tr>
                    <td align="center" bgcolor="#3462da" style="background-color:#3462da;border-radius:999px;mso-padding-alt:12px 32px">
                      <a href="${escapeHtml(props.threadUrl)}" style="display:inline-block;padding:12px 32px;border-radius:999px;color:#ffffff;font-size:13px;font-weight:700;line-height:16px;text-decoration:none">Open in ${assistantName} &rarr;</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 0 0;border-top:1px solid #dbcdc6;color:#8c9094;font-size:12px;line-height:1.6">${footer}</td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>`;
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
