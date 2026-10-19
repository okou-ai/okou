import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import {
  remoteNetworkPicker$,
  setRemoteNetworkPicker$,
  chooseRemoteNetworkProvider$,
} from "../../signals/remote-control-setup.ts";
import { tailscaleSettingsEnabled$ } from "../../signals/tailscale.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
export function NetworkProviderPicker() {
  const { t } = useTranslation();
  const open = useGet(remoteNetworkPicker$);
  const setOpen = useSet(setRemoteNetworkPicker$);
  const tailscale = useGet(tailscaleSettingsEnabled$);
  const [choosing, choose] = useLoadableSet(chooseRemoteNetworkProvider$);
  const signal = useGet(pageSignal$);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.remoteControlSetup.networkProvider;
            })}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {tailscale && (
            <Button
              variant="outline"
              disabled={choosing.state === "loading"}
              onClick={() => {
                detach(choose("tailscale", signal), Reason.DomCallback);
              }}
            >
              Tailscale
            </Button>
          )}
          <Button
            variant="outline"
            disabled={choosing.state === "loading"}
            onClick={() => {
              detach(choose("cloudflare_access", signal), Reason.DomCallback);
            }}
          >
            Cloudflare Access
          </Button>
          {choosing.state === "hasError" && (
            <p role="alert">
              {t(($) => {
                return $.remoteControlSetup.failedLoad;
              })}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
