import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import {
  closeVncDialog$,
  mountVncForm$,
  saveVnc$,
  vncConflict$,
  vncCredentials$,
  vncDialog$,
  vncEditor$,
  vncSaveMessage$,
  vncSaveUncertain$,
  type VncDialogState,
} from "../../signals/vnc.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { localizedVncError } from "../../lib/vnc-error.ts";
import {
  VncCredentialFields,
  VncCredentialImpact,
  VncCredentialSelection,
  VncEndpointFields,
  VncTrustFields,
} from "./vnc-fields.tsx";

function useDialogCopy(kind: VncDialogState["kind"] | undefined) {
  const { t } = useTranslation();
  switch (kind) {
    case "create": {
      return {
        title: t(($) => {
          return $.vnc.add;
        }),
        description: null,
      };
    }
    case "edit": {
      return {
        title: t(($) => {
          return $.vnc.edit;
        }),
        description: t(($) => {
          return $.vnc.editHelp;
        }),
      };
    }
    case "delete": {
      return {
        title: t(($) => {
          return $.vnc.delete;
        }),
        description: t(($) => {
          return $.vnc.deleteHelp;
        }),
      };
    }
    case "create-credential": {
      return {
        title: t(($) => {
          return $.vnc.credential.add;
        }),
        description: null,
      };
    }
    case "edit-credential": {
      return {
        title: t(($) => {
          return $.vnc.credential.edit;
        }),
        description: null,
      };
    }
    case "delete-credential": {
      return {
        title: t(($) => {
          return $.vnc.credential.delete;
        }),
        description: t(($) => {
          return $.vnc.credential.deleteHelp;
        }),
      };
    }
    case undefined: {
      return { title: "", description: null };
    }
  }
}

function VncSaveNotice({ saving }: { readonly saving: boolean }) {
  const { t } = useTranslation();
  const uncertain = useGet(vncSaveUncertain$);
  const message = useGet(vncSaveMessage$);
  const conflict = useGet(vncConflict$);
  if (saving || (!uncertain && !message)) {
    return null;
  }
  return (
    <div role="alert" className="grid gap-2 text-sm text-muted-foreground">
      <p>
        {uncertain
          ? t(($) => {
              return $.vnc.saveRecovery.uncertain;
            })
          : (localizedVncError(message ?? "") ??
            t(($) => {
              return $.vnc.errors.failed;
            }))}
      </p>
      {conflict && (
        <p>
          {t(($) => {
            return $.vnc.saveRecovery.review;
          })}
        </p>
      )}
    </div>
  );
}

function useSaveBlocked(dialog: VncDialogState) {
  const credentials = useLoadable(vncCredentials$);
  const editor = useGet(vncEditor$);
  const conflict = useGet(vncConflict$);
  if (conflict) {
    return true;
  }
  if (dialog.kind === "create" || dialog.kind === "edit") {
    return (
      credentials.state !== "hasData" ||
      credentials.data === null ||
      (editor.selection !== "new" &&
        !credentials.data.some((credential) => {
          return credential.id === editor.selection;
        }))
    );
  }
  return (
    dialog.kind === "delete-credential" &&
    (dialog.credential?.hosts.length ?? 0) > 0
  );
}

function VncFormActions({
  saving,
  blocked,
  destructive,
  title,
}: {
  readonly saving: boolean;
  readonly blocked: boolean;
  readonly destructive: boolean;
  readonly title: string;
}) {
  const { t } = useTranslation();
  const close = useSet(closeVncDialog$);
  const uncertain = useGet(vncSaveUncertain$);
  const conflict = useGet(vncConflict$);
  return (
    <div className="flex shrink-0 justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={saving}
        onClick={() => {
          close();
        }}
      >
        {conflict
          ? t(($) => {
              return $.vnc.close;
            })
          : t(($) => {
              return $.vnc.cancel;
            })}
      </Button>
      <Button
        type="submit"
        variant={destructive ? "destructive" : "default"}
        disabled={saving || conflict || (!uncertain && blocked)}
      >
        {saving
          ? t(($) => {
              return $.vnc.saving;
            })
          : uncertain
            ? t(($) => {
                return $.vnc.retry;
              })
            : destructive
              ? title
              : t(($) => {
                  return $.vnc.save;
                })}
      </Button>
    </div>
  );
}

function VncForm({
  dialog,
  saving,
  save,
}: {
  readonly dialog: VncDialogState;
  readonly saving: boolean;
  readonly save: (form: HTMLFormElement, signal: AbortSignal) => Promise<void>;
}) {
  const uncertain = useGet(vncSaveUncertain$);
  const conflict = useGet(vncConflict$);
  const mount = useSet(mountVncForm$);
  const signal = useGet(pageSignal$);
  const blocked = useSaveBlocked(dialog);
  const { title } = useDialogCopy(dialog.kind);
  const hostEditor = dialog.kind === "create" || dialog.kind === "edit";
  const destructive =
    dialog.kind === "delete" || dialog.kind === "delete-credential";
  const disabled = saving || uncertain || conflict;
  return (
    <form
      ref={mount}
      autoComplete="off"
      aria-busy={saving}
      className="flex min-h-0 min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving && !conflict && (uncertain || !blocked)) {
          detach(save(event.currentTarget, signal), Reason.DomCallback);
        }
      }}
    >
      <DialogBody className="grid gap-4">
        {!destructive && (
          <fieldset disabled={disabled} className="grid min-w-0 gap-5">
            {hostEditor ? (
              <>
                <VncEndpointFields connection={dialog.connection} />
                <VncCredentialSelection disabled={disabled} />
                <VncTrustFields
                  connection={dialog.connection}
                  disabled={disabled}
                />
              </>
            ) : (
              <VncCredentialFields
                credential={dialog.credential}
                disabled={disabled}
              />
            )}
          </fieldset>
        )}
        {destructive && (
          <p className="break-all text-sm font-medium">
            {dialog.connection?.displayName ?? dialog.credential?.name}
          </p>
        )}
        {dialog.credential && (
          <VncCredentialImpact credential={dialog.credential} />
        )}
        <VncSaveNotice saving={saving} />
      </DialogBody>
      <VncFormActions
        saving={saving}
        blocked={blocked}
        destructive={destructive}
        title={title}
      />
    </form>
  );
}

export function VncDialog() {
  const data = useLoadable(vncDialog$);
  const close = useSet(closeVncDialog$);
  const [saving, save] = useLoadableSet(saveVnc$);
  const dialog = data.state === "hasData" ? data.data : null;
  const { title, description } = useDialogCopy(dialog?.kind);
  const busy = saving.state === "loading";
  if (!dialog) {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          close();
        }
      }}
    >
      <DialogContent contentClassName="flex flex-col" key={dialog.creationId}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <VncForm dialog={dialog} saving={busy} save={save} />
      </DialogContent>
    </Dialog>
  );
}
