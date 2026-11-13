import { LoadingSkeleton } from "../components/loading-skeleton.tsx";
import {
  RemoteNetworkScopeField,
  RemoteNetworkScopeConfirmation,
} from "./remote-network-scope.tsx";
import {
  RemoteNetworkSummary,
  RemoteNetworkDeleteAction,
} from "./remote-network-summary.tsx";
import { useRemoteNetworkSaveLabel } from "./remote-network-help.tsx";
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
import { Button, Checkbox, DialogBody, LoadErrorRow } from "@okouai/ui";
import type {
  TailscaleConfig,
  TailscaleImpactPreview,
} from "@okouai/api-contracts/contracts/tailscale";
import {
  acknowledgeTailscale$,
  closeTailscaleDialog$,
  mountTailscaleForm$,
  openTailscaleDialog$,
  saveTailscale$,
  tailscaleAcknowledged$,
  tailscaleDialog$,
  tailscaleImpact$,
  tailscaleSaveUncertain$,
  type TailscaleOperation,
  type TailscaleDialogState,
} from "../../signals/tailscale.ts";
import { localizedTailscaleError } from "../../lib/tailscale-error.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { TailscaleFields } from "./tailscale-fields.tsx";
import { PrivateNetworkAffectedMembers } from "./private-network-impact.tsx";

function useOperationCopy(kind: TailscaleOperation | undefined) {
  const { t } = useTranslation();
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
    default: {
      return {
        title: t(($) => {
          return $.remoteNetworkScope.addTailscale;
        }),
        description: t(($) => {
          return $.remoteNetworkScope.scopeDescription;
        }),
      };
    }
  }
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
  if (dialog.kind === "delete" && dialog.config?.scope === "organization") {
    return (
      <div className="grid gap-3 text-sm">
        <p role="alert">
          {error === "uncertain"
            ? t(($) => {
                return $.cloudflareAccess.deleteUncertain;
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

function TailscaleDeletionBody({
  config,
  disabled,
}: {
  readonly config: TailscaleConfig;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const impact = useLoadable(tailscaleImpact$);
  return (
    <div className="grid gap-3">
      <p className="font-medium">{config.name}</p>
      <TailscaleHostReferences config={config} />
      {config.scope === "organization" && (
        <>
          {impact.state === "loading" && (
            <LoadingSkeleton
              label={t(($) => {
                return $.tailscale.loading;
              })}
              variant="text"
            />
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
              disabled={disabled || impact.data.ownHostCount > 0}
            />
          )}
        </>
      )}
      {(privateNetworkHostCount(config) > 0 ||
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
  if (kind === "delete" && config?.scope === "personal") {
    return privateNetworkHostCount(config) > 0;
  }
  if (config?.scope === "organization" && kind === "delete") {
    return (
      impact.state !== "hasData" ||
      !impact.data ||
      (impact.data.otherHostCount > 0 &&
        acknowledged !== impact.data.impactSnapshot) ||
      impact.data.ownHostCount > 0
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
  const edit = dialog.kind === "create" || dialog.kind === "edit";
  return (
    <>
      {edit ? (
        <fieldset disabled={disabled} className="grid min-w-0 gap-4">
          <TailscaleFields
            config={dialog.config}
            disabled={disabled}
            scopeField={
              <RemoteNetworkScopeField
                provider="tailscale"
                config={dialog.config}
                disabled={disabled}
              />
            }
          />
        </fieldset>
      ) : (
        dialog.config && (
          <TailscaleDeletionBody config={dialog.config} disabled={disabled} />
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
      : dialog.kind !== "delete"
        ? saveLabel
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
  canManage,
}: {
  readonly config: TailscaleConfig;
  readonly canManage: boolean;
}) {
  const { t } = useTranslation();
  const open = useSet(openTailscaleDialog$);
  const signal = useGet(pageSignal$);
  return (
    <article className="grid gap-5">
      <RemoteNetworkSummary
        config={config}
        kind="tailscale"
        tags={config.tags}
      />
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="neutral"
            onClick={() => {
              return detach(open("edit", config, signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.remoteControlSetup.networkEditSettings;
            })}
          </Button>
          <RemoteNetworkDeleteAction
            label={t(($) => {
              return $.tailscale.delete;
            })}
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
  scope,
  configs,
  admin,
}: {
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
      {configs.map((config) => {
        return (
          <TailscaleConfigCard
            key={config.id}
            config={config}
            canManage={canManage}
          />
        );
      })}
    </section>
  );
}
