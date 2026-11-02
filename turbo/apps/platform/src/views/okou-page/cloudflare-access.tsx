import { RemoteSecretInput } from "./remote-secret-input.tsx";
import type { ReactNode, ClipboardEvent } from "react";
import {
  RemoteNetworkScopeField,
  RemoteNetworkScopeConfirmation,
} from "./remote-network-scope.tsx";
import {
  RemoteNetworkSummary,
  RemoteNetworkDeleteAction,
} from "./remote-network-summary.tsx";
import {
  RemoteNetworkCredentialHelp,
  useRemoteNetworkSaveLabel,
} from "./remote-network-help.tsx";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";
import { remoteNetworkScopeStatus$ } from "../../signals/remote-network-scope.ts";
import {
  RemoteEditorFrame,
  useRemoteNetworkEditorVisible,
} from "./remote-editor-frame.tsx";
import { privateNetworkHostCount } from "../../lib/private-network-references.ts";
import { PrivateNetworkHostReferences } from "./private-network-host-references.tsx";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { RemoteFormFooter } from "./remote-form-footer.tsx";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  Button,
  Input,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  LoadErrorRow,
  surfaceVariants,
} from "@okouai/ui";
import { CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH } from "@okouai/api-contracts/validators/cloudflare-access";
import type {
  CloudflareAccessConfig,
  CloudflareAccessImpactPreview,
  ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  acknowledgeCloudflareAccessConversion$,
  acknowledgeCloudflareAccessDeletion$,
  acknowledgeCloudflareAccessPromotion$,
  chooseCloudflareAccessScope$,
  closeCloudflareAccessDialog$,
  closeCloudflareAccessConversion$,
  closeCloudflareAccessDeletion$,
  closeCloudflareAccessPromotion$,
  cloudflareAccessConfigs$,
  cloudflareAccessConversionAcknowledgedSnapshot$,
  cloudflareAccessConversionDialog$,
  cloudflareAccessConversionError$,
  cloudflareAccessConversionPreview$,
  cloudflareAccessDeletionAcknowledged$,
  cloudflareAccessDeletionDialog$,
  cloudflareAccessDeletionError$,
  cloudflareAccessDeletionPreview$,
  cloudflareAccessPromotionDialog$,
  cloudflareAccessPromotionError$,
  cloudflareAccessPromotionAcknowledged$,
  cloudflareAccessConflict$,
  cloudflareAccessCreateScope$,
  cloudflareAccessDialog$,
  cloudflareAccessReplaceToken$,
  cloudflareAccessSaveMessage$,
  cloudflareAccessSaveUncertain$,
  confirmCloudflareAccessConversion$,
  confirmCloudflareAccessDeletion$,
  confirmCloudflareAccessPromotion$,
  mountCloudflareAccessForm$,
  openCloudflareAccessDialog$,
  openCloudflareAccessConversion$,
  openCloudflareAccessDeletion$,
  openCloudflareAccessPromotion$,
  replaceCloudflareAccessToken$,
  saveCloudflareAccess$,
  type CloudflareAccessDialogState,
} from "../../signals/cloudflare-access.ts";
import { localizedCloudflareAccessError } from "../../lib/cloudflare-access-error.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { PrivateNetworkAffectedMembers } from "./private-network-impact.tsx";

function CloudflareAccessConflictNotice() {
  const { t } = useTranslation();
  const conflict = useGet(cloudflareAccessConflict$);
  if (!conflict) {
    return null;
  }
  return (
    <p role="alert" className="text-sm text-destructive">
      {localizedCloudflareAccessError(conflict) ??
        t(($) => {
          return $.cloudflareAccess.failed;
        })}
    </p>
  );
}

export function CloudflareAccessLoadError() {
  const { t } = useTranslation();
  return (
    <LoadErrorRow
      message={t(($) => {
        return $.cloudflareAccess.loadFailed;
      })}
    />
  );
}

export function AccessImpact({
  config,
}: {
  readonly config: Pick<CloudflareAccessConfig, "sshHosts" | "vncHosts">;
}) {
  return <PrivateNetworkHostReferences config={config} />;
}

interface AccessCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

