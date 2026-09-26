import type { ClipboardEvent } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
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
  surfaceVariants,
} from "@okouai/ui";
import {
  CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH,
  type CloudflareAccessConfig,
  type CloudflareAccessImpactPreview,
  type ScopedCloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  acceptCloudflareAccessConflictReview$,
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
  cloudflareAccessConflictReview$,
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
  retryCloudflareAccess$,
  reviewCloudflareAccessConversion$,
  reviewCloudflareAccessDeletion$,
  saveCloudflareAccess$,
  type CloudflareAccessDialogState,
} from "../../signals/cloudflare-access.ts";
import { localizedCloudflareAccessError } from "../../lib/cloudflare-access-error.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";

export function CloudflareAccessConflictReview() {
  const { t } = useTranslation();
  const conflict = useGet(cloudflareAccessConflict$);
  const review = useLoadable(cloudflareAccessConflictReview$);
  const acceptReview = useSet(acceptCloudflareAccessConflictReview$);
  const signal = useGet(pageSignal$);
  if (!conflict) {
    return null;
  }
  const current = review.state === "hasData" ? review.data : null;
  return (
    <div className="grid gap-3 rounded-lg border p-4 text-sm">
      <p role="alert">
        {localizedCloudflareAccessError(conflict) ??
          t(($) => {
            return $.cloudflareAccess.failed;
          })}
      </p>
      {review.state === "hasError" && <CloudflareAccessLoadError />}
      {review.state === "loading" && (
        <p role="status">
          {t(($) => {
            return $.cloudflareAccess.loading;
          })}
        </p>
      )}
      {current && (
        <>
          <h3 className="font-semibold">
            {t(($) => {
              return $.cloudflareAccess.latest;
            })}
          </h3>
          {current.config && (
            <>
              <p>{current.config.name}</p>
              <AccessImpact config={current.config} />
            </>
          )}
          <p>
            {t(($) => {
              return $.cloudflareAccess.reviewHelp;
            })}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={
              current.kind === "delete" &&
              (current.config?.sshHosts.length ?? 0) > 0
            }
            onClick={() => {
              return detach(acceptReview(current, signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.cloudflareAccess.keepChanges;
            })}
          </Button>
        </>
      )}
    </div>
  );
}

export function CloudflareAccessLoadError() {
  const { t } = useTranslation();
  const retry = useSet(retryCloudflareAccess$);
  const signal = useGet(pageSignal$);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 text-sm"
    >
      <p>
        {t(($) => {
          return $.cloudflareAccess.loadFailed;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          return detach(retry(signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.cloudflareAccess.retry;
        })}
      </Button>
    </div>
  );
}

export function AccessImpact({
  config,
}: {
  readonly config: Pick<CloudflareAccessConfig, "sshHosts">;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1 text-sm text-muted-foreground">
      <p>
        {config.sshHosts.length === 0
          ? t(($) => {
              return $.cloudflareAccess.unused;
            })
          : t(
              ($) => {
                return $.cloudflareAccess.usedBy;
              },
              { count: config.sshHosts.length },
            )}
      </p>
      {config.sshHosts.length > 0 && (
        <ul className="list-inside list-disc">
          {config.sshHosts.map((host) => {
            return <li key={host.id}>{host.displayName}</li>;
          })}
        </ul>
      )}
    </div>
  );
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
  return input instanceof HTMLInputElement && input.type === "password"
    ? input
    : null;
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
}: {
  readonly config: CloudflareAccessConfig | null;
}) {
  const { t } = useTranslation();
  const replace = useGet(cloudflareAccessReplaceToken$);
  const setReplace = useSet(replaceCloudflareAccessToken$);
  return (
    <>
      <label className="grid gap-2">
        {t(($) => {
          return $.cloudflareAccess.name;
        })}
        <Input
          name="accessName"
          placeholder={t(($) => {
            return $.cloudflareAccess.namePlaceholder;
          })}
          required
          pattern=".*\S.*"
          maxLength={128}
          defaultValue={config?.name}
        />
      </label>
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
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.cloudflareAccess.tokenHelp;
            })}
          </p>
          <label className="grid gap-2">
            {t(($) => {
              return $.cloudflareAccess.clientId;
            })}
            <Input
              name="clientId"
              placeholder={t(($) => {
                return $.cloudflareAccess.clientIdPlaceholder;
              })}
              required
              type="password"
              pattern="[!-~]+"
              maxLength={CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH}
              autoComplete="new-password"
              spellCheck={false}
              onPaste={pasteAccessCredentials}
            />
          </label>
          <label className="grid gap-2">
            {t(($) => {
              return $.cloudflareAccess.clientSecret;
            })}
            <Input
              name="clientSecret"
              placeholder={t(($) => {
                return $.cloudflareAccess.clientSecretPlaceholder;
              })}
              required
              type="password"
              pattern="[!-~]+"
              maxLength={CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH}
              autoComplete="new-password"
              spellCheck={false}
              onPaste={pasteAccessCredentials}
            />
          </label>
        </>
      )}
    </>
  );
}

