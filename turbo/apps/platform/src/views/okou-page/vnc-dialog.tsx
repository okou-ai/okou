import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { useLastResolved, useGet, useLoadable, useSet } from "ccstate-react";
import {
  remoteControlGuidedEnabled$,
  remoteVncConnectionOptionsAvailable$,
  remoteSetup$,
  updateRemoteSetup$,
  type RemoteVncStep,
} from "../../signals/remote-control-setup.ts";
import { requestRemoteLoginSave$ } from "../../signals/remote-login.ts";
import { RemoteLoginConfirmation } from "./remote-login-controls.tsx";
import { RemoteVncProtectionNotice } from "./remote-vnc-dependencies.tsx";
import { ComputerNetworkSummary } from "./remote-computer-setup.tsx";
import {
  RemoteEditorFrame,
  REMOTE_PAGE_ACTION,
} from "./remote-editor-frame.tsx";
import { KerberosConnectionFields } from "./vnc-kerberos-fields.tsx";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { Button, DialogBody } from "@okouai/ui";
import {
  clearVncSaveMessage$,
  closeVncDialog$,
  mountVncForm$,
  saveVnc$,
  vncLoginChanged,
  vncConflict$,
  vncCredentials$,
  vncDialog$,
  vncEditor$,
  vncProfile$,
  vncCredentialMatchesProfile,
  isVncReviewableConflict,
  vncSaveMessage$,
  vncNoticeSource$,
  vncSaveUncertain$,
  vncAuthMethodForProfile,
  requiresVncProtectiveRoute,
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
import { VncAuthenticationLabel } from "./vnc-authentication-label.tsx";
import {
  VncCredentialFields,
  VncCredentialImpact,
  VncCredentialSelection,
  VncDisplayNameField,
  VncEndpointFields,
  VncSecurityProfileField,
  ComputerScreenService,
  VncTlsFields,
  VncTransportFields,
  isPrivateVncLiteral,
} from "./vnc-fields.tsx";

function useDialogCopy(kind: VncDialogState["kind"] | undefined) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
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
          return guided ? $.remoteControlSetup.deleteConnection : $.vnc.delete;
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
  step,
}: {
  readonly saving: boolean;
  readonly dialog: VncDialogState;
  readonly step?: RemoteVncStep;
}) {
  const { t } = useTranslation();
  const uncertain = useGet(vncSaveUncertain$);
  const message = useGet(vncSaveMessage$);
  const source = useGet(vncNoticeSource$);
  const conflict = useGet(vncConflict$);
  const reviewable = isVncReviewableConflict(dialog, message);
  const noticeStep = source === "kerberos-import" ? "login" : "trust";
  if (
    saving ||
    (!uncertain && !message) ||
    (step !== undefined && step !== noticeStep)
  ) {
    return null;
  }
  return (
    <div role="alert" className="grid gap-2 text-sm text-muted-foreground">
      <p className="text-destructive">
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

function VncSaveLabel({
  saving,
  uncertain,
  destructive,
  title,
}: {
  readonly saving: boolean;
  readonly uncertain: boolean;
  readonly destructive: boolean;
  readonly title: string;
}) {
  const { t } = useTranslation();
  return saving
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
          });
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
  const dialog = useLastResolved(vncDialog$);
  const conflict = useGet(vncConflict$);
  const guided = useGet(remoteControlGuidedEnabled$);
  return (
    <div
      className={
        inline || guided
          ? "mt-2 flex shrink-0 flex-wrap justify-end gap-3 border-t border-divider pt-5"
          : "flex shrink-0 justify-end gap-2"
      }
    >
      {(!inline || dialog?.kind === "edit") && (
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
      )}
      <Button
        type="submit"
        className={
          (inline || guided) && !destructive ? REMOTE_PAGE_ACTION : undefined
        }
        variant={destructive ? "destructive" : "default"}
        disabled={saving || conflict || (!uncertain && blocked)}
      >
        <VncSaveLabel
          saving={saving}
          uncertain={uncertain}
          destructive={destructive}
          title={title}
        />
      </Button>
    </div>
  );
}