function accessCredentialField(
  headerName: string,
): keyof AccessCredentials | null {
  switch (headerName.toLowerCase()) {
    case "cf-access-client-id": {
      return "clientId";
    }
    case "cf-access-client-secret": {
      return "clientSecret";
    }
    default: {
      return null;
    }
  }
}

function validAccessCredential(value: string): boolean {
  return (
    value.length <= CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

function accessCredentialsFromClipboard(
  clipboard: string,
): AccessCredentials | null {
  const lines = clipboard.split(/\r\n|\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length !== 2) {
    return null;
  }
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      return null;
    }
    const field = accessCredentialField(line.slice(0, separator));
    const value = line.slice(separator + 1).replace(/^[\t ]*/u, "");
    if (!field || !validAccessCredential(value)) {
      return null;
    }
    if (field === "clientId") {
      if (clientId !== undefined) {
        return null;
      }
      clientId = value;
    } else {
      if (clientSecret !== undefined) {
        return null;
      }
      clientSecret = value;
    }
  }
  if (clientId === undefined || clientSecret === undefined) {
    return null;
  }
  return {
    clientId,
    clientSecret,
  };
}

function accessCredentialInput(
  form: HTMLFormElement,
  name: keyof AccessCredentials,
): HTMLInputElement | null {
  const input = form.elements.namedItem(name);
  return input instanceof HTMLInputElement ? input : null;
}

function pasteAccessCredentials(event: ClipboardEvent<HTMLInputElement>) {
  const credentials = accessCredentialsFromClipboard(
    event.clipboardData.getData("text/plain"),
  );
  const form = event.currentTarget.form;
  if (!credentials || !form) {
    return;
  }
  const clientId = accessCredentialInput(form, "clientId");
  const clientSecret = accessCredentialInput(form, "clientSecret");
  if (!clientId || !clientSecret) {
    return;
  }
  event.preventDefault();
  clientId.value = credentials.clientId;
  clientSecret.value = credentials.clientSecret;
}

export function AccessFields({
  config,
  scopeField,
}: {
  readonly config: CloudflareAccessConfig | null;
  readonly scopeField?: ReactNode;
}) {
  const { t } = useTranslation();
  const replace = useGet(cloudflareAccessReplaceToken$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const setReplace = useSet(replaceCloudflareAccessToken$);
  return (
    <>
      <div className="grid gap-2">
        <label className="grid gap-2">
          {t(($) => {
            return guided
              ? $.remoteNetworkScope.networkName
              : $.cloudflareAccess.name;
          })}
          <Input
            name="accessName"
            placeholder={t(($) => {
              return guided
                ? $.remoteNetworkScope.networkNamePlaceholder
                : $.cloudflareAccess.namePlaceholder;
            })}
            aria-describedby={guided ? "cloudflare-name-help" : undefined}
            required
            pattern=".*\S.*"
            maxLength={128}
            defaultValue={config?.name}
          />
        </label>
        {guided && (
          <p
            id="cloudflare-name-help"
            className="text-sm text-muted-foreground"
          >
            {t(($) => {
              return $.remoteNetworkScope.networkNameHelp;
            })}
          </p>
        )}
      </div>
      {scopeField}
      {config && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            name="replaceToken"
            checked={replace}
            onCheckedChange={(checked) => {
              return setReplace(checked);
            }}
          />
          {t(($) => {
            return $.cloudflareAccess.replace;
          })}
        </label>
      )}
      {(!config || replace) && (
        <>
          {guided && <RemoteNetworkCredentialHelp provider="cloudflare" />}
          {!guided && (
            <p className="text-sm text-muted-foreground">
              {t(($) => {
                return $.cloudflareAccess.tokenHelp;
              })}
            </p>
          )}
          <div className="grid gap-2">
            <label htmlFor="cloudflare-clientId">
              {t(($) => {
                return guided
                  ? $.remoteNetworkGuide.clientId
                  : $.cloudflareAccess.clientId;
              })}
            </label>
            <RemoteSecretInput
              id="cloudflare-clientId"
              name="clientId"
              placeholder={t(($) => {
                return $.cloudflareAccess.clientIdPlaceholder;
              })}
              required
              pattern="[!-~]+"
              maxLength={CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH}
              autoComplete="new-password"
              spellCheck={false}
              onPaste={pasteAccessCredentials}
            />
          </div>
          <div className="grid gap-2">
            <label htmlFor="cloudflare-clientSecret">
              {t(($) => {
                return guided
                  ? $.remoteNetworkGuide.clientSecret
                  : $.cloudflareAccess.clientSecret;
              })}
            </label>
            <RemoteSecretInput
              id="cloudflare-clientSecret"
              name="clientSecret"
              placeholder={t(($) => {
                return $.cloudflareAccess.clientSecretPlaceholder;
              })}
              required
              pattern="[!-~]+"
              maxLength={CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH}
              autoComplete="new-password"
              spellCheck={false}
              onPaste={pasteAccessCredentials}
            />
          </div>
        </>
      )}
    </>
  );
}

