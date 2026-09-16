import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";
import { convert } from "html-to-text";

const OKOU_EMAIL_AVATAR_URL =
  "https://static.okou.io/public/okou-agent-email-avatar-5c997967b68e.png";
const FOOTER_LINK_STYLE = "color:#171717;text-decoration:underline";

interface EmailLink {
  readonly label: string;
  readonly url: string;
}

interface EmailLayoutProps {
  readonly title: string;
  // Callers own escaping dynamic content before inserting trusted body markup.
  readonly bodyHtml: string;
  readonly action: EmailLink;
  readonly footer: {
    readonly text: string;
    readonly links: readonly EmailLink[];
  };
  readonly hero?: {
    readonly url: string;
    readonly alt: string;
  };
}

export function escapeEmailHtml(value: string): string {
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "&": {
        escaped += "&amp;";
        break;
      }
      case "<": {
        escaped += "&lt;";
        break;
      }
      case ">": {
        escaped += "&gt;";
        break;
      }
      case '"': {
        escaped += "&quot;";
        break;
      }
      default: {
        escaped += char;
      }
    }
  }
  return escaped;
}

export function renderEmailLayout(props: EmailLayoutProps): string {
  const brandName = escapeEmailHtml(PUBLIC_BRAND_PRESENTATION.brandName);
  const header = props.hero
    ? `<img src="${escapeEmailHtml(props.hero.url)}" width="600" alt="${escapeEmailHtml(props.hero.alt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;color:#171717;font-size:24px;font-weight:700;line-height:1.3">`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td width="40" height="40" style="width:40px;height:40px;line-height:0"><img src="${OKOU_EMAIL_AVATAR_URL}" width="40" height="40" alt="" role="presentation" style="display:block;width:40px;height:40px;border:0;border-radius:50%;outline:none;text-decoration:none"></td><td valign="middle" style="padding-left:12px;color:#171717;font-size:24px;font-weight:700;line-height:1.3">${brandName}</td></tr></table>`;
  const footer = [
    escapeEmailHtml(props.footer.text),
    ...props.footer.links.map((link) => {
      return `<a href="${escapeEmailHtml(link.url)}" style="${FOOTER_LINK_STYLE}">${escapeEmailHtml(link.label)}</a>`;
    }),
  ].join(" &middot; ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeEmailHtml(props.title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#ffffff;color:#171717;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;border-collapse:collapse;background-color:#ffffff">
      <tr>
        <td align="center" style="padding:24px 20px 48px">
          <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;text-align:left">
            <tr>
              <td style="padding:0 0 36px">${header}</td>
            </tr>
            <tr>
              <td style="padding:0">
                <div style="margin:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word">${props.bodyHtml}</div>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:24px 0 36px">
                  <tr>
                    <td align="center" bgcolor="#3462da" style="background-color:#3462da;border-radius:999px;mso-padding-alt:12px 32px">
                      <a href="${escapeEmailHtml(props.action.url)}" style="display:inline-block;padding:12px 32px;border-radius:999px;color:#ffffff;font-size:13px;font-weight:700;line-height:16px;text-decoration:none">${escapeEmailHtml(props.action.label)} &rarr;</a>
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

export function plainTextFromEmailHtml(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [{ selector: "img", format: "skip" }],
  }).trim();
}
