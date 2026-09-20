import { escapeHtml } from "markdown-it/lib/common/utils.mjs";

interface EmailLayoutLink {
  readonly label: string;
  readonly url: string;
}

interface EmailLayoutProps {
  readonly title: string;
  readonly heroUrl: string;
  readonly heroAlt: string;
  readonly bodyHtml: string;
  readonly action: EmailLayoutLink;
  readonly footerText: string;
  readonly footerLinks: readonly EmailLayoutLink[];
}

/** Shared Morning Brief layout; callers provide escaped or sanitized body HTML. */
export function renderEmailLayout(props: EmailLayoutProps): string {
  const footer = [
    escapeHtml(props.footerText),
    ...props.footerLinks.map((link) => {
      return `<a href="${escapeHtml(link.url)}" style="color:#171717;text-decoration:underline">${escapeHtml(link.label)}</a>`;
    }),
  ].join(" &middot; ");

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
                <img src="${escapeHtml(props.heroUrl)}" width="600" alt="${escapeHtml(props.heroAlt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;color:#171717;font-size:24px;font-weight:700;line-height:1.3">
              </td>
            </tr>
            <tr>
              <td style="padding:0">
                <div style="margin:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word">${props.bodyHtml}</div>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:24px 0 36px">
                  <tr>
                    <td align="center" bgcolor="#3462da" style="background-color:#3462da;border-radius:999px;mso-padding-alt:12px 32px">
                      <a href="${escapeHtml(props.action.url)}" style="display:inline-block;padding:12px 32px;border-radius:999px;color:#ffffff;font-size:13px;font-weight:700;line-height:16px;text-decoration:none">${escapeHtml(props.action.label)} &rarr;</a>
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
