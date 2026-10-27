import {
  RemoteNetworkScopeField,
  RemoteNetworkScopeConfirmation,
} from "./remote-network-scope.tsx";
import {
  RemoteNetworkSummary,
  RemoteNetworkDeleteAction,
} from "./remote-network-summary.tsx";
import { useRemoteNetworkSaveLabel } from "./remote-network-help.tsx";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";
import { remoteNetworkScopeStatus$ } from "../../signals/remote-network-scope.ts";
import {
  RemoteEditorFrame,
  useRemoteNetworkEditorVisible,
} from "./remote-editor-frame.tsx";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { privateNetworkHostCount } from "../../lib/private-network-references.ts";
import { PrivateNetworkHostReferences } from "./private-network-host-references.tsx";
import { useLoadableSet } from "ccstate-react/experimental";
import { RemoteFormFooter } from "./remote-form-footer.tsx";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../lib/api-error.ts";
import { Plus } from "lucide-react";
import {
  Button,
  Checkbox,
  DialogBody,
  LoadErrorRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  surfaceVariants,
} from "@okouai/ui";
import type {
  TailscaleConfig,
  TailscaleImpactPreview,
} from "@okouai/api-contracts/contracts/tailscale";
import {
  acknowledgeTailscale$,
  chooseTailscaleScope$,
  closeTailscaleDialog$,
  mountTailscaleForm$,
  openTailscaleDialog$,
  saveTailscale$,
  tailscaleAcknowledged$,
  tailscaleConfigs$,
  tailscaleDialog$,
  tailscaleImpact$,
  tailscaleSaveUncertain$,
  tailscaleScope$,
  type TailscaleOperation,
  type TailscaleDialogState,
} from "../../signals/tailscale.ts";
import { localizedTailscaleError } from "../../lib/tailscale-error.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { TailscaleFields } from "./tailscale-fields.tsx";
import { PrivateNetworkAffectedMembers } from "./private-network-impact.tsx";

function useOperationCopy(kind: TailscaleOperation | undefined) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  switch (kind) {
    case "edit": {
      return {
        title: t(($) => {
          return $.tailscale.edit;
        }),
        description: undefined,
      };
    }
    case "delete": {
      return {
        title: t(($) => {
          return $.tailscale.delete;
        }),
        description: t(($) => {
          return $.tailscale.deleteHelp;
        }),
      };
    }
    case "promote": {
      return {
        title: t(($) => {
          return $.cloudflareAccess.promote;
        }),
        description: t(($) => {
          return $.tailscale.promoteHelp;
        }),
      };
    }
    case "adopt": {
      return {
        title: t(($) => {
          return $.cloudflareAccess.convert;
        }),
        description: t(($) => {
          return $.tailscale.adoptHelp;
        }),
      };
    }
    default: {
      return {
        title: t(($) => {
          return guided ? $.remoteNetworkScope.addTailscale : $.tailscale.add;
        }),
        description: guided
          ? t(($) => {
              return $.remoteNetworkScope.scopeDescription;
            })
          : undefined,
      };
    }
  }
}