function useCloudflareAccessDialogCopy(
  kind: CloudflareAccessDialogState["kind"] | undefined,
) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  switch (kind) {
    case "create": {
      return {
        title: t(($) => {
          return guided
            ? $.remoteNetworkScope.addCloudflare
            : $.cloudflareAccess.add;
        }),
        description: guided
          ? t(($) => {
              return $.remoteNetworkScope.scopeDescription;
            })
          : null,
      };
    }
    case "edit": {
      return {
        title: t(($) => {
          return $.cloudflareAccess.edit;
        }),
        description: null,
      };
    }
    case "delete": {
      return {
        title: t(($) => {
          return $.cloudflareAccess.delete;
        }),
        description: t(($) => {
          return $.cloudflareAccess.deleteHelp;
        }),
      };
    }
    case undefined: {
      return { title: "", description: null };
    }
  }
}

function CloudflareAccessSaveNotice() {
  const { t } = useTranslation();
  const uncertain = useGet(cloudflareAccessSaveUncertain$);
  const message = useGet(cloudflareAccessSaveMessage$);
  if (!uncertain && !message) {
    return null;
  }
  return (
    <p role="alert" className="text-sm text-muted-foreground">
      {uncertain
        ? t(($) => {
            return $.cloudflareAccess.saveUncertain;
          })
        : (localizedCloudflareAccessError(message ?? "") ??
          t(($) => {
            return $.cloudflareAccess.invalidInput;
          }))}
    </p>
  );
}

function CloudflareAccessScopeSelect({
  value,
  disabled,
}: {
  readonly value: "personal" | "organization";
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const chooseScope = useSet(chooseCloudflareAccessScope$);
  const signal = useGet(pageSignal$);
  return (
    <div className="grid gap-2">
      <span id="cloudflare-access-scope-label">
        {t(($) => {
          return $.cloudflareAccess.scope;
        })}
      </span>
      <Select
        items={[
          {
            value: "personal",
            label: t(($) => {
              return $.cloudflareAccess.personal;
            }),
          },
          {
            value: "organization",
            label: t(($) => {
              return $.cloudflareAccess.organization;
            }),
          },
        ]}
        value={value}
        disabled={disabled}
        onValueChange={(scope, details) => {
          if (scope !== "personal" && scope !== "organization") {
            details.cancel();
            return;
          }
          detach(chooseScope(scope, signal), Reason.DomCallback);
        }}
      >
        <SelectTrigger aria-labelledby="cloudflare-access-scope-label">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="personal">
            {t(($) => {
              return $.cloudflareAccess.personal;
            })}
          </SelectItem>
          <SelectItem value="organization">
            {t(($) => {
              return $.cloudflareAccess.organization;
            })}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function CloudflareDialogScope({
  creating,
  scope,
  disabled,
}: {
  readonly creating: boolean;
  readonly scope: "personal" | "organization";
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const admin = useLoadable(isOrgAdmin$);
  return (
    <>
      {" "}
      {creating && admin.state === "hasData" && admin.data && (
        <CloudflareAccessScopeSelect value={scope} disabled={disabled} />
      )}
      {scope === "organization" && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.organizationHelp;
          })}
        </p>
      )}
    </>
  );
}

