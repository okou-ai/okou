import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { AlertTriangle, Check, Monitor, Download, Loader2 } from "lucide-react";
import type {
  ComputerUseAuthorizationSource,
  ComputerUseHost,
} from "@okouai/api-contracts/contracts/computer-use";
import { Button } from "@okouai/ui/components/ui/button";
import { useTranslation } from "react-i18next";
import {
  applyComputerUseAuthorizationRequest$,
  computerUseAuthorizationRequest$,
} from "../../signals/computer-use-authorization/computer-use-authorization.ts";
import {
  desktopDownloadSupportStatus$,
  visibleComputerUseHosts,
  OKOU_DESKTOP_DOWNLOAD_URL,
} from "../../signals/okou-page/computer-use-hosts.ts";
import { computerUseProductName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { computerUseIllustrationImg } from "../okou-page/platform-assets.ts";
import { ProductBrandMarkLink } from "../okou-page/directed-shared.tsx";
import {
  AuthorizationErrorState,
  formatTime,
} from "../components/authorization-error-state.tsx";
import { locale$ } from "../../signals/locale.ts";
import { i18n } from "../../i18n/index.ts";

function sourceLabel(source: ComputerUseAuthorizationSource): string {
  switch (source) {
    case "chat": {
      return i18n.t(($) => {
        return $.authorization.computerUse.sources.chat;
      });
    }
    case "slack": {
      return i18n.t(($) => {
        return $.authorization.computerUse.sources.slack;
      });
    }
    case "teams": {
      return i18n.t(($) => {
        return $.authorization.computerUse.sources.teams;
      });
    }
  }
}

function HostOption({
  host,
  disabled,
  applying,
  applied,
  onAuthorize,
}: {
  host: ComputerUseHost;
  disabled: boolean;
  applying: boolean;
  applied: boolean;
  onAuthorize: () => void;
}) {
  const { t } = useTranslation();
  const locale = useGet(locale$);
  return (
    <div className="flex w-full flex-col gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Monitor size={18} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            <span>{host.displayName}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t(
              ($) => {
                return $.authorization.computerUse.lastSeen;
              },
              { date: formatTime(host.lastSeenAt, locale) },
            )}
          </div>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={onAuthorize}
        className="h-9 w-full shrink-0 sm:w-auto"
      >
        {applying && <Loader2 size={16} className="animate-spin" />}
        {applied ? (
          <>
            <Check size={16} />
            {t(($) => {
              return $.authorization.computerUse.authorized;
            })}
          </>
        ) : (
          t(($) => {
            return $.authorization.computerUse.authorize;
          })
        )}
      </Button>
    </div>
  );
}

function EmptyHosts() {
  const { t } = useTranslation();
  const desktopApplicationName = useGet(computerUseProductName$);
  const downloadSupportLoadable = useLoadable(desktopDownloadSupportStatus$);
  const downloadSupportStatus =
    downloadSupportLoadable.state === "hasData"
      ? downloadSupportLoadable.data
      : "checking";

  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-muted/30 px-4 py-6 text-center">
      <div className="flex h-24 w-24 items-center justify-center">
        <img
          src={computerUseIllustrationImg}
          alt=""
          className="h-24 w-24 object-contain"
        />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.authorization.computerUse.noHostsTitle;
          })}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t(
            ($) => {
              return $.authorization.computerUse.noHostsDescription;
            },
            { desktopApplicationName },
          )}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">
          {t(($) => {
            return $.authorization.computerUse.macRequirement;
          })}
        </p>
      </div>
      {downloadSupportStatus === "unsupported-intel-mac" ? (
        <Button type="button" variant="outline" disabled className="h-9">
          <AlertTriangle size={16} />
          {t(($) => {
            return $.authorization.computerUse.unsupportedIntelMac;
          })}
        </Button>
      ) : downloadSupportStatus === "checking" ? (
        <Button type="button" variant="outline" disabled className="h-9">
          {t(($) => {
            return $.authorization.computerUse.checkingCompatibility;
          })}
        </Button>
      ) : (
        <a
          href={OKOU_DESKTOP_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-state-hover"
        >
          <Download size={16} />
          {t(($) => {
            return $.authorization.computerUse.downloadMac;
          })}
        </a>
      )}
    </div>
  );
}

export function ComputerUseAuthorizationPage() {
  const { t } = useTranslation();
  const locale = useGet(locale$);
  const pageSignal = useGet(pageSignal$);
  const requestLoadable = useLoadable(computerUseAuthorizationRequest$);
  const [applyLoadable, applyAuthorization] = useLoadableSet(
    applyComputerUseAuthorizationRequest$,
  );
  const request =
    requestLoadable.state === "hasData" ? requestLoadable.data : null;
  const hosts = request?.hosts;
  const selectedHostId =
    applyLoadable.state === "hasData"
      ? applyLoadable.data.computerUseHostId
      : (request?.computerUseHostId ?? null);
  const visibleHosts = visibleComputerUseHosts(hosts ?? [], selectedHostId);

  if (requestLoadable.state === "loading") {
    return (
      <div className="fixed inset-0 z-10 flex h-viewport flex-col items-center overflow-y-auto pt-safe-offset-8 pr-safe-offset-4 pb-safe-offset-8 pl-safe-offset-4">
        <Loader2
          size={22}
          className="my-auto shrink-0 animate-spin text-muted-foreground"
        />
      </div>
    );
  }

  if (requestLoadable.state === "hasError" || !request) {
    return (
      <AuthorizationErrorState
        title={t(($) => {
          return $.authorization.computerUse.unavailableTitle;
        })}
        description={t(($) => {
          return $.authorization.computerUse.unavailableDescription;
        })}
      />
    );
  }

  const applying = applyLoadable.state === "loading";
  const completed =
    applyLoadable.state === "hasData" || Boolean(request.completedAt);

  return (
    <div className="fixed inset-0 z-10 flex h-viewport flex-col items-center overflow-y-auto pt-safe-offset-8 pr-safe-offset-4 pb-safe-offset-8 pl-safe-offset-4">
      <div className="my-auto flex w-[520px] max-w-full shrink-0 flex-col gap-6 rounded-xl border border-border bg-background px-6 py-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <ProductBrandMarkLink />
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted">
            <Monitor size={22} />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-lg font-medium text-foreground">
              {t(($) => {
                return $.authorization.computerUse.title;
              })}
            </h1>
            <p className="mx-auto max-w-md text-sm leading-5 text-muted-foreground">
              {t(
                ($) => {
                  return $.authorization.computerUse.description;
                },
                { source: sourceLabel(request.source) },
              )}
            </p>
          </div>
        </div>

        {visibleHosts.length === 0 ? (
          <EmptyHosts />
        ) : (
          <div className="flex flex-col gap-3">
            {visibleHosts.map((host) => {
              return (
                <HostOption
                  key={host.id}
                  host={host}
                  disabled={applying || completed}
                  applying={applying}
                  applied={selectedHostId === host.id}
                  onAuthorize={() => {
                    detach(
                      applyAuthorization(host, pageSignal),
                      Reason.DomCallback,
                    );
                  }}
                />
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-border pt-5">
          <div className="text-xs text-muted-foreground">
            {t(
              ($) => {
                return $.authorization.computerUse.linkExpires;
              },
              { date: formatTime(request.expiresAt, locale) },
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
