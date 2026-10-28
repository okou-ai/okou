import type { ReactNode } from "react";
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
import { RemoteFormFooter } from "./remote-form-footer.tsx";
import { useTranslation } from "react-i18next";
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
  vncTransport$,
  vncNetworkConfigId$,
  vncKdcTransport$,
  vncKdcNetworkConfigId$,
  vncKdcHost$,
  vncSshConnectionId$,
  vncKdcSshConnectionId$,
  vncDirectDestinationHost$,
  vncCredentialSelection$,
  vncCredentialMatchesProfile,
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
import { tailscaleConfigs$ } from "../../signals/tailscale.ts";
import { isVncKerberosMethod } from "@okouai/api-contracts/contracts/vnc-kerberos";
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

function VncSaveNotice({ step }: { readonly step?: RemoteVncStep }) {
  const { t } = useTranslation();
  const uncertain = useGet(vncSaveUncertain$);
  const message = useGet(vncSaveMessage$);
  const source = useGet(vncNoticeSource$);
  const noticeStep = source === "kerberos-import" ? "login" : "trust";
  if ((!uncertain && !message) || (step !== undefined && step !== noticeStep)) {
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
    </div>
  );
}

function useNativeVncNetworkBlocked() {
  const access = useLoadable(cloudflareAccessConfigs$);
  const tailscale = useLoadable(tailscaleConfigs$);
  const profile = useGet(vncProfile$);
  const transport = useGet(vncTransport$);
  const networkConfigId = useGet(vncNetworkConfigId$);
  const kdcTransport = useGet(vncKdcTransport$);
  const kdcNetworkConfigId = useGet(vncKdcNetworkConfigId$);
  const kdcHost = useGet(vncKdcHost$);
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
    isVncKerberosMethod(profile) && profile !== "qemu_kerberos_ticket";
  return (
    networkUnavailable(transport, networkConfigId) ||
    (onlineKdc &&
      (networkUnavailable(kdcTransport, kdcNetworkConfigId) ||
        (kdcTransport === "direct" && isPrivateVncLiteral(kdcHost))))
  );
}

function useVncRouteBlocked() {
  const sshConnections = useLoadable(sshConnections$);
  const transport = useGet(vncTransport$);
  const sshConnectionId = useGet(vncSshConnectionId$);
  const profile = useGet(vncProfile$);
  const kdcTransport = useGet(vncKdcTransport$);
  const kdcSshConnectionId = useGet(vncKdcSshConnectionId$);
  const directDestinationHost = useGet(vncDirectDestinationHost$);
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
    transport === "ssh" && sshUnavailable(sshConnectionId);
  const kdcBlocked =
    isVncKerberosMethod(profile) &&
    profile !== "qemu_kerberos_ticket" &&
    kdcTransport === "ssh" &&
    sshUnavailable(kdcSshConnectionId);
  const destinationBlocked =
    directDestinationHost !== null &&
    isPrivateVncLiteral(directDestinationHost);
  return transportBlocked || kdcBlocked || nativeBlocked || destinationBlocked;
}

function useSaveBlocked(dialog: VncDialogState) {
  const credentials = useLoadable(vncCredentials$);
  const profile = useGet(vncProfile$);
  const selection = useGet(vncCredentialSelection$);
  const routeBlocked = useVncRouteBlocked();
  const conflict = useGet(vncConflict$);
  if (conflict) {
    return true;
  }
  if (dialog.kind === "create" || dialog.kind === "edit") {
    const credentialBlocked =
      profile !== "x509_none" &&
      (credentials.state !== "hasData" ||
        credentials.data === null ||
        (selection !== "new" &&
          !credentials.data.some((credential) => {
            return (
              credential.id === selection &&
              vncCredentialMatchesProfile(credential, profile)
            );
          })));
    return credentialBlocked || routeBlocked;
  }
  return (
    dialog.kind === "delete-credential" &&
    (dialog.credential?.hosts.length ?? 0) > 0
  );
}

