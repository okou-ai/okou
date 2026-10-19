import { ArrowRight, LockKeyhole, Network } from "lucide-react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Radio,
  RadioGroup,
} from "@okouai/ui";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";
import { org$, isOrgAdmin$ } from "../../signals/org.ts";
import {
  chooseTailscaleScope$,
  tailscaleScope$,
} from "../../signals/tailscale.ts";
import {
  chooseCloudflareAccessScope$,
  cloudflareAccessCreateScope$,
} from "../../signals/cloudflare-access.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  remoteNetworkScopeDraft$,
  editRemoteNetworkScope$,
  remoteNetworkScopeChange$,
  remoteNetworkScopeImpact$,
  remoteNetworkScopeStatus$,
  cancelRemoteNetworkScope$,
  acknowledgeRemoteNetworkScope$,
  approveRemoteNetworkScope$,
  type RemoteNetworkProvider,
} from "../../signals/remote-network-scope.ts";
import { PrivateNetworkAffectedMembers } from "./private-network-impact.tsx";
import { PrivateNetworkHostReferences } from "./private-network-host-references.tsx";

export function useRemoteNetworkOrganization() {
  const { t } = useTranslation();
  const org = useLoadable(org$);
  return org.state === "hasData" && org.data
    ? org.data.name
    : t(($) => {
        return $.remoteNetworkScope.unknownOrganization;
      });
}
export function RemoteNetworkScopeField({
  provider,
  config,
  disabled,
}: {
  readonly provider: RemoteNetworkProvider;
  readonly config: ScopedCloudflareAccessConfig | null;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const organization = useRemoteNetworkOrganization();
  const admin = useLoadable(isOrgAdmin$);
  const isAdmin = admin.state === "hasData" && admin.data;
  const draft = useGet(remoteNetworkScopeDraft$);
  const tsScope = useGet(tailscaleScope$);
  const cfScope = useGet(cloudflareAccessCreateScope$);
  const change = useSet(editRemoteNetworkScope$);
  const chooseTs = useSet(chooseTailscaleScope$);
  const chooseCf = useSet(chooseCloudflareAccessScope$);
  const signal = useGet(pageSignal$);
  const scope = config
    ? draft?.provider === provider && draft.configId === config.id
      ? draft.scope
      : config.scope
    : provider === "tailscale"
      ? tsScope
      : cfScope;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium">
        {t(($) => {
          return $.cloudflareAccess.scope;
        })}
      </legend>
      <RadioGroup
        aria-label={t(($) => {
          return $.cloudflareAccess.scope;
        })}
        value={scope}
        disabled={disabled}
        className="grid gap-3 sm:grid-cols-2"
        onValueChange={(value) => {
          if (value !== "personal" && value !== "organization") {
            return;
          }
          if (value === "organization" && !isAdmin) {
            return;
          }
          if (config) {
            change(provider, config.id, value);
          } else {
            detach(
              provider === "tailscale"
                ? chooseTs(value, signal)
                : chooseCf(value, signal),
              Reason.DomCallback,
            );
          }
        }}
      >
        {(["personal", "organization"] as const).map((value) => {
          return (
            <label
              key={value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-divider p-3.5 hover:bg-gray-50 has-data-checked:border-foreground has-data-checked:bg-gray-50 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50"
            >
              <Radio
                value={value}
                disabled={disabled || (value === "organization" && !isAdmin)}
                className="mt-0.5 shrink-0 data-checked:border-foreground data-checked:bg-foreground"
              />
              <span className="grid gap-1 text-sm">
                <strong className="font-medium">
                  {t(($) => {
                    return value === "personal"
                      ? $.remoteNetworkScope.onlyMe
                      : $.remoteNetworkScope.members;
                  })}
                </strong>
                <span className="text-xs leading-5 text-muted-foreground">
                  {t(
                    ($) => {
                      return value === "personal"
                        ? $.remoteNetworkScope.personalHelp
                        : $.remoteNetworkScope.organizationHelp;
                    },
                    { organization },
                  )}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      {(!isAdmin || scope === "organization") && (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return !isAdmin
              ? $.remoteNetworkScope.adminRule
              : $.remoteNetworkScope.separateConnections;
          })}
        </p>
      )}
    </fieldset>
  );
}
export function RemoteNetworkAccessSummary({
  scope,
}: {
  readonly scope: "personal" | "organization";
}) {
  const { t } = useTranslation();
  const organization = useRemoteNetworkOrganization();
  const admin = useLoadable(isOrgAdmin$);
  const canManage =
    scope === "personal" || (admin.state === "hasData" && admin.data);
  return (
    <section className="flex items-start gap-3 rounded-lg border border-divider bg-gray-50 p-4 text-sm">
      <span className="rounded-lg bg-card p-2">
        {scope === "organization" ? (
          <Network size={20} aria-hidden />
        ) : (
          <LockKeyhole size={20} aria-hidden />
        )}
      </span>
      <div className="grid gap-1.5">
        <span className="text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.scope;
          })}
        </span>
        <strong className="font-medium">
          {scope === "organization"
            ? `${organization} · ${t(($) => {
                return $.remoteNetworkScope.members;
              })}`
            : t(($) => {
                return $.remoteNetworkScope.onlyMe;
              })}
        </strong>
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return canManage
              ? $.remoteNetworkScope.canManage
              : $.remoteNetworkScope.canUse;
          })}
        </p>
      </div>
    </section>
  );
}
function useScopeReview() {
  const pending = useGet(remoteNetworkScopeChange$);
  const impact = useLoadable(remoteNetworkScopeImpact$);
  const status = useGet(remoteNetworkScopeStatus$);
  const restricting = pending?.scope === "personal";
  const preview = impact.state === "hasData" ? impact.data : null;
  const needsAck = restricting && (preview?.otherHostCount ?? 0) > 0;
  const error =
    status.error ??
    (restricting &&
    preview &&
    preview.expectedRevision !== pending?.config.revision
      ? "conflict"
      : null);
  const blocked =
    status.busy ||
    !!error ||
    (restricting &&
      (!preview || preview.expectedRevision !== pending?.config.revision)) ||
    (needsAck && status.acknowledged !== preview?.impactSnapshot);
  return {
    pending,
    status,
    restricting,
    preview,
    needsAck,
    blocked,
    error,
    impact,
  };
}

