import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button, LoadErrorRow } from "@okouai/ui";
import {
  openRemoteConnectionEditor$,
  type RemoteConnectionEditor,
} from "../../signals/remote-resource-detail.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function RemoteConnectionEditButton({
  resource,
  disabled = false,
}: {
  readonly resource: RemoteConnectionEditor;
  readonly disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [opening, open] = useLoadableSet(openRemoteConnectionEditor$);
  const signal = useGet(pageSignal$);
  return (
    <div className="grid gap-2">
      <Button
        variant={resource.kind === "ssh" ? "outline" : "quiet"}
        disabled={disabled || opening.state === "loading"}
        aria-busy={opening.state === "loading"}
        onClick={() => {
          detach(open(resource, signal), Reason.DomCallback);
        }}
      >
        {opening.state === "loading" && (
          <Loader2 size={16} className="animate-spin" aria-hidden />
        )}
        {t(($) => {
          return $.remoteControlSetup.editConnection;
        })}
      </Button>
      {opening.state === "hasError" && (
        <LoadErrorRow
          message={t(($) => {
            return resource.kind === "ssh"
              ? $.ssh.loadFailed
              : $.vnc.loadFailed;
          })}
        />
      )}
    </div>
  );
}
