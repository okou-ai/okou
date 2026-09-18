import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Monitor, Plug, Plus, RefreshCw } from "lucide-react";
import { Button, SegmentControl, SegmentControlItem } from "@okouai/ui";
import type { VncConnectionResponse } from "@okouai/api-contracts/contracts/vnc-connections";
import type { VncCredentialResponse } from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  changeVncView$,
  invalidateVnc$,
  openVncDialog$,
  vncConnections$,
  vncCredentials$,
  vncView$,
} from "../../signals/vnc.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import {
  DetailPageBreadcrumbBar,
  DetailPageHeader,
  DetailPageMain,
  DetailPageShell,
} from "../components/detail-page-layout.tsx";
import { VncCredentialImpact } from "./vnc-fields.tsx";
import { VncDialog } from "./vnc-dialog.tsx";
import { VncLoadError } from "./vnc-load-error.tsx";

function VncHostCard({
  connection,
}: {
  readonly connection: VncConnectionResponse;
}) {
  const { t } = useTranslation();
  const open = useSet(openVncDialog$);
  const signal = useGet(pageSignal$);
  return (
    <article className="grid gap-3 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="break-all font-semibold">{connection.displayName}</h2>
        <span className="text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.configured;
          })}
        </span>
      </div>
      <p className="break-all text-sm">
        {connection.host.includes(":")
          ? `[${connection.host}]`
          : connection.host}
        :{connection.port}
      </p>
      <p className="break-all text-sm text-muted-foreground">
        {connection.credentialName}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.security.profile;
        })}
        {" · "}
        {connection.security.trust.mode === "system"
          ? t(($) => {
              return $.vnc.security.system;
            })
          : t(($) => {
              return $.vnc.security.custom;
            })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            detach(open("edit", connection, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.vnc.edit;
          })}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            detach(open("delete", connection, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.vnc.delete;
          })}
        </Button>
      </div>
    </article>
  );
}

function VncHosts() {
  const { t } = useTranslation();
  const hosts = useLoadable(vncConnections$);
  const open = useSet(openVncDialog$);
  const signal = useGet(pageSignal$);
  if (hosts.state === "loading") {
    return (
      <p role="status">
        {t(($) => {
          return $.vnc.loading;
        })}
      </p>
    );
  }
  if (hosts.state === "hasError") {
    return <VncLoadError />;
  }
  if (!hosts.data) {
    return (
      <p>
        {t(($) => {
          return $.vnc.unavailable;
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
              return $.vnc.summary;
            },
            { count: hosts.data.length },
          )}
        </p>
        <Button
          onClick={() => {
            detach(open("create", null, signal), Reason.DomCallback);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.vnc.add;
          })}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.configurationHelp;
        })}
      </p>
      {hosts.data.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.empty;
          })}
        </p>
      )}
      {hosts.data.map((connection) => {
        return <VncHostCard key={connection.id} connection={connection} />;
      })}
    </div>
  );
}

function VncCredentialCard({
  credential,
}: {
  readonly credential: VncCredentialResponse;
}) {
  const { t } = useTranslation();
  const open = useSet(openVncDialog$);
  const signal = useGet(pageSignal$);
  return (
    <article className="grid gap-3 rounded-xl border bg-card p-5">
      <h2 className="break-all font-semibold">{credential.name}</h2>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.credential.method;
        })}
      </p>
      <VncCredentialImpact credential={credential} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            detach(
              open("edit-credential", credential, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.vnc.credential.edit;
          })}
        </Button>
        <Button
          variant="outline"
          disabled={credential.hosts.length > 0}
          onClick={() => {
            detach(
              open("delete-credential", credential, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.vnc.credential.delete;
          })}
        </Button>
      </div>
      {credential.hosts.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.credential.inUse;
          })}
        </p>
      )}
    </article>
  );
}

function VncCredentials() {
  const { t } = useTranslation();
  const credentials = useLoadable(vncCredentials$);
  const open = useSet(openVncDialog$);
  const signal = useGet(pageSignal$);
  if (credentials.state === "loading") {
    return (
      <p role="status">
        {t(($) => {
          return $.vnc.loading;
        })}
      </p>
    );
  }
  if (credentials.state === "hasError") {
    return <VncLoadError />;
  }
  if (!credentials.data) {
    return (
      <p>
        {t(($) => {
          return $.vnc.unavailable;
        })}
      </p>
    );
  }
  return (
    <div className="grid gap-5">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            detach(open("create-credential", null, signal), Reason.DomCallback);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.vnc.credential.add;
          })}
        </Button>
      </div>
      {credentials.data.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.credential.empty;
          })}
        </p>
      )}
      {credentials.data.map((credential) => {
        return (
          <VncCredentialCard key={credential.id} credential={credential} />
        );
      })}
    </div>
  );
}

function VncPageHeader() {
  const { t } = useTranslation();
  return (
    <>
      <DetailPageBreadcrumbBar>
        <Link
          pathname={ROUTES.connectors}
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-inherit no-underline transition-colors hover:bg-state-hover hover:text-foreground"
        >
          <Plug size={14} className="shrink-0" aria-hidden="true" />
          {t(($) => {
            return $.appShell.sidebar.navigation.connectors;
          })}
        </Link>
        <span className="select-none text-muted-foreground/40">/</span>
        <span
          aria-current="page"
          className="min-w-0 truncate px-1.5 py-0.5 font-medium"
        >
          {t(($) => {
            return $.vnc.label;
          })}
        </span>
      </DetailPageBreadcrumbBar>
      <DetailPageHeader>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gray-100 text-muted-foreground sm:h-16 sm:w-16">
            <Monitor size={28} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t(($) => {
                return $.vnc.title;
              })}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t(($) => {
                return $.vnc.description;
              })}
            </p>
          </div>
        </div>
      </DetailPageHeader>
    </>
  );
}

export function VncConnectorPage() {
  const { t } = useTranslation();
  const view = useGet(vncView$);
  const changeView = useSet(changeVncView$);
  const refresh = useSet(invalidateVnc$);
  return (
    <DetailPageShell>
      <VncPageHeader />
      <DetailPageMain constrainContent>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <SegmentControl
            value={view}
            onValueChange={changeView}
            aria-label={t(($) => {
              return $.vnc.title;
            })}
          >
            <SegmentControlItem value="hosts">
              {t(($) => {
                return $.vnc.hostsTab;
              })}
            </SegmentControlItem>
            <SegmentControlItem value="credentials">
              {t(($) => {
                return $.vnc.credentialsTab;
              })}
            </SegmentControlItem>
          </SegmentControl>
          <Button
            variant="outline"
            onClick={() => {
              refresh();
            }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {t(($) => {
              return $.vnc.refresh;
            })}
          </Button>
        </div>
        {view === "hosts" ? <VncHosts /> : <VncCredentials />}
        <VncDialog />
      </DetailPageMain>
    </DetailPageShell>
  );
}