interface VncFormProps {
  readonly dialog: VncDialogState;
  readonly saving: boolean;
  readonly save: (
    form: HTMLFormElement,
    signal: AbortSignal,
  ) => Promise<unknown>;
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
  const connectionOptions = useLoadable(remoteVncConnectionOptionsAvailable$);
  if (!setup) {
    return null;
  }
  const step = setup.vncStep;
  if (
    step === "connection" &&
    (connectionOptions.state !== "hasData" || !connectionOptions.data)
  ) {
    return null;
  }
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
    <div className="mt-2 flex justify-end border-t border-divider pt-5">
      <Button
        type="button"
        className={REMOTE_PAGE_ACTION}
        disabled={
          saving ||
          (step === "connection" && routeBlocked) ||
          (step === "profile" &&
            setup.fromComputer &&
            !setup.computerScreenService)
        }
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
  const enabled = useGet(remoteControlGuidedEnabled$);
  const editor = useGet(vncEditor$);
  const confirmLogin = useSet(requestRemoteLoginSave$);
  const uncertain = useGet(vncSaveUncertain$);
  const conflict = useGet(vncConflict$);
  const mount = useSet(mountVncForm$);
  const clearSaveMessage = useSet(clearVncSaveMessage$);
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
      id={enabled ? "remote-vnc-edit-form" : undefined}
      autoComplete="off"
      noValidate={guided}
      aria-busy={saving}
      className="flex min-h-0 min-w-0 flex-col gap-4"
      onChange={clearSaveMessage}
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
        if (
          enabled &&
          dialog.kind === "edit" &&
          dialog.loginCredential &&
          editor.selection === dialog.loginCredential.id &&
          vncCredentialMatchesProfile(dialog.loginCredential, editor.profile) &&
          !confirmLogin(
            "vnc",
            dialog.loginCredential.hosts,
            vncLoginChanged(event.currentTarget, dialog.loginCredential),
          )
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
      {enabled && <RemoteLoginConfirmation protocol="vnc" />}
    </form>
  );
}

function VncSetupReview() {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const ssh = useLoadable(sshConnections$);
  const access = useLoadable(cloudflareAccessConfigs$);
  const tailscale = useLoadable(scopedTailscaleConfigs$);
  const networks = editor.transport === "tailscale" ? tailscale : access;
  const network =
    networks.state === "hasData"
      ? networks.data?.find((config) => {
          return config.id === editor.networkConfigId;
        })
      : undefined;
  const sshConnection =
    ssh.state === "hasData"
      ? ssh.data?.find((connection) => {
          return connection.id === editor.sshConnectionId;
        })
      : undefined;
  const route = t(($) => {
    return editor.transport === "ssh"
      ? $.vnc.transport.ssh
      : editor.transport === "tailscale"
        ? $.tailscale.title
        : editor.transport === "cloudflare_access"
          ? $.cloudflareAccess.title
          : $.remoteControlSetup.direct;
  });
  return (
    <div className="grid gap-4">
      <dl className="grid gap-4 rounded-xl bg-gray-50 p-4 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.connectionMethod;
          })}
        </dt>
        <dd className="break-words">
          {route}
          {editor.transport === "ssh" && sshConnection
            ? ` · ${sshConnection.displayName}`
            : network &&
                (editor.transport === "tailscale" ||
                  editor.transport === "cloudflare_access")
              ? ` · ${network.name}`
              : ""}
        </dd>
        <dt className="text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.deviceAddress;
          })}
        </dt>
        <dd className="break-all font-mono">
          {editor.transport === "ssh" &&
          requiresVncProtectiveRoute(editor.profile)
            ? editor.loopbackHost
            : editor.destinationHost}
        </dd>
        <dt className="text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.vncLoginMethod;
          })}
        </dt>
        <dd>
          <VncAuthenticationLabel
            method={vncAuthMethodForProfile(editor.profile)}
          />
        </dd>
      </dl>
    </div>
  );
}

function VncTrustFields({
  guided,
  disabled,
}: {
  readonly guided?: boolean;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const profile = useGet(vncProfile$);
  return (
    <div className="grid gap-4">
      {guided && <VncSetupReview />}
      {guided && !requiresVncProtectiveRoute(profile) && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.trustHelp;
          })}
        </p>
      )}
      <VncTlsFields disabled={disabled} />
    </div>
  );
}

