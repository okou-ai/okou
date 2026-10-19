import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import {
  remoteControlGuidedEnabled$,
  setRemoteNetworkPicker$,
} from "../../signals/remote-control-setup.ts";
import { openSshDialog$ } from "../../signals/ssh.ts";
import { vncEditor$, requiresVncProtectiveRoute } from "../../signals/vnc.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function RemoteVncDependencies({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const enabled = useGet(remoteControlGuidedEnabled$);
  const editor = useGet(vncEditor$);
  const [opening, open] = useLoadableSet(openSshDialog$);
  const network = useSet(setRemoteNetworkPicker$);
  const signal = useGet(pageSignal$);
  if (!enabled) {
    return null;
  }
  const protective = requiresVncProtectiveRoute(editor.profile);
  return (
    <div className="grid gap-3">
      {protective && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.sshDependency;
          })}
        </p>
      )}
      {editor.transport === "ssh" && (
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          disabled={disabled || opening.state === "loading"}
          onClick={() => {
            detach(open("create", null, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.remoteControlSetup.addSsh;
          })}
        </Button>
      )}
      {(editor.transport === "tailscale" ||
        editor.transport === "cloudflare_access" ||
        editor.kdcTransport === "tailscale" ||
        editor.kdcTransport === "cloudflare_access") && (
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          disabled={disabled}
          onClick={() => {
            network(true);
          }}
        >
          {t(($) => {
            return $.remoteControlSetup.addNetworkInline;
          })}
        </Button>
      )}
      {opening.state === "hasError" && (
        <p role="alert">
          {t(($) => {
            return $.remoteControlSetup.failedLoad;
          })}
        </p>
      )}
    </div>
  );
}