function TailscaleScope({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const scope = useGet(tailscaleScope$);
  const choose = useSet(chooseTailscaleScope$);
  const signal = useGet(pageSignal$);
  const items = [
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
  ];
  return (
    <div className="grid gap-2">
      <span id="tailscale-scope-label">
        {t(($) => {
          return $.cloudflareAccess.scope;
        })}
      </span>
      <Select
        items={items}
        value={scope}
        disabled={disabled}
        onValueChange={(value, details) => {
          if (value !== "personal" && value !== "organization") {
            details.cancel();
            return;
          }
          detach(choose(value, signal), Reason.DomCallback);
        }}
      >
        <SelectTrigger aria-labelledby="tailscale-scope-label">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function TailscaleHostReferences({
  config,
}: {
  readonly config: TailscaleConfig;
}) {
  return <PrivateNetworkHostReferences config={config} />;
}

function TailscaleImpact({
  preview,
  disabled,
}: {
  readonly preview: TailscaleImpactPreview;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const acknowledged = useGet(tailscaleAcknowledged$);
  const acknowledge = useSet(acknowledgeTailscale$);
  if (preview.otherHostCount === 0) {
    return null;
  }
  return (
    <div className="grid gap-3 rounded-lg border p-4 text-sm">
      <PrivateNetworkAffectedMembers preview={preview} />
      <label className="flex items-start gap-2">
        <Checkbox
          disabled={disabled}
          checked={acknowledged === preview.impactSnapshot}
          onCheckedChange={(checked) => {
            return acknowledge(checked ? preview.impactSnapshot : null);
          }}
        />
        {t(($) => {
          return $.vnc.native.impactConfirm;
        })}
      </label>
    </div>
  );
}

function TailscaleSaveNotice({
  dialog,
  error,
}: {
  readonly dialog: TailscaleDialogState;
  readonly error: string | null;
}) {
  const { t } = useTranslation();
  const uncertain = useGet(tailscaleSaveUncertain$);
  if (!error && !uncertain) {
    return null;
  }
  const shared =
    dialog.kind === "adopt" ||
    (dialog.kind === "delete" && dialog.config?.scope === "organization");
  if (shared || dialog.kind === "promote") {
    return (
      <div className="grid gap-3 text-sm">
        <p role="alert">
          {error === "uncertain"
            ? t(($) => {
                return dialog.kind === "delete"
                  ? $.cloudflareAccess.deleteUncertain
                  : dialog.kind === "promote"
                    ? $.cloudflareAccess.promoteUncertain
                    : $.cloudflareAccess.convertUncertain;
              })
            : (localizedTailscaleError(error ?? "") ??
              t(($) => {
                return $.tailscale.failed;
              }))}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-3 text-sm">
      <p role="alert">
        {uncertain
          ? t(($) => {
              return $.tailscale.uncertain;
            })
          : (localizedTailscaleError(error ?? "") ??
            t(($) => {
              return $.tailscale.failed;
            }))}
      </p>
    </div>
  );
}

function TailscaleOperationBody({
  config,
  kind,
  disabled,
}: {
  readonly config: TailscaleConfig;
  readonly kind: TailscaleOperation;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const impact = useLoadable(tailscaleImpact$);
  const acknowledged = useGet(tailscaleAcknowledged$);
  const acknowledge = useSet(acknowledgeTailscale$);
  return (
    <div className="grid gap-3">
      <p className="font-medium">{config.name}</p>
      <TailscaleHostReferences config={config} />
      {kind === "promote" && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            disabled={disabled}
            checked={acknowledged === "promote"}
            onCheckedChange={(checked) => {
              return acknowledge(checked ? "promote" : null);
            }}
          />
          {t(($) => {
            return $.tailscale.promoteConfirm;
          })}
        </label>
      )}
      {config.scope === "organization" &&
        (kind === "delete" || kind === "adopt") && (
          <>
            {impact.state === "loading" && (
              <p role="status">
                {t(($) => {
                  return $.tailscale.loading;
                })}
              </p>
            )}
            {impact.state === "hasError" && (
              <LoadErrorRow
                message={t(($) => {
                  return $.tailscale.loadFailed;
                })}
              />
            )}
            {impact.state === "hasData" && impact.data && (
              <TailscaleImpact
                preview={impact.data}
                disabled={
                  disabled ||
                  (kind === "delete" && impact.data.ownHostCount > 0)
                }
              />
            )}
          </>
        )}
      {kind === "delete" &&
        (privateNetworkHostCount(config) > 0 ||
          (impact.state === "hasData" &&
            (impact.data?.ownHostCount ?? 0) > 0)) && (
          <p role="alert" className="text-sm">
            {t(($) => {
              return $.vnc.native.inUse;
            })}
          </p>
        )}
    </div>
  );
}

function useOperationBlocked(
  kind: TailscaleOperation | undefined,
  config: TailscaleConfig | null,
) {
  const impact = useLoadable(tailscaleImpact$);
  const acknowledged = useGet(tailscaleAcknowledged$);
  if (kind === "promote") {
    return acknowledged !== "promote";
  }
  if (kind === "delete" && config?.scope === "personal") {
    return privateNetworkHostCount(config) > 0;
  }
  if (
    config?.scope === "organization" &&
    (kind === "delete" || kind === "adopt")
  ) {
    return (
      impact.state !== "hasData" ||
      !impact.data ||
      (impact.data.otherHostCount > 0 &&
        acknowledged !== impact.data.impactSnapshot) ||
      (kind === "delete" && impact.data.ownHostCount > 0)
    );
  }
  return false;
}

function TailscaleFormFields({
  dialog,
  disabled,
}: {
  readonly dialog: TailscaleDialogState;
  readonly disabled: boolean;
}) {
  const admin = useLoadable(isOrgAdmin$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const edit = dialog.kind === "create" || dialog.kind === "edit";
  return (
    <>
      {!guided &&
        dialog.kind === "create" &&
        admin.state === "hasData" &&
        admin.data && <TailscaleScope disabled={disabled} />}
      {edit ? (
        <fieldset disabled={disabled} className="grid min-w-0 gap-4">
          <TailscaleFields
            config={dialog.config}
            disabled={disabled}
            scopeField={
              guided ? (
                <RemoteNetworkScopeField
                  provider="tailscale"
                  config={dialog.config}
                  disabled={disabled}
                />
              ) : undefined
            }
          />
        </fieldset>
      ) : (
        dialog.config && (
          <TailscaleOperationBody
            kind={dialog.kind}
            config={dialog.config}
            disabled={disabled}
          />
        )
      )}
    </>
  );
}

function tailscaleRequestErrorCode(error: unknown): string {
  // Credential requests must never display raw transport or provider messages.
  return error instanceof ApiError && error.status < 500
    ? error.code
    : "uncertain";
}

function useTailscaleFormSubmission(
  saveAction: typeof saveTailscale$,
  dialog: TailscaleDialogState,
) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const saveLabel = useRemoteNetworkSaveLabel();
  const uncertain = useGet(tailscaleSaveUncertain$);
  const [operation, save] = useLoadableSet(saveAction);
  const error =
    operation.state === "hasError"
      ? tailscaleRequestErrorCode(operation.error)
      : null;
  const signal = useGet(pageSignal$);
  const { title, description } = useOperationCopy(dialog?.kind);
  const operationBlocked = useOperationBlocked(dialog.kind, dialog.config);
  const blocked =
    operationBlocked ||
    (!!error && error !== "invalid" && error !== "INVALID_INPUT");
  const scopeStatus = useGet(remoteNetworkScopeStatus$);
  const busy = operation.state === "loading";
  const edit = dialog?.kind === "create" || dialog?.kind === "edit";
  return {
    dialog,
    title,
    description,
    busy,
    uncertain,
    error,
    submitDisabled: busy || uncertain || blocked || !!scopeStatus.error,
    submitLabel: busy
      ? t(($) => {
          return $.connectors.actions.saving;
        })
      : guided && dialog?.kind !== "delete"
        ? saveLabel
        : edit
          ? t(($) => {
              return $.cloudflareAccess.save;
            })
          : title,
    submit(form: HTMLFormElement) {
      if (!busy && !uncertain && !scopeStatus.error && !blocked) {
        detach(save(form, signal), Reason.DomCallback);
      }
    },
  };
}

export function TailscaleDialog({
  inline = false,
  saveAction = saveTailscale$,
}: {
  readonly inline?: boolean;
  readonly saveAction?: typeof saveTailscale$;
} = {}) {
  const dialog = useLastResolved(tailscaleDialog$);
  const visible = useRemoteNetworkEditorVisible(inline, dialog);
  return dialog && visible ? (
    <TailscaleDialogForm
      key={`${dialog.identity}:${dialog.kind}:${dialog.config?.id ?? "new"}`}
      dialog={dialog}
      inline={inline}
      saveAction={saveAction}
    />
  ) : null;
}

function TailscaleDialogForm({
  dialog,
  inline,
  saveAction,
}: {
  readonly dialog: TailscaleDialogState;
  readonly inline: boolean;
  readonly saveAction: typeof saveTailscale$;
}) {
  const { t } = useTranslation();
  const {
    title,
    description,
    busy,
    uncertain,
    error,
    submitDisabled,
    submitLabel,
    submit,
  } = useTailscaleFormSubmission(saveAction, dialog);
  const close = useSet(closeTailscaleDialog$);
  const mount = useSet(mountTailscaleForm$);
  return (
    <RemoteEditorFrame
      key={`${dialog.identity}:${dialog.kind}:${dialog.config?.id ?? "new"}`}
      inline={inline}
      title={title}
      description={description}
      busy={busy}
      onClose={close}
    >
      <form
        id="remote-network-tailscale"
        ref={mount}
        autoComplete="off"
        className="flex min-h-0 min-w-0 flex-col gap-4"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          submit(event.currentTarget);
        }}
      >
        <DialogBody className="grid gap-4">
          <TailscaleFormFields dialog={dialog} disabled={busy || uncertain} />
          {!busy && (error !== null || uncertain) && (
            <TailscaleSaveNotice dialog={dialog} error={error} />
          )}
          <RemoteNetworkScopeConfirmation
            busy={busy}
            provider="tailscale"
            configId={dialog.config?.id}
          />
        </DialogBody>
        <RemoteFormFooter
          separated={inline}
          onCancel={inline ? undefined : close}
          cancelLabel={t(($) => {
            return $.cloudflareAccess.cancel;
          })}
          cancelDisabled={busy}
          submitDisabled={submitDisabled}
          destructive={dialog.kind === "delete"}
          submitLabel={submitLabel}
        />
      </form>
    </RemoteEditorFrame>
  );
}

function TailscaleConfigCard({
  config,
  compact,
  scope,
  canManage,
  admin,
}: {
  readonly config: TailscaleConfig;
  readonly compact: boolean;
  readonly scope: "personal" | "organization";
  readonly canManage: boolean;
  readonly admin: boolean;
}) {
  const { t } = useTranslation();
  const open = useSet(openTailscaleDialog$);
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
        <RemoteNetworkSummary
          config={config}
          kind="tailscale"
          tags={config.tags}
        />
      ) : (
        <>
          <h4 className="font-semibold">{config.name}</h4>
          <p className="text-sm text-muted-foreground">
            {config.tags.join(", ")}
          </p>
          <TailscaleHostReferences config={config} />
        </>
      )}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={compact ? "neutral" : "outline"}
            onClick={() => {
              return detach(open("edit", config, signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return compact
                ? $.remoteControlSetup.networkEditSettings
                : $.tailscale.edit;
            })}
          </Button>
          {admin && !compact && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                return detach(
                  open(
                    scope === "personal" ? "promote" : "adopt",
                    config,
                    signal,
                  ),
                  Reason.DomCallback,
                );
              }}
            >
              {scope === "personal"
                ? t(($) => {
                    return $.cloudflareAccess.promote;
                  })
                : t(($) => {
                    return $.cloudflareAccess.convert;
                  })}
            </Button>
          )}
          <RemoteNetworkDeleteAction
            label={t(($) => {
              return $.tailscale.delete;
            })}
            compact={compact}
            disabled={privateNetworkHostCount(config) > 0}
            onClick={() => {
              return detach(open("delete", config, signal), Reason.DomCallback);
            }}
          />
        </div>
      )}
    </article>
  );
}

