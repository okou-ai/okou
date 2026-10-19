import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
export function RemoteTailscaleCredentialHelp() {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 text-sm">
      <p className="text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.oauthHelp;
        })}
      </p>
      <a
        href="https://console.tailscale.com/admin/settings/trust-credentials"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-2 rounded-md p-1 text-link underline underline-offset-4 hover:text-link-hover"
      >
        {t(($) => {
          return $.remoteControlSetup.openOAuth;
        })}
        <ExternalLink size={14} aria-hidden />
      </a>
    </div>
  );
}