function CloudflareAccessEditorFields({
  dialog,
  disabled,
}: {
  readonly dialog: CloudflareAccessDialogState;
  readonly disabled: boolean;
}) {
  const guided = useGet(remoteControlGuidedEnabled$);
  const createScope = useGet(cloudflareAccessCreateScope$);
  const scope = dialog.kind === "create" ? createScope : dialog.scope;
  return (
    <>
      {!guided && (
        <CloudflareDialogScope
          creating={dialog.kind === "create"}
          scope={scope}
          disabled={disabled}
        />
      )}
      {dialog.kind !== "delete" && (
        <fieldset disabled={disabled} className="grid min-w-0 gap-4">
          <AccessFields
            config={dialog.config}
            scopeField={
              guided ? (
                <RemoteNetworkScopeField
                  provider="cloudflare"
                  config={dialog.config}
                  disabled={disabled}
                />
              ) : undefined
            }
          />
        </fieldset>
      )}
      {dialog.config && <AccessImpact config={dialog.config} />}
    </>
  );
}

export function CloudflareAccessDialog({
  inline = false,
  saveAction = saveCloudflareAccess$,
}: {
  readonly inline?: boolean;
  readonly saveAction?: typeof saveCloudflareAccess$;
} = {}) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const saveLabel = useRemoteNetworkSaveLabel();
  const dialog = useLastResolved(cloudflareAccessDialog$);
  const close = useSet(closeCloudflareAccessDialog$);
  const [saving, save] = useLoadableSet(saveAction);
  const mount = useSet(mountCloudflareAccessForm$);
  const signal = useGet(pageSignal$);
  const conflict = useGet(cloudflareAccessConflict$);
  const uncertain = useGet(cloudflareAccessSaveUncertain$);
  const { title, description } = useCloudflareAccessDialogCopy(dialog?.kind);
  const scopeStatus = useGet(remoteNetworkScopeStatus$);
  const isSaving = saving.state === "loading";
  const visible = useRemoteNetworkEditorVisible(inline, dialog);
  if (!dialog || !visible) {
    return null;
  }
  const destructive = dialog.kind === "delete";
  return (
    <RemoteEditorFrame
      key={`${dialog.identity}:${dialog.kind}:${dialog.config?.id ?? "new"}`}
      inline={inline}
      title={title}
      description={description}
      busy={isSaving}
      onClose={close}
    >
      <form
        id="remote-network-cloudflare"
        ref={mount}
        className="flex min-h-0 min-w-0 flex-col gap-4"
        autoComplete="off"
        aria-busy={isSaving}
        onSubmit={(event) => {
          event.preventDefault();
          if (!isSaving && !uncertain && !scopeStatus.error && !conflict) {
            detach(save(event.currentTarget, signal), Reason.DomCallback);
          }
        }}
      >
        <DialogBody className="grid gap-4">
          <CloudflareAccessEditorFields
            dialog={dialog}
            disabled={isSaving || uncertain}
          />
          <CloudflareAccessConflictNotice />
          {!isSaving && <CloudflareAccessSaveNotice />}
          <RemoteNetworkScopeConfirmation
            busy={isSaving}
            provider="cloudflare"
            configId={dialog.config?.id}
          />
        </DialogBody>
        <RemoteFormFooter
          separated={inline}
          onCancel={inline ? undefined : close}
          cancelLabel={t(($) => {
            return $.cloudflareAccess.cancel;
          })}
          cancelDisabled={isSaving}
          submitDisabled={
            isSaving || uncertain || !!conflict || !!scopeStatus.error
          }
          destructive={destructive}
          submitLabel={
            isSaving
              ? t(($) => {
                  return $.connectors.actions.saving;
                })
              : destructive
                ? title
                : guided
                  ? saveLabel
                  : t(($) => {
                      return $.cloudflareAccess.save;
                    })
          }
        />
      </form>
    </RemoteEditorFrame>
  );
}