function VncConnectionFields({
  guided,
  connection,
  disabled,
}: {
  readonly guided?: boolean;
  readonly connection: VncDialogState["connection"];
  readonly disabled: boolean;
}) {
  const setup = useGet(remoteSetup$);
  const connectionOptions = useLoadable(remoteVncConnectionOptionsAvailable$);
  const hideConnectionDetails =
    guided &&
    (connectionOptions.state !== "hasData" || !connectionOptions.data);
  return (
    <div className="grid gap-4">
      {guided && setup?.fromComputer ? (
        <ComputerNetworkSummary />
      ) : (
        <VncTransportFields
          disabled={disabled}
          hideConnectionDetails={hideConnectionDetails}
        />
      )}
      <div hidden={hideConnectionDetails}>
        <div className="grid gap-4">
          <RemoteVncProtectionNotice />
          <VncEndpointFields connection={connection} />
          <KerberosConnectionFields
            connection={connection}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
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
  const enabled = useGet(remoteControlGuidedEnabled$);
  const profile = useGet(vncProfile$);
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  const guided =
    inline && dialog.kind === "create" && setup?.protocol === "vnc";
  const step = setup?.vncStep;
  if (enabled && dialog.kind === "edit") {
    return (
      <div className="grid gap-6">
        <VncDisplayNameField connection={dialog.connection} />
        <details className="border-y border-divider py-4">
          <summary className="cursor-pointer rounded-md text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t(($) => {
              return $.remoteControlSetup.connectionSettings;
            })}
          </summary>
          <div className="mt-5 grid gap-5">
            <VncSecurityProfileField
              profile={profile}
              disabled={disabled}
              compact
            />
            <VncTransportFields disabled={disabled} />
            <RemoteVncProtectionNotice />
            <VncEndpointFields connection={dialog.connection} />
            <KerberosConnectionFields
              connection={dialog.connection}
              disabled={disabled}
            />
            <VncTlsFields disabled={disabled} />
          </div>
        </details>
        {profile !== "x509_none" && (
          <VncCredentialSelection disabled={disabled} />
        )}
      </div>
    );
  }
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
            {guided && setup.fromComputer ? (
              <ComputerScreenService disabled={disabled} />
            ) : (
              <VncSecurityProfileField profile={profile} disabled={disabled} />
            )}
          </div>
        </div>
        <div
          data-remote-vnc-step="connection"
          hidden={guided && step !== "connection"}
        >
          <VncConnectionFields
            guided={guided}
            connection={dialog.connection}
            disabled={disabled}
          />
        </div>
        <div data-remote-vnc-step="trust" hidden={guided && step !== "trust"}>
          <VncTrustFields guided={guided} disabled={disabled} />
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
  const { t } = useTranslation();
  const setup = useGet(remoteSetup$);
  const guided = useGet(remoteControlGuidedEnabled$);
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
      <DialogBody className={guided ? "-m-1 grid gap-4 p-1" : "grid gap-4"}>
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
        <VncSaveNotice
          saving={saving}
          dialog={dialog}
          step={
            inline && dialog.kind === "create" && setup?.protocol === "vnc"
              ? setup.vncStep
              : undefined
          }
        />
        {dialog.connectionSaved && (
          <p role="alert" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.partialLoginSave;
            })}
          </p>
        )}
        <VncConflictReview dialog={dialog} />
      </DialogBody>
    </VncFormBoundary>
  );
}

function useVncPresentation(dialog: VncDialogState | null, inline: boolean) {
  const { t } = useTranslation();
  const base = useDialogCopy(dialog?.kind);
  const setup = useGet(remoteSetup$);
  if (inline && dialog?.kind === "edit") {
    return {
      title: t(($) => {
        return $.remoteControlSetup.editConnection;
      }),
      description: `${dialog.connection?.displayName ?? ""} · ${t(($) => {
        return $.vnc.label;
      })}`,
    };
  }
  if (!inline || dialog?.kind !== "create" || setup?.protocol !== "vnc") {
    return base;
  }
  return {
    title: t(($) => {
      return setup.vncStep === "profile"
        ? setup.fromComputer
          ? $.remoteComputerSetup.screenServiceTitle
          : $.remoteControlSetup.vncProfileTitle
        : setup.vncStep === "connection"
          ? $.remoteControlSetup.vncConnectionTitle
          : setup.vncStep === "login"
            ? $.remoteControlSetup.loginTitle
            : $.remoteControlSetup.trustTitle;
    }),
    description:
      setup.vncStep === "profile"
        ? t(($) => {
            return setup.fromComputer
              ? $.remoteComputerSetup.screenServiceDescription
              : $.remoteControlSetup.vncProfileDescription;
          })
        : setup.vncStep === "connection"
          ? t(($) => {
              return $.remoteControlSetup.vncConnectionDescription;
            })
          : base.description,
  };
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
  const lastDialog = useLastResolved(vncDialog$);
  const sessionKey = useGet(authenticatedSessionKey$);
  const close = useSet(closeVncDialog$);
  const [saving, save] = useLoadableSet(saveAction);
  const dialog = lastDialog?.sessionKey === sessionKey ? lastDialog : null;
  const { title, description } = useVncPresentation(dialog, inline);
  if (!dialog) {
    return null;
  }
  const busy = saving.state === "loading";
  return (
    <RemoteEditorFrame
      key={dialog.creationId}
      inline={inline}
      title={title}
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
