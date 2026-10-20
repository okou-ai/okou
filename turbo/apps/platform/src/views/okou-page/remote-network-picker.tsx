import { Cloud, Network, ChevronRight } from "lucide-react";
import { RemoteEditorFrame } from "./remote-editor-frame.tsx";
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
export function NetworkProviderPicker({
  inline = false,
}: { readonly inline?: boolean } = {}) {
  const { t } = useTranslation();
  const open = useGet(remoteNetworkPicker$);
  const setOpen = useSet(setRemoteNetworkPicker$);
  const tailscale = useGet(tailscaleSettingsEnabled$);
  const [choosing, choose] = useLoadableSet(chooseRemoteNetworkProvider$);
  const signal = useGet(pageSignal$);
  const choices = (
    <div className="grid gap-3">
      {tailscale && (
        <Button
          variant="outline"
          className="h-auto min-h-16 justify-start gap-4 whitespace-normal rounded-xl border-divider p-4 text-left"
          disabled={choosing.state === "loading"}
          onClick={(event) => {
            const tags =
              event.currentTarget
                .closest("main")
                ?.querySelector<HTMLInputElement>('input[name="tailscaleTags"]')
                ?.value ?? "tag:okou";
            detach(choose("tailscale", tags, signal), Reason.DomCallback);
          }}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-50">
            <Network size={20} aria-hidden />
          </span>
          <span className="grid flex-1 gap-1">
            <span>
              {t(($) => {
                return $.tailscale.title;
              })}
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              {t(($) => {
                return $.remoteControlSetup.networkTailscaleHelp;
              })}
            </span>
          </span>
          <ChevronRight size={16} aria-hidden />
        </Button>
      )}
      <Button
        variant="outline"
        className="h-auto min-h-16 justify-start gap-4 whitespace-normal rounded-xl border-divider p-4 text-left"
        disabled={choosing.state === "loading"}
        onClick={() => {
          detach(choose("cloudflare_access", "", signal), Reason.DomCallback);
        }}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-50">
          <Cloud size={20} aria-hidden />
        </span>
        <span className="grid flex-1 gap-1">
          <span>
            {t(($) => {
              return $.cloudflareAccess.title;
            })}
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.networkCloudflareHelp;
            })}
          </span>
        </span>
        <ChevronRight size={16} aria-hidden />
      </Button>
      {choosing.state === "hasError" && (
        <p role="alert">
          {t(($) => {
            return $.remoteControlSetup.failedLoad;
          })}
        </p>
      )}
    </div>
  );
  if (inline) {
    return (
      <RemoteEditorFrame
        inline
        title={t(($) => {
          return $.remoteControlSetup.addNetworkInline;
        })}
        description={t(($) => {
          return $.remoteControlSetup.networkProviderHelp;
        })}
        busy={choosing.state === "loading"}
        onClose={() => {
          setOpen(false);
        }}
      >
        {choices}
      </RemoteEditorFrame>
    );
  }
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
        {choices}
      </DialogContent>
    </Dialog>
  );
}
