import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";
import { convert } from "html-to-text";

// Brand artwork used by the published Okou Welcome and paid onboarding
// templates in Resend (day-0-welcome / okou-paid-onboarding-session-1).
const OKOU_EMAIL_BANNER_URL =
  "https://clever-flame-3d70727f81.media.strapiapp.com/okou_onboarding_banner_2x_6b7c3904fd.png";

interface CreditLowBalanceEmailProps {
  readonly title: string;
  readonly orgName: string;
  readonly remainingCredits: number;
  readonly thresholdCredits: number;
  readonly billingUrl: string;
  readonly websiteUrl: string;
  readonly unsubscribeUrl?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderCreditLowBalanceEmail(
  props: CreditLowBalanceEmailProps,
): { readonly html: string; readonly text: string } {
  const title = escapeHtml(props.title);
  const orgName = escapeHtml(props.orgName);
  const remainingCredits = escapeHtml(
    props.remainingCredits.toLocaleString("en-US"),
  );
  const thresholdCredits = escapeHtml(
    props.thresholdCredits.toLocaleString("en-US"),
  );
  const brandName = escapeHtml(PUBLIC_BRAND_PRESENTATION.brandName);
  const supportEmail = escapeHtml(PUBLIC_BRAND_PRESENTATION.supportEmail);
  const unsubscribe = props.unsubscribeUrl
    ? `<p style="margin:14px 0 0;font-size:12px;line-height:19px"><a href="${escapeHtml(props.unsubscribeUrl)}" style="color:#8C8685;text-decoration:underline">Unsubscribe</a></p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${title}</title>
    <style>
      @media only screen and (max-width:640px) {
        .credit-shell { padding-left:20px !important; padding-right:20px !important; }
        .credit-title { font-size:30px !important; line-height:36px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:#FFFFFF;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
    <div class="email-preheader" style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;mso-hide:all">${orgName} has ${remainingCredits} credits remaining.</div>
    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" style="width:100%;border-collapse:collapse;background-color:#FFFFFF">
      <tr>
        <td class="credit-shell" align="center" style="padding:24px 16px 48px">
          <!--[if mso]><table role="presentation" width="600" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
          <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;table-layout:fixed;border-collapse:collapse;text-align:left;color:#242121;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;overflow-wrap:anywhere;word-break:break-word">
            <tr>
              <td style="padding:0 0 37px;font-size:0;line-height:0">
                <img src="${OKOU_EMAIL_BANNER_URL}" width="600" height="225" alt="${brandName}" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;border-radius:18px;color:#242121;font-size:24px;line-height:30px;-ms-interpolation-mode:bicubic">
              </td>
            </tr>
            <tr>
              <td style="padding:0">
                <h1 class="credit-title" style="margin:0 0 20px;font-size:38px;line-height:46px;font-weight:700;letter-spacing:-0.8px">${title}</h1>
                <p style="margin:0 0 14px"><strong>${orgName}</strong> has <strong>${remainingCredits} credits</strong> remaining.</p>
                <p style="margin:0 0 28px">Review your balance and billing options to keep your work moving.</p>
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:0 0 28px">
                  <tr>
                    <td align="center" bgcolor="#3363D3" style="background-color:#3363D3;border-radius:19px;mso-padding-alt:11px 40px">
                      <a href="${escapeHtml(props.billingUrl)}" style="display:inline-block;padding:11px 40px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;line-height:16px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:19px">Manage billing</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 24px;color:#8C8685;font-size:13px;line-height:20px">This reminder is sent when your workspace reaches ${thresholdCredits} credits or less.</p>
                <p style="margin:0 0 32px;font-weight:600">The ${brandName} Team</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 0 0;border-top:1px solid #D8CBC4;color:#8C8685;font-size:12px;line-height:19px">
                <p style="margin:0 0 14px;font-size:13px;line-height:20px"><a href="${escapeHtml(props.websiteUrl)}" style="color:#242121;text-decoration:none;font-weight:600">Web</a><span style="color:#A9A3A2"> &middot; </span><a href="mailto:${supportEmail}" style="color:#242121;text-decoration:none;font-weight:600">Contact support</a></p>
                <p style="margin:0 0 4px">${brandName} &middot; Get the right data, run agentic workflows, and deliver finished work with team-wide context.</p>
                ${unsubscribe}
              </td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    html,
    text: convert(html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: ".email-preheader", format: "skip" },
        { selector: "h1", options: { uppercase: false } },
      ],
    }).trim(),
  };
}
