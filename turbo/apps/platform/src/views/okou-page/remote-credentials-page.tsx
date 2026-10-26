import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Button, SegmentControl, SegmentControlItem } from "@okouai/ui";
import {
  closeRemoteCredentialsPage$,
  remoteControlType$,
  setRemoteControlType$,
} from "../../signals/okou-page/settings/remote-control-directory.ts";
import { mountRemoteControlPanel$ } from "../../signals/remote-management-realtime.ts";
import { RemoteDetailPage } from "./remote-detail-page.tsx";
import { SshCredentials, SshDialog } from "./ssh-management.tsx";
import { VncCredentials } from "./vnc-management.tsx";
import { VncDialog } from "./vnc-dialog.tsx";

export function RemoteCredentialsPage() {
  const { t } = useTranslation();
  const close = useSet(closeRemoteCredentialsPage$);
  const type = useGet(remoteControlType$);
  const setType = useSet(setRemoteControlType$);
  const mount = useSet(mountRemoteControlPanel$);
  const showVnc = type === "vnc";
  const title = t(($) => {
    return $.connectors.catalog.remoteControl.credentials;
  });
  return (
    <RemoteDetailPage title={title} onBack={close}>
      <div ref={mount} className="mx-auto grid w-full max-w-3xl gap-6">
        <Button variant="quiet" className="justify-self-start" onClick={close}>
          <ArrowLeft size={16} aria-hidden />
          {t(($) => {
            return $.remoteControlSetup.backToConnections;
          })}
        </Button>
        <header className="grid gap-2">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.credentialsDescription;
            })}
          </p>
        </header>
        <SegmentControl
          className="justify-self-start"
          value={showVnc ? "vnc" : "ssh"}
          onValueChange={(value) => {
            if (value === "ssh" || value === "vnc") {
              setType(value);
            }
          }}
          aria-label={t(($) => {
            return $.connectors.catalog.remoteControl.type;
          })}
        >
          <SegmentControlItem value="ssh">
            {t(($) => {
              return $.ssh.label;
            })}
          </SegmentControlItem>
          <SegmentControlItem value="vnc">
            {t(($) => {
              return $.vnc.label;
            })}
          </SegmentControlItem>
        </SegmentControl>
        <section
          aria-label={t(($) => {
            return showVnc ? $.vnc.label : $.ssh.label;
          })}
        >
          {showVnc ? <VncCredentials /> : <SshCredentials />}
        </section>
        <SshDialog />
        <VncDialog />
      </div>
    </RemoteDetailPage>
  );
}