export function TailscaleSection({
  compact = false,
  scope,
  configs,
  admin,
}: {
  readonly compact?: boolean;
  readonly scope: "personal" | "organization";
  readonly configs: readonly TailscaleConfig[];
  readonly admin: boolean;
}) {
  const { t } = useTranslation();
  const canManage = scope === "personal" || admin;
  return (
    <section
      className="grid gap-3"
      aria-label={
        scope === "personal"
          ? t(($) => {
              return $.cloudflareAccess.personal;
            })
          : t(($) => {
              return $.cloudflareAccess.organization;
            })
      }
    >
      {!compact && (
        <h3 className="text-base font-semibold">
          {scope === "personal"
            ? t(($) => {
                return $.cloudflareAccess.personal;
              })
            : t(($) => {
                return $.cloudflareAccess.organization;
              })}
        </h3>
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
          <TailscaleConfigCard
            key={config.id}
            config={config}
            compact={compact}
            scope={scope}
            canManage={canManage}
            admin={admin}
          />
        );
      })}
    </section>
  );
}

export function TailscaleManagement() {
  const { t } = useTranslation();
  const configs = useLoadable(tailscaleConfigs$);
  const admin = useLoadable(isOrgAdmin$);
  const open = useSet(openTailscaleDialog$);
  const signal = useGet(pageSignal$);
  return (
    <section
      className="grid gap-4"
      aria-label={t(($) => {
        return $.tailscale.title;
      })}
    >
      {configs.state === "hasData" && configs.data && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t(
              ($) => {
                return $.tailscale.summary;
              },
              { count: configs.data.length },
            )}
          </p>
          <Button
            type="button"
            onClick={() => {
              return detach(open("create", null, signal), Reason.DomCallback);
            }}
          >
            <Plus size={16} aria-hidden="true" />
            {t(($) => {
              return $.tailscale.add;
            })}
          </Button>
        </div>
      )}
      {configs.state === "loading" && (
        <p role="status">
          {t(($) => {
            return $.tailscale.loading;
          })}
        </p>
      )}
      {configs.state === "hasError" && (
        <LoadErrorRow
          message={t(($) => {
            return $.tailscale.loadFailed;
          })}
        />
      )}
      {configs.state === "hasData" && configs.data && (
        <>
          <TailscaleSection
            scope="personal"
            configs={configs.data.filter((config) => {
              return config.scope === "personal";
            })}
            admin={admin.state === "hasData" && admin.data}
          />
          <TailscaleSection
            scope="organization"
            configs={configs.data.filter((config) => {
              return config.scope === "organization";
            })}
            admin={admin.state === "hasData" && admin.data}
          />
        </>
      )}
      <TailscaleDialog />
    </section>
  );
}
