import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";
import { convert } from "html-to-text";
import { escapeHtml } from "markdown-it/lib/common/utils.mjs";

import { renderEmailLayout } from "./email-layout";

// The existing Okou onboarding banner contains no Morning Brief-specific copy.
const OKOU_EMAIL_BANNER_URL =
  "https://clever-flame-3d70727f81.media.strapiapp.com/okou_onboarding_banner_2x_6b7c3904fd.png";
const TITLE = "Your data export is ready";

interface DataExportReadyEmailProps {
  readonly downloadUrl: string;
  readonly expiresAt: string;
}

export function renderDataExportReadyEmail(props: DataExportReadyEmailProps): {
  readonly html: string;
  readonly text: string;
} {
  const html = renderEmailLayout({
    title: TITLE,
    heroUrl: OKOU_EMAIL_BANNER_URL,
    heroAlt: PUBLIC_BRAND_PRESENTATION.brandName,
    bodyHtml: `<h1 style="margin:0 0 24px;font-size:24px;line-height:1.3;letter-spacing:-0.025em">${TITLE}</h1>
<p style="margin:0 0 20px">Your requested data export has been completed and is ready to download.</p>
<p style="margin:0 0 20px">This download is available until <strong>${escapeHtml(props.expiresAt)}</strong>.</p>
<p style="margin:0">If the link expires, request a new export from your account settings.</p>`,
    action: { label: "Download data", url: props.downloadUrl },
    footerText: `Sent by ${PUBLIC_BRAND_PRESENTATION.assistantName}`,
    footerLinks: [
      {
        label: "Contact support",
        url: `mailto:${PUBLIC_BRAND_PRESENTATION.supportEmail}`,
      },
    ],
  });

  return {
    html,
    text: convert(html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "h1", options: { uppercase: false } },
      ],
    }).trim(),
  };
}
