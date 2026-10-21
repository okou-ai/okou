import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";
import { vncEditor$, requiresVncProtectiveRoute } from "../../signals/vnc.ts";

export function RemoteVncProtectionNotice() {
  const { t } = useTranslation();
  const enabled = useGet(remoteControlGuidedEnabled$);
  const editor = useGet(vncEditor$);
  if (
    !enabled ||
    editor.transport !== "ssh" ||
    !requiresVncProtectiveRoute(editor.profile)
  ) {
    return null;
  }
  return (
    <p className="text-sm text-muted-foreground">
      {t(($) => {
        return $.remoteControlSetup.sshDependency;
      })}
    </p>
  );
}