function CloudflareAccessConversionControls({
  preview,
  isSaving,
  onCancel,
  onConfirm,
}: {
  readonly preview: CloudflareAccessImpactPreview | null;
  readonly isSaving: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (preview: CloudflareAccessImpactPreview) => void;
}) {
  const { t } = useTranslation();
  const acknowledgedSnapshot = useGet(
    cloudflareAccessConversionAcknowledgedSnapshot$,
  );
  const acknowledge = useSet(acknowledgeCloudflareAccessConversion$);
  const confirmed =
    preview !== null && acknowledgedSnapshot === preview.impactSnapshot;
  return (
    <>
      {preview && preview.otherHostCount > 0 && (
        <div className="grid gap-3 rounded-lg border p-4 text-sm">
          <PrivateNetworkAffectedMembers preview={preview} />
          <label className="flex items-start gap-2">
            <Checkbox
              checked={confirmed}
              disabled={isSaving}
              onCheckedChange={(checked) => {
                acknowledge(checked ? preview.impactSnapshot : null);
              }}
            />
            {t(($) => {
              return $.vnc.native.impactConfirm;
            })}
          </label>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={isSaving}
          onClick={onCancel}
        >
          {t(($) => {
            return $.cloudflareAccess.cancel;
          })}
        </Button>
        {preview && (
          <Button
            type="button"
            disabled={isSaving || (preview.otherHostCount > 0 && !confirmed)}
            onClick={() => {
              onConfirm(preview);
            }}
          >
            {t(($) => {
              return $.cloudflareAccess.convert;
            })}
          </Button>
        )}
      </div>
    </>
  );
}

export function CloudflareAccessPromotionDialog() {
  const { t } = useTranslation();
  const dialog = useLoadable(cloudflareAccessPromotionDialog$);
  const error = useGet(cloudflareAccessPromotionError$);
  const acknowledged = useGet(cloudflareAccessPromotionAcknowledged$);
  const setAcknowledged = useSet(acknowledgeCloudflareAccessPromotion$);
  const close = useSet(closeCloudflareAccessPromotion$);
  const [saving, confirm] = useLoadableSet(confirmCloudflareAccessPromotion$);
  const signal = useGet(pageSignal$);
  const current = dialog.state === "hasData" ? dialog.data : null;
  if (!current) {
    return null;
  }
  const isSaving = saving.state === "loading";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) {
          close();
        }
      }}
    >
      <DialogContent key={current.configId} contentClassName="flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.cloudflareAccess.promote;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.cloudflareAccess.promoteHelp;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <p className="font-medium">{current.name}</p>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={acknowledged}
              disabled={isSaving || !!error}
              onCheckedChange={(checked) => {
                return setAcknowledged(checked === true);
              }}
            />
            {t(($) => {
              return $.cloudflareAccess.promoteConfirm;
            })}
          </label>
          {error && (
            <p role="alert">
              {error === "uncertain"
                ? t(($) => {
                    return $.cloudflareAccess.promoteUncertain;
                  })
                : (localizedCloudflareAccessError(error) ??
                  t(($) => {
                    return $.cloudflareAccess.failed;
                  }))}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={close}
            >
              {t(($) => {
                return $.cloudflareAccess.cancel;
              })}
            </Button>
            <Button
              type="button"
              disabled={!acknowledged || isSaving || !!error}
              onClick={() => {
                return detach(confirm(signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return $.cloudflareAccess.promote;
              })}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function CloudflareAccessDeletionReview() {
  const { t } = useTranslation();
  const preview = useLoadable(cloudflareAccessDeletionPreview$);
  const impact = preview.state === "hasData" ? preview.data : null;
  return (
    <>
      {preview.state === "loading" && (
        <p role="status">
          {t(($) => {
            return $.cloudflareAccess.loading;
          })}
        </p>
      )}
      {preview.state === "hasError" && (
        <p role="alert">
          {t(($) => {
            return $.cloudflareAccess.loadFailed;
          })}
        </p>
      )}
      {preview.state === "hasData" && !impact && (
        <p role="alert">
          {t(($) => {
            return $.cloudflareAccess.missing;
          })}
        </p>
      )}
      {impact && impact.ownHostCount > 0 && (
        <p role="alert">
          {t(($) => {
            return $.vnc.native.inUse;
          })}
        </p>
      )}
    </>
  );
}

export function CloudflareAccessDeletionDialog() {
  const { t } = useTranslation();
  const dialog = useLoadable(cloudflareAccessDeletionDialog$);
  const preview = useLoadable(cloudflareAccessDeletionPreview$);
  const acknowledged = useGet(cloudflareAccessDeletionAcknowledged$);
  const acknowledge = useSet(acknowledgeCloudflareAccessDeletion$);
  const error = useGet(cloudflareAccessDeletionError$);
  const close = useSet(closeCloudflareAccessDeletion$);
  const [saving, confirm] = useLoadableSet(confirmCloudflareAccessDeletion$);
  const signal = useGet(pageSignal$);
  const current = dialog.state === "hasData" ? dialog.data : null;
  if (!current) {
    return null;
  }
  const isSaving = saving.state === "loading";
  const impact = preview.state === "hasData" ? preview.data : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) {
          close();
        }
      }}
    >
      <DialogContent contentClassName="flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.cloudflareAccess.delete;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.cloudflareAccess.deleteHelp;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <p className="font-medium">{current.name}</p>
          <CloudflareAccessDeletionReview />
          {impact && impact.otherHostCount > 0 && (
            <div className="grid gap-3 rounded-lg border p-4 text-sm">
              <PrivateNetworkAffectedMembers preview={impact} />
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={acknowledged === impact.impactSnapshot}
                  disabled={isSaving || !!error || impact.ownHostCount > 0}
                  onCheckedChange={(checked) => {
                    return acknowledge(checked ? impact.impactSnapshot : null);
                  }}
                />
                {t(($) => {
                  return $.vnc.native.impactConfirm;
                })}
              </label>
            </div>
          )}
          {error && (
            <p role="alert">
              {error === "uncertain"
                ? t(($) => {
                    return $.cloudflareAccess.deleteUncertain;
                  })
                : (localizedCloudflareAccessError(error) ??
                  t(($) => {
                    return $.cloudflareAccess.failed;
                  }))}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={close}
            >
              {t(($) => {
                return $.cloudflareAccess.cancel;
              })}
            </Button>
            {impact && !error && (
              <Button
                type="button"
                variant="destructive"
                disabled={
                  isSaving ||
                  impact.ownHostCount > 0 ||
                  (impact.otherHostCount > 0 &&
                    acknowledged !== impact.impactSnapshot)
                }
                onClick={() => {
                  return detach(confirm(impact, signal), Reason.DomCallback);
                }}
              >
                {t(($) => {
                  return $.cloudflareAccess.delete;
                })}
              </Button>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function CloudflareAccessConversionDialog() {
  const { t } = useTranslation();
  const dialog = useLoadable(cloudflareAccessConversionDialog$);
  const preview = useLoadable(cloudflareAccessConversionPreview$);
  const error = useGet(cloudflareAccessConversionError$);
  const close = useSet(closeCloudflareAccessConversion$);
  const [saving, confirm] = useLoadableSet(confirmCloudflareAccessConversion$);
  const signal = useGet(pageSignal$);
  const current = dialog.state === "hasData" ? dialog.data : null;
  if (!current) {
    return null;
  }
  const isSaving = saving.state === "loading";
  const impact = preview.state === "hasData" ? preview.data : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) {
          close();
        }
      }}
    >
      <DialogContent contentClassName="flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.cloudflareAccess.convert;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.cloudflareAccess.convertHelp;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <p className="font-medium">{current.name}</p>
          {preview.state === "loading" && (
            <p role="status">
              {t(($) => {
                return $.cloudflareAccess.loading;
              })}
            </p>
          )}
          {preview.state === "hasError" && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 text-sm"
            >
              <p>
                {t(($) => {
                  return $.cloudflareAccess.loadFailed;
                })}
              </p>
            </div>
          )}
          {preview.state === "hasData" && !impact && (
            <p role="alert">
              {t(($) => {
                return $.cloudflareAccess.missing;
              })}
            </p>
          )}
          {error && (
            <p role="alert">
              {error === "uncertain"
                ? t(($) => {
                    return $.cloudflareAccess.convertUncertain;
                  })
                : (localizedCloudflareAccessError(error) ??
                  t(($) => {
                    return $.cloudflareAccess.failed;
                  }))}
            </p>
          )}

          <CloudflareAccessConversionControls
            preview={error ? null : impact}
            isSaving={isSaving}
            onCancel={close}
            onConfirm={(reviewed) => {
              return detach(confirm(reviewed, signal), Reason.DomCallback);
            }}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function CloudflareConfigCard({
  config,
  compact,
  scope,
  canManage,
  canPromote,
}: {
  readonly config: ScopedCloudflareAccessConfig;
  readonly compact: boolean;
  readonly scope: "personal" | "organization";
  readonly canManage: boolean;
  readonly canPromote: boolean;
}) {
  const { t } = useTranslation();
  const open = useSet(openCloudflareAccessDialog$);
  const openConversion = useSet(openCloudflareAccessConversion$);
  const openPromotion = useSet(openCloudflareAccessPromotion$);
  const openDeletion = useSet(openCloudflareAccessDeletion$);
  const signal = useGet(pageSignal$);
  return (
    <article
      className={
        compact
          ? "grid gap-5"
          : surfaceVariants({ className: "grid gap-3 p-5" })
      }
    >
      {compact ? (
        <RemoteNetworkSummary config={config} kind="cloudflare" />
      ) : (
        <>
          <h3 className="font-semibold">{config.name}</h3>
          <AccessImpact config={config} />
        </>
      )}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant={compact ? "neutral" : "outline"}
            onClick={() => {
              return detach(open("edit", config, signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return compact
                ? $.remoteControlSetup.networkEditSettings
                : $.cloudflareAccess.edit;
            })}
          </Button>
          {scope === "personal" && canPromote && !compact && (
            <Button
              variant="outline"
              onClick={() => {
                return detach(
                  openPromotion(config, signal),
                  Reason.DomCallback,
                );
              }}
            >
              {t(($) => {
                return $.cloudflareAccess.promote;
              })}
            </Button>
          )}
          {scope === "organization" && !compact && (
            <Button
              variant="outline"
              onClick={() => {
                return detach(
                  openConversion(config, signal),
                  Reason.DomCallback,
                );
              }}
            >
              {t(($) => {
                return $.cloudflareAccess.convert;
              })}
            </Button>
          )}
          <RemoteNetworkDeleteAction
            label={t(($) => {
              return $.cloudflareAccess.delete;
            })}
            compact={compact}
            disabled={privateNetworkHostCount(config) > 0}
            onClick={() => {
              return detach(
                scope === "organization"
                  ? openDeletion(config, signal)
                  : open("delete", config, signal),
                Reason.DomCallback,
              );
            }}
          />
        </div>
      )}
    </article>
  );
}

export function CloudflareAccessSection({
  compact = false,
  scope,
  configs,
  canManage,
  canPromote = false,
}: {
  readonly compact?: boolean;
  readonly scope: "personal" | "organization";
  readonly configs: readonly ScopedCloudflareAccessConfig[];
  readonly canManage: boolean;
  readonly canPromote?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t(($) => {
        return scope === "personal"
          ? $.cloudflareAccess.personal
          : $.cloudflareAccess.organization;
      })}
      className="grid gap-3"
    >
      {!compact && (
        <h2 className="text-base font-semibold">
          {t(($) => {
            return scope === "personal"
              ? $.cloudflareAccess.personal
              : $.cloudflareAccess.organization;
          })}
        </h2>
      )}
      {configs.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.sectionEmpty;
          })}
        </p>
      )}
      {configs.map((config) => {
        return (
          <CloudflareConfigCard
            key={config.id}
            config={config}
            compact={compact}
            scope={scope}
            canManage={canManage}
            canPromote={canPromote}
          />
        );
      })}
    </section>
  );
}

