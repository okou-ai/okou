import { ArrowRight } from "lucide-react";
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
                <span className="text-sm leading-5 text-muted-foreground">
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
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteNetworkScope.adminRule;
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
  return (
    <>
      <dt className="text-muted-foreground">
        {t(($) => {
          return $.cloudflareAccess.scope;
        })}
      </dt>
      <dd className="break-words">
        {scope === "organization"
          ? `${organization} · ${t(($) => {
              return $.remoteNetworkScope.members;
            })}`
          : t(($) => {
              return $.remoteNetworkScope.onlyMe;
            })}
      </dd>
    </>
  );
}
function useScopeReview(busy: boolean) {
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
    busy ||
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
    busy,
  };
}

function ScopeChangeError({
  error,
}: {
  readonly error: ReturnType<typeof useScopeReview>["error"];
}) {
  const { t } = useTranslation();
  return error ? (
    <p role="alert" className="text-sm text-muted-foreground">
      {t(($) => {
        return error === "uncertain"
          ? $.remoteNetworkScope.scopeUncertain
          : error === "conflict"
            ? $.remoteNetworkScope.scopeConflict
            : $.remoteNetworkScope.scopeUnavailable;
      })}
    </p>
  ) : null;
}

function ScopeImpactContent({ busy }: { readonly busy: boolean }) {
  const { t } = useTranslation();
  const organization = useRemoteNetworkOrganization();
  const acknowledge = useSet(acknowledgeRemoteNetworkScope$);
  const { pending, status, preview, needsAck, error, impact } =
    useScopeReview(busy);
  if (!pending) {
    return null;
  }
  return (
    <DialogBody className="grid min-h-0 gap-4 overflow-y-auto text-sm">
      <p className="font-medium">{pending.config.name}</p>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-divider bg-gray-50 p-4">
        <span>
          {`${organization} · ${t(($) => {
            return $.remoteNetworkScope.members;
          })}`}
        </span>
        <ArrowRight size={16} className="shrink-0" aria-hidden />
        <strong className="font-medium">
          {t(($) => {
            return $.remoteNetworkScope.onlyMe;
          })}
        </strong>
      </div>
      <p>
        {t(($) => {
          return $.remoteNetworkScope.restrictHelp;
        })}
      </p>
      <PrivateNetworkHostReferences config={pending.config} />
      {impact.state === "loading" && (
        <p role="status">
          {t(($) => {
            return $.remoteNetworkScope.reviewLoading;
          })}
        </p>
      )}
      {impact.state !== "loading" && !preview && (
        <p role="alert">
          {t(($) => {
            return $.remoteNetworkScope.scopeUnavailable;
          })}
        </p>
      )}
      {needsAck && preview && (
        <>
          <PrivateNetworkAffectedMembers preview={preview} />
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteNetworkScope.impactVisibility;
            })}
          </p>
          <label className="flex items-start gap-2">
            <Checkbox
              disabled={busy || !!status.error}
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
      <ScopeChangeError error={error} />
    </DialogBody>
  );
}

export function RemoteNetworkScopeConfirmation({
  provider,
  configId,
  busy,
}: {
  readonly provider: RemoteNetworkProvider;
  readonly configId?: string;
  readonly busy: boolean;
}) {
  const { t } = useTranslation();
  const review = useScopeReview(busy);
  const { pending, status, restricting, blocked } = review;
  const draft = useGet(remoteNetworkScopeDraft$);
  const cancel = useSet(cancelRemoteNetworkScope$);
  const approve = useSet(approveRemoteNetworkScope$);
  if (
    !pending ||
    pending.provider !== provider ||
    pending.configId !== configId
  ) {
    if (draft?.provider === provider && draft.configId === configId) {
      return <ScopeChangeError error={status.error} />;
    }
    return status.savedId === configId ? (
      <p role="status" className="text-sm">
        {t(($) => {
          return $.remoteNetworkScope.scopeSaved;
        })}
      </p>
    ) : null;
  }
  if (!restricting) {
    return <ScopeChangeError error={review.error} />;
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          cancel();
        }
      }}
    >
      <DialogContent contentClassName="flex max-h-[90dvh] flex-col">
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.remoteNetworkScope.restrictTitle;
            })}
          </DialogTitle>
        </DialogHeader>
        <ScopeImpactContent busy={busy} />
        <div className="flex shrink-0 flex-wrap justify-end gap-3 border-t border-divider pt-4">
          <Button
            type="button"
            variant="quiet"
            disabled={busy}
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
              return $.remoteNetworkScope.restrictAction;
            })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
