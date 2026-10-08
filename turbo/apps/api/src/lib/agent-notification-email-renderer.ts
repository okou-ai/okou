import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { escapeHtml } from "markdown-it/lib/common/utils.mjs";
import { renderEmailLayout } from "../signals/services/email-layout";
import {
  markdownRenderer,
  plainTextFromHtml,
} from "../signals/services/official-automation-result-email-renderer";

export function renderAgentNotificationEmail(
  props: {
    readonly subject: string;
    readonly text: string;
    readonly runUrl: string;
  },
  unsubscribeUrl: string,
) {
  const layout = (bodyHtml: string) => {
    return renderEmailLayout({
      title: props.subject,
      bodyHtml,
      action: {
        label: `Open in ${BRAND_PRESENTATION.assistantName}`,
        url: props.runUrl,
      },
      footerText: `Sent by your ${BRAND_PRESENTATION.assistantName} agent`,
      footerLinks: [{ label: "Unsubscribe", url: unsubscribeUrl }],
    });
  };
  let html = layout(markdownRenderer.render(props.text));
  if (Buffer.byteLength(html, "utf8") > 96 * 1024) {
    html = layout(
      `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit">${escapeHtml(props.text)}</pre>`,
    );
  }
  return { html, text: plainTextFromHtml(html) };
}
