import { RemoteVncDependencies } from "./remote-vnc-dependencies.tsx";
import {
  remoteSetup$,
  updateRemoteSetup$,
  type RemoteVncStep,
} from "../../signals/remote-control-setup.ts";
import {
  RemoteEditorFrame,
  REMOTE_PAGE_ACTION,
} from "./remote-editor-frame.tsx";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { KerberosConnectionFields } from "./vnc-kerberos-fields.tsx";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { Button, DialogBody } from "@okouai/ui";
import {
  closeVncDialog$,
  mountVncForm$,
  saveVnc$,
  vncConflict$,
  vncCredentials$,
  vncDialog$,
  vncEditor$,
  vncProfile$,
  vncCredentialMatchesProfile,
  isVncReviewableConflict,
  vncSaveMessage$,
  vncSaveUncertain$,
  type VncDialogState,
} from "../../signals/vnc.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { localizedVncError } from "../../lib/vnc-error.ts";
import { sshConnections$ } from "../../signals/ssh.ts";
import { cloudflareAccessConfigs$ } from "../../signals/cloudflare-access.ts";
import { scopedTailscaleConfigs$ } from "../../signals/tailscale.ts";
import { isVncKerberosMethod } from "@okouai/api-contracts/contracts/vnc-kerberos";
import { VncConflictReview } from "./vnc-conflict-review.tsx";
import {
  VncCredentialFields,
  VncCredentialImpact,
  VncCredentialSelection,
  VncDisplayNameField,
  VncEndpointFields,
  VncSecurityProfileField,
  VncTlsFields,
  VncTransportFields,
  isPrivateVncLiteral,
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

function VncSaveNotice({
  saving,
  dialog,
}: {
  readonly saving: boolean;
  readonly dialog: VncDialogState;
}) {
  const { t } = useTranslation();
  const uncertain = useGet(vncSaveUncertain$);
  const message = useGet(vncSaveMessage$);
  const conflict = useGet(vncConflict$);
  const reviewable = isVncReviewableConflict(dialog, message);
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
      {conflict && !reviewable && (
        <p>
          {t(($) => {
            return $.vnc.saveRecovery.review;
          })}
        </p>
      )}
    </div>
  );
}

function useNativeVncNetworkBlocked() {
  const access = useLoadable(cloudflareAccessConfigs$);
  const tailscale = useLoadable(scopedTailscaleConfigs$);
  const editor = useGet(vncEditor$);
  const networkUnavailable = (type: string, id: string) => {
    if (type !== "cloudflare_access" && type !== "tailscale") {
      return false;
    }
    const configs = type === "cloudflare_access" ? access : tailscale;
    return (
      configs.state !== "hasData" ||
      !configs.data?.some((config) => {
        return config.id === id;
      })
    );
  };
  const onlineKdc =
    isVncKerberosMethod(editor.profile) &&
    editor.profile !== "qemu_kerberos_ticket";
  return (
    networkUnavailable(editor.transport, editor.networkConfigId) ||
    (onlineKdc &&
      (networkUnavailable(editor.kdcTransport, editor.kdcNetworkConfigId) ||
        (editor.kdcTransport === "direct" &&
          isPrivateVncLiteral(editor.kdcHost))))
  );
}

function useVncRouteBlocked() {
  const sshConnections = useLoadable(sshConnections$);
  const editor = useGet(vncEditor$);
  const nativeBlocked = useNativeVncNetworkBlocked();
  const sshUnavailable = (id: string) => {
    return (
      sshConnections.state !== "hasData" ||
      sshConnections.data === null ||
      !sshConnections.data.some((connection) => {
        return connection.id === id;
      })
    );
  };
  const transportBlocked =
    editor.transport === "ssh" && sshUnavailable(editor.sshConnectionId);
  const kdcBlocked =
    isVncKerberosMethod(editor.profile) &&
    editor.profile !== "qemu_kerberos_ticket" &&
    editor.kdcTransport === "ssh" &&
    sshUnavailable(editor.kdcSshConnectionId);
  const destinationBlocked =
    editor.transport === "direct" &&
    isPrivateVncLiteral(editor.destinationHost);
  return transportBlocked || kdcBlocked || nativeBlocked || destinationBlocked;
}