function ScopeImpactContent({
  review,
}: {
  readonly review: ReturnType<typeof useScopeReview>;
}) {
  const { t } = useTranslation();
  const organization = useRemoteNetworkOrganization();
  const acknowledge = useSet(acknowledgeRemoteNetworkScope$);
  const { pending, status, restricting, preview, needsAck, error, impact } =
    review;
  if (!pending) {
    return null;
  }
  return (
    <DialogBody className="grid min-h-0 gap-4 overflow-y-auto text-sm">
      <p className="font-medium">{pending.config.name}</p>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-divider bg-gray-50 p-4">
        <span>
          {restricting
            ? `${organization} · ${t(($) => {
                return $.remoteNetworkScope.members;
              })}`
            : t(($) => {
                return $.remoteNetworkScope.onlyMe;
              })}
        </span>
        <ArrowRight size={16} className="shrink-0" aria-hidden />
        <strong className="font-medium">
          {restricting
            ? t(($) => {
                return $.remoteNetworkScope.onlyMe;
              })
            : `${organization} · ${t(($) => {
                return $.remoteNetworkScope.members;
              })}`}
        </strong>
      </div>
      <p>
        {t(($) => {
          return restricting
            ? $.remoteNetworkScope.restrictHelp
            : $.remoteNetworkScope.separateConnections;
        })}
      </p>
      <PrivateNetworkHostReferences config={pending.config} />
      {restricting && impact.state === "loading" && (
        <p role="status">
          {t(($) => {
            return $.remoteNetworkScope.reviewLoading;
          })}
        </p>
      )}
      {restricting && impact.state !== "loading" && !preview && (
        <p role="alert">
          {t(($) => {
            return $.remoteNetworkScope.scopeUnavailable;
          })}
        </p>
      )}
      {needsAck && preview && (
        <>
          <PrivateNetworkAffectedMembers preview={preview} />
          <p className="text-xs text-muted-foreground">
            {t(($) => {
              return $.remoteNetworkScope.impactVisibility;
            })}
          </p>
          <label className="flex items-start gap-2">
            <Checkbox
              disabled={status.busy || !!status.error}
              checked={status.acknowledged === preview.impactSnapshot}
              onCheckedChange={(checked) => {
                acknowledge(checked ? preview.impactSnapshot : null);
              }}
            />
            <span>
              {t(($) => {
                return $.remoteNetworkScope.acknowledge;
              })}
            </span>
          </label>
        </>
      )}
      {error && (
        <p role="alert">
          {t(($) => {
            return error === "uncertain"
              ? $.remoteNetworkScope.scopeUncertain
              : error === "conflict"
                ? $.remoteNetworkScope.scopeConflict
                : $.remoteNetworkScope.scopeUnavailable;
          })}
        </p>
      )}
    </DialogBody>
  );
}

export function RemoteNetworkScopeConfirmation({
  provider,
  configId,
}: {
  readonly provider: RemoteNetworkProvider;
  readonly configId?: string;
}) {
  const { t } = useTranslation();
  const review = useScopeReview();
  const { pending, status, restricting, blocked } = review;
  const cancel = useSet(cancelRemoteNetworkScope$);
  const approve = useSet(approveRemoteNetworkScope$);
  if (
    !pending ||
    pending.provider !== provider ||
    pending.configId !== configId
  ) {
    return status.savedId === configId ? (
      <p role="status" className="text-sm">
        {t(($) => {
          return $.remoteNetworkScope.scopeSaved;
        })}
      </p>
    ) : null;
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          cancel();
        }
      }}
    >
      <DialogContent contentClassName="flex max-h-[90dvh] flex-col">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return restricting
                ? $.remoteNetworkScope.restrictTitle
                : $.remoteNetworkScope.shareTitle;
            })}
          </DialogTitle>
        </DialogHeader>
        <ScopeImpactContent review={review} />
        <div className="flex shrink-0 flex-wrap justify-end gap-3 border-t border-divider pt-4">
          <Button
            type="button"
            variant="quiet"
            disabled={status.busy}
            onClick={cancel}
          >
            {t(($) => {
              return $.remoteNetworkScope.keepEditing;
            })}
          </Button>
          <Button
            type="submit"
            form={`remote-network-${provider}`}
            disabled={blocked}
            onClick={approve}
          >
            {t(($) => {
              return restricting
                ? $.remoteNetworkScope.restrictAction
                : $.remoteNetworkScope.shareAction;
            })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