interface VncFormProps {
  readonly enabledFields: ReactNode;
  readonly disabledFields: ReactNode;
  readonly dialog: VncDialogState;
  readonly saveAction: typeof saveVnc$;
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

function VncGuidedNextAction() {
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
    return null;
  }
  return (
    <div className="mt-2 flex justify-end border-t border-divider pt-5">
      <Button
        type="button"
        className={REMOTE_PAGE_ACTION}
        disabled={
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

function VncSetupReview() {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const ssh = useLoadable(sshConnections$);
  const access = useLoadable(cloudflareAccessConfigs$);
  const tailscale = useLoadable(tailscaleConfigs$);
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
function VncFormFields({
  dialog,
  inline,
  disabled,
}: {
  dialog: VncDialogState;
  inline: boolean;
  disabled: boolean;
}) {
  const conflict = useGet(vncConflict$);
  const destructive =
    dialog.kind === "delete" || dialog.kind === "delete-credential";
  const hostEditor = dialog.kind === "create" || dialog.kind === "edit";
  return (
    <>
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
    </>
  );
}

function useVncFormSubmission(
  dialog: VncDialogState,
  saveAction: typeof saveVnc$,
  inline: boolean,
) {
  const { t } = useTranslation();
  const { title } = useDialogCopy(dialog.kind);
  const [operation, save] = useLoadableSet(saveAction);
  const saving = operation.state === "loading";
  const setup = useGet(remoteSetup$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const profile = useGet(vncProfile$);
  const selection = useGet(vncCredentialSelection$);
  const confirmLogin = useSet(requestRemoteLoginSave$);
  const uncertain = useGet(vncSaveUncertain$);
  const conflict = useGet(vncConflict$);
  const signal = useGet(pageSignal$);
  const blocked = useSaveBlocked(dialog);
  const inlineCreate =
    inline && dialog.kind === "create" && setup?.protocol === "vnc";
  return {
    saving,
    conflict,
    fieldsDisabled: saving || uncertain || conflict,
    submitDisabled: saving || uncertain || conflict || blocked,
    inlineCreate,
    setup,
    submitLabel: saving
      ? t(($) => {
          return $.vnc.saving;
        })
      : dialog.kind === "delete" || dialog.kind === "delete-credential"
        ? title
        : t(($) => {
            return $.vnc.save;
          }),
    submit(form: HTMLFormElement) {
      if (saving || uncertain || conflict || blocked) {
        return;
      }
      if (
        inlineCreate &&
        (setup.vncStep !== "trust" || !form.reportValidity())
      ) {
        return;
      }
      if (
        guided &&
        dialog.kind === "edit" &&
        dialog.loginCredential &&
        selection === dialog.loginCredential.id &&
        vncCredentialMatchesProfile(dialog.loginCredential, profile) &&
        !confirmLogin(
          "vnc",
          dialog.loginCredential.hosts,
          vncLoginChanged(form, dialog.loginCredential),
        )
      ) {
        return;
      }
      detach(save(form, signal), Reason.DomCallback);
    },
  };
}

function VncForm({
  enabledFields,
  disabledFields,
  dialog,
  saveAction,
  inline = false,
  onCancel,
}: VncFormProps) {
  const { t } = useTranslation();
  const {
    saving,
    conflict,
    fieldsDisabled,
    submitDisabled,
    inlineCreate,
    setup,
    submitLabel,
    submit,
  } = useVncFormSubmission(dialog, saveAction, inline);
  const close = useSet(closeVncDialog$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const mount = useSet(mountVncForm$);
  const clearSaveMessage = useSet(clearVncSaveMessage$);
  const { title, description } = useVncPresentation(dialog, inline);
  const update = useSet(updateRemoteSetup$);
  const destructive =
    dialog.kind === "delete" || dialog.kind === "delete-credential";
  return (
    <RemoteEditorFrame
      inline={inline}
      title={title}
      description={description}
      busy={saving}
      onClose={onCancel ?? close}
    >
      <form
        ref={mount}
        id={guided ? "remote-vnc-edit-form" : undefined}
        autoComplete="off"
        noValidate={inlineCreate}
        aria-busy={saving}
        className="flex min-h-0 min-w-0 flex-col gap-4"
        onChange={clearSaveMessage}
        onInvalidCapture={(event) => {
          if (inlineCreate && event.target instanceof HTMLElement) {
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
          submit(event.currentTarget);
        }}
      >
        <DialogBody className={guided ? "-m-1 grid gap-4 p-1" : "grid gap-4"}>
          {fieldsDisabled ? disabledFields : enabledFields}
          {!saving && (
            <VncSaveNotice step={inlineCreate ? setup?.vncStep : undefined} />
          )}
          {dialog.connectionSaved && (
            <p role="alert" className="text-sm text-muted-foreground">
              {t(($) => {
                return $.remoteControlSetup.partialLoginSave;
              })}
            </p>
          )}
        </DialogBody>
        {inlineCreate && setup?.vncStep !== "trust" ? (
          <fieldset disabled={saving} className="min-w-0">
            <VncGuidedNextAction />
          </fieldset>
        ) : (
          <RemoteFormFooter
            separated={inline || guided}
            onCancel={
              !inline || dialog.kind === "edit"
                ? (onCancel ?? close)
                : undefined
            }
            cancelLabel={t(($) => {
              return conflict ? $.vnc.close : $.vnc.cancel;
            })}
            cancelDisabled={saving}
            submitDisabled={submitDisabled}
            destructive={destructive}
            submitLabel={submitLabel}
          />
        )}
        {guided && <RemoteLoginConfirmation protocol="vnc" />}
      </form>
    </RemoteEditorFrame>
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
  const dialog = lastDialog?.sessionKey === sessionKey ? lastDialog : null;
  if (!dialog) {
    return null;
  }
  return (
    <VncForm
      enabledFields={
        <VncFormFields dialog={dialog} inline={inline} disabled={false} />
      }
      disabledFields={
        <VncFormFields dialog={dialog} inline={inline} disabled />
      }
      key={dialog.creationId}
      dialog={dialog}
      saveAction={saveAction}
      inline={inline}
      onCancel={onCancel}
    />
  );
}
