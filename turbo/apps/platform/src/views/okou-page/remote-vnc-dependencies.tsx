import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { vncEditor$, requiresVncProtectiveRoute } from "../../signals/vnc.ts";

export function RemoteVncProtectionNotice() {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  if (
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