function useSaveBlocked(dialog: VncDialogState) {
  const credentials = useLoadable(vncCredentials$);
  const editor = useGet(vncEditor$);
  const routeBlocked = useVncRouteBlocked();
  const conflict = useGet(vncConflict$);
  if (conflict) {
    return true;
  }
  if (dialog.kind === "create" || dialog.kind === "edit") {
    const credentialBlocked =
      editor.profile !== "x509_none" &&
      (credentials.state !== "hasData" ||
        credentials.data === null ||
        (editor.selection !== "new" &&
          !credentials.data.some((credential) => {
            return (
              credential.id === editor.selection &&
              vncCredentialMatchesProfile(credential, editor.profile)
            );
          })));
    return credentialBlocked || routeBlocked;
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
  inline,
  onCancel,
}: {
  readonly saving: boolean;
  readonly blocked: boolean;
  readonly destructive: boolean;
  readonly title: string;
  readonly inline?: boolean;
  readonly onCancel?: () => void;
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
          (onCancel ?? close)();
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
        className={inline && !destructive ? REMOTE_PAGE_ACTION : undefined}
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

interface VncFormProps {
  readonly dialog: VncDialogState;
  readonly saving: boolean;
  readonly save: (form: HTMLFormElement, signal: AbortSignal) => Promise<void>;
  readonly inline?: boolean;
  readonly onCancel?: () => void;
}

const VNC_NEXT_STEP: Readonly<
  Record<Exclude<RemoteVncStep, "trust">, RemoteVncStep>
> = {
  profile: "connection",
  connection: "login",
  login: "trust",
};

function VncGuidedActions({
  saving,
  blocked,
  onCancel,
}: {
  readonly saving: boolean;
  readonly blocked: boolean;
  readonly onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  const update = useSet(updateRemoteSetup$);
  const routeBlocked = useVncRouteBlocked();
  if (!setup) {
    return null;
  }
  const step = setup.vncStep;
  if (step === "trust") {
    return (
      <VncFormActions
        saving={saving}
        blocked={blocked}
        destructive={false}
        title=""
        inline
        onCancel={onCancel}
      />
    );
  }
  return (
    <div className="flex justify-end border-t border-divider pt-5">
      <Button
        type="button"
        className={REMOTE_PAGE_ACTION}
        disabled={saving || (step === "connection" && routeBlocked)}
        onClick={(event) => {
          const section = event.currentTarget.form?.querySelector(
            `[data-remote-vnc-step="${step}"]`,
          );
          if (!section) {
            return;
          }
          for (const input of section.querySelectorAll(
            "input, textarea, select",
          )) {
            if (
              (input instanceof HTMLInputElement ||
                input instanceof HTMLTextAreaElement ||
                input instanceof HTMLSelectElement) &&
              !input.reportValidity()
            ) {
              return;
            }
          }
          update({ vncStep: VNC_NEXT_STEP[step] });
        }}
      >
        {t(($) => {
          return $.remoteControlSetup.next;
        })}
      </Button>
    </div>
  );
}

function VncFormBoundary({
  dialog,
  saving,
  save,
  children,
  inline,
  onCancel,
}: VncFormProps & { readonly children: ReactNode }) {
  const uncertain = useGet(vncSaveUncertain$);
  const conflict = useGet(vncConflict$);
  const mount = useSet(mountVncForm$);
  const signal = useGet(pageSignal$);
  const blocked = useSaveBlocked(dialog);
  const { title } = useDialogCopy(dialog.kind);
  const destructive =
    dialog.kind === "delete" || dialog.kind === "delete-credential";
  const setup = useGet(remoteSetup$);
  const update = useSet(updateRemoteSetup$);
  const guided =
    inline && dialog.kind === "create" && setup?.protocol === "vnc";
  return (
    <form
      ref={mount}
      autoComplete="off"
      noValidate={guided}
      aria-busy={saving}
      className="flex min-h-0 min-w-0 flex-col gap-4"
      onInvalidCapture={(event) => {
        if (guided && event.target instanceof HTMLElement) {
          const step = event.target.closest<HTMLElement>(
            "[data-remote-vnc-step]",
          )?.dataset.remoteVncStep;
          if (
            step === "profile" ||
            step === "connection" ||
            step === "login" ||
            step === "trust"
          ) {
            update({ vncStep: step });
          }
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (
          guided &&
          (setup.vncStep !== "trust" || !event.currentTarget.reportValidity())
        ) {
          return;
        }
        if (!saving && !conflict && (uncertain || !blocked)) {
          detach(save(event.currentTarget, signal), Reason.DomCallback);
        }
      }}
    >
      {children}
      {guided ? (
        <VncGuidedActions
          saving={saving}
          blocked={blocked}
          onCancel={onCancel}
        />
      ) : (
        <VncFormActions
          saving={saving}
          blocked={blocked}
          destructive={destructive}
          title={title}
          inline={inline}
          onCancel={onCancel}
        />
      )}
    </form>
  );
}

function VncHostFields({
  dialog,
  inline,
  disabled,
}: {
  readonly dialog: VncDialogState;
  readonly inline?: boolean;
  readonly disabled: boolean;
}) {
  const profile = useGet(vncProfile$);
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  const guided =
    inline && dialog.kind === "create" && setup?.protocol === "vnc";
  const step = setup?.vncStep;
  return (
    <>
      <fieldset className="grid min-w-0 gap-4">
        <legend hidden={guided} className="mb-3 text-sm font-semibold">
          {t(($) => {
            return $.ssh.hostSection;
          })}
        </legend>
        {!guided && <VncDisplayNameField connection={dialog.connection} />}
        <div
          data-remote-vnc-step="profile"
          hidden={guided && step !== "profile"}
        >
          <div className="grid gap-4">
            <VncSecurityProfileField profile={profile} disabled={disabled} />
          </div>
        </div>
        <div
          data-remote-vnc-step="connection"
          hidden={guided && step !== "connection"}
        >
          <div className="grid gap-4">
            <VncTransportFields disabled={disabled} />
            <RemoteVncDependencies disabled={disabled} />
            <VncEndpointFields connection={dialog.connection} />
            <KerberosConnectionFields
              connection={dialog.connection}
              disabled={disabled}
            />
          </div>
        </div>
        <div data-remote-vnc-step="trust" hidden={guided && step !== "trust"}>
          <div className="grid gap-4">
            {guided && (
              <p className="text-sm text-muted-foreground">
                {t(($) => {
                  return $.remoteControlSetup.trustHelp;
                })}
              </p>
            )}
            <VncTlsFields disabled={disabled} />
          </div>
        </div>
      </fieldset>
      <div data-remote-vnc-step="login" hidden={guided && step !== "login"}>
        <div className="grid gap-5">
          {profile !== "x509_none" && (
            <VncCredentialSelection disabled={disabled} />
          )}
          {guided && <VncDisplayNameField connection={dialog.connection} />}
        </div>
      </div>
    </>
  );
}
function VncForm({ dialog, saving, save, inline, onCancel }: VncFormProps) {
  const uncertain = useGet(vncSaveUncertain$);
  const conflict = useGet(vncConflict$);
  const hostEditor = dialog.kind === "create" || dialog.kind === "edit";
  const destructive =
    dialog.kind === "delete" || dialog.kind === "delete-credential";
  const disabled = saving || uncertain || conflict;
  return (
    <VncFormBoundary
      dialog={dialog}
      saving={saving}
      save={save}
      inline={inline}
      onCancel={onCancel}
    >
      <DialogBody className="grid gap-4">
        {!destructive && (
          <fieldset disabled={disabled} className="grid min-w-0 gap-5">
            {hostEditor ? (
              <VncHostFields
                dialog={dialog}
                inline={inline}
                disabled={disabled}
              />
            ) : (
              <VncCredentialFields
                credential={dialog.credential}
                disabled={disabled}
                showMethodSelection={dialog.kind === "create-credential"}
              />
            )}
          </fieldset>
        )}
        {destructive && (
          <p className="break-all text-sm font-medium">
            {dialog.connection?.displayName ?? dialog.credential?.name}
          </p>
        )}
        {dialog.credential && !(destructive && conflict) && (
          <VncCredentialImpact credential={dialog.credential} />
        )}
        <VncSaveNotice saving={saving} dialog={dialog} />
        <VncConflictReview dialog={dialog} />
      </DialogBody>
    </VncFormBoundary>
  );
}

export function VncDialog({
  inline = false,
  saveAction = saveVnc$,
  onCancel,
}: {
  readonly inline?: boolean;
  readonly saveAction?: typeof saveVnc$;
  readonly onCancel?: () => void;
} = {}) {
  const data = useLoadable(vncDialog$);
  const close = useSet(closeVncDialog$);
  const [saving, save] = useLoadableSet(saveAction);
  const dialog = data.state === "hasData" ? data.data : null;
  const { title, description } = useDialogCopy(dialog?.kind);
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  const guided =
    inline && dialog?.kind === "create" && setup?.protocol === "vnc";
  const guidedTitle = t(($) => {
    return setup?.vncStep === "profile"
      ? $.remoteControlSetup.vncProfileTitle
      : setup?.vncStep === "connection"
        ? $.remoteControlSetup.vncConnectionTitle
        : setup?.vncStep === "login"
          ? $.remoteControlSetup.loginTitle
          : $.remoteControlSetup.trustTitle;
  });
  if (!dialog) {
    return null;
  }
  const busy = saving.state === "loading";
  return (
    <RemoteEditorFrame
      key={dialog.creationId}
      inline={inline}
      title={guided ? guidedTitle : title}
      description={description}
      busy={busy}
      onClose={onCancel ?? close}
    >
      <VncForm
        dialog={dialog}
        saving={busy}
        save={save}
        inline={inline}
        onCancel={onCancel}
      />
    </RemoteEditorFrame>
  );
}