function useCloudflareAccessDialogCopy(
  kind: CloudflareAccessDialogState["kind"] | undefined,
) {
  const { t } = useTranslation();
  switch (kind) {
    case "create": {
      return {
        title: t(($) => {
          return $.cloudflareAccess.add;
        }),
        description: null,
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

function CloudflareAccessSaveNotice({
  isSaving,
}: {
  readonly isSaving: boolean;
}) {
  const { t } = useTranslation();
  const uncertain = useGet(cloudflareAccessSaveUncertain$);
  const message = useGet(cloudflareAccessSaveMessage$);
  if (isSaving || (!uncertain && !message)) {
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

function CloudflareAccessFormActions({
  isSaving,
  blocked,
  destructive,
  title,
}: {
  readonly isSaving: boolean;
  readonly blocked: boolean;
  readonly destructive: boolean;
  readonly title: string;
}) {
  const { t } = useTranslation();
  const close = useSet(closeCloudflareAccessDialog$);
  const uncertain = useGet(cloudflareAccessSaveUncertain$);
  return (
    <div className="flex shrink-0 justify-end gap-2">
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
        type="submit"
        disabled={isSaving || (!uncertain && blocked)}
        variant={destructive ? "destructive" : "default"}
      >
        {isSaving
          ? t(($) => {
              return $.connectors.actions.saving;
            })
          : uncertain
            ? t(($) => {
                return $.cloudflareAccess.retry;
              })
            : destructive
              ? title
              : t(($) => {
                  return $.cloudflareAccess.save;
                })}
      </Button>
    </div>
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

export function CloudflareAccessDialog() {
  const { t } = useTranslation();
  const data = useLoadable(cloudflareAccessDialog$);
  const close = useSet(closeCloudflareAccessDialog$);
  const [saving, save] = useLoadableSet(saveCloudflareAccess$);
  const mount = useSet(mountCloudflareAccessForm$);
  const signal = useGet(pageSignal$);
  const conflict = useGet(cloudflareAccessConflict$);
  const uncertain = useGet(cloudflareAccessSaveUncertain$);
  const admin = useLoadable(isOrgAdmin$);
  const createScope = useGet(cloudflareAccessCreateScope$);
  const dialog = data.state === "hasData" ? data.data : null;
  const { title, description } = useCloudflareAccessDialogCopy(dialog?.kind);
  const isSaving = saving.state === "loading";
  if (!dialog) {
    return null;
  }
  const destructive = dialog.kind === "delete";
  const scope = dialog.kind === "create" ? createScope : dialog.scope;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) {
          close();
        }
      }}
    >
      <DialogContent
        contentClassName="flex flex-col"
        key={`${dialog.identity}:${dialog.kind}:${dialog.config?.id ?? "new"}`}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          ref={mount}
          className="flex min-h-0 min-w-0 flex-col gap-4"
          autoComplete="off"
          aria-busy={isSaving}
          onSubmit={(event) => {
            event.preventDefault();
            if (!isSaving && (uncertain || !conflict)) {
              detach(save(event.currentTarget, signal), Reason.DomCallback);
            }
          }}
        >
          <DialogBody className="grid gap-4">
            {dialog.kind === "create" &&
              admin.state === "hasData" &&
              admin.data && (
                <CloudflareAccessScopeSelect
                  value={scope}
                  disabled={isSaving || uncertain}
                />
              )}
            {scope === "organization" && (
              <p className="text-sm text-muted-foreground">
                {t(($) => {
                  return $.cloudflareAccess.organizationHelp;
                })}
              </p>
            )}
            {!destructive && (
              <fieldset
                disabled={isSaving || uncertain}
                className="grid min-w-0 gap-4"
              >
                <AccessFields config={dialog.config} />
              </fieldset>
            )}
            {dialog.config && <AccessImpact config={dialog.config} />}
            <CloudflareAccessConflictReview />
            <CloudflareAccessSaveNotice isSaving={isSaving} />
          </DialogBody>
          <CloudflareAccessFormActions
            isSaving={isSaving}
            blocked={isSaving || !!conflict}
            destructive={destructive}
            title={title}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CloudflareAccessAffectedMembers({
  preview,
}: {
  readonly preview: CloudflareAccessImpactPreview;
}) {
  const { t } = useTranslation();
  if (preview.otherHostCount === 0) {
    return null;
  }
  const nameCounts = new Map<string, number>();
  const suffixCounts = new Map<string, number>();
  for (const owner of preview.affectedOwners) {
    if (owner.displayName) {
      nameCounts.set(
        owner.displayName,
        (nameCounts.get(owner.displayName) ?? 0) + 1,
      );
    }
    const suffix = owner.userId.slice(-8);
    suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
  }
  return (
    <>
      <p role="alert">
        {t(
          ($) => {
            return $.cloudflareAccess.impactSummary;
          },
          {
            members: t(
              ($) => {
                return $.cloudflareAccess.affectedMembers;
              },
              { count: preview.affectedOwners.length },
            ),
            hosts: t(
              ($) => {
                return $.cloudflareAccess.hostCount;
              },
              { count: preview.otherHostCount },
            ),
          },
        )}
      </p>
      <ul className="list-inside list-disc">
        {preview.affectedOwners.map(({ userId, displayName }) => {
          const ambiguous =
            !displayName || (nameCounts.get(displayName) ?? 0) > 1;
          const tail = userId.slice(-8);
          const identifier =
            (suffixCounts.get(tail) ?? 0) > 1 ? userId : `…${tail}`;
          return (
            <li key={userId}>
              {displayName ??
                t(($) => {
                  return $.cloudflareAccess.nameUnavailable;
                })}
              {ambiguous &&
                t(
                  ($) => {
                    return $.cloudflareAccess.memberIdentifier;
                  },
                  { identifier },
                )}
            </li>
          );
        })}
      </ul>
    </>
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
          <CloudflareAccessAffectedMembers preview={preview} />
          <label className="flex items-start gap-2">
            <Checkbox
              checked={confirmed}
              disabled={isSaving}
              onCheckedChange={(checked) => {
                acknowledge(checked ? preview.impactSnapshot : null);
              }}
            />
            {t(($) => {
              return $.cloudflareAccess.convertConfirm;
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

function CloudflareAccessDeletionReview({
  isSaving,
  error,
}: {
  readonly isSaving: boolean;
  readonly error: string | null;
}) {
  const { t } = useTranslation();
  const preview = useLoadable(cloudflareAccessDeletionPreview$);
  const impact = preview.state === "hasData" ? preview.data : null;
  const acknowledged = useGet(cloudflareAccessDeletionAcknowledged$);
  const acknowledge = useSet(acknowledgeCloudflareAccessDeletion$);
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
            return $.cloudflareAccess.inUseHelp;
          })}
        </p>
      )}
      {impact && impact.otherHostCount > 0 && (
        <div className="grid gap-3 rounded-lg border p-4 text-sm">
          <CloudflareAccessAffectedMembers preview={impact} />
          <label className="flex items-start gap-2">
            <Checkbox
              checked={acknowledged === impact.impactSnapshot}
              disabled={isSaving || !!error || impact.ownHostCount > 0}
              onCheckedChange={(checked) => {
                return acknowledge(checked ? impact.impactSnapshot : null);
              }}
            />
            {t(($) => {
              return $.cloudflareAccess.deleteConfirm;
            })}
          </label>
        </div>
      )}
    </>
  );
}

export function CloudflareAccessDeletionDialog() {
  const { t } = useTranslation();
  const dialog = useLoadable(cloudflareAccessDeletionDialog$);
  const preview = useLoadable(cloudflareAccessDeletionPreview$);
  const acknowledged = useGet(cloudflareAccessDeletionAcknowledged$);
  const error = useGet(cloudflareAccessDeletionError$);
  const close = useSet(closeCloudflareAccessDeletion$);
  const review = useSet(reviewCloudflareAccessDeletion$);
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
          <CloudflareAccessDeletionReview isSaving={isSaving} error={error} />
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
          {(error || preview.state === "hasError") && (
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={review}
            >
              {t(($) => {
                return $.cloudflareAccess.reviewLatest;
              })}
            </Button>
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
  const review = useSet(reviewCloudflareAccessConversion$);
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
              <Button type="button" variant="outline" onClick={review}>
                {t(($) => {
                  return $.cloudflareAccess.retry;
                })}
              </Button>
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
          {error && (
            <Button
              type="button"
              variant="outline"
              onClick={review}
              disabled={isSaving}
            >
              {t(($) => {
                return $.cloudflareAccess.reviewLatest;
              })}
            </Button>
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

function CloudflareAccessSection({
  scope,
  configs,
  canManage,
  canPromote = false,
}: {
  readonly scope: "personal" | "organization";
  readonly configs: readonly ScopedCloudflareAccessConfig[];
  readonly canManage: boolean;
  readonly canPromote?: boolean;
}) {
  const { t } = useTranslation();
  const open = useSet(openCloudflareAccessDialog$);
  const openConversion = useSet(openCloudflareAccessConversion$);
  const openPromotion = useSet(openCloudflareAccessPromotion$);
  const openDeletion = useSet(openCloudflareAccessDeletion$);
  const signal = useGet(pageSignal$);
  return (
    <section
      aria-label={t(($) => {
        return scope === "personal"
          ? $.cloudflareAccess.personal
          : $.cloudflareAccess.organization;
      })}
      className="grid gap-3"
    >
      <h2 className="text-base font-semibold">
        {t(($) => {
          return scope === "personal"
            ? $.cloudflareAccess.personal
            : $.cloudflareAccess.organization;
        })}
      </h2>
      {configs.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.sectionEmpty;
          })}
        </p>
      )}
      {configs.map((config) => {
        return (
          <article
            key={config.id}
            className={surfaceVariants({ className: "grid gap-3 p-5" })}
          >
            <h3 className="font-semibold">{config.name}</h3>
            <AccessImpact config={config} />
            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    return detach(
                      open("edit", config, signal),
                      Reason.DomCallback,
                    );
                  }}
                >
                  {t(($) => {
                    return $.cloudflareAccess.edit;
                  })}
                </Button>
                {scope === "personal" && canPromote && (
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
                {scope === "organization" && (
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
                <Button
                  variant="outline"
                  disabled={config.sshHosts.length > 0}
                  onClick={() => {
                    return detach(
                      scope === "organization"
                        ? openDeletion(config, signal)
                        : open("delete", config, signal),
                      Reason.DomCallback,
                    );
                  }}
                >
                  {t(($) => {
                    return $.cloudflareAccess.delete;
                  })}
                </Button>
              </div>
            )}
            {canManage && config.sshHosts.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t(($) => {
                  return $.cloudflareAccess.inUseHelp;
                })}
              </p>
            )}
          </article>
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