export function CloudflareAccessConfigs() {
  const { t } = useTranslation();
  const configs = useLoadable(cloudflareAccessConfigs$);
  const open = useSet(openCloudflareAccessDialog$);
  const signal = useGet(pageSignal$);
  const admin = useLoadable(isOrgAdmin$);
  if (configs.state === "loading") {
    return (
      <p role="status">
        {t(($) => {
          return $.cloudflareAccess.loading;
        })}
      </p>
    );
  }
  if (configs.state === "hasError") {
    return <CloudflareAccessLoadError />;
  }
  if (!configs.data) {
    return (
      <p>
        {t(($) => {
          return $.cloudflareAccess.unavailable;
        })}
      </p>
    );
  }
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.cloudflareAccess.summary;
            },
            { count: configs.data.length },
          )}
        </p>
        <Button
          onClick={() => {
            return detach(open("create", null, signal), Reason.DomCallback);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.cloudflareAccess.add;
          })}
        </Button>
      </div>
      <CloudflareAccessSection
        scope="personal"
        configs={configs.data.filter((config) => {
          return config.scope === "personal";
        })}
        canManage
        canPromote={admin.state === "hasData" && admin.data === true}
      />
      <CloudflareAccessSection
        scope="organization"
        configs={configs.data.filter((config) => {
          return config.scope === "organization";
        })}
        canManage={admin.state === "hasData" && admin.data === true}
      />
    </div>
  );
}
